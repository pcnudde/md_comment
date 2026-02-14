const UI = {
  button: null,
  composer: null,
  toast: null,
  badge: null,
  activeSelection: null,
  outsideHandler: null,
  listenersActive: false,
  selectionTimer: null
};

init();

function init() {
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
    return;
  }

  if (!shouldEnable && UI.listenersActive) {
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("selectionchange", onSelectionChange);
    UI.listenersActive = false;
    removeBadge();
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
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
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
