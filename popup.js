let currentItems = [];
let lastFailedItems = [];
const STATE_KEY = "sora_popup_state_v1";

const scanBtn = document.getElementById("scanBtn");
const pauseScanBtn = document.getElementById("pauseScanBtn");
const downloadBtn = document.getElementById("downloadBtn");
const retryFailedBtn = document.getElementById("retryFailedBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const statusEl = document.getElementById("status");
const statusSpinnerEl = document.getElementById("statusSpinner");
const statusStateEl = document.getElementById("statusState");
const itemsList = document.getElementById("itemsList");
const csvToggle = document.getElementById("csvToggle");
const manifestToggle = document.getElementById("manifestToggle");
const imageJsonToggle = document.getElementById("imageJsonToggle");
const skipExistingToggle = document.getElementById("skipExistingToggle");
const organizeByGenerationToggle = document.getElementById("organizeByGenerationToggle");
const autoScrollToggle = document.getElementById("autoScrollToggle");
const downloadModeEl = document.getElementById("downloadMode");
const maxItemsEl = document.getElementById("maxItems");
const folderPrefixEl = document.getElementById("folderPrefix");
const exportSettingsBody = document.getElementById("exportSettingsBody");
const toggleExportSectionBtn = document.getElementById("toggleExportSectionBtn");
let activeScanInProgress = false;
let scanPaused = false;
let activeScanTabId = null;
let lastSnapshotAt = 0;
let snapshotInFlight = false;
let uiBusy = false;
let activeDownloadInProgress = false;

// ── Scan progress from content script (arrives via chrome.runtime messaging) ──
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "SORA_SCAN_PROGRESS") {
    if (!activeScanInProgress) return;
    const progress = message.progress || {};
    const step = Number(progress.step || 0);
    const maxSteps = Number(progress.maxSteps || 0);
    const found = Number(progress.found || 0);
    const stagnantRounds = Number(progress.stagnantRounds || 0);
    const stagnantLimit = Number(progress.stagnantLimit || 0);
    const y = Number(progress.scrollY || 0);
    setStatus(`Scanning... ${step}/${maxSteps} | found: ${found} | y: ${y}px | stalls: ${stagnantRounds}/${stagnantLimit}`, { state: "scan", busy: true });
    requestScanSnapshot();
  }
});

// ── Download/enrichment progress from downloader.js (same window, custom event) ──
window.addEventListener("sora-download-progress", (e) => {
  const p = e.detail || {};
  const phase = String(p.phase || "downloading");
  const mode = String(p.mode || "");
  if (phase === "enriching") {
    setStatus(p.message ? String(p.message) : `Fetching references... ${p.processed}/${p.requested}`, { state: "download", busy: true });
  } else if (phase === "finalizing") {
    setStatus(p.message ? String(p.message) : `Finalizing ${mode.toUpperCase()}... completed: ${p.completed}, failed: ${p.failed}, skipped: ${p.skipped}`, { state: "download", busy: true });
  } else {
    setStatus(`Downloading ${mode.toUpperCase()}... ${p.processed}/${p.requested} | ok: ${p.completed} | failed: ${p.failed} | skipped: ${p.skipped}`, { state: "download", busy: true });
  }
});

scanBtn.addEventListener("click", onScan);
pauseScanBtn.addEventListener("click", onTogglePauseScan);
downloadBtn.addEventListener("click", onDownloadAll);
retryFailedBtn.addEventListener("click", onRetryFailedOnly);
clearCacheBtn.addEventListener("click", onClearCache);
toggleExportSectionBtn.addEventListener("click", () => onToggleSection("export"));

setStatus("Not scanned yet.", { state: "idle", busy: false });
renderItems([]);
setBusy(false);
restoreState();

async function onScan() {
  setBusy(true);
  setStatus(autoScrollToggle.checked ? "Auto-scanning (scrolling)..." : "Scanning active tab...", { state: "scan", busy: true });
  try {
    const tab = await getActiveTab();
    activeScanInProgress = true;
    activeScanTabId = tab.id;
    scanPaused = false;
    refreshControlState();
    refreshPauseButton();
    ensureTabIsScannable(tab);
    currentItems = [];
    renderItems(currentItems);
    await sendMessageWithAutoInject(tab.id, { type: "SORA_CLEAR_SCAN_CACHE" });
    const response = await sendMessageWithAutoInject(tab.id, {
      type: autoScrollToggle.checked ? "SORA_SCAN_WITH_SCROLL" : "SORA_SCAN",
      options: {
        maxSteps: 90,
        totalMaxSteps: 5000,
        settleMs: 350
      }
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "Content script did not return data.");
    }

    currentItems = response.items || [];
    await persistState();
    renderItems(currentItems);

    if (currentItems.length > 0) {
      setStatus(`Found ${currentItems.length} item(s). Enriching references...`, { state: "download", busy: true });
      // Enrichment runs directly in this window (no messaging needed)
      await batchEnrichAllItems(currentItems, sharedDetailCache, "enrich");
      await persistState();
      renderItems(currentItems);
      const totalRefs = currentItems.reduce((sum, item) => sum + Number(item?.referenceCount || 0), 0);
      setStatus(`Found ${currentItems.length} item(s), refs: ${totalRefs}. Ready to download.`, { state: "done", busy: false });
    } else {
      setStatus("No items found.", { state: "done", busy: false });
    }
  } catch (error) {
    setStatus(`Scan failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    activeScanInProgress = false;
    activeScanTabId = null;
    scanPaused = false;
    refreshControlState();
    refreshPauseButton();
    setBusy(false);
  }
}

async function onTogglePauseScan() {
  if (!activeScanInProgress) {
    return;
  }
  try {
    const tab = await getActiveTab();
    ensureTabIsScannable(tab);
    scanPaused = !scanPaused;
    await sendMessageWithAutoInject(tab.id, {
      type: "SORA_SET_SCAN_PAUSED",
      paused: scanPaused
    });
    refreshControlState();
    await requestScanSnapshot(true);
    refreshPauseButton();
    setStatus(scanPaused ? "Scan paused." : "Scan resumed.", { state: scanPaused ? "paused" : "scan", busy: !scanPaused });
  } catch (error) {
    scanPaused = false;
    refreshControlState();
    refreshPauseButton();
    setStatus(`Pause/resume failed: ${error.message}`, { state: "error", busy: false });
  }
}

async function onDownloadAll() {
  if (!currentItems.length) {
    setStatus("Scan first. No items to download.", { state: "idle", busy: false });
    return;
  }

  const maxItems = getMaxItems();
  const limitedItems = currentItems.slice(0, maxItems);
  if (!limitedItems.length) {
    setStatus("No items selected for this run.", { state: "idle", busy: false });
    return;
  }

  setBusy(true);
  activeDownloadInProgress = true;
  setStatus(`Starting downloads (${limitedItems.length} item(s))...`, { state: "download", busy: true });
  try {
    const result = await downloadAll(limitedItems, {
      folderPrefix: folderPrefixEl.value.trim() || "SORA_EXPORT",
      exportCsv: csvToggle.checked,
      exportManifest: manifestToggle.checked,
      exportImageJson: imageJsonToggle.checked,
      skipExisting: skipExistingToggle.checked,
      organizeByGeneration: organizeByGenerationToggle.checked,
      exportZip: true,
      preferPng: true,
      mode: downloadModeEl.value === "fast" ? "fast" : "safe",
      retryOnly: false
    });
    lastFailedItems = result.failedItems || [];
    await persistState();
    setStatus(`Done. Requested: ${result.requested}, completed: ${result.completed}, failed: ${result.failed}, skipped: ${result.skipped}.`, { state: "done", busy: false });
  } catch (error) {
    setStatus(`Download failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    activeDownloadInProgress = false;
    setBusy(false);
  }
}

async function onRetryFailedOnly() {
  if (!lastFailedItems.length) {
    setStatus("No failed items available to retry yet.", { state: "idle", busy: false });
    return;
  }

  setBusy(true);
  activeDownloadInProgress = true;
  setStatus(`Retrying ${lastFailedItems.length} failed item(s)...`, { state: "download", busy: true });
  try {
    const result = await downloadAll(lastFailedItems, {
      folderPrefix: folderPrefixEl.value.trim() || "SORA_EXPORT",
      exportCsv: csvToggle.checked,
      exportManifest: manifestToggle.checked,
      exportImageJson: imageJsonToggle.checked,
      skipExisting: skipExistingToggle.checked,
      organizeByGeneration: organizeByGenerationToggle.checked,
      exportZip: true,
      preferPng: true,
      mode: downloadModeEl.value === "fast" ? "fast" : "safe",
      retryOnly: true
    });
    lastFailedItems = result.failedItems || [];
    await persistState();
    setStatus(`Retry done. Requested: ${result.requested}, completed: ${result.completed}, failed: ${result.failed}, skipped: ${result.skipped}.`, { state: "done", busy: false });
  } catch (error) {
    setStatus(`Retry failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    activeDownloadInProgress = false;
    setBusy(false);
  }
}

async function onClearCache() {
  setBusy(true);
  try {
    if (activeScanInProgress && typeof activeScanTabId === "number") {
      try {
        await sendMessageWithAutoInject(activeScanTabId, { type: "SORA_CANCEL_SCAN" });
      } catch {
        // If cancel message fails, proceed with local reset anyway.
      }
    }

    currentItems = [];
    lastFailedItems = [];
    await chrome.storage.local.remove([STATE_KEY]);

    try {
      const tab = await getActiveTab();
      ensureTabIsScannable(tab);
      await sendMessageWithAutoInject(tab.id, { type: "SORA_CLEAR_SCAN_CACHE" });
    } catch {
      // Ignore tab-level clear failures; popup state is still reset.
    }

    renderItems(currentItems);
    setStatus("Scan cache cleared.", { state: "idle", busy: false });
  } catch (error) {
    setStatus(`Clear failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    setBusy(false);
  }
}

function renderItems(items) {
  itemsList.innerHTML = "";

  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "No items found yet.";
    itemsList.appendChild(li);
    return;
  }

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const li = document.createElement("li");
    const promptPreviewRaw = truncate(item.prompt || "Prompt not detected", 130);
    const promptPreview = stripLeadingListMarker(promptPreviewRaw);
    li.textContent = promptPreview;
    itemsList.appendChild(li);
  }
}

function setStatus(message, options = {}) {
  const state = String(options.state || "idle");
  const busy = Boolean(options.busy);
  statusEl.textContent = message;
  if (statusSpinnerEl) {
    statusSpinnerEl.classList.toggle("is-active", busy);
  }
  if (statusStateEl) {
    statusStateEl.textContent = mapStatusStateLabel(state);
    statusStateEl.classList.remove("is-scan", "is-download", "is-paused", "is-done", "is-error");
    if (state === "scan") statusStateEl.classList.add("is-scan");
    if (state === "download") statusStateEl.classList.add("is-download");
    if (state === "paused") statusStateEl.classList.add("is-paused");
    if (state === "done") statusStateEl.classList.add("is-done");
    if (state === "error") statusStateEl.classList.add("is-error");
  }
}

function mapStatusStateLabel(state) {
  if (state === "scan") return "Scanning";
  if (state === "download") return "Downloading";
  if (state === "paused") return "Paused";
  if (state === "done") return "Done";
  if (state === "error") return "Error";
  return "Idle";
}

function setBusy(isBusy) {
  uiBusy = isBusy;
  refreshControlState();
}

function truncate(input, maxLen) {
  if (input.length <= maxLen) {
    return input;
  }
  return `${input.slice(0, maxLen - 3)}...`;
}

function stripLeadingListMarker(input) {
  return String(input).replace(/^\s*\d+\s*[\.\)]\s+/, "");
}

async function getActiveTab() {
  // Query all windows for active tabs, then pick the best one
  // (the detached popup window has no tabs, so we skip it)
  const tabs = await chrome.tabs.query({ active: true });
  const httpTab = tabs.find((t) => /^https?:\/\//i.test(t.url || ""));
  if (httpTab && typeof httpTab.id === "number") return httpTab;
  const anyTab = tabs.find((t) => typeof t.id === "number");
  if (anyTab) return anyTab;
  throw new Error("No active tab found. Open a web page first.");
}

function getMaxItems() {
  const raw = Number(maxItemsEl.value);
  if (!Number.isFinite(raw) || raw < 1) {
    return 300;
  }
  return Math.floor(raw);
}

async function sendMessageWithAutoInject(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const msg = String(error?.message || error || "");
    if (!msg.includes("Receiving end does not exist")) {
      throw error;
    }
    await injectContentScript(tabId);
    await sleepMs(100);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function requestScanSnapshot(force = false) {
  if (!activeScanInProgress || typeof activeScanTabId !== "number") {
    return;
  }
  const now = Date.now();
  if (!force && (snapshotInFlight || now - lastSnapshotAt < 800)) {
    return;
  }
  snapshotInFlight = true;
  try {
    const response = await sendMessageWithAutoInject(activeScanTabId, { type: "SORA_GET_SCAN_SNAPSHOT" });
    if (response?.ok && Array.isArray(response.items)) {
      currentItems = response.items;
      renderItems(currentItems);
      await persistState();
    }
  } catch {
    // Ignore intermittent snapshot failures during long scans.
  } finally {
    lastSnapshotAt = Date.now();
    snapshotInFlight = false;
  }
}

function injectContentScript(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

function ensureTabIsScannable(tab) {
  const url = String(tab?.url || "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Open a regular web page tab first (not chrome:// or extension pages).");
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistState() {
  const state = {
    currentItems,
    lastFailedItems,
    settings: {
      exportCsv: csvToggle.checked,
      exportManifest: manifestToggle.checked,
      exportImageJson: imageJsonToggle.checked,
      skipExisting: skipExistingToggle.checked,
      organizeByGeneration: organizeByGenerationToggle.checked,
      autoScroll: autoScrollToggle.checked,
      downloadMode: downloadModeEl.value,
      maxItems: maxItemsEl.value,
      folderPrefix: folderPrefixEl.value,
      collapsedExport: exportSettingsBody.classList.contains("section-collapsed")
    },
    savedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

async function restoreState() {
  try {
    const result = await chrome.storage.local.get([STATE_KEY]);
    const state = result?.[STATE_KEY];
    if (!state) return;

    currentItems = Array.isArray(state.currentItems) ? state.currentItems : [];
    lastFailedItems = Array.isArray(state.lastFailedItems) ? state.lastFailedItems : [];

    const settings = state.settings || {};
    if (typeof settings.exportCsv === "boolean") csvToggle.checked = settings.exportCsv;
    if (typeof settings.exportManifest === "boolean") manifestToggle.checked = settings.exportManifest;
    if (typeof settings.exportImageJson === "boolean") imageJsonToggle.checked = settings.exportImageJson;
    if (typeof settings.skipExisting === "boolean") skipExistingToggle.checked = settings.skipExisting;
    if (typeof settings.organizeByGeneration === "boolean") organizeByGenerationToggle.checked = settings.organizeByGeneration;
    if (typeof settings.autoScroll === "boolean") autoScrollToggle.checked = settings.autoScroll;
    if (typeof settings.downloadMode === "string") downloadModeEl.value = settings.downloadMode;
    if (settings.maxItems != null) maxItemsEl.value = String(settings.maxItems);
    if (typeof settings.folderPrefix === "string") folderPrefixEl.value = settings.folderPrefix;
    if (typeof settings.collapsedExport === "boolean") setSectionCollapsed("export", settings.collapsedExport);

    renderItems(currentItems);
    setStatus(currentItems.length ? `Restored ${currentItems.length} scanned item(s).` : "Not scanned yet.", { state: "idle", busy: false });
    setBusy(false);
    refreshPauseButton();
  } catch {
    // Ignore restore errors and continue with defaults.
  }
}

function refreshPauseButton() {
  pauseScanBtn.disabled = !activeScanInProgress;
  pauseScanBtn.textContent = scanPaused ? "Resume Scan" : "Pause Scan";
}

function refreshControlState() {
  const scanning = activeScanInProgress;
  const paused = scanPaused;
  const scanBusy = scanning && !paused;

  scanBtn.disabled = uiBusy || scanning;
  pauseScanBtn.disabled = !scanning;

  clearCacheBtn.disabled = uiBusy && !scanning;

  const lockDownloads = activeDownloadInProgress || (uiBusy && !scanning) || scanBusy;
  downloadBtn.disabled = lockDownloads;
  retryFailedBtn.disabled = lockDownloads || !lastFailedItems.length;
}

function onToggleSection(which) {
  const body = exportSettingsBody;
  const collapsed = !body.classList.contains("section-collapsed");
  setSectionCollapsed(which, collapsed);
  persistState();
}

function setSectionCollapsed(which, collapsed) {
  const body = exportSettingsBody;
  const btn = toggleExportSectionBtn;
  if (collapsed) {
    body.classList.add("section-collapsed");
    btn.textContent = "\u25b8";
    btn.setAttribute("aria-label", "Expand export settings");
  } else {
    body.classList.remove("section-collapsed");
    btn.textContent = "\u25be";
    btn.setAttribute("aria-label", "Collapse export settings");
  }
}
