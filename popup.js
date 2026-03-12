let currentItems = [];
let lastFailedItems = [];
const STATE_KEY = "sora_popup_state_v2";

const scanBtn = document.getElementById("scanBtn");
const pauseScanBtn = document.getElementById("pauseScanBtn");
const downloadBtn = document.getElementById("downloadBtn");
const cancelDownloadBtn = document.getElementById("cancelDownloadBtn");
const retryFailedBtn = document.getElementById("retryFailedBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const statusEl = document.getElementById("status");
const statusSpinnerEl = document.getElementById("statusSpinner");
const statusStateEl = document.getElementById("statusState");
const itemsList = document.getElementById("itemsList");
const organizeByGenerationToggle = document.getElementById("organizeByGenerationToggle");
const autoScrollToggle = document.getElementById("autoScrollToggle");
const downloadModeEl = document.getElementById("downloadMode");
const batchSizeEl = document.getElementById("batchSize");
const folderPrefixEl = document.getElementById("folderPrefix");
const includePromptsToggle = document.getElementById("includePromptsToggle");
const includePresetsToggle = document.getElementById("includePresetsToggle");
const includeReferencesToggle = document.getElementById("includeReferencesToggle");
const exportSettingsBody = document.getElementById("exportSettingsBody");
const toggleExportSectionBtn = document.getElementById("toggleExportSectionBtn");
const fullModeBtn = document.getElementById("fullModeBtn");
const selectiveModeBtn = document.getElementById("selectiveModeBtn");
const selectionControls = document.getElementById("selectionControls");
const selectAllBtn = document.getElementById("selectAllBtn");
const deselectAllBtn = document.getElementById("deselectAllBtn");
const selectionCountEl = document.getElementById("selectionCount");
const batchProgressWrap = document.getElementById("batchProgressWrap");
const batchProgressText = document.getElementById("batchProgressText");
const batchProgressPercent = document.getElementById("batchProgressPercent");
const batchProgressFill = document.getElementById("batchProgressFill");
const scanStallPrompt = document.getElementById("scanStallPrompt");
const stallDoneBtn = document.getElementById("stallDoneBtn");
const stallContinueBtn = document.getElementById("stallContinueBtn");

let activeScanInProgress = false;
let scanPaused = false;
let activeScanTabId = null;
let lastSnapshotAt = 0;
let snapshotInFlight = false;
let uiBusy = false;
let activeDownloadInProgress = false;
let downloadCancelToken = null;
let downloadMode = "full"; // "full" | "selective"
let selectedKeys = new Set();
let liveEnrichToken = null;

// ── Scan progress from content script (arrives via chrome.runtime messaging) ──
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "SORA_SELECTION_COUNT") {
    if (typeof message.count === "number") {
      selectionCountEl.textContent = `${message.count} selected`;
    }
    return;
  }
  if (message.type === "SORA_SCAN_STALLED") {
    if (!activeScanInProgress) return;
    const info = message.info || {};
    const found = Number(info.found || 0);
    setStatus(`Scan stalled at ${found} items — waiting for your decision.`, { state: "paused", busy: false });
    scanStallPrompt.style.display = "";
    requestScanSnapshot(true);
    return;
  }
  if (message.type === "SORA_SCAN_PROGRESS") {
    if (!activeScanInProgress) return;
    const progress = message.progress || {};
    const found = Number(progress.found || 0);
    setStatus(`Scanning... found ${found} items`, { state: "scan", busy: true });
    scanStallPrompt.style.display = "none";
    requestScanSnapshot();
  }
});

// ── Download/enrichment progress from downloader.js (same window, custom event) ──
window.addEventListener("sora-download-progress", (e) => {
  const p = e.detail || {};
  const phase = String(p.phase || "downloading");

  if (phase === "enriching") {
    setStatus(p.message ? String(p.message) : `Fetching references... ${p.processed}/${p.requested}`, { state: "download", busy: true });
  } else if (phase === "finalizing") {
    const batchInfo = p.totalBatches > 1 ? ` (batch ${p.batchNumber}/${p.totalBatches})` : "";
    setStatus(p.message ? String(p.message) : `Building ZIP file${batchInfo}...`, { state: "download", busy: true });
  } else if (phase === "batch-transition") {
    setStatus(p.message || `Completed batch ${p.batchNumber}/${p.totalBatches}. Starting next...`, { state: "download", busy: true });
  } else {
    const batchInfo = p.totalBatches > 1 ? ` | batch ${p.batchNumber}/${p.totalBatches}` : "";
    setStatus(`Downloading... ${p.processed}/${p.requested} | ok: ${p.completed} | failed: ${p.failed}${batchInfo}`, { state: "download", busy: true });
  }

  // Update batch progress bar
  if (p.totalBatches && p.totalBatches > 1) {
    batchProgressWrap.style.display = "";
    batchProgressText.textContent = `Batch ${p.batchNumber || 1}/${p.totalBatches}`;
    const overallPercent = p.requested > 0 ? Math.round((p.processed / p.requested) * 100) : 0;
    batchProgressPercent.textContent = `${overallPercent}%`;
    batchProgressFill.style.width = `${overallPercent}%`;
  }
});

scanBtn.addEventListener("click", onScan);
pauseScanBtn.addEventListener("click", onTogglePauseScan);
downloadBtn.addEventListener("click", onDownloadAll);
cancelDownloadBtn.addEventListener("click", onCancelDownload);
retryFailedBtn.addEventListener("click", onRetryFailedOnly);
clearCacheBtn.addEventListener("click", onClearCache);
toggleExportSectionBtn.addEventListener("click", () => onToggleSection("export"));
fullModeBtn.addEventListener("click", () => setDownloadMode("full"));
selectiveModeBtn.addEventListener("click", () => setDownloadMode("selective"));
selectAllBtn.addEventListener("click", onSelectAll);
deselectAllBtn.addEventListener("click", onDeselectAll);
stallDoneBtn.addEventListener("click", onStallDone);
stallContinueBtn.addEventListener("click", onStallContinue);

setStatus("Not scanned yet.", { state: "idle", busy: false });
renderItems([]);
setBusy(false);
restoreState();

// ── Download mode toggle ──

function setDownloadMode(mode) {
  downloadMode = mode;
  fullModeBtn.classList.toggle("active", mode === "full");
  selectiveModeBtn.classList.toggle("active", mode === "selective");
  selectionControls.style.display = mode === "selective" ? "" : "none";
  downloadBtn.textContent = mode === "selective" ? "Download Selected" : "Download All";

  if (mode === "selective") {
    enterSelectionMode();
  } else {
    exitSelectionMode();
  }

  updateSelectionCount();
  persistState();
}

async function enterSelectionMode() {
  try {
    const tab = await getActiveTab();
    ensureTabIsScannable(tab);
    await sendMessageWithAutoInject(tab.id, { type: "SORA_ENTER_SELECTION_MODE" });
  } catch {
    // Selection mode is best-effort; items can still be downloaded in full mode.
  }
}

async function exitSelectionMode() {
  try {
    const tab = await getActiveTab();
    ensureTabIsScannable(tab);
    await sendMessageWithAutoInject(tab.id, { type: "SORA_EXIT_SELECTION_MODE" });
  } catch {
    // Best-effort cleanup.
  }
}

async function onSelectAll() {
  for (const item of currentItems) {
    const key = item.detailUrl || item.imageUrl || "";
    if (key) selectedKeys.add(key);
  }
  updateSelectionCount();
  try {
    const tab = await getActiveTab();
    await sendMessageWithAutoInject(tab.id, { type: "SORA_SELECT_ALL" });
  } catch { /* best-effort */ }
  persistState();
}

async function onDeselectAll() {
  selectedKeys.clear();
  updateSelectionCount();
  try {
    const tab = await getActiveTab();
    await sendMessageWithAutoInject(tab.id, { type: "SORA_DESELECT_ALL" });
  } catch { /* best-effort */ }
  persistState();
}

function updateSelectionCount() {
  if (selectionCountEl) {
    selectionCountEl.textContent = `${selectedKeys.size} selected`;
  }
}

// ── Scan ──

async function onScan() {
  setBusy(true);
  setStatus("Scanning page...", { state: "scan", busy: true });
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
    scanStallPrompt.style.display = "none";
    resetLiveEnrichState();
    liveEnrichToken = { cancelled: false };
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

    // Stop live enrichment — full enrichment pass will handle any remaining
    if (liveEnrichToken) liveEnrichToken.cancelled = true;

    currentItems = response.items || [];
    await persistState();
    renderItems(currentItems);

    if (currentItems.length > 0) {
      setStatus(`Found ${currentItems.length} items. Finishing enrichment...`, { state: "download", busy: true });
      await batchEnrichAllItems(currentItems, sharedDetailCache, "enrich");
      await persistState();
      renderItems(currentItems);
      const totalRefs = currentItems.reduce((sum, item) => sum + Number(item?.referenceCount || 0), 0);
      setStatus(`Found ${currentItems.length} items${totalRefs ? ` (${totalRefs} references)` : ""}. Ready to download.`, { state: "done", busy: false });
    } else {
      setStatus("No items found.", { state: "done", busy: false });
    }
  } catch (error) {
    setStatus(`Scan failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    activeScanInProgress = false;
    activeScanTabId = null;
    scanPaused = false;
    if (liveEnrichToken) liveEnrichToken.cancelled = true;
    liveEnrichToken = null;
    scanStallPrompt.style.display = "none";
    refreshControlState();
    refreshPauseButton();
    setBusy(false);
  }
}

async function onTogglePauseScan() {
  if (!activeScanInProgress) {
    return;
  }
  // Disable button immediately to prevent rapid toggling
  pauseScanBtn.disabled = true;
  try {
    const tab = await getActiveTab();
    ensureTabIsScannable(tab);
    scanPaused = !scanPaused;
    // Update UI immediately so user sees feedback
    refreshPauseButton();
    setStatus(scanPaused ? "Pausing scan..." : "Resuming scan...", { state: scanPaused ? "paused" : "scan", busy: !scanPaused });
    await sendMessageWithAutoInject(tab.id, {
      type: "SORA_SET_SCAN_PAUSED",
      paused: scanPaused
    });
    refreshControlState();
    if (scanPaused) await requestScanSnapshot(true);
    setStatus(scanPaused ? "Scan paused." : "Scan resumed.", { state: scanPaused ? "paused" : "scan", busy: !scanPaused });
  } catch (error) {
    scanPaused = false;
    refreshControlState();
    refreshPauseButton();
    setStatus(`Pause/resume failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    // Re-enable after a short cooldown to prevent rapid toggling
    setTimeout(() => {
      if (activeScanInProgress) pauseScanBtn.disabled = false;
    }, 500);
  }
}

// ── Scan stall handlers ──

async function onStallDone() {
  scanStallPrompt.style.display = "none";
  try {
    const tab = await getActiveTab();
    await sendMessageWithAutoInject(tab.id, { type: "SORA_CANCEL_SCAN" });
  } catch {
    // If cancel fails, the scan will end naturally when the async response returns.
  }
  setStatus(`Scan stopped by user. Processing ${currentItems.length} found items...`, { state: "scan", busy: true });
}

async function onStallContinue() {
  scanStallPrompt.style.display = "none";
  setStatus("Resuming scan...", { state: "scan", busy: true });
  try {
    const tab = await getActiveTab();
    await sendMessageWithAutoInject(tab.id, { type: "SORA_CONTINUE_PAST_STALL" });
  } catch (error) {
    setStatus(`Resume failed: ${error.message}`, { state: "error", busy: false });
  }
}

// ── Download ──

function getDownloadOptions() {
  return {
    folderPrefix: folderPrefixEl.value.trim() || "SORA_EXPORT",
    organizeByGeneration: organizeByGenerationToggle.checked,
    exportZip: true,
    preferPng: true,
    mode: downloadModeEl.value === "fast" ? "fast" : "safe",
    batchSize: getBatchSize(),
    includePrompts: includePromptsToggle.checked,
    includePresets: includePresetsToggle.checked,
    includeReferences: includeReferencesToggle.checked
  };
}

async function onDownloadAll() {
  let targetItems;
  if (downloadMode === "selective") {
    // Get selected items directly from content script — no prior scan needed
    try {
      const tab = await getActiveTab();
      const response = await sendMessageWithAutoInject(tab.id, { type: "SORA_GET_SELECTED_ITEM_DATA" });
      targetItems = (response?.items || []);
    } catch {
      targetItems = [];
    }
    if (!targetItems.length) {
      setStatus("No items selected. Enable Selective mode and check images on the page first.", { state: "idle", busy: false });
      return;
    }
  } else {
    if (!currentItems.length) {
      setStatus("Scan first. No items to download.", { state: "idle", busy: false });
      return;
    }
    targetItems = currentItems;
  }

  setBusy(true);
  activeDownloadInProgress = true;
  downloadCancelToken = { cancelled: false };
  cancelDownloadBtn.style.display = "";
  batchProgressWrap.style.display = "none";
  batchProgressFill.style.width = "0%";
  setStatus(`Starting download... (${targetItems.length} items)`, { state: "download", busy: true });

  try {
    const opts = getDownloadOptions();
    opts.cancelToken = downloadCancelToken;
    const result = await downloadAll(targetItems, opts);
    lastFailedItems = result.failedItems || [];
    await persistState();

    if (downloadCancelToken.cancelled) {
      const batchInfo = result.batches > 1 ? ` across ${result.batches} batch(es)` : "";
      setStatus(`Cancelled. ${result.completed} of ${result.requested} downloaded${batchInfo}.`, { state: "done", busy: false });
    } else {
      const batchInfo = result.batches > 1 ? ` in ${result.batches} batches` : "";
      const doneMsg = result.failed > 0
        ? `Done! ${result.completed} of ${result.requested} downloaded${batchInfo} (${result.failed} failed).`
        : `Done! ${result.completed} of ${result.requested} downloaded${batchInfo}.`;
      setStatus(doneMsg, { state: "done", busy: false });
    }
  } catch (error) {
    setStatus(`Download failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    activeDownloadInProgress = false;
    downloadCancelToken = null;
    cancelDownloadBtn.style.display = "none";
    setBusy(false);
  }
}

function onCancelDownload() {
  if (downloadCancelToken) {
    downloadCancelToken.cancelled = true;
    setStatus("Cancelling...", { state: "download", busy: true });
  }
}

async function onRetryFailedOnly() {
  if (!lastFailedItems.length) {
    setStatus("No failed items to retry.", { state: "idle", busy: false });
    return;
  }

  setBusy(true);
  activeDownloadInProgress = true;
  downloadCancelToken = { cancelled: false };
  cancelDownloadBtn.style.display = "";
  batchProgressWrap.style.display = "none";
  setStatus(`Retrying ${lastFailedItems.length} failed items...`, { state: "download", busy: true });

  try {
    const opts = getDownloadOptions();
    opts.cancelToken = downloadCancelToken;
    opts.retryOnly = true;
    const result = await downloadAll(lastFailedItems, opts);
    lastFailedItems = result.failedItems || [];
    await persistState();
    const retryMsg = result.failed > 0
      ? `Retry done! ${result.completed} of ${result.requested} recovered (${result.failed} still failed).`
      : `Retry done! ${result.completed} of ${result.requested} recovered.`;
    setStatus(retryMsg, { state: "done", busy: false });
  } catch (error) {
    setStatus(`Retry failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    activeDownloadInProgress = false;
    downloadCancelToken = null;
    cancelDownloadBtn.style.display = "none";
    setBusy(false);
  }
}

async function syncSelectionFromContentScript() {
  try {
    const tab = await getActiveTab();
    const response = await sendMessageWithAutoInject(tab.id, { type: "SORA_GET_SELECTED_ITEMS" });
    if (response?.ok && Array.isArray(response.keys)) {
      selectedKeys = new Set(response.keys);
      updateSelectionCount();
    }
  } catch {
    // Use existing selectedKeys if sync fails.
  }
}

// ── Clear cache ──

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
    selectedKeys.clear();
    await chrome.storage.local.remove([STATE_KEY]);

    try {
      const tab = await getActiveTab();
      ensureTabIsScannable(tab);
      await sendMessageWithAutoInject(tab.id, { type: "SORA_CLEAR_SCAN_CACHE" });
    } catch {
      // Ignore tab-level clear failures; popup state is still reset.
    }

    renderItems(currentItems);
    updateSelectionCount();
    setStatus("Scan cache cleared.", { state: "idle", busy: false });
  } catch (error) {
    setStatus(`Clear failed: ${error.message}`, { state: "error", busy: false });
  } finally {
    setBusy(false);
  }
}

// ── Rendering ──

function renderItems(_items) {
  // Item list removed — count is shown in the status bar instead.
}

// ── Status ──

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

// ── Snapshot merging ──

/**
 * Merge incoming scan snapshot items with existing enriched items.
 * Preserves API-fetched data (prompts, references, presets) that the DOM scan can't see.
 */
function mergeSnapshotWithEnriched(existing, incoming) {
  if (!existing.length) return incoming;
  const enrichedByKey = new Map();
  for (const item of existing) {
    const key = item.detailUrl || item.imageUrl || "";
    if (key) enrichedByKey.set(key, item);
  }
  return incoming.map((item) => {
    const key = item.detailUrl || item.imageUrl || "";
    const prev = key ? enrichedByKey.get(key) : null;
    if (!prev) return item;
    // Preserve enriched fields that the DOM scan can't provide
    const merged = { ...item };
    if (prev.prompt && prev.prompt !== "Prompt not detected" && (!merged.prompt || merged.prompt === "Prompt not detected")) {
      merged.prompt = prev.prompt;
    }
    if (prev.presetName && !merged.presetName) merged.presetName = prev.presetName;
    if (prev.presetId && !merged.presetId) merged.presetId = prev.presetId;
    if (prev.presetDescription && !merged.presetDescription) merged.presetDescription = prev.presetDescription;
    if (Array.isArray(prev.referenceImages) && prev.referenceImages.length > 0 && (!Array.isArray(merged.referenceImages) || merged.referenceImages.length === 0)) {
      merged.referenceImages = prev.referenceImages;
      merged.referenceMediaIds = prev.referenceMediaIds;
      merged.referenceCount = prev.referenceCount;
    }
    return merged;
  });
}

// ── Utilities ──

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
  const tabs = await chrome.tabs.query({ active: true });
  const httpTab = tabs.find((t) => /^https?:\/\//i.test(t.url || ""));
  if (httpTab && typeof httpTab.id === "number") return httpTab;
  const anyTab = tabs.find((t) => typeof t.id === "number");
  if (anyTab) return anyTab;
  throw new Error("No active tab found. Open a web page first.");
}

function getBatchSize() {
  const raw = Number(batchSizeEl.value);
  if (!Number.isFinite(raw) || raw < 50) return 300;
  return Math.min(1000, Math.floor(raw));
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
      // Merge snapshot with existing enriched data (so API-fetched prompts aren't overwritten)
      currentItems = mergeSnapshotWithEnriched(currentItems, response.items);
      renderItems(currentItems);
      // Note: don't persistState() here — items are large and would exceed storage quota.
      // Items persist in memory and get saved after scanning completes.
      // Kick off live enrichment in the background (non-blocking)
      if (liveEnrichToken && !liveEnrichToken.cancelled) {
        liveEnrichItems(currentItems, sharedDetailCache, liveEnrichToken).then((count) => {
          if (count > 0) renderItems(currentItems);
        }).catch(() => {});
      }
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

// ── State persistence ──

async function persistState() {
  const state = {
    currentItems,
    lastFailedItems,
    settings: {
      organizeByGeneration: organizeByGenerationToggle.checked,
      autoScroll: autoScrollToggle.checked,
      downloadMode: downloadModeEl.value,
      batchSize: batchSizeEl.value,
      folderPrefix: folderPrefixEl.value,
      includePrompts: includePromptsToggle.checked,
      includePresets: includePresetsToggle.checked,
      includeReferences: includeReferencesToggle.checked,
      collapsedExport: exportSettingsBody.classList.contains("section-collapsed"),
      dlMode: downloadMode,
      selectedKeys: Array.from(selectedKeys)
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
    if (typeof settings.organizeByGeneration === "boolean") organizeByGenerationToggle.checked = settings.organizeByGeneration;
    if (typeof settings.autoScroll === "boolean") autoScrollToggle.checked = settings.autoScroll;
    if (typeof settings.downloadMode === "string") downloadModeEl.value = settings.downloadMode;
    if (settings.batchSize != null) batchSizeEl.value = String(settings.batchSize);
    if (typeof settings.folderPrefix === "string") folderPrefixEl.value = settings.folderPrefix;
    if (typeof settings.includePrompts === "boolean") includePromptsToggle.checked = settings.includePrompts;
    if (typeof settings.includePresets === "boolean") includePresetsToggle.checked = settings.includePresets;
    if (typeof settings.includeReferences === "boolean") includeReferencesToggle.checked = settings.includeReferences;
    if (typeof settings.collapsedExport === "boolean") setSectionCollapsed("export", settings.collapsedExport);
    if (typeof settings.dlMode === "string") {
      downloadMode = settings.dlMode;
      setDownloadMode(downloadMode);
    }
    if (Array.isArray(settings.selectedKeys)) {
      selectedKeys = new Set(settings.selectedKeys);
      updateSelectionCount();
    }

    renderItems(currentItems);
    setStatus(currentItems.length ? `Restored ${currentItems.length} scanned item(s).` : "Not scanned yet.", { state: "idle", busy: false });
    setBusy(false);
    refreshPauseButton();
  } catch {
    // Ignore restore errors and continue with defaults.
  }
}

// ── UI state helpers ──

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
  const collapsed = !exportSettingsBody.classList.contains("section-collapsed");
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
