const SIDEBAR_SETTING_KEY = "enableSidebarComments";
const SIDEBAR_EXPLICIT_KEY = "sidebarPreferenceExplicit";

const UI = {
  button: null,
  composer: null,
  toast: null,
  badge: null,
  sidebarRoot: null,
  sidebarToggle: null,
  sidebarList: null,
  sidebarStatus: null,
  sidebarDebugButton: null,
  sidebarDebugPanel: null,
  sidebarDebugOutput: null,
  sidebarDebugVisible: false,
  lastDebugText: "",
  activeSelection: null,
  outsideHandler: null,
  listenersActive: false,
  selectionTimer: null,
  sidebarEnabled: false,
  sidebarVisible: false,
  sidebarPrKey: "",
  sidebarComments: [],
  sidebarLoading: false,
  storageChangeHandler: null,
  sidebarTargetById: new Map(),
  alignedCardById: new Map(),
  alignedItems: [],
  alignedLayer: null,
  sidebarScrollHandler: null,
  sidebarSyncTimer: null,
  diffObserver: null,
  diffSyncTimer: null,
  remapRetryTimer: null,
  remapRetryRemaining: 0
};

init();

function init() {
  registerStorageListener();
  syncActivation();
  observeUrlChanges();
}

function syncActivation() {
  const shouldEnable = isPullFilesPage();
  if (shouldEnable && !UI.listenersActive) {
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    UI.listenersActive = true;
    ensureBadge();
    void refreshSidebarFeature(false);
    return;
  }

  if (shouldEnable && UI.listenersActive) {
    void refreshSidebarFeature(false);
    return;
  }

  if (!shouldEnable && UI.listenersActive) {
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("selectionchange", onSelectionChange);
    UI.listenersActive = false;
    removeBadge();
    removeSidebarUi();
    cleanupUi();
  }
}

function observeUrlChanges() {
  let previous = location.href;
  const observer = new MutationObserver(() => {
    if (location.href === previous) {
      return;
    }

    previous = location.href;
    syncActivation();
  });

  observer.observe(document.documentElement, { subtree: true, childList: true });
}

function registerStorageListener() {
  if (UI.storageChangeHandler) {
    return;
  }

  UI.storageChangeHandler = (changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(changes, SIDEBAR_SETTING_KEY)) {
      return;
    }

    void refreshSidebarFeature(true);
  };

  chrome.storage.onChanged.addListener(UI.storageChangeHandler);
}

async function refreshSidebarFeature(forceRefresh = false) {
  UI.sidebarEnabled = await readSidebarEnabled();
  if (!UI.sidebarEnabled || !isPullFilesPage()) {
    removeSidebarUi();
    return;
  }

  const pr = readPullContext();
  if (!pr) {
    removeSidebarUi();
    return;
  }

  const nextKey = `${pr.owner}/${pr.repo}#${pr.pullNumber}`;
  const pullChanged = nextKey !== UI.sidebarPrKey;
  UI.sidebarPrKey = nextKey;

  ensureSidebarUi();
  if (pullChanged) {
    UI.sidebarComments = [];
    renderSidebarComments([]);
  }

  await loadSidebarComments(pr, { forceRefresh: forceRefresh || pullChanged });
}

async function readSidebarEnabled() {
  try {
    const stored = await chrome.storage.sync.get([SIDEBAR_SETTING_KEY, SIDEBAR_EXPLICIT_KEY]);
    const hasExplicitPreference = Boolean(stored[SIDEBAR_EXPLICIT_KEY]);
    if (hasExplicitPreference) {
      return Boolean(stored[SIDEBAR_SETTING_KEY]);
    }

    const value = stored[SIDEBAR_SETTING_KEY];
    if (value !== true) {
      await chrome.storage.sync.set({ [SIDEBAR_SETTING_KEY]: true });
    }
    return true;
  } catch (_) {
    return true;
  }
}

function ensureSidebarUi() {
  if (UI.sidebarToggle && UI.sidebarRoot) {
    ensureDiffObserver();
    updateDebugPanelVisibility();
    updateSidebarVisibility();
    return;
  }

  UI.sidebarToggle = document.createElement("button");
  UI.sidebarToggle.type = "button";
  UI.sidebarToggle.className = "mdc-sidebar-toggle";
  UI.sidebarToggle.addEventListener("click", () => {
    UI.sidebarVisible = !UI.sidebarVisible;
    updateSidebarVisibility();
  });

  UI.sidebarRoot = document.createElement("aside");
  UI.sidebarRoot.className = "mdc-sidebar";
  UI.sidebarRoot.innerHTML = [
    '<div class="mdc-sidebar-header">',
    '  <div class="mdc-sidebar-title">PR Comments</div>',
    '  <div class="mdc-sidebar-actions">',
    '    <button type="button" class="mdc-sidebar-refresh" title="Refresh">Refresh</button>',
    '    <button type="button" class="mdc-sidebar-debug" title="Debug">Debug</button>',
    '    <button type="button" class="mdc-sidebar-hide" title="Hide">Hide</button>',
    "  </div>",
    "</div>",
    '<div class="mdc-sidebar-status">Loading comments...</div>',
    '<div class="mdc-sidebar-debug-panel">',
    '  <div class="mdc-sidebar-debug-actions">',
    '    <button type="button" class="mdc-sidebar-debug-copy">Copy</button>',
    '    <button type="button" class="mdc-sidebar-debug-close">Close</button>',
    "  </div>",
    '  <textarea class="mdc-sidebar-debug-output" readonly></textarea>',
    "</div>",
    '<div class="mdc-sidebar-list"></div>'
  ].join("");

  UI.sidebarStatus = UI.sidebarRoot.querySelector(".mdc-sidebar-status");
  UI.sidebarList = UI.sidebarRoot.querySelector(".mdc-sidebar-list");
  UI.sidebarDebugButton = UI.sidebarRoot.querySelector(".mdc-sidebar-debug");
  UI.sidebarDebugPanel = UI.sidebarRoot.querySelector(".mdc-sidebar-debug-panel");
  UI.sidebarDebugOutput = UI.sidebarRoot.querySelector(".mdc-sidebar-debug-output");

  const refreshButton = UI.sidebarRoot.querySelector(".mdc-sidebar-refresh");
  const debugButton = UI.sidebarRoot.querySelector(".mdc-sidebar-debug");
  const debugCopyButton = UI.sidebarRoot.querySelector(".mdc-sidebar-debug-copy");
  const debugCloseButton = UI.sidebarRoot.querySelector(".mdc-sidebar-debug-close");
  const hideButton = UI.sidebarRoot.querySelector(".mdc-sidebar-hide");
  refreshButton.addEventListener("click", () => {
    const pr = readPullContext();
    if (!pr) {
      return;
    }
    void loadSidebarComments(pr, { forceRefresh: true });
  });
  hideButton.addEventListener("click", () => {
    UI.sidebarVisible = false;
    updateSidebarVisibility();
  });
  debugButton.addEventListener("click", () => {
    UI.sidebarDebugVisible = !UI.sidebarDebugVisible;
    updateDebugPanelVisibility();
  });
  debugCloseButton.addEventListener("click", () => {
    UI.sidebarDebugVisible = false;
    updateDebugPanelVisibility();
  });
  debugCopyButton.addEventListener("click", () => {
    void copyDebugOutput();
  });

  UI.sidebarVisible = false;
  UI.sidebarDebugVisible = false;
  ensureAlignedLayer();
  document.body.appendChild(UI.sidebarToggle);
  document.body.appendChild(UI.sidebarRoot);
  ensureDiffObserver();
  updateDebugPanelVisibility();
  updateSidebarVisibility();
}

function removeSidebarUi() {
  UI.sidebarComments = [];
  UI.sidebarPrKey = "";
  UI.sidebarLoading = false;
  UI.sidebarTargetById.clear();
  UI.alignedCardById.clear();
  UI.alignedItems = [];
  detachSidebarScrollSync();
  detachDiffObserver();
  stopRemapRetryLoop();
  removeAlignedLayer();

  if (UI.sidebarToggle) {
    UI.sidebarToggle.remove();
    UI.sidebarToggle = null;
  }

  if (UI.sidebarRoot) {
    UI.sidebarRoot.remove();
    UI.sidebarRoot = null;
  }

  UI.sidebarList = null;
  UI.sidebarStatus = null;
  UI.sidebarDebugButton = null;
  UI.sidebarDebugPanel = null;
  UI.sidebarDebugOutput = null;
  UI.sidebarDebugVisible = false;
  UI.lastDebugText = "";
}

function updateSidebarVisibility() {
  if (!UI.sidebarToggle || !UI.sidebarRoot) {
    return;
  }

  UI.sidebarRoot.classList.toggle("is-visible", UI.sidebarVisible);
  UI.sidebarToggle.textContent = UI.sidebarVisible
    ? `Hide Comments (${UI.sidebarComments.length})`
    : `Comments (${UI.sidebarComments.length})`;
  scheduleAlignedLayout();
}

function updateDebugPanelVisibility() {
  if (!UI.sidebarDebugPanel || !UI.sidebarDebugButton) {
    return;
  }

  UI.sidebarDebugPanel.classList.toggle("is-visible", UI.sidebarDebugVisible);
  UI.sidebarDebugButton.textContent = UI.sidebarDebugVisible ? "Debug On" : "Debug";
  if (UI.sidebarDebugVisible) {
    renderDebugText();
  }
}

function renderDebugText() {
  if (!UI.sidebarDebugOutput) {
    return;
  }

  UI.sidebarDebugOutput.value = UI.lastDebugText || "No debug snapshot yet.";
}

async function copyDebugOutput() {
  const text = UI.lastDebugText || "";
  if (!text) {
    notify("No debug output available.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    notify("Debug output copied.", "ok");
    return;
  } catch (_) {
    // Fallback to selection copy.
  }

  if (!UI.sidebarDebugOutput) {
    notify("Copy failed.", "error");
    return;
  }

  UI.sidebarDebugOutput.focus();
  UI.sidebarDebugOutput.select();
  const copied = document.execCommand("copy");
  notify(copied ? "Debug output copied." : "Copy failed.", copied ? "ok" : "error");
}

function ensureDiffObserver() {
  if (UI.diffObserver) {
    return;
  }

  UI.diffObserver = new MutationObserver((mutations) => {
    if (!UI.sidebarEnabled || UI.sidebarLoading || !UI.sidebarComments.length || !isPullFilesPage()) {
      return;
    }

    if (!hasRelevantDiffMutation(mutations)) {
      return;
    }

    scheduleSidebarRemap();
  });

  UI.diffObserver.observe(document.body, {
    subtree: true,
    childList: true
  });
}

function detachDiffObserver() {
  if (UI.diffObserver) {
    UI.diffObserver.disconnect();
    UI.diffObserver = null;
  }

  window.clearTimeout(UI.diffSyncTimer);
  UI.diffSyncTimer = null;
}

function scheduleSidebarRemap() {
  window.clearTimeout(UI.diffSyncTimer);
  UI.diffSyncTimer = window.setTimeout(() => {
    if (!UI.sidebarEnabled || UI.sidebarLoading || !UI.sidebarComments.length || !UI.sidebarRoot) {
      return;
    }

    renderSidebarComments(UI.sidebarComments);
    updateSidebarVisibility();
  }, 90);
}

function hasRelevantDiffMutation(mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    return false;
  }

  for (const mutation of mutations) {
    if (!mutation || mutation.type !== "childList" || mutation.addedNodes.length === 0) {
      continue;
    }

    const target = mutation.target instanceof Element ? mutation.target : null;
    if (target && !isExtensionUiElement(target) && target.closest("#files")) {
      return true;
    }

    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) {
        continue;
      }

      if (isExtensionUiElement(node)) {
        continue;
      }

      if (node.closest("#files") || isDiffRegionNode(node)) {
        return true;
      }
    }
  }

  return false;
}

function stopRemapRetryLoop() {
  window.clearInterval(UI.remapRetryTimer);
  UI.remapRetryTimer = null;
  UI.remapRetryRemaining = 0;
}

function startRemapRetryLoop() {
  if (UI.remapRetryTimer) {
    return;
  }

  UI.remapRetryRemaining = 12;
  UI.remapRetryTimer = window.setInterval(() => {
    if (!UI.sidebarEnabled || UI.sidebarLoading || !UI.sidebarComments.length || !UI.sidebarRoot) {
      stopRemapRetryLoop();
      return;
    }

    UI.remapRetryRemaining -= 1;
    renderSidebarComments(UI.sidebarComments);
    updateSidebarVisibility();

    const mapped = UI.alignedItems.filter((item) => Boolean(item.target)).length;
    if (mapped > 0 || UI.remapRetryRemaining <= 0) {
      stopRemapRetryLoop();
    }
  }, 700);
}

function isExtensionUiElement(element) {
  if (!element) {
    return false;
  }

  return Boolean(
    element.closest(
      ".mdc-sidebar, .mdc-sidebar-toggle, .mdc-aligned-layer, .mdc-composer, .mdc-comment-btn, .mdc-toast, .mdc-badge"
    )
  );
}

function isDiffRegionNode(element) {
  if (!element) {
    return false;
  }

  const selector = [
    "#files",
    ".js-diff-progressive-container",
    "[data-file-path]",
    "[data-path]",
    "[data-line-number]",
    ".js-diff-table",
    ".js-file-content",
    ".blob-wrapper",
    ".markdown-body",
    ".rich-diff-level-zero",
    ".rich-diff-level-one"
  ].join(", ");

  if (element.matches(selector)) {
    return true;
  }

  return Boolean(element.querySelector(selector));
}

async function loadSidebarComments(pr, { forceRefresh = false } = {}) {
  if (!UI.sidebarEnabled || !UI.sidebarRoot || UI.sidebarLoading) {
    return;
  }

  UI.sidebarLoading = true;
  updateSidebarStatus("Loading comments...", false);

  try {
    const response = await sendMessage({
      type: "listPullComments",
      payload: {
        owner: pr.owner,
        repo: pr.repo,
        pullNumber: pr.pullNumber,
        forceRefresh
      }
    });

    if (!response.ok) {
      throw new Error(response.error || "Failed to load comments.");
    }

    UI.sidebarComments = Array.isArray(response.comments) ? response.comments : [];
    renderSidebarComments(UI.sidebarComments);
    updateSidebarStatus(`${UI.sidebarComments.length} comments`, false);
  } catch (error) {
    updateSidebarStatus(stringifyError(error), true);
    renderSidebarComments([]);
  } finally {
    UI.sidebarLoading = false;
    updateSidebarVisibility();
  }
}

function updateSidebarStatus(message, isError) {
  if (!UI.sidebarStatus) {
    return;
  }

  UI.sidebarStatus.textContent = message;
  UI.sidebarStatus.classList.toggle("is-error", Boolean(isError));
}

function renderSidebarComments(comments) {
  if (!UI.sidebarList) {
    return;
  }

  UI.sidebarTargetById.clear();
  UI.alignedCardById.clear();
  UI.alignedItems = [];
  UI.sidebarList.innerHTML = "";
  if (!Array.isArray(comments) || comments.length === 0) {
    stopRemapRetryLoop();
    updateDebugSnapshot([], []);
    const empty = document.createElement("div");
    empty.className = "mdc-sidebar-empty";
    empty.textContent = "No inline review comments found.";
    UI.sidebarList.appendChild(empty);
    renderAlignedComments([]);
    detachSidebarScrollSync();
    return;
  }

  const aligned = alignCommentsToRenderedView(comments);
  UI.alignedItems = aligned;
  renderAlignedComments(aligned);

  const mappedCount = aligned.filter((item) => isAlignedRenderableItem(item)).length;
  updateDebugSnapshot(comments, aligned);

  const summary = document.createElement("div");
  summary.className = "mdc-sidebar-empty";
  summary.textContent = `${mappedCount} aligned comments`;
  UI.sidebarList.appendChild(summary);

  const info = document.createElement("div");
  info.className = "mdc-sidebar-empty";
  info.textContent = "Only mapped comments are shown in the aligned right rail.";
  UI.sidebarList.appendChild(info);

  if (mappedCount === 0) {
    startRemapRetryLoop();
  } else {
    stopRemapRetryLoop();
  }
  attachSidebarScrollSync();
}

function alignCommentsToRenderedView(comments) {
  const items = comments.map((comment) => {
    const diagnosis = diagnoseCommentTarget(comment);
    const target = diagnosis.target;
    return {
      comment,
      target,
      top: target ? getAbsoluteTop(target) : Number.POSITIVE_INFINITY,
      debug: diagnosis
    };
  });

  items.sort((a, b) => {
    const aFinite = Number.isFinite(a.top);
    const bFinite = Number.isFinite(b.top);
    if (aFinite && bFinite && a.top !== b.top) {
      return a.top - b.top;
    }
    if (aFinite !== bFinite) {
      return aFinite ? -1 : 1;
    }

    const aPath = String(a.comment.path || "");
    const bPath = String(b.comment.path || "");
    if (aPath !== bPath) {
      return aPath.localeCompare(bPath);
    }

    const aLine = Number(a.comment.line || a.comment.startLine || 0);
    const bLine = Number(b.comment.line || b.comment.startLine || 0);
    if (aLine !== bLine) {
      return aLine - bLine;
    }

    return Number(a.comment.id || 0) - Number(b.comment.id || 0);
  });

  return items;
}

function updateDebugSnapshot(comments, aligned) {
  UI.lastDebugText = buildDebugReport(comments, aligned);
  if (UI.sidebarDebugVisible) {
    renderDebugText();
  }
}

function buildDebugReport(comments, aligned) {
  const pr = readPullContext();
  const diagnostics = Array.isArray(aligned)
    ? aligned.map((item) => item.debug || diagnoseCommentTarget(item.comment))
    : [];
  const mappedCount = diagnostics.filter((diag) => Boolean(diag && diag.target)).length;
  const withCurrentLine = Array.isArray(comments)
    ? comments.filter((comment) => Number(comment.line || 0) > 0).length
    : 0;
  const withOnlyOriginalLine = Array.isArray(comments)
    ? comments.filter((comment) => !comment.line && Number(comment.originalLine || 0) > 0).length
    : 0;
  const commentPaths = Array.isArray(comments)
    ? Array.from(new Set(comments.map((comment) => normalizePathKey(comment.path || "")).filter(Boolean))).sort()
    : [];
  const loadedPaths = collectLoadedFilePaths();
  const loadedAnchors = collectLoadedDiffAnchors();
  const treeAnchorsByPath = {};
  for (const path of commentPaths) {
    const anchor = findTreeDiffAnchorIdByPath(path);
    treeAnchorsByPath[path] = {
      treeAnchorId: anchor || "",
      treeAnchorLoaded: Boolean(anchor && loadedAnchors.includes(anchor)),
      fileRootFound: Boolean(findFileRootByPath(path))
    };
  }

  const reasons = {};
  for (const diagnostic of diagnostics) {
    const key = diagnostic && diagnostic.reason ? diagnostic.reason : "unknown";
    reasons[key] = (reasons[key] || 0) + 1;
  }

  const perComment = diagnostics.map((diagnostic) => ({
    id: diagnostic.commentId,
    path: diagnostic.path,
    line: diagnostic.line,
    startLine: diagnostic.startLine,
    originalLine: diagnostic.originalLine,
    originalStartLine: diagnostic.originalStartLine,
    chosenLine: diagnostic.lineCandidate,
    reason: diagnostic.reason,
    treeAnchorId: diagnostic.treeAnchorId,
    treeAnchorLoaded: diagnostic.treeAnchorLoaded,
    fileRoot: diagnostic.fileRoot,
    lineTarget: diagnostic.lineTarget,
    anchorTarget: diagnostic.anchorTarget,
    finalTarget: diagnostic.finalTarget,
    preview: diagnostic.preview
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    url: location.href,
    richDiffMode: isRichDiffMode(),
    pr: pr || null,
    summary: {
      totalComments: Array.isArray(comments) ? comments.length : 0,
      mappedComments: mappedCount,
      withCurrentLine,
      withOnlyOriginalLine,
      remapRetryRemaining: UI.remapRetryRemaining || 0
    },
    loadedDom: {
      loadedPaths,
      loadedDiffAnchors: loadedAnchors
    },
    commentPathResolution: treeAnchorsByPath,
    reasonCounts: reasons,
    comments: perComment
  };

  return JSON.stringify(report, null, 2);
}

function collectLoadedFilePaths() {
  const values = new Set();
  const nodes = document.querySelectorAll("[data-file-path], [data-path], [data-tagsearch-path]");
  for (const node of nodes) {
    const attrs = [
      node.getAttribute("data-file-path"),
      node.getAttribute("data-path"),
      node.getAttribute("data-tagsearch-path")
    ];
    for (const attr of attrs) {
      const normalized = normalizePathKey(attr || "");
      if (normalized) {
        values.add(normalized);
      }
    }
  }

  const titleLinks = document.querySelectorAll("a[href^='#diff-'][title]");
  for (const link of titleLinks) {
    const normalized = normalizePathKey(link.getAttribute("title") || "");
    if (normalized) {
      values.add(normalized);
    }
  }

  const treeNodes = document.querySelectorAll("[data-filterable-item-text]");
  for (const node of treeNodes) {
    const normalized = normalizePathKey((node.textContent || "").trim());
    if (normalized) {
      values.add(normalized);
    }
  }

  return Array.from(values).sort();
}

function collectLoadedDiffAnchors() {
  const values = new Set();
  const idNodes = document.querySelectorAll("[id^='diff-']");
  for (const node of idNodes) {
    const id = String(node.id || "").trim();
    if (isLikelyFileDiffAnchorId(id)) {
      values.add(id);
    }
  }

  const anchorNodes = document.querySelectorAll("[data-diff-anchor]");
  for (const node of anchorNodes) {
    const anchor = String(node.getAttribute("data-diff-anchor") || "").trim();
    if (isLikelyFileDiffAnchorId(anchor)) {
      values.add(anchor);
    }
  }

  return Array.from(values).sort();
}

function isLikelyFileDiffAnchorId(value) {
  return /^diff-[0-9a-f]{16,}$/i.test(String(value || ""));
}

function ensureAlignedLayer() {
  if (UI.alignedLayer) {
    return;
  }

  UI.alignedLayer = document.createElement("div");
  UI.alignedLayer.className = "mdc-aligned-layer";
  document.body.appendChild(UI.alignedLayer);
}

function removeAlignedLayer() {
  if (!UI.alignedLayer) {
    return;
  }

  UI.alignedLayer.remove();
  UI.alignedLayer = null;
}

function renderAlignedComments(items) {
  ensureAlignedLayer();
  if (!UI.alignedLayer) {
    return;
  }

  if (!Array.isArray(items) || items.length === 0) {
    UI.alignedItems = [];
    UI.alignedLayer.innerHTML = "";
    UI.alignedCardById.clear();
    UI.alignedLayer.style.display = "none";
    return;
  }

  UI.alignedItems = items.filter((item) => isAlignedRenderableItem(item));
  for (const item of items) {
    if (isAlignedRenderableItem(item)) {
      UI.sidebarTargetById.set(item.comment.id, item.target);
    }
  }

  scheduleAlignedLayout();
}

function isAlignedRenderableItem(item) {
  if (!item || !item.target) {
    return false;
  }

  const reason = item.debug && item.debug.reason ? item.debug.reason : "";
  return reason === "lineMatchCurrent" || reason === "anchorMatch";
}

function layoutAlignedComments() {
  if (!UI.alignedLayer) {
    return;
  }

  UI.alignedLayer.innerHTML = "";
  UI.alignedCardById.clear();

  if (!Array.isArray(UI.alignedItems) || UI.alignedItems.length === 0) {
    UI.alignedLayer.style.display = "none";
    return;
  }

  UI.alignedLayer.style.display = "block";
  const layerRect = UI.alignedLayer.getBoundingClientRect();
  const layerHeight = Math.max(80, layerRect.height);
  let previousBottom = -8;

  const visibleItems = UI.alignedItems.filter((item) => item.target && document.contains(item.target));
  const anchorLineRangesByTarget = buildAnchorLineRangesByTarget(visibleItems);

  const sorted = visibleItems.sort((a, b) => {
    const ay = computeAlignedViewportTop(a, anchorLineRangesByTarget);
    const by = computeAlignedViewportTop(b, anchorLineRangesByTarget);
    return ay - by;
  });

  for (const item of sorted) {
    const id = item.comment.id;
    const target = item.target;
    if (!target || !document.contains(target)) {
      continue;
    }

    const rect = target.getBoundingClientRect();
    const isVisible = rect.bottom >= 0 && rect.top <= window.innerHeight;
    if (!isVisible) {
      continue;
    }

    const card = buildAlignedCard(item.comment);
    UI.alignedLayer.appendChild(card);

    const alignedViewportTop = computeAlignedViewportTop(item, anchorLineRangesByTarget);
    const desiredTop = alignedViewportTop - layerRect.top - 8;
    let top = Math.max(0, desiredTop);
    top = Math.max(top, previousBottom + 8);
    if (top >= layerHeight - 24) {
      card.remove();
      continue;
    }

    card.style.left = "0px";
    card.style.top = `${top}px`;
    UI.alignedCardById.set(id, card);
    previousBottom = top + card.offsetHeight;

    if (previousBottom >= layerHeight - 8) {
      break;
    }
  }
}

function buildAlignedCard(comment) {
  const card = document.createElement("div");
  card.className = "mdc-aligned-comment";
  card.dataset.commentId = String(comment.id);
  card.innerHTML = [
    `<div class="mdc-aligned-head">${escapeHtml(comment.path || "Unknown file")} ${escapeHtml(formatCommentLine(comment))}</div>`,
    `<div class="mdc-aligned-body">${escapeHtml(trimPreview((comment.body || "").replace(/\s+/g, " ").trim(), 220))}</div>`,
    `<div class="mdc-aligned-meta">${escapeHtml(comment.user || "unknown")} • ${escapeHtml(formatTimestamp(comment.createdAt))}</div>`
  ].join("");
  return card;
}

function buildAnchorLineRangesByTarget(items) {
  const ranges = new Map();
  if (!Array.isArray(items) || items.length === 0) {
    return ranges;
  }

  for (const item of items) {
    if (!item || !item.target || !item.debug || item.debug.reason !== "anchorMatch") {
      continue;
    }

    const lineHint = getCommentLineHint(item.comment);
    if (lineHint <= 0) {
      continue;
    }

    const current = ranges.get(item.target);
    if (!current) {
      ranges.set(item.target, { min: lineHint, max: lineHint });
      continue;
    }

    if (lineHint < current.min) {
      current.min = lineHint;
    }
    if (lineHint > current.max) {
      current.max = lineHint;
    }
  }

  return ranges;
}

function computeAlignedViewportTop(item, rangesByTarget) {
  const target = item && item.target;
  if (!target) {
    return Number.POSITIVE_INFINITY;
  }

  const rect = target.getBoundingClientRect();
  let top = rect.top;

  if (!item.debug || item.debug.reason !== "anchorMatch") {
    return top;
  }

  const lineHint = getCommentLineHint(item.comment);
  const range = rangesByTarget ? rangesByTarget.get(target) : null;
  if (!range || range.max <= range.min || lineHint <= 0) {
    return top;
  }

  const ratio = (lineHint - range.min) / (range.max - range.min);
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const usableHeight = Math.max(0, rect.height - 16);
  top = rect.top + clampedRatio * usableHeight;
  return top;
}

function getCommentLineHint(comment) {
  if (!comment) {
    return 0;
  }
  return Number(comment.line || comment.startLine || comment.originalLine || comment.originalStartLine || 0);
}

function scheduleAlignedLayout() {
  window.clearTimeout(UI.sidebarSyncTimer);
  UI.sidebarSyncTimer = window.setTimeout(() => {
    layoutAlignedComments();
  }, 50);
}

function formatCommentLine(comment) {
  const startLine = Number(comment.startLine || comment.originalStartLine || 0);
  const line = Number(comment.line || comment.originalLine || 0);
  if (startLine > 0 && line > 0 && startLine !== line) {
    return `L${startLine}-L${line}`;
  }
  if (line > 0) {
    return `L${line}`;
  }
  if (startLine > 0) {
    return `L${startLine}`;
  }
  return "(no line)";
}

function formatTimestamp(value) {
  if (!value) {
    return "unknown time";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }

  return date.toLocaleString();
}

function jumpToSidebarComment(comment) {
  if (!comment || !comment.path) {
    notify("Comment does not include a file path.", "error");
    return;
  }

  let target = UI.sidebarTargetById.get(comment.id) || null;
  if (target && !document.contains(target)) {
    target = null;
  }

  if (!target) {
    target = findCommentTargetElement(comment);
    if (target) {
      UI.sidebarTargetById.set(comment.id, target);
    }
  }

  if (!target) {
    notify(`Could not locate rendered target for ${comment.path}.`, "error");
    return;
  }

  target.scrollIntoView({ behavior: "smooth", block: "center" });
  flashElement(target);
}

function findCommentTargetElement(comment) {
  return diagnoseCommentTarget(comment).target;
}

function diagnoseCommentTarget(comment) {
  const result = {
    commentId: comment && comment.id ? comment.id : null,
    path: normalizePathKey(comment && comment.path ? comment.path : ""),
    line: comment && comment.line ? Number(comment.line) : null,
    startLine: comment && comment.startLine ? Number(comment.startLine) : null,
    originalLine: comment && comment.originalLine ? Number(comment.originalLine) : null,
    originalStartLine: comment && comment.originalStartLine ? Number(comment.originalStartLine) : null,
    lineCandidate: 0,
    treeAnchorId: "",
    treeAnchorLoaded: false,
    fileRoot: "",
    lineTarget: "",
    anchorTarget: "",
    finalTarget: "",
    reason: "unknown",
    preview: trimPreview(((comment && comment.body) || "").replace(/\s+/g, " ").trim(), 140),
    target: null
  };

  if (!comment || !comment.path) {
    result.reason = "missingPath";
    return result;
  }

  const currentLineCandidate = Number(comment.line || comment.startLine || 0);
  result.lineCandidate = currentLineCandidate;
  if (isRichDiffMode() && currentLineCandidate <= 0) {
    result.reason = "outdatedNoCurrentLineInRich";
    return result;
  }

  const treeAnchorId = findTreeDiffAnchorIdByPath(result.path);
  result.treeAnchorId = treeAnchorId || "";
  if (treeAnchorId) {
    const escaped = safeCssEscape(treeAnchorId);
    result.treeAnchorLoaded = Boolean(
      document.getElementById(treeAnchorId) || (escaped && document.querySelector(`[data-diff-anchor="${escaped}"]`))
    );
  }

  const fileRoot = findFileRootByPath(comment.path);
  if (!fileRoot) {
    result.reason = "fileRootNotFound";
    return result;
  }
  result.fileRoot = describeElementForDebug(fileRoot);

  if (currentLineCandidate > 0) {
    const lineTarget = findLineElementInFile(fileRoot, currentLineCandidate);
    if (lineTarget) {
      result.lineTarget = describeElementForDebug(lineTarget);
      result.finalTarget = result.lineTarget;
      result.reason = "lineMatchCurrent";
      result.target = lineTarget;
      return result;
    }
  }

  const renderedTarget = findRenderedAnchorElement(fileRoot, comment.anchorText || "");
  if (renderedTarget) {
    result.anchorTarget = describeElementForDebug(renderedTarget);
    result.finalTarget = result.anchorTarget;
    result.reason = "anchorMatch";
    result.target = renderedTarget;
    return result;
  }

  if (currentLineCandidate > 0) {
    result.reason = "currentLineNotFound";
  } else if (Number(comment.originalLine || comment.originalStartLine || 0) > 0) {
    result.reason = "outdatedNoCurrentLine";
  } else {
    result.reason = "noLineInfo";
  }
  result.target = null;
  return result;
}

function describeElementForDebug(element) {
  if (!element) {
    return "";
  }

  const parts = [];
  parts.push(String(element.tagName || "").toLowerCase());

  if (element.id) {
    parts.push(`#${String(element.id).slice(0, 120)}`);
  }

  if (element.classList && element.classList.length > 0) {
    parts.push(`.${Array.from(element.classList).slice(0, 4).join(".")}`);
  }

  const attrs = [];
  const dataFilePath = element.getAttribute("data-file-path");
  const dataPath = element.getAttribute("data-path");
  const dataTagPath = element.getAttribute("data-tagsearch-path");
  const dataLine = element.getAttribute("data-line-number");
  const dataDiffAnchor = element.getAttribute("data-diff-anchor");
  if (dataFilePath) {
    attrs.push(`data-file-path=${dataFilePath}`);
  }
  if (dataPath) {
    attrs.push(`data-path=${dataPath}`);
  }
  if (dataTagPath) {
    attrs.push(`data-tagsearch-path=${dataTagPath}`);
  }
  if (dataLine) {
    attrs.push(`data-line-number=${dataLine}`);
  }
  if (dataDiffAnchor) {
    attrs.push(`data-diff-anchor=${dataDiffAnchor}`);
  }

  if (attrs.length > 0) {
    parts.push(`[${attrs.join(" ")}]`);
  }

  return parts.join("");
}

function findRenderedAnchorElement(fileRoot, anchorText) {
  const anchor = normalizeRenderText(anchorText);
  if (!anchor) {
    return null;
  }

  const selector = [
    ".markdown-body p",
    ".markdown-body li",
    ".markdown-body h1",
    ".markdown-body h2",
    ".markdown-body h3",
    ".markdown-body h4",
    ".markdown-body h5",
    ".markdown-body h6",
    ".markdown-body blockquote",
    ".markdown-body td",
    ".markdown-body pre",
    ".rich-diff-level-zero",
    ".rich-diff-level-one"
  ].join(", ");

  const candidates = Array.from(fileRoot.querySelectorAll(selector));
  let bestElement = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    if (!isVisibleElement(candidate)) {
      continue;
    }

    const normalized = normalizeRenderText(candidate.textContent || "");
    if (!normalized) {
      continue;
    }

    const score = scoreRenderAnchor(anchor, normalized);
    if (score > bestScore) {
      bestScore = score;
      bestElement = candidate;
      if (score >= 0.99) {
        break;
      }
    }
  }

  if (bestScore < 0.24) {
    return null;
  }

  return bestElement;
}

function isVisibleElement(element) {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (!style || style.visibility === "hidden" || style.display === "none") {
    return false;
  }

  return true;
}

function normalizeRenderText(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreRenderAnchor(anchor, candidate) {
  if (!anchor || !candidate) {
    return 0;
  }

  if (candidate.includes(anchor)) {
    return 1;
  }

  if (anchor.includes(candidate)) {
    return Math.max(0.35, candidate.length / Math.max(anchor.length, 1));
  }

  const anchorTokens = new Set(anchor.split(/\s+/).filter(Boolean));
  const candidateTokens = new Set(candidate.split(/\s+/).filter(Boolean));
  const overlap = tokenOverlapRatio(anchorTokens, candidateTokens);
  const lengthPenalty = 1 - Math.min(0.55, Math.abs(candidate.length - anchor.length) / Math.max(anchor.length, 1));
  return overlap * 0.8 + lengthPenalty * 0.2;
}

function tokenOverlapRatio(a, b) {
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

function getAbsoluteTop(element) {
  const rect = element.getBoundingClientRect();
  return window.scrollY + rect.top;
}

function attachSidebarScrollSync() {
  if (UI.sidebarScrollHandler) {
    return;
  }

  UI.sidebarScrollHandler = () => {
    scheduleAlignedLayout();
  };

  window.addEventListener("scroll", UI.sidebarScrollHandler, { passive: true });
  window.addEventListener("resize", UI.sidebarScrollHandler, { passive: true });
}

function detachSidebarScrollSync() {
  if (!UI.sidebarScrollHandler) {
    return;
  }

  window.removeEventListener("scroll", UI.sidebarScrollHandler);
  window.removeEventListener("resize", UI.sidebarScrollHandler);
  UI.sidebarScrollHandler = null;
  window.clearTimeout(UI.sidebarSyncTimer);
  UI.sidebarSyncTimer = null;
}

function findFileRootByPath(path) {
  const normalizedTarget = normalizePathKey(path);
  const safePath = safeCssEscape(path);
  if (safePath) {
    const direct = document.querySelector(`[data-file-path="${safePath}"]`);
    if (direct) {
      return direct;
    }
  }

  const normalizedEscaped = safeCssEscape(normalizedTarget);
  if (normalizedEscaped && normalizedEscaped !== safePath) {
    const directNormalized = document.querySelector(`[data-file-path="${normalizedEscaped}"]`);
    if (directNormalized) {
      return directNormalized;
    }
  }

  const candidates = document.querySelectorAll("[data-file-path], [data-path], .file, .js-file, .js-file-content, .blob-wrapper");
  let suffixMatch = null;
  let basenameMatch = null;
  const targetBase = baseName(normalizedTarget);

  for (const candidate of candidates) {
    const details = extractFileDetailsFromRoot(candidate);
    if (!details || !details.path) {
      continue;
    }

    const candidatePath = normalizePathKey(details.path);
    if (!candidatePath) {
      continue;
    }

    if (candidatePath === normalizedTarget) {
      return candidate;
    }

    if (!suffixMatch && (candidatePath.endsWith(`/${normalizedTarget}`) || normalizedTarget.endsWith(`/${candidatePath}`))) {
      suffixMatch = candidate;
    }

    if (!basenameMatch && targetBase && baseName(candidatePath) === targetBase) {
      basenameMatch = candidate;
    }
  }

  if (suffixMatch) {
    return suffixMatch;
  }

  if (basenameMatch) {
    return basenameMatch;
  }

  const treeAnchorId = findTreeDiffAnchorIdByPath(normalizedTarget);
  if (treeAnchorId) {
    const byId = document.getElementById(treeAnchorId);
    if (byId) {
      return byId;
    }

    const escapedAnchor = safeCssEscape(treeAnchorId);
    const table = escapedAnchor ? document.querySelector(`[data-diff-anchor="${escapedAnchor}"]`) : null;
    if (table) {
      const tableRoot = table.closest(
        "[id^='diff-'], [data-file-path], [data-path], .file, .js-file, .js-file-content, .blob-wrapper"
      );
      if (tableRoot) {
        return tableRoot;
      }
      return table;
    }

    const lineProbe = escapedAnchor ? document.querySelector(`[id^="${escapedAnchor}R"]`) : null;
    if (lineProbe) {
      return lineProbe.closest(
        "[id^='diff-'], [data-file-path], [data-path], .file, .js-file, .js-file-content, .blob-wrapper"
      );
    }
  }

  return null;
}

function findTreeDiffAnchorIdByPath(path) {
  const normalizedTarget = normalizePathKey(path);
  if (!normalizedTarget) {
    return "";
  }

  const pathNodes = document.querySelectorAll("[data-filterable-item-text]");
  for (const node of pathNodes) {
    const text = normalizePathKey((node.textContent || "").trim());
    if (!text || text !== normalizedTarget) {
      continue;
    }

    const row = node.closest("li, [role='treeitem'], .ActionList-item");
    if (!row) {
      continue;
    }

    const link = row.querySelector("a[href^='#diff-']");
    if (!link) {
      continue;
    }

    const href = String(link.getAttribute("href") || "").trim();
    if (!href.startsWith("#")) {
      continue;
    }

    return href.slice(1);
  }

  let basenameFallback = "";
  const headerLinks = document.querySelectorAll("a[href^='#diff-'][title]");
  for (const link of headerLinks) {
    const href = String(link.getAttribute("href") || "").trim();
    if (!href.startsWith("#")) {
      continue;
    }

    const anchorId = href.slice(1);
    if (!isLikelyFileDiffAnchorId(anchorId)) {
      continue;
    }

    const titlePath = normalizePathKey(link.getAttribute("title") || "");
    if (!titlePath) {
      continue;
    }

    if (titlePath === normalizedTarget) {
      return anchorId;
    }

    if (!basenameFallback && baseName(titlePath) === baseName(normalizedTarget)) {
      basenameFallback = anchorId;
    }
  }

  if (basenameFallback) {
    return basenameFallback;
  }

  let textFallback = "";
  const anyDiffLinks = document.querySelectorAll("a[href^='#diff-']");
  for (const link of anyDiffLinks) {
    const href = String(link.getAttribute("href") || "").trim();
    if (!href.startsWith("#")) {
      continue;
    }

    const anchorId = href.slice(1);
    if (!isLikelyFileDiffAnchorId(anchorId)) {
      continue;
    }

    const text = normalizePathKey((link.textContent || "").trim());
    if (!text) {
      continue;
    }

    if (text === normalizedTarget) {
      return anchorId;
    }

    if (!textFallback && baseName(text) === baseName(normalizedTarget)) {
      textFallback = anchorId;
    }
  }

  if (textFallback) {
    return textFallback;
  }

  return "";
}

function findLineElementInFile(fileRoot, line) {
  const lineNumber = Number(line);
  if (!lineNumber || !fileRoot) {
    return null;
  }

  const selectors = [
    `[data-line-number="${lineNumber}"]`,
    `td[data-line-number="${lineNumber}"]`,
    `tr[data-line-number="${lineNumber}"]`,
    `[id$="R${lineNumber}"]`,
    `[id$="L${lineNumber}"]`,
    `[data-source-line="${lineNumber}"]`
  ];

  for (const selector of selectors) {
    const match = fileRoot.querySelector(selector);
    if (match) {
      return match;
    }
  }

  return null;
}

function normalizePathKey(path) {
  if (!path) {
    return "";
  }

  let key = String(path).trim();
  try {
    key = decodeURIComponent(key);
  } catch (_) {
    // Keep raw key if decode fails.
  }

  key = key.replace(/^\/+/, "");
  key = key.replace(/^[ab]\//, "");
  key = key.replace(/\\/g, "/");
  key = key.replace(/\/+/g, "/");
  return key;
}

function baseName(path) {
  if (!path) {
    return "";
  }
  const parts = String(path).split("/");
  return parts[parts.length - 1] || "";
}

function flashElement(element) {
  if (!element) {
    return;
  }

  element.classList.add("mdc-flash-target");
  window.setTimeout(() => {
    element.classList.remove("mdc-flash-target");
  }, 1400);
}

function safeCssEscape(value) {
  if (!value) {
    return "";
  }

  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

function onKeyUp(event) {
  if (!isPullFilesPage()) {
    hideButton();
    removeComposer();
    UI.activeSelection = null;
    return;
  }

  if (event.key === "Escape") {
    cleanupUi();
  }
}

function onMouseUp(event) {
  if (!isPullFilesPage()) {
    cleanupUi();
    return;
  }

  scheduleSelectionEvaluation(event.target);
}

function onSelectionChange() {
  if (!isPullFilesPage()) {
    return;
  }
  scheduleSelectionEvaluation(document.activeElement);
}

function scheduleSelectionEvaluation(target) {
  window.clearTimeout(UI.selectionTimer);
  UI.selectionTimer = window.setTimeout(() => {
    if (isEditableTarget(target)) {
      hideButton();
      return;
    }

    const selectionData = readSelection();
    if (!selectionData) {
      hideButton();
      return;
    }

    UI.activeSelection = selectionData;
    showButton(selectionData.rect);
  }, 25);
}

function readSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const text = selection.toString().trim();
  if (text.length < 3) {
    return null;
  }

  const range = selection.getRangeAt(0);

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }

  const fileDetails = findFileDetailsForRange(range, rect);
  if (!isLikelyDiffSelection(range, fileDetails)) {
    return null;
  }

  const pr = readPullContext();
  if (!pr) {
    return null;
  }

  return {
    owner: pr.owner,
    repo: pr.repo,
    pullNumber: pr.pullNumber,
    path: fileDetails && fileDetails.path ? fileDetails.path : "",
    diffAnchor: fileDetails && fileDetails.diffAnchor ? fileDetails.diffAnchor : "",
    selectedText: text,
    rect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    }
  };
}

function showButton(rect) {
  if (!UI.button) {
    UI.button = document.createElement("button");
    UI.button.type = "button";
    UI.button.className = "mdc-comment-btn";
    UI.button.textContent = "Comment";
    UI.button.addEventListener("click", openComposer);
    document.body.appendChild(UI.button);
  }

  UI.button.style.top = `${Math.max(8, rect.top + window.scrollY - 34)}px`;
  UI.button.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  UI.button.style.display = "inline-flex";
}

function hideButton() {
  if (UI.button) {
    UI.button.style.display = "none";
  }
}

async function openComposer(event) {
  event.preventDefault();
  event.stopPropagation();

  if (!UI.activeSelection) {
    return;
  }

  hideButton();
  removeComposer();

  const composer = document.createElement("div");
  composer.className = "mdc-composer";
  composer.innerHTML = [
    '<div class="mdc-composer-header">Add PR comment</div>',
    `<div class="mdc-selection">${escapeHtml(trimPreview(UI.activeSelection.selectedText, 220))}</div>`,
    '<textarea class="mdc-text" placeholder="Write comment"></textarea>',
    '<div class="mdc-anchor-status">Resolving anchor in diff...</div>',
    '<div class="mdc-candidates"></div>',
    '<div class="mdc-actions">',
    '  <button type="button" class="mdc-cancel">Cancel</button>',
    '  <button type="button" class="mdc-submit" disabled>Post comment</button>',
    '</div>'
  ].join("");

  document.body.appendChild(composer);
  positionComposer(composer, UI.activeSelection.rect);

  const textArea = composer.querySelector(".mdc-text");
  const status = composer.querySelector(".mdc-anchor-status");
  const candidatesEl = composer.querySelector(".mdc-candidates");
  const submitButton = composer.querySelector(".mdc-submit");
  const cancelButton = composer.querySelector(".mdc-cancel");

  let chosen = null;
  let candidates = [];

  cancelButton.addEventListener("click", () => {
    removeComposer();
    clearSelection();
  });

  submitButton.addEventListener("click", async () => {
    const body = textArea.value.trim();
    if (!body) {
      notify("Comment text is empty.", "error");
      return;
    }

    if (!chosen) {
      notify("Pick a mapped location first.", "error");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Posting...";

    const payload = {
      owner: UI.activeSelection.owner,
      repo: UI.activeSelection.repo,
      pullNumber: UI.activeSelection.pullNumber,
      path: chosen.path || UI.activeSelection.path,
      body,
      line: chosen.line,
      side: chosen.side,
      startLine: chosen.startLine
    };

    try {
      const response = await sendMessage({ type: "postComment", payload });
      if (!response.ok) {
        throw new Error(response.error || "Failed to post comment.");
      }

      notify("Comment posted.", "ok");
      if (UI.sidebarEnabled) {
        const pr = readPullContext();
        if (pr) {
          void loadSidebarComments(pr, { forceRefresh: true });
        }
      }
      removeComposer();
      clearSelection();
    } catch (error) {
      notify(stringifyError(error), "error");
      submitButton.disabled = false;
      submitButton.textContent = "Post comment";
    }
  });

  UI.composer = composer;

  try {
    if (!UI.activeSelection.path) {
      const inferred = inferFileDetailsForSelection(UI.activeSelection);
      if (inferred && inferred.path) {
        UI.activeSelection.path = inferred.path;
        if (inferred.diffAnchor) {
          UI.activeSelection.diffAnchor = inferred.diffAnchor;
        }
      }
    }

    const response = await sendMessage({
      type: "resolveAnchor",
      payload: {
        owner: UI.activeSelection.owner,
        repo: UI.activeSelection.repo,
        pullNumber: UI.activeSelection.pullNumber,
        path: UI.activeSelection.path || undefined,
        selectedText: UI.activeSelection.selectedText
      }
    });

    if (!response.ok) {
      throw new Error(response.error || "Failed to resolve anchor.");
    }

    candidates = Array.isArray(response.candidates) ? response.candidates : [];
    if (!candidates.length) {
      throw new Error("No anchor candidates returned.");
    }

    chosen = candidates[0];
    if (chosen.path) {
      UI.activeSelection.path = chosen.path;
    }
    if (shouldShowCandidateChooser(candidates)) {
      renderCandidates(candidatesEl, candidates, chosen, (next) => {
        chosen = next;
        submitButton.disabled = false;
      });
    } else {
      candidatesEl.innerHTML = "";
    }

    submitButton.disabled = false;
    status.textContent = `Mapped to ${chosen.path || UI.activeSelection.path || "detected file"}`;
  } catch (error) {
    const message = stringifyError(error);
    status.innerHTML = [
      `<span class="mdc-error">${escapeHtml(message)}</span>`,
      `<a class="mdc-source-link" href="${buildSourceLink(UI.activeSelection)}" target="_blank" rel="noreferrer">Open source view</a>`
    ].join(" ");
    submitButton.disabled = true;
  }

  UI.outsideHandler = (outsideEvent) => {
    if (!UI.composer) {
      return;
    }

    const node = outsideEvent.target;
    if (UI.composer.contains(node) || (UI.button && UI.button.contains(node))) {
      return;
    }

    removeComposer();
  };

  document.addEventListener("mousedown", UI.outsideHandler);
}

function renderCandidates(container, candidates, activeCandidate, onSelect) {
  container.innerHTML = "";

  const list = document.createElement("div");
  list.className = "mdc-candidate-list";
  container.appendChild(list);

  const radiosName = `mdc-anchor-${Date.now()}`;

  candidates.forEach((candidate, idx) => {
    const id = `${radiosName}-${idx}`;
    const label = document.createElement("label");
    label.className = "mdc-candidate";
    label.setAttribute("for", id);

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = radiosName;
    radio.id = id;
    radio.checked = candidate === activeCandidate;

    const lineInfo = candidate.startLine && candidate.startLine !== candidate.line
      ? `L${candidate.startLine}-L${candidate.line}`
      : `L${candidate.line}`;
    const prefix = candidate.path ? `${candidate.path} ${lineInfo}` : lineInfo;

    const text = document.createElement("span");
    text.className = "mdc-candidate-text";
    text.textContent = `${prefix} (${Math.round(candidate.score * 100)}%): ${candidate.preview}`;

    radio.addEventListener("change", () => {
      onSelect(candidate);
    });

    label.appendChild(radio);
    label.appendChild(text);
    list.appendChild(label);
  });
}

function shouldShowCandidateChooser(candidates) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return false;
  }

  const top = candidates[0];
  const second = candidates[1];
  if (!top || !second) {
    return false;
  }

  const scoreGap = top.score - second.score;
  if ((top.path || "") !== (second.path || "")) {
    return scoreGap < 0.2;
  }

  return scoreGap < 0.12;
}

function positionComposer(composer, rect) {
  const maxWidth = 420;
  const margin = 12;
  const top = rect.top + window.scrollY + rect.height + margin;
  const left = Math.min(
    window.scrollX + window.innerWidth - maxWidth - margin,
    Math.max(window.scrollX + margin, rect.left + window.scrollX)
  );

  composer.style.top = `${top}px`;
  composer.style.left = `${left}px`;
}

function removeComposer() {
  if (UI.outsideHandler) {
    document.removeEventListener("mousedown", UI.outsideHandler);
    UI.outsideHandler = null;
  }

  if (UI.composer) {
    UI.composer.remove();
    UI.composer = null;
  }
}

function clearSelection() {
  UI.activeSelection = null;
  hideButton();
}

function cleanupUi() {
  window.clearTimeout(UI.selectionTimer);
  hideButton();
  removeComposer();
  clearSelection();
}

function ensureBadge() {
  if (UI.badge) {
    UI.badge.style.display = "inline-flex";
    return;
  }

  UI.badge = document.createElement("div");
  UI.badge.className = "mdc-badge";
  UI.badge.textContent = "MDC active";
  document.body.appendChild(UI.badge);
}

function removeBadge() {
  if (!UI.badge) {
    return;
  }
  UI.badge.remove();
  UI.badge = null;
}

function notify(message, kind = "ok") {
  if (!UI.toast) {
    UI.toast = document.createElement("div");
    UI.toast.className = "mdc-toast";
    document.body.appendChild(UI.toast);
  }

  UI.toast.textContent = message;
  UI.toast.classList.toggle("is-error", kind === "error");
  UI.toast.classList.toggle("is-ok", kind !== "error");
  UI.toast.classList.add("is-visible");

  window.clearTimeout(notify._timer);
  notify._timer = window.setTimeout(() => {
    if (UI.toast) {
      UI.toast.classList.remove("is-visible");
    }
  }, 3500);
}

function readPullContext() {
  const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    pullNumber: Number(match[3])
  };
}

function isPullFilesPage() {
  if (!location.hostname.endsWith("github.com")) {
    return false;
  }

  if (!location.pathname.includes("/pull/")) {
    return false;
  }

  return location.pathname.includes("/files") || location.pathname.includes("/changes") || location.search.includes("diff=");
}

function isRichDiffMode() {
  const renderedSelected = document.querySelector(".js-rendered.selected, .js-rendered[aria-current='true']");
  if (renderedSelected) {
    return true;
  }

  const hasRichContent = Boolean(
    document.querySelector(
      "#files .rich-diff-level-zero, #files .rich-diff-level-one, #files .markdown-body, #files markdown-accessiblity-table"
    )
  );
  if (hasRichContent) {
    return true;
  }

  const sourceSelected = document.querySelector(".js-source.selected, .js-source[aria-current='true']");
  if (sourceSelected) {
    return false;
  }

  if (location.search.includes("diff=unified") || location.search.includes("diff=split")) {
    return false;
  }

  const filesRoot = document.querySelector("#files");
  if (!filesRoot) {
    return false;
  }

  return Boolean(filesRoot.querySelector(".markdown-body, .rich-diff-level-zero, .rich-diff-level-one"));
}

function isEditableTarget(target) {
  const element = target instanceof Element ? target : null;
  if (!element) {
    return false;
  }

  return Boolean(
    element.closest("input, textarea, select, button, [contenteditable=''], [contenteditable='true']")
  );
}

function isLikelyDiffSelection(range, fileDetails) {
  if (fileDetails && fileDetails.path) {
    return true;
  }

  const node = range.commonAncestorContainer || range.startContainer;
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) {
    return false;
  }

  if (element.closest(".mdc-composer, .mdc-comment-btn, .mdc-toast")) {
    return false;
  }

  return Boolean(
    element.closest(
      ".file, .js-file, [data-file-path], [id^='diff-'], .blob-wrapper, .js-file-content, .markdown-body, .react-code-text"
    )
  );
}

function findFileDetailsForRange(range, rect) {
  const byStart = findFileDetailsFromNode(range.startContainer);
  if (byStart && byStart.path) {
    return byStart;
  }

  const byCommon = findFileDetailsFromNode(range.commonAncestorContainer);
  if (byCommon && byCommon.path) {
    return byCommon;
  }

  return findFileDetailsNearRect(rect);
}

function findFileDetailsFromNode(node) {
  let element = node instanceof Element ? node : node.parentElement;

  while (element) {
    if (element.closest(".mdc-composer, .mdc-comment-btn, .mdc-toast")) {
      return null;
    }

    const fileRoot = element.closest("[data-file-path], .file, .js-file, .js-file-content, .blob-wrapper");
    if (!fileRoot) {
      break;
    }

    const details = extractFileDetailsFromRoot(fileRoot);
    if (details && details.path) {
      return details;
    }

    element = fileRoot.parentElement;
  }

  return null;
}

function findFileDetailsNearRect(rect) {
  const probeX = Math.max(0, rect.left + Math.min(12, rect.width / 2));
  const probeY = Math.max(0, rect.top + Math.min(12, rect.height / 2));
  const elements = document.elementsFromPoint(probeX, probeY);

  for (const element of elements) {
    const fileRoot = element.closest("[data-file-path], .file, .js-file, .js-file-content, .blob-wrapper");
    if (!fileRoot) {
      continue;
    }

    const details = extractFileDetailsFromRoot(fileRoot);
    if (details && details.path) {
      return details;
    }
  }

  const files = Array.from(document.querySelectorAll("[data-file-path]"));
  for (const file of files) {
    const rectFile = file.getBoundingClientRect();
    const withinX = probeX >= rectFile.left && probeX <= rectFile.right;
    const withinY = probeY >= rectFile.top && probeY <= rectFile.bottom;
    if (!withinX || !withinY) {
      continue;
    }

    const details = extractFileDetailsFromRoot(file);
    if (details && details.path) {
      return details;
    }
  }

  if (files.length === 1) {
    const details = extractFileDetailsFromRoot(files[0]);
    if (details && details.path) {
      return details;
    }
  }

  return null;
}

function inferFileDetailsForSelection(selection) {
  if (selection.path) {
    return { path: selection.path, diffAnchor: selection.diffAnchor || "" };
  }

  if (selection.rect) {
    const near = findFileDetailsNearRect(selection.rect);
    if (near && near.path) {
      return near;
    }
  }

  const all = collectAllFileDetails();
  if (all.length === 1) {
    return all[0];
  }

  return null;
}

function collectAllFileDetails() {
  const roots = Array.from(document.querySelectorAll("[data-file-path], .file, .js-file, .js-file-content"));
  const unique = new Map();

  for (const root of roots) {
    const details = extractFileDetailsFromRoot(root);
    if (!details || !details.path) {
      continue;
    }
    if (!unique.has(details.path)) {
      unique.set(details.path, details);
    }
  }

  return Array.from(unique.values());
}

function extractFileDetailsFromRoot(fileRoot) {
  if (!fileRoot) {
    return null;
  }

  const diffAnchor = fileRoot.id || "";
  const direct = fileRoot.getAttribute("data-file-path") || fileRoot.dataset.filePath;
  if (direct) {
    return { path: direct, diffAnchor };
  }

  const ownDataPath = fileRoot.getAttribute("data-path") || fileRoot.dataset.path;
  if (ownDataPath) {
    return { path: ownDataPath, diffAnchor };
  }

  const nestedDataPath = fileRoot.querySelector("[data-path]");
  if (nestedDataPath) {
    const value = nestedDataPath.getAttribute("data-path");
    if (value) {
      return { path: value, diffAnchor };
    }
  }

  const titledLink = fileRoot.querySelector(".file-info a[title], a[title][data-pjax]");
  if (titledLink) {
    const title = titledLink.getAttribute("title");
    if (title) {
      return { path: title, diffAnchor };
    }
  }

  const primaryLink = fileRoot.querySelector(".file-info a.Link--primary, .file-info a.Link--secondary");
  if (primaryLink) {
    const text = (primaryLink.textContent || "").trim();
    if (text && text.includes("/")) {
      return { path: text, diffAnchor };
    }
  }

  const breadcrumb = fileRoot.querySelector(".file-header [title], .js-path-segment");
  if (breadcrumb) {
    const text = (breadcrumb.getAttribute("title") || breadcrumb.textContent || "").trim();
    if (text && text.includes("/")) {
      return { path: text, diffAnchor };
    }
  }

  const tagPath = fileRoot.getAttribute("data-tagsearch-path");
  if (tagPath) {
    return { path: tagPath, diffAnchor };
  }

  return null;
}

function buildSourceLink(selection) {
  const anchor = selection.diffAnchor ? `#${selection.diffAnchor}` : "";
  return `https://github.com/${selection.owner}/${selection.repo}/pull/${selection.pullNumber}/files?diff=unified${anchor}`;
}

function trimPreview(text, limit) {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 1)}...`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(normalizeRuntimeErrorMessage(chrome.runtime.lastError.message)));
        return;
      }

      resolve(response);
    });
  });
}

function normalizeRuntimeErrorMessage(message) {
  const text = String(message || "Unknown runtime error.");
  if (/extension context invalidated/i.test(text)) {
    return "Extension was reloaded. Refresh this GitHub tab and try again.";
  }
  return text;
}

function stringifyError(error) {
  if (!error) {
    return "Unknown error";
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
    return "Unknown error";
  }
}
