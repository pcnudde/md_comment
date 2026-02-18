const GITHUB_API_BASE = "https://api.github.com";
import {
  buildThreadedReviewComments,
  collectResolvedCommentIdsFromReviewThreadsResponse,
  filterOutResolvedComments
} from "./review-thread-filter.mjs";

const pullCommentsCache = new Map();
const pullFilesCache = new Map();
const fileContentCache = new Map();

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (!message || !message.type) {
        throw new Error("Invalid message payload.");
      }

      switch (message.type) {
        case "saveToken": {
          const token = String(message.token || "").trim();
          await chrome.storage.local.set({ githubToken: token });
          await chrome.storage.sync.remove(["githubToken"]);
          clearApiCaches();
          sendResponse({ ok: true });
          return;
        }
        case "getToken": {
          const token = await getOptionalToken();
          sendResponse({ ok: true, token });
          return;
        }
        case "validateToken": {
          const token = await getToken();
          const resp = await githubFetch("/user", token);
          const json = await resp.json();
          sendResponse({ ok: true, login: json.login || null });
          return;
        }
        case "resolveAnchor": {
          const token = await getToken();
          const candidates = await resolveAnchorCandidates(message.payload, token);
          sendResponse({ ok: true, candidates });
          return;
        }
        case "postComment": {
          const token = await getToken();
          const result = await postReviewComment(message.payload, token);
          sendResponse({ ok: true, result });
          return;
        }
        case "replyToComment": {
          const token = await getToken();
          const result = await replyToReviewComment(message.payload, token);
          sendResponse({ ok: true, result });
          return;
        }
        case "listPullComments": {
          const token = await getToken();
          const comments = await listPullReviewComments(message.payload, token);
          sendResponse({ ok: true, comments });
          return;
        }
        default:
          throw new Error(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      sendResponse({ ok: false, error: stringifyError(error) });
    }
  })();

  return true;
});

function clearApiCaches() {
  pullCommentsCache.clear();
  pullFilesCache.clear();
  fileContentCache.clear();
}

function buildScopedCacheKey(owner, repo, pullNumber, token) {
  return `${tokenFingerprint(token)}:${owner}/${repo}#${pullNumber}`;
}

function tokenFingerprint(token) {
  const value = String(token || "");
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function getOptionalToken() {
  const localStored = await chrome.storage.local.get(["githubToken"]);
  const localToken = String(localStored.githubToken || "").trim();
  if (localToken) {
    return localToken;
  }

  // One-time migration for earlier versions that persisted the token in sync storage.
  const syncStored = await chrome.storage.sync.get(["githubToken"]);
  const syncToken = String(syncStored.githubToken || "").trim();
  if (!syncToken) {
    return "";
  }

  await chrome.storage.local.set({ githubToken: syncToken });
  await chrome.storage.sync.remove(["githubToken"]);
  clearApiCaches();
  return syncToken;
}

async function getToken() {
  const token = await getOptionalToken();
  if (!token) {
    throw new Error("No GitHub token configured. Open extension options and set a fine-grained PAT.");
  }
  return token;
}

async function postReviewComment(payload, token) {
  assertPayload(payload, ["owner", "repo", "pullNumber", "path", "body", "line", "side"]);

  const head = await getPullHeadSha(payload.owner, payload.repo, payload.pullNumber, token);
  const commentBody = {
    body: payload.body,
    commit_id: head,
    path: payload.path,
    line: Number(payload.line),
    side: payload.side === "LEFT" ? "LEFT" : "RIGHT"
  };

  const resp = await githubFetch(
    `/repos/${encodeURIComponent(payload.owner)}/${encodeURIComponent(payload.repo)}/pulls/${Number(payload.pullNumber)}/comments`,
    token,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(commentBody)
    }
  );

  const json = await resp.json();
  return {
    id: json.id,
    html_url: json.html_url,
    path: json.path,
    line: json.line,
    side: json.side
  };
}

async function replyToReviewComment(payload, token) {
  assertPayload(payload, ["owner", "repo", "pullNumber", "inReplyTo", "body"]);

  const resp = await githubFetch(
    `/repos/${encodeURIComponent(payload.owner)}/${encodeURIComponent(payload.repo)}/pulls/${Number(payload.pullNumber)}/comments`,
    token,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        body: payload.body,
        in_reply_to: Number(payload.inReplyTo)
      })
    }
  );

  const json = await resp.json();
  return {
    id: json.id,
    html_url: json.html_url,
    in_reply_to_id: json.in_reply_to_id || null
  };
}

async function resolveAnchorCandidates(payload, token) {
  assertPayload(payload, ["owner", "repo", "pullNumber", "selectedText"]);

  const files = await getPullFiles(payload.owner, payload.repo, payload.pullNumber, token);
  const requestedPath = String(payload.path || "").trim();
  const exactFiles = requestedPath ? files.filter((file) => file.filename === requestedPath) : [];
  const fallbackFiles = exactFiles.length
    ? files.filter((file) => file.filename !== requestedPath)
    : [];
  const orderedFiles = exactFiles.length ? [...exactFiles, ...fallbackFiles] : files;

  const allCandidates = [];
  let needsLargeFileFallback = false;
  let fallbackPermissionError = "";
  let headSha = "";
  for (const file of orderedFiles) {
    if (!file || !file.filename) {
      continue;
    }

    let patchLines = file.patch ? parsePatchRightLines(file.patch) : [];
    if (!patchLines.length && isPatchlessAddedFile(file)) {
      needsLargeFileFallback = true;
      try {
        if (!headSha) {
          headSha = await getPullHeadSha(payload.owner, payload.repo, payload.pullNumber, token);
        }
        patchLines = await getAddedFileLinesViaContentsFallback(
          payload.owner,
          payload.repo,
          payload.pullNumber,
          file.filename,
          headSha,
          token
        );
      } catch (error) {
        fallbackPermissionError = stringifyError(error);
      }
    }

    if (!patchLines.length) {
      continue;
    }

    const fileBoost = requestedPath && file.filename === requestedPath ? 0.05 : 0;
    const perFileLimit = requestedPath ? 5 : 3;
    const ranked = rankCandidates(payload.selectedText, patchLines).slice(0, perFileLimit);

    for (const candidate of ranked) {
      allCandidates.push({
        ...candidate,
        score: Math.min(1, candidate.score + fileBoost),
        path: file.filename
      });
    }
  }

  if (!allCandidates.length) {
    if (needsLargeFileFallback && fallbackPermissionError) {
      throw new Error(
        `Could not map selection from large file fallback: ${fallbackPermissionError}. Ensure PAT has Contents: Read.`
      );
    }
    if (needsLargeFileFallback) {
      throw new Error(
        "Could not map selection in this large added file. Try a shorter unique selection, or enable Contents: Read for fallback."
      );
    }
    throw new Error("Could not map selection to changed content. Try selecting a shorter unique segment.");
  }

  allCandidates.sort((a, b) => b.score - a.score);

  const deduped = [];
  const seen = new Set();
  for (const candidate of allCandidates) {
    const key = `${candidate.path}:${candidate.startLine}:${candidate.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
    if (deduped.length >= 5) {
      break;
    }
  }

  return deduped;
}

function isPatchlessAddedFile(file) {
  return Boolean(file && !file.patch && String(file.status || "") === "added");
}

async function getAddedFileLinesViaContentsFallback(owner, repo, pullNumber, path, ref, token) {
  const cacheKey = `${buildScopedCacheKey(owner, repo, pullNumber, token)}:content:${String(ref || "")}:${String(path || "")}`;
  if (fileContentCache.has(cacheKey)) {
    return fileContentCache.get(cacheKey);
  }

  const encodedPath = encodePathForContentsApi(path);
  const resp = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    token
  );
  const json = await resp.json();

  if (!json || json.type !== "file") {
    throw new Error("Contents API fallback returned a non-file response.");
  }

  const body = decodeGithubFileContent(json);
  if (!body) {
    throw new Error("Contents API fallback returned empty file content.");
  }

  const lines = parseAddedFileLines(body);
  fileContentCache.set(cacheKey, lines);
  return lines;
}

function encodePathForContentsApi(path) {
  return String(path || "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeGithubFileContent(fileJson) {
  const encoding = String(fileJson.encoding || "").toLowerCase();
  const content = String(fileJson.content || "");
  if (!content) {
    return "";
  }

  if (encoding === "base64") {
    const normalized = content.replace(/\s+/g, "");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  return content;
}

function parseAddedFileLines(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    out.push({ line: i + 1, raw, rendered: normalizeForMatch(raw), op: "+" });
  }
  return out;
}

async function listPullReviewComments(payload, token) {
  assertPayload(payload, ["owner", "repo", "pullNumber"]);
  const owner = String(payload.owner);
  const repo = String(payload.repo);
  const pullNumber = Number(payload.pullNumber);
  const cacheKey = buildScopedCacheKey(owner, repo, pullNumber, token);
  if (payload.forceRefresh) {
    pullCommentsCache.delete(cacheKey);
  }

  if (!pullCommentsCache.has(cacheKey)) {
    pullCommentsCache.set(cacheKey, await fetchAllPullReviewComments(owner, repo, pullNumber, token));
  }

  return pullCommentsCache.get(cacheKey);
}

async function getPullHeadSha(owner, repo, pullNumber, token) {
  const resp = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(pullNumber)}`,
    token
  );
  const pull = await resp.json();
  if (!pull || !pull.head || !pull.head.sha) {
    throw new Error("Unable to resolve PR head commit SHA.");
  }
  return pull.head.sha;
}

async function getPullFiles(owner, repo, pullNumber, token) {
  const key = buildScopedCacheKey(owner, repo, pullNumber, token);
  if (!pullFilesCache.has(key)) {
    pullFilesCache.set(key, await fetchAllPullFiles(owner, repo, pullNumber, token));
  }

  return pullFilesCache.get(key);
}

async function fetchAllPullFiles(owner, repo, pullNumber, token) {
  const allFiles = [];
  let page = 1;

  while (page <= 10) {
    const resp = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(pullNumber)}/files?per_page=100&page=${page}`,
      token
    );

    const files = await resp.json();
    if (!Array.isArray(files) || files.length === 0) {
      break;
    }

    allFiles.push(...files);
    if (files.length < 100) {
      break;
    }

    page += 1;
  }

  return allFiles;
}

async function fetchAllPullReviewComments(owner, repo, pullNumber, token) {
  const resolvedThreadCommentIds = await fetchResolvedThreadCommentIds(owner, repo, pullNumber, token);
  const comments = [];
  let page = 1;

  while (page <= 10) {
    const resp = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${Number(pullNumber)}/comments?per_page=100&page=${page}`,
      token
    );

    const items = await resp.json();
    if (!Array.isArray(items) || items.length === 0) {
      break;
    }

    const unresolvedItems = filterOutResolvedComments(items, resolvedThreadCommentIds);
    for (const item of unresolvedItems) {
      comments.push({
        id: item.id,
        path: item.path || "",
        line: item.line || null,
        startLine: item.start_line || null,
        originalLine: item.original_line || null,
        originalStartLine: item.original_start_line || null,
        side: item.side || "RIGHT",
        body: item.body || "",
        user: item.user && item.user.login ? item.user.login : "unknown",
        createdAt: item.created_at || "",
        updatedAt: item.updated_at || "",
        htmlUrl: item.html_url || "",
        inReplyToId: item.in_reply_to_id || null
      });
    }

    if (items.length < 100) {
      break;
    }

    page += 1;
  }

  comments.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }

    const lineA = a.line || 0;
    const lineB = b.line || 0;
    if (lineA !== lineB) {
      return lineA - lineB;
    }

    return String(a.createdAt).localeCompare(String(b.createdAt));
  });

  await attachAnchorTextToComments(owner, repo, pullNumber, comments, token);
  return buildThreadedReviewComments(comments);
}

async function fetchResolvedThreadCommentIds(owner, repo, pullNumber, token) {
  const resolvedIds = new Set();
  let cursor = null;
  let page = 0;

  while (page < 20) {
    const query = [
      "query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {",
      "  repository(owner: $owner, name: $repo) {",
      "    pullRequest(number: $number) {",
      "      reviewThreads(first: 50, after: $cursor) {",
      "        pageInfo { hasNextPage endCursor }",
      "        nodes {",
      "          isResolved",
      "          comments(first: 100) {",
      "            nodes { databaseId }",
      "          }",
      "        }",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n");

    const payload = {
      query,
      variables: {
        owner,
        repo,
        number: Number(pullNumber),
        cursor
      }
    };

    const json = await githubGraphql(payload, token);
    const result = collectResolvedCommentIdsFromReviewThreadsResponse(json);
    for (const id of result.resolvedIds) {
      resolvedIds.add(id);
    }

    const pageInfo = result.pageInfo || {};
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) {
      break;
    }

    cursor = pageInfo.endCursor;
    page += 1;
  }

  return resolvedIds;
}

async function attachAnchorTextToComments(owner, repo, pullNumber, comments, token) {
  if (!Array.isArray(comments) || comments.length === 0) {
    return;
  }

  const files = await getPullFiles(owner, repo, pullNumber, token);
  const byPath = new Map();

  for (const file of files) {
    if (!file || !file.filename || !file.patch) {
      continue;
    }

    const patchLines = parsePatchRightLines(file.patch);
    if (!patchLines.length) {
      continue;
    }

    const lineMap = new Map();
    for (const line of patchLines) {
      if (!lineMap.has(line.line)) {
        lineMap.set(line.line, line.raw || "");
      }
    }

    byPath.set(file.filename, lineMap);
  }

  for (const comment of comments) {
    if (!comment || !comment.path) {
      continue;
    }

    const lineMap = byPath.get(comment.path);
    if (!lineMap) {
      continue;
    }

    const line = Number(comment.line || comment.originalLine || 0);
    const startLine = Number(comment.startLine || comment.originalStartLine || 0);
    const lo = Math.min(...[line, startLine].filter((n) => n > 0));
    const hi = Math.max(line, startLine);
    let anchorText = "";

    if (lo > 0 && hi > 0 && hi >= lo) {
      const parts = [];
      for (let n = lo; n <= hi && parts.length < 4; n += 1) {
        const value = lineMap.get(n);
        if (value) {
          parts.push(value);
        }
      }
      anchorText = parts.join(" ");
    }

    if (!anchorText && line > 0) {
      anchorText = lineMap.get(line) || "";
    }
    if (!anchorText && startLine > 0) {
      anchorText = lineMap.get(startLine) || "";
    }

    comment.anchorText = String(anchorText || "").trim().slice(0, 320);
  }
}

async function githubFetch(path, token, init = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(init.headers || {})
  };

  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    let detail = `GitHub API failed (${response.status}).`;
    try {
      const json = await response.json();
      if (json && json.message) {
        detail = `${detail} ${json.message}`;
      }
    } catch (_) {
      // Ignore JSON parse errors and keep default detail.
    }
    throw new Error(detail);
  }

  return response;
}

async function githubGraphql(payload, token) {
  const response = await fetch(`${GITHUB_API_BASE}/graphql`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json();
  if (!response.ok) {
    const detail = json && json.message ? json.message : `GitHub GraphQL failed (${response.status}).`;
    throw new Error(detail);
  }

  if (json && Array.isArray(json.errors) && json.errors.length > 0) {
    const first = json.errors[0];
    const message = first && first.message ? first.message : "GitHub GraphQL returned errors.";
    throw new Error(message);
  }

  return json;
}

function parsePatchRightLines(patch) {
  const lines = patch.split("\n");
  const out = [];
  let right = 0;
  let inHunk = false;

  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const hunk = parseHunkHeader(raw);
      if (!hunk) {
        inHunk = false;
        continue;
      }
      right = hunk.rightStart;
      inHunk = true;
      continue;
    }

    if (!inHunk || raw.length === 0) {
      continue;
    }

    if (raw.startsWith("+")) {
      const text = raw.slice(1);
      out.push({ line: right, raw: text, rendered: normalizeForMatch(text), op: "+" });
      right += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      const text = raw.slice(1);
      out.push({ line: right, raw: text, rendered: normalizeForMatch(text), op: " " });
      right += 1;
      continue;
    }

    if (raw.startsWith("-")) {
      continue;
    }
  }

  return out;
}

function parseHunkHeader(line) {
  const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) {
    return null;
  }

  return {
    rightStart: Number(match[1]),
    rightCount: Number(match[2] || "1")
  };
}

function rankCandidates(selectedText, patchLines) {
  const target = normalizeForMatch(selectedText);
  if (!target) {
    return [];
  }

  const targetTokens = tokenize(target);
  const maxWindow = 12;
  const results = [];

  for (let start = 0; start < patchLines.length; start += 1) {
    let joined = "";

    for (let size = 1; size <= maxWindow && start + size <= patchLines.length; size += 1) {
      const line = patchLines[start + size - 1];
      joined = joined ? `${joined} ${line.rendered}` : line.rendered;
      if (!joined) {
        continue;
      }

      const spanPenalty = Math.min(0.28, (size - 1) * 0.06);
      const similarity = scoreText(target, joined, targetTokens) - spanPenalty;
      if (similarity < 0.2) {
        continue;
      }

      const startLine = patchLines[start].line;
      const endLine = line.line;
      const preview = joined.slice(0, 220);

      results.push({
        score: similarity,
        startLine,
        line: endLine,
        side: "RIGHT",
        preview
      });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    const aSpan = a.line - a.startLine;
    const bSpan = b.line - b.startLine;
    return aSpan - bSpan;
  });

  const deduped = [];
  const seen = new Set();
  for (const candidate of results) {
    const key = `${candidate.startLine}:${candidate.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function scoreText(target, candidate, targetTokens) {
  if (!candidate) {
    return 0;
  }

  if (candidate.includes(target)) {
    return 1;
  }

  if (target.includes(candidate)) {
    return Math.max(0.3, candidate.length / target.length);
  }

  const candidateTokens = tokenize(candidate);
  const overlap = tokenOverlap(targetTokens, candidateTokens);
  const lengthPenalty = 1 - Math.min(0.5, Math.abs(candidate.length - target.length) / Math.max(target.length, 1));

  return overlap * 0.75 + lengthPenalty * 0.25;
}

function normalizeForMatch(value) {
  if (!value) {
    return "";
  }

  let text = String(value);
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, " $1 ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, " $1 ");
  text = text.replace(/`+/g, " ");
  text = text.replace(/^\s*#{1,6}\s+/g, " ");
  text = text.replace(/^\s*([-*+]\s+|\d+\.\s+)/g, " ");
  text = text.replace(/[*_~>#]/g, " ");
  text = text.replace(/\s+/g, " ");
  return text.trim().toLowerCase();
}

function tokenize(value) {
  return new Set(value.split(/\s+/).filter(Boolean));
}

function tokenOverlap(a, b) {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of a) {
    if (b.has(token)) {
      matches += 1;
    }
  }

  return matches / Math.max(a.size, b.size);
}

function assertPayload(payload, requiredKeys) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Missing payload.");
  }

  for (const key of requiredKeys) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
      throw new Error(`Missing required field: ${key}`);
    }
  }
}

function stringifyError(error) {
  if (!error) {
    return "Unknown error.";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error.message) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch (_) {
    return "Unknown error.";
  }
}
