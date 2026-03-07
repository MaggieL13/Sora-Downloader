let currentItems = [];
let lastFailedItems = [];
const STATE_KEY = "sora_popup_state_v1";

const scanBtn = document.getElementById("scanBtn");
const downloadBtn = document.getElementById("downloadBtn");
const retryFailedBtn = document.getElementById("retryFailedBtn");
const clearCacheBtn = document.getElementById("clearCacheBtn");
const statusEl = document.getElementById("status");
const itemsList = document.getElementById("itemsList");
const csvToggle = document.getElementById("csvToggle");
const manifestToggle = document.getElementById("manifestToggle");
const imageJsonToggle = document.getElementById("imageJsonToggle");
const skipExistingToggle = document.getElementById("skipExistingToggle");
const organizeByGenerationToggle = document.getElementById("organizeByGenerationToggle");
const exportZipToggle = document.getElementById("exportZipToggle");
const preferPngToggle = document.getElementById("preferPngToggle");
const autoScrollToggle = document.getElementById("autoScrollToggle");
const downloadModeEl = document.getElementById("downloadMode");
const maxItemsEl = document.getElementById("maxItems");
const folderPrefixEl = document.getElementById("folderPrefix");

scanBtn.addEventListener("click", onScan);
downloadBtn.addEventListener("click", onDownloadAll);
retryFailedBtn.addEventListener("click", onRetryFailedOnly);
clearCacheBtn.addEventListener("click", onClearCache);

setStatus("Not scanned yet.");
renderItems([]);
setBusy(false);
restoreState();

async function onScan() {
  setBusy(true);
  setStatus(autoScrollToggle.checked ? "Auto-scanning (scrolling)..." : "Scanning active tab...");
  try {
    const tab = await getActiveTab();
    ensureTabIsScannable(tab);
    const response = await sendMessageWithAutoInject(tab.id, {
      type: autoScrollToggle.checked ? "SORA_SCAN_WITH_SCROLL" : "SORA_SCAN",
      options: {
        maxSteps: 90,
        settleMs: 350
      }
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "Content script did not return data.");
    }

    currentItems = response.items || [];
    await persistState();
    renderItems(currentItems);
    setStatus(`Found ${currentItems.length} item(s).`);
  } catch (error) {
    setStatus(`Scan failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function onDownloadAll() {
  if (!currentItems.length) {
    setStatus("Scan first. No items to download.");
    return;
  }

  const maxItems = getMaxItems();
  const limitedItems = currentItems.slice(0, maxItems);
  if (!limitedItems.length) {
    setStatus("No items selected for this run.");
    return;
  }

  setBusy(true);
  setStatus(`Starting downloads (${limitedItems.length} item(s))...`);
  try {
    const response = await runDownload(limitedItems, false);
    const { requested, completed, failed, skipped } = response.result;
    lastFailedItems = response.result.failedItems || [];
    await persistState();
    setStatus(`Done. Requested: ${requested}, completed: ${completed}, failed: ${failed}, skipped: ${skipped}.`);
  } catch (error) {
    setStatus(`Download failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function onRetryFailedOnly() {
  if (!lastFailedItems.length) {
    setStatus("No failed items available to retry yet.");
    return;
  }

  setBusy(true);
  setStatus(`Retrying ${lastFailedItems.length} failed item(s)...`);
  try {
    const response = await runDownload(lastFailedItems, true);
    const { requested, completed, failed, skipped } = response.result;
    lastFailedItems = response.result.failedItems || [];
    await persistState();
    setStatus(`Retry done. Requested: ${requested}, completed: ${completed}, failed: ${failed}, skipped: ${skipped}.`);
  } catch (error) {
    setStatus(`Retry failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function onClearCache() {
  setBusy(true);
  try {
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
    setStatus("Scan cache cleared.");
  } catch (error) {
    setStatus(`Clear failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function runDownload(items, retryOnly) {
  const payload = {
    items,
    folderPrefix: folderPrefixEl.value.trim() || "SORA_EXPORT",
    exportCsv: csvToggle.checked,
    exportManifest: manifestToggle.checked,
    exportImageJson: imageJsonToggle.checked,
    skipExisting: skipExistingToggle.checked,
    organizeByGeneration: organizeByGenerationToggle.checked,
    exportZip: exportZipToggle.checked,
    preferPng: preferPngToggle.checked,
    mode: downloadModeEl.value === "fast" ? "fast" : "safe",
    retryOnly
  };

  const response = await chrome.runtime.sendMessage({
    type: "SORA_DOWNLOAD_ITEMS",
    payload
  });

  if (!response || !response.ok) {
    throw new Error(response?.error || "Download request failed.");
  }

  return response;
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
    const promptPreview = truncate(item.prompt || "Prompt not detected", 130);
    li.textContent = `${i + 1}. ${promptPreview}`;
    itemsList.appendChild(li);
  }
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setBusy(isBusy) {
  scanBtn.disabled = isBusy;
  downloadBtn.disabled = isBusy;
  retryFailedBtn.disabled = isBusy || !lastFailedItems.length;
  clearCacheBtn.disabled = isBusy;
}

function truncate(input, maxLen) {
  if (input.length <= maxLen) {
    return input;
  }
  return `${input.slice(0, maxLen - 3)}...`;
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const tab = tabs[0];
      if (!tab || typeof tab.id !== "number") {
        reject(new Error("No active tab found."));
        return;
      }
      resolve(tab);
    });
  });
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
    await sleep(100);
    return chrome.tabs.sendMessage(tabId, message);
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

function sleep(ms) {
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
      exportZip: exportZipToggle.checked,
      preferPng: preferPngToggle.checked,
      autoScroll: autoScrollToggle.checked,
      downloadMode: downloadModeEl.value,
      maxItems: maxItemsEl.value,
      folderPrefix: folderPrefixEl.value
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
    if (typeof settings.exportZip === "boolean") exportZipToggle.checked = settings.exportZip;
    if (typeof settings.preferPng === "boolean") preferPngToggle.checked = settings.preferPng;
    if (typeof settings.autoScroll === "boolean") autoScrollToggle.checked = settings.autoScroll;
    if (typeof settings.downloadMode === "string") downloadModeEl.value = settings.downloadMode;
    if (settings.maxItems != null) maxItemsEl.value = String(settings.maxItems);
    if (typeof settings.folderPrefix === "string") folderPrefixEl.value = settings.folderPrefix;

    renderItems(currentItems);
    setStatus(currentItems.length ? `Restored ${currentItems.length} scanned item(s).` : "Not scanned yet.");
    setBusy(false);
  } catch {
    // Ignore restore errors and continue with defaults.
  }
}
