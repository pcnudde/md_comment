# GitHub Rendered Diff Commenter (Private MV3)

Private Chrome extension for commenting on rendered Markdown diffs in GitHub PRs without switching to source view.

## What It Does

- Adds a `Comment` button when you select text in a GitHub PR rendered/rich diff.
- Maps the selected text to likely changed lines in the patch.
- Lets you pick the best line candidate.
- Posts a native GitHub PR review comment through the REST API.
- Supports inline replies from aligned sidebar comment cards.
- Shows existing thread replies inside each aligned comment card.

## Scope

- Target: personal/team internal use (unpacked extension).
- Supported pages: GitHub PR files/changes views.
- Best for Markdown/prose diffs.

## Install (Unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `/Users/pcnudde/prj/md_comment`.
5. Click the extension icon and open options (or use extension details -> options).

## Token Setup

1. Create a fine-grained PAT in GitHub.
2. Grant repo access to needed repositories.
3. Set minimum permissions:
   - `Pull requests`: Read and write
   - `Contents`: Read (optional fallback)
4. Paste token in options and click **Save**.
5. Click **Validate Token**.

## Use

1. Open a PR changed-files page in GitHub rendered/rich diff mode.
2. Highlight text in rendered Markdown.
3. Click `Comment`.
4. Review or switch the mapped line candidate.
5. Write comment and click **Post comment**.

### Optional Sidebar

The PR comments sidebar is enabled by default. You can disable it in extension options with `Enable optional PR comments sidebar in Files view`.
Use `Debug` in the sidebar to open a copyable mapping diagnostics panel.
Resolved PR review-thread comments are hidden from the sidebar/aligned rail.

## Project Files

- `/Users/pcnudde/prj/md_comment/manifest.json`
- `/Users/pcnudde/prj/md_comment/src/background.js`
- `/Users/pcnudde/prj/md_comment/src/content-script.js`
- `/Users/pcnudde/prj/md_comment/src/content-style.css`
- `/Users/pcnudde/prj/md_comment/src/options.html`
- `/Users/pcnudde/prj/md_comment/src/options.js`

## Run Tests

1. From `/Users/pcnudde/prj/md_comment`, run `npm test`.
2. This runs fixture-based regression tests for PR `NVIDIA/NVFlare#4196` comment/HTML shape.

## Notes and Limits

- Mapping from rendered text to patch lines is heuristic; repeated text can produce ambiguous candidates.
- Very large file diffs may omit `patch` in GitHub API; those cannot be auto-mapped.
- Token is stored in Chrome extension sync storage for convenience.
- Resolved-comment filtering requires GitHub review-thread access. If that lookup fails, comments are not shown.
