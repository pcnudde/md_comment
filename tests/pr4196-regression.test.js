const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function normalizePathKey(input) {
  if (!input) {
    return "";
  }

  let key = String(input).trim();
  try {
    key = decodeURIComponent(key);
  } catch (_) {
    // Keep the original value if decode fails.
  }

  key = key.replace(/^\/+/, "");
  key = key.replace(/^[ab]\//, "");
  key = key.replace(/\\/g, "/");
  key = key.replace(/\/+/g, "/");
  return key;
}

function resolveCommentLines(comment) {
  const startLine = Number(
    comment.start_line || comment.startLine || comment.original_start_line || comment.originalStartLine || 0
  );
  const line = Number(comment.line || comment.original_line || comment.originalLine || 0);
  return { startLine, line };
}

function extractLoadedDiffPaths(html) {
  const paths = new Set();
  const patterns = [
    /data-file-path="([^"]+)"/g,
    /data-path="([^"]+)"/g,
    /data-tagsearch-path="([^"]+)"/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(html);
    while (match) {
      paths.add(normalizePathKey(match[1]));
      match = pattern.exec(html);
    }
  }

  return paths;
}

function countMappableComments(comments, loadedDiffPaths) {
  let count = 0;
  for (const comment of comments) {
    const targetPath = normalizePathKey(comment.path);
    if (!targetPath || !loadedDiffPaths.has(targetPath)) {
      continue;
    }

    const { startLine, line } = resolveCommentLines(comment);
    if (line > 0 || startLine > 0) {
      count += 1;
    }
  }
  return count;
}

function extractTreeAnchorsByPath(html) {
  const out = new Map();
  const pattern =
    /<li[\s\S]*?<span[^>]*data-filterable-item-text[^>]*>([^<]+)<\/span>[\s\S]*?<a[^>]*href="#(diff-[^"]+)"/g;
  let match = pattern.exec(html);
  while (match) {
    const pathKey = normalizePathKey(match[1]);
    const anchorId = String(match[2] || "").trim();
    if (pathKey && anchorId && !out.has(pathKey)) {
      out.set(pathKey, anchorId);
    }
    match = pattern.exec(html);
  }
  return out;
}

function extractLoadedDiffIds(html) {
  const ids = new Set();
  const patterns = [/id="(diff-[^"]+)"/g, /data-diff-anchor="(diff-[^"]+)"/g];
  for (const pattern of patterns) {
    let match = pattern.exec(html);
    while (match) {
      ids.add(String(match[1] || "").trim());
      match = pattern.exec(html);
    }
  }
  return ids;
}

function countMappableCommentsWithAnchorFallback(comments, loadedDiffPaths, treeAnchorsByPath, loadedDiffIds) {
  let count = 0;
  for (const comment of comments) {
    const targetPath = normalizePathKey(comment.path);
    if (!targetPath) {
      continue;
    }

    const byPath = loadedDiffPaths.has(targetPath);
    const byAnchor = !byPath && treeAnchorsByPath.has(targetPath) && loadedDiffIds.has(treeAnchorsByPath.get(targetPath));
    if (!byPath && !byAnchor) {
      continue;
    }

    const { startLine, line } = resolveCommentLines(comment);
    if (line > 0 || startLine > 0) {
      count += 1;
    }
  }
  return count;
}

const commentsFixturePath = path.join(__dirname, "fixtures", "pr4196-comments.json");
const htmlFixturePath = path.join(__dirname, "fixtures", "pr4196-files-initial.html");

const comments = JSON.parse(fs.readFileSync(commentsFixturePath, "utf8"));
const initialHtml = fs.readFileSync(htmlFixturePath, "utf8");

test("PR 4196 fixture captures GitHub comment shape (line often null, original_line present)", () => {
  assert.ok(Array.isArray(comments));
  assert.ok(comments.length > 0);

  const nullLineWithOriginal = comments.filter((c) => c.line == null && Number(c.original_line) > 0).length;
  const rangedComments = comments.filter((c) => Number(c.start_line || c.original_start_line || 0) > 0).length;

  assert.ok(nullLineWithOriginal >= 2, "Expected multiple comments with null line + original_line");
  assert.ok(rangedComments >= 3, "Expected several range comments");
});

test("line fallback handles current-line and original-line comments", () => {
  const outdated = comments.find((c) => c.id === 2808272535);
  const current = comments.find((c) => c.id === 2808301082);
  const range = comments.find((c) => c.id === 2808272557);

  assert.ok(outdated);
  assert.ok(current);
  assert.ok(range);

  assert.deepEqual(resolveCommentLines(outdated), { startLine: 0, line: 985 });
  assert.deepEqual(resolveCommentLines(current), { startLine: 249, line: 252 });
  assert.deepEqual(resolveCommentLines(range), { startLine: 953, line: 980 });
});

test("initial progressive HTML can load only one file root", () => {
  const loadedPaths = extractLoadedDiffPaths(initialHtml);

  assert.ok(loadedPaths.has("docs/design/collab_api_design_spec.md"));
  assert.ok(!loadedPaths.has("docs/design/collab_api_spec.md"));
});

test("comments remain unmappable until their file root is present in the loaded DOM", () => {
  const loadedPaths = extractLoadedDiffPaths(initialHtml);
  const initialMapped = countMappableComments(comments, loadedPaths);
  assert.equal(initialMapped, 0);

  loadedPaths.add("docs/design/collab_api_spec.md");
  const mappedAfterFileLoad = countMappableComments(comments, loadedPaths);
  assert.equal(mappedAfterFileLoad, comments.length);
});

test("tree path to diff-anchor mapping can recover file roots when data-file-path is absent", () => {
  const loadedPaths = extractLoadedDiffPaths(initialHtml);
  const treeAnchors = extractTreeAnchorsByPath(initialHtml);
  const loadedDiffIds = extractLoadedDiffIds(initialHtml);

  assert.equal(
    treeAnchors.get("docs/design/collab_api_spec.md"),
    "diff-54b971adbadb1c63c11cf47a6c543bbf61f4bfe83579a042675d69ddbcb7114a"
  );

  const initialMapped = countMappableCommentsWithAnchorFallback(comments, loadedPaths, treeAnchors, loadedDiffIds);
  assert.equal(initialMapped, 0);

  loadedDiffIds.add("diff-54b971adbadb1c63c11cf47a6c543bbf61f4bfe83579a042675d69ddbcb7114a");
  const mappedAfterAnchorLoad = countMappableCommentsWithAnchorFallback(comments, loadedPaths, treeAnchors, loadedDiffIds);
  assert.equal(mappedAfterAnchorLoad, comments.length);
});
