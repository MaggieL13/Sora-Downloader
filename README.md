# SORA Downloader — Bulk Export for SORA AI

> **Note:** SORA is shutting down on March 13, 2026. This tool was built to rescue your creative work before it's gone. If you have generations on SORA, use it now.

A Chrome extension that bulk-exports your entire SORA AI generation history — images, prompts, presets, and reference images — into organized ZIP archives. Built out of spite because the official data export never arrived. 💜

---

## What it does

SORA uses virtualized scrolling, meaning your thousands of images are never all loaded at once. This extension handles that by:

- **Auto-scrolling** through your entire grid or list view to discover all generations
- **Fetching metadata from the API** while scanning — prompts, preset names/descriptions, and reference images — so by the time scanning finishes, most enrichment is already done
- **Downloading in parallel** (5 concurrent fetches) into batched ZIP files
- **Organizing everything** into numbered folders with `prompt.txt`, `preset.txt`, `references/`, and `metadata.json` alongside each image

---

## Features

- Auto-scroll scanning — works on grid and list view, handles 2000+ items
- Live API enrichment during scan (prompts, preset details, reference images)
- Stall detection with user choice — "It's Done" / "Keep Scanning"
- SORA loading spinner awareness (waits instead of false-stalling)
- Batched ZIP downloads — configurable batch size, default 300 per ZIP
- 5 parallel image fetches — significantly faster than sequential
- Selective mode — checkboxes appear directly on image cards, no scan needed first
- Pause / Cancel during both scanning and downloading
- Clean numbered folder structure — extract all ZIPs to one folder, no collisions

---

## Install

This is an unpacked Chrome extension (not on the Web Store). Here's how to install it:

1. Download or clone this repo
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the `sora-downloader-extension` folder
6. The extension icon will appear in your toolbar

> **"Developer mode" sounds scary but it just means Chrome loads the extension from your local files instead of the store. Nothing sketchy — you can read every line of code right here.**

---

## Usage

### Bulk export (full history)

1. Go to `sora.chatgpt.com` and open your generations (grid or list view)
2. Click the extension icon — a popup window opens (stays open even if you click away)
3. Click **Scan Page** — the extension auto-scrolls and collects everything
4. When it stalls at the end, click **It's Done**
5. Click **Download All** — ZIP files start downloading automatically

### Selective download (pick specific images)

1. Click **Selective** in the popup — no scan needed
2. Checkboxes appear on every image card on the page
3. Scroll and check what you want — new cards get checkboxes automatically
4. Click **Download Selected**

---

## Output structure

All ZIPs extract into the same root folder with no collisions:

```
SORA_EXPORT/
  0001_task_01kj8ks06q.../
    img_0001.png
    prompt.txt
    preset.txt          ← if a preset was used
    references/
      reference_01.png  ← inpaint/reference images
    metadata.json
  0002_task_01kj8kh7gp.../
    img_0002.png
    img_0003.png        ← multiple images from same generation
    prompt.txt
    metadata.json
  ...
```

Each folder is numbered so batches merge cleanly — just extract all ZIPs to the same location.

---

## Settings

| Setting | Description |
|---------|-------------|
| **Organize by generation folders** | Groups images by generation (recommended) |
| **Download mode** | `Safe` (gentler on SORA's servers) or `Fast` |
| **Batch size** | Items per ZIP (50–1000, default 300) |
| **Folder prefix** | Root folder name (default: `SORA_EXPORT`) |
| **Include Prompts** | Saves `prompt.txt` per generation |
| **Include Presets** | Saves `preset.txt` with name + full description |
| **Include References** | Downloads inpaint/reference images |

---

## Notes

- No login or token setup needed — uses your existing browser session automatically
- Preset details (name, description) are fetched from the SORA API — the grid only shows the button label
- Reference images are resolved via API — they're not visible in the grid DOM
- Uses `unlimitedStorage` permission to handle large scan caches without quota errors
- This extension only accesses your own account data and sends nothing anywhere external
- For your own content only — use in line with platform terms

---

## Why does this exist

SORA promised a data export. It never came. The shutdown is in days.

This was built to fill that gap — if you've spent months generating images on SORA, you deserve to keep them. ☁️➡️💾
