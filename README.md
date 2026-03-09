# SORA Prompt + Image Downloader (Chrome Extension)

Personal-use Chrome extension that bulk-exports your SORA AI generations — images, prompts, presets, and reference images — into organized ZIP archives.

## Features

- **Auto-scroll scanning** — automatically scrolls through your SORA grid/list view to discover all generations, even 2000+ items
- **Live enrichment** — fetches prompts, preset details, and references from the SORA API while scanning (no waiting until the end)
- **Stall detection** — detects when SORA's lazy-loading stops and asks you to decide: "It's Done" or "Keep Scanning"
- **Spinner awareness** — waits for SORA's loading spinner before declaring a stall
- **Batched ZIP downloads** — splits large exports into manageable ZIP files (configurable batch size, default 300 items per ZIP)
- **Parallel image fetching** — downloads 5 images concurrently for significantly faster exports
- **Selective download mode** — overlay checkboxes on the SORA page to pick specific images
- **Export curation** — toggle inclusion of prompts, presets, and reference images
- **Organized folder structure** — each generation gets a numbered folder with its images, prompt, preset, metadata, and references
- **Pause / Cancel** — responsive controls during both scanning and downloading

## Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `sora-downloader-extension`.

## Usage

1. Navigate to your SORA generations page (grid or list view).
2. Click the extension icon — a detached popup window opens (stays open even if you click away).
3. Click **Scan Page** — the extension auto-scrolls and scans for generations.
   - Live enrichment fetches prompts, preset details, and references from the API as items are found.
   - If the scan stalls (no new items after several scrolls), you'll be prompted to stop or continue.
   - Use **Pause Scan** to temporarily halt scanning.
4. Once scanning finishes, click **Download All**.
5. ZIP files download automatically, one per batch.

### Selective Mode

1. After scanning, switch to **Selective** mode.
2. Checkboxes appear on each image on the SORA page.
3. Check the images you want, then click **Download All** — only selected items are exported.

## Export Settings

| Setting | Description |
|---------|-------------|
| **Organize by generation folders** | Groups images by generation into numbered folders |
| **Download mode** | `Safe` (more delay between requests) or `Fast` (quicker, more aggressive) |
| **Batch size** | Items per ZIP file (50–1000, default 300) |
| **Folder prefix** | Root folder name inside ZIPs (default: `SORA_EXPORT`) |
| **Include Prompts** | Export `prompt.txt` per generation |
| **Include Presets** | Export `preset.txt` per generation |
| **Include References** | Export reference/inpaint images per generation |

## Output Structure

When organized by generation, each batch ZIP extracts to:

```
SORA_EXPORT/
  0001_task_or_gen_id/
    img_0001.png
    prompt.txt
    preset.txt
    references.txt
    metadata.json
  0002_another_generation/
    img_0002.png
    prompt.txt
    metadata.json
  ...
```

Folders are numbered sequentially across batches, so extracting all ZIPs to the same location merges cleanly with no collisions.

## Architecture

- **popup.html / popup.js / popup.css** — Detached window UI with scan/download controls and settings
- **content.js** — Injected into SORA pages; handles DOM scanning, auto-scrolling, scroll container detection, and selection mode overlays
- **downloader.js** — Download engine with API enrichment, parallel image fetching, ZIP building, and batch management
- **background.js** — Minimal service worker that opens/focuses the popup window

The popup runs as a detached Chrome window (`chrome.windows.create`), giving it full DOM access and persistence. `downloader.js` and `popup.js` share the same window context, communicating via `CustomEvent` for progress updates.

## Notes

- Auth uses a Bearer token fetched from SORA's session endpoint — no manual token entry needed.
- Reference images (inpaint items) are resolved via the API since the grid DOM doesn't show them.
- Preset details (name, description, URL) are fetched from `/backend/presets/{id}` — the grid DOM only shows the button label, not the full preset info.
- The extension uses `unlimitedStorage` permission to avoid quota issues during large scans.
- If SORA's UI changes, update selectors in `content.js` (`PROMPT_SELECTORS`, `CARD_SELECTORS`).
- This extension is for your own account/content and should be used in line with platform terms.
