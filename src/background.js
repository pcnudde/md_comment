const GITHUB_API_BASE = "https://api.github.com";

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
          await chrome.storage.sync.set({ githubToken: token });
          sendResponse({ ok: true });
          return;
        }
        case "getToken": {
          const stored = await chrome.storage.sync.get(["githubToken"]);
          sendResponse({ ok: true, token: stored.githubToken || "" });
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
        default:
          throw new Error(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      sendResponse({ ok: false, error: stringifyError(error) });
    }
  })();

  return true;
});

async function getToken() {
  const stored = await chrome.storage.sync.get(["githubToken"]);
  const token = String(stored.githubToken || "").trim();
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
  for (const file of orderedFiles) {
    if (!file || !file.filename || !file.patch) {
      continue;
    }

    const patchLines = parsePatchRightLines(file.patch);
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

const pullFilesCache = new Map();

async function getPullFiles(owner, repo, pullNumber, token) {
  const key = `${owner}/${repo}#${pullNumber}`;
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
