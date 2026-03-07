# SORA Prompt + Image Downloader (Chrome Extension)

Personal-use Chrome extension to scan the current page for generated images, then download:

- The image file (`item_0001.png`, etc.)
- A matching JSON sidecar with prompt + metadata (`item_0001.json`)
- Optional combined CSV (`prompts.csv`)

## Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `sora-downloader-extension`.

## Use

1. Open your SORA generations/history page.
2. Click the extension icon.
3. Scroll to load as many items as you want on screen.
4. Click **Scan Page**.
5. Set run options:
   - `Download mode`: `Safe` (recommended) or `Fast`
   - `Max items per run`
   - `Skip already downloaded` for resume behavior
   - `Organize by generation folders` to group pairs/singles together
   - `Export single ZIP file` to avoid many separate downloads
   - `Prefer PNG output` to convert WEBP/JPEG to PNG when possible
6. Optionally change folder prefix or disable CSV/manifest export.
7. Click **Download All**.
8. If needed, click **Retry Failed Only**.

Files are saved into your default Chrome downloads folder under the selected prefix, such as:

- `SORA_EXPORT/<task_or_title>/img_01.webp`
- `SORA_EXPORT/<task_or_title>/img_01.json`
- `SORA_EXPORT/<task_or_title>/prompt.txt`
- `SORA_EXPORT/<task_or_title>/metadata.json`
- `SORA_EXPORT/prompts.csv`

If `Export single ZIP file` is enabled, you get one archive like:

- `SORA_EXPORT/SORA_EXPORT_YYYYMMDD_HHMMSS.zip`

## Notes

- Prompt extraction is tuned for SORA grid cards and nearby metadata blocks.
- Grid view: the extension reads visible cards and prompt/title text in the same record block.
- Detail view (`/g/gen_...`): the extension can scan that page too.
- High-res behavior: it tries ranked image candidates (`srcset`, `currentSrc`, `src`) and falls back automatically if a URL fails.
- Resume behavior: "Skip already downloaded" uses an internal key ledger in extension storage (`detailUrl`/`imageUrl` identity), so reruns can continue without reprocessing known items.
- Manifest output: each run can write `manifest_YYYYMMDD_HHMMSS.json` with stats + failures.
- If SORA UI changes, update selectors in `content.js`:
  - `PROMPT_SELECTORS`
  - `CARD_SELECTORS`
- This extension is for your own account/content and should be used in line with platform terms.

## Recommended Backup Strategy

1. Keep `Auto-scroll while scanning` enabled.
2. Use `Safe` mode and run in chunks (for example `200-500` items per run).
3. Leave `Skip already downloaded` on.
4. Run `Retry Failed Only` after each chunk.
5. Repeat until no new items are found.
