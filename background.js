chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "SORA_DOWNLOAD_ITEMS") {
    return;
  }

  const payload = message.payload || {};
  const {
    items,
    folderPrefix,
    exportCsv,
    exportManifest,
    exportImageJson,
    skipExisting,
    organizeByGeneration,
    exportZip,
    preferPng,
    mode,
    retryOnly
  } = payload;

  downloadAll(items || [], {
    folderPrefix: folderPrefix || "SORA_EXPORT",
    exportCsv: Boolean(exportCsv),
    exportManifest: Boolean(exportManifest),
    exportImageJson: Boolean(exportImageJson),
    skipExisting: Boolean(skipExisting),
    organizeByGeneration: Boolean(organizeByGeneration),
    exportZip: Boolean(exportZip),
    preferPng: preferPng !== false,
    mode: mode === "fast" ? "fast" : "safe",
    retryOnly: Boolean(retryOnly)
  })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));

  return true;
});

async function downloadAll(items, options) {
  if (options.exportZip) {
    return downloadAllAsZip(items, options);
  }
  return downloadAllAsFiles(items, options);
}

async function downloadAllAsFiles(items, options) {
  const cleanedPrefix = sanitizePathSegment(options.folderPrefix || "SORA_EXPORT");
  const profile = getModeProfile(options.mode);
  const runId = buildRunId();
  const csvRows = [["index", "taskId", "prompt", "imageUrl", "pageUrl", "collectedAt"]];
  const failures = [];
  const failedItems = [];
  const completedItems = [];
  const generationMap = new Map();
  let completed = 0;
  let skipped = 0;
  const nativeDownloadCache = new Map();

  const storageKey = buildResumeStorageKey(cleanedPrefix, "files");
  const previouslyDownloaded = options.skipExisting ? await getDownloadedKeySet(storageKey) : new Set();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const index = i + 1;
    const identityKey = getItemIdentityKey(item);

    if (options.skipExisting && identityKey && previouslyDownloaded.has(identityKey)) {
      skipped += 1;
      continue;
    }

    const stem = `item_${String(index).padStart(4, "0")}`;
    const primaryUrl = item.imageUrl || "";
    const candidates = Array.isArray(item.imageCandidates) ? item.imageCandidates.filter(Boolean) : [];
    const candidateUrls = await buildCandidateUrls(item, primaryUrl, candidates, nativeDownloadCache);
    const ext = guessExtension(candidateUrls[0] || primaryUrl);
    const group = getGenerationGroup(item, index);
    const groupState = getOrCreateGroupState(generationMap, group);
    const imageSeq = groupState.images.length + 1;
    const imageBaseName = options.organizeByGeneration
      ? `img_${String(imageSeq).padStart(2, "0")}`
      : stem;
    const baseFolder = options.organizeByGeneration ? `${cleanedPrefix}/${group.folder}` : cleanedPrefix;
    const jsonFilename = `${baseFolder}/${imageBaseName}.json`;

    try {
      const fetched = await fetchFromCandidates(candidateUrls, profile.attemptDelayMs);
      const processed = await processImageBytes(fetched.bytes, fetched.url, options.preferPng);
      const outputExt = processed.ext || ext;
      const imageFilename = `${baseFolder}/${imageBaseName}${outputExt}`;
      const metadata = buildMetadata(item, index, runId, fetched.url, candidateUrls);
      metadata.outputFormat = outputExt.replace(".", "");
      metadata.sourceUrl = fetched.url;
      metadata.convertedToPng = outputExt === ".png" && !/\.png(?:[?#]|$)/i.test(fetched.url);

      await downloadBlob(new Blob([processed.bytes], { type: processed.mimeType }), imageFilename);
      if (options.exportImageJson) {
        await downloadTextFile(JSON.stringify(metadata, null, 2), jsonFilename, "application/json");
      }
      csvRows.push(buildCsvRow(index, metadata));

      completed += 1;
      completedItems.push(metadata);
      appendToGroupState(groupState, imageBaseName, outputExt, metadata);
      if (identityKey) previouslyDownloaded.add(identityKey);
    } catch (error) {
      failures.push({ index, imageUrl: primaryUrl, error: String(error) });
      failedItems.push(item);
    }

    await sleep(profile.itemDelayMs);
  }

  if (options.skipExisting) {
    await setDownloadedKeySet(storageKey, previouslyDownloaded);
  }

  if (options.exportCsv) {
    const csvContent = csvRows.map((row) => row.join(",")).join("\n");
    await downloadTextFile(csvContent, `${cleanedPrefix}/prompts.csv`, "text/csv");
  }

  if (options.organizeByGeneration) {
    await writeGenerationSummariesAsFiles(cleanedPrefix, generationMap, runId);
  }

  const manifest = buildManifest(runId, options, cleanedPrefix, items.length, completed, failures, skipped, completedItems);
  if (options.exportManifest) {
    await downloadTextFile(buildRunSummaryText(manifest), `${cleanedPrefix}/summary_${runId}.txt`, "text/plain");
  }

  return {
    requested: items.length,
    completed,
    failed: failures.length,
    skipped,
    failures,
    failedItems,
    runId,
    output: "files"
  };
}

async function downloadAllAsZip(items, options) {
  const cleanedPrefix = sanitizePathSegment(options.folderPrefix || "SORA_EXPORT");
  const profile = getModeProfile(options.mode);
  const runId = buildRunId();
  const zip = new SimpleZipWriter();
  const csvRows = [["index", "taskId", "prompt", "imageUrl", "pageUrl", "collectedAt"]];
  const failures = [];
  const failedItems = [];
  const completedItems = [];
  const generationMap = new Map();
  let completed = 0;
  let skipped = 0;
  const nativeDownloadCache = new Map();

  const storageKey = buildResumeStorageKey(cleanedPrefix, "zip");
  const previouslyDownloaded = options.skipExisting ? await getDownloadedKeySet(storageKey) : new Set();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const index = i + 1;
    const identityKey = getItemIdentityKey(item);

    if (options.skipExisting && identityKey && previouslyDownloaded.has(identityKey)) {
      skipped += 1;
      continue;
    }

    const stem = `item_${String(index).padStart(4, "0")}`;
    const primaryUrl = item.imageUrl || "";
    const candidates = Array.isArray(item.imageCandidates) ? item.imageCandidates.filter(Boolean) : [];
    const candidateUrls = await buildCandidateUrls(item, primaryUrl, candidates, nativeDownloadCache);
    const ext = guessExtension(candidateUrls[0] || primaryUrl);
    const group = getGenerationGroup(item, index);
    const groupState = getOrCreateGroupState(generationMap, group);
    const imageSeq = groupState.images.length + 1;
    const imageBaseName = options.organizeByGeneration
      ? `img_${String(imageSeq).padStart(2, "0")}`
      : stem;
    const baseFolder = options.organizeByGeneration ? `${cleanedPrefix}/${group.folder}` : cleanedPrefix;
    const jsonPath = `${baseFolder}/${imageBaseName}.json`;

    try {
      const fetched = await fetchFromCandidates(candidateUrls, profile.attemptDelayMs);
      const processed = await processImageBytes(fetched.bytes, fetched.url, options.preferPng);
      const outputExt = processed.ext || ext;
      const imagePath = `${baseFolder}/${imageBaseName}${outputExt}`;
      const metadata = buildMetadata(item, index, runId, fetched.url, candidateUrls);
      metadata.outputFormat = outputExt.replace(".", "");
      metadata.sourceUrl = fetched.url;
      metadata.convertedToPng = outputExt === ".png" && !/\.png(?:[?#]|$)/i.test(fetched.url);

      zip.addFile(imagePath, processed.bytes);
      if (options.exportImageJson) {
        zip.addTextFile(jsonPath, JSON.stringify(metadata, null, 2));
      }
      csvRows.push(buildCsvRow(index, metadata));

      completed += 1;
      completedItems.push(metadata);
      appendToGroupState(groupState, imageBaseName, outputExt, metadata);
      if (identityKey) previouslyDownloaded.add(identityKey);
    } catch (error) {
      failures.push({ index, imageUrl: primaryUrl, error: String(error) });
      failedItems.push(item);
    }

    await sleep(profile.itemDelayMs);
  }

  if (options.skipExisting) {
    await setDownloadedKeySet(storageKey, previouslyDownloaded);
  }

  if (options.exportCsv) {
    zip.addTextFile(`${cleanedPrefix}/prompts.csv`, csvRows.map((row) => row.join(",")).join("\n"));
  }

  if (options.organizeByGeneration) {
    writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId);
  }

  const manifest = buildManifest(runId, options, cleanedPrefix, items.length, completed, failures, skipped, completedItems);
  if (options.exportManifest) {
    zip.addTextFile(`${cleanedPrefix}/summary_${runId}.txt`, buildRunSummaryText(manifest));
  }

  const zipBytes = zip.finalize();
  await downloadBlob(
    new Blob([zipBytes], { type: "application/zip" }),
    `${cleanedPrefix}/${cleanedPrefix}_${runId}.zip`
  );

  return {
    requested: items.length,
    completed,
    failed: failures.length,
    skipped,
    failures,
    failedItems,
    runId,
    output: "zip"
  };
}

function buildMetadata(item, index, runId, selectedUrl, candidateUrls) {
  return {
    index,
    runId,
    title: item.title || "",
    prompt: item.prompt || "",
    imageUrl: selectedUrl,
    imageCandidates: candidateUrls,
    detailUrl: item.detailUrl || "",
    taskUrl: item.taskUrl || "",
    taskId: item.taskId || "",
    pageUrl: item.pageUrl || "",
    pageTitle: item.pageTitle || "",
    collectedAt: item.collectedAt || new Date().toISOString(),
    downloadedAt: new Date().toISOString()
  };
}

async function buildCandidateUrls(item, primaryUrl, candidates, nativeDownloadCache) {
  const nativeUrl = await getNativeDownloadUrl(item, nativeDownloadCache);
  const all = Array.from(new Set([nativeUrl, primaryUrl, ...(candidates || [])].filter(Boolean)));
  all.sort((a, b) => qualityScoreForPreferredSource(b) - qualityScoreForPreferredSource(a));
  return all;
}

async function getNativeDownloadUrl(item, cache) {
  const genId = extractGenerationId(item);
  if (!genId) return "";
  if (cache.has(genId)) return cache.get(genId) || "";

  try {
    const endpoint = `https://sora.chatgpt.com/backend/generations/${genId}/download`;
    const response = await fetch(endpoint, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      cache.set(genId, "");
      return "";
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      const directUrl = response.url || "";
      cache.set(genId, directUrl);
      return directUrl;
    }

    const payload = await response.json();
    const urls = collectUrlsFromJson(payload);
    const preferred = pickBestNativeUrl(urls);
    cache.set(genId, preferred || "");
    return preferred || "";
  } catch {
    cache.set(genId, "");
    return "";
  }
}

function extractGenerationId(item) {
  const detailUrl = String(item?.detailUrl || "");
  const m = detailUrl.match(/gen_[A-Za-z0-9]+/);
  if (m) return m[0];
  return "";
}

function collectUrlsFromJson(input) {
  const urls = [];
  const stack = [input];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    if (typeof cur === "string") {
      if (/^https?:\/\//i.test(cur)) {
        urls.push(cur);
      }
      continue;
    }
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    if (typeof cur === "object") {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return Array.from(new Set(urls));
}

function pickBestNativeUrl(urls) {
  if (!urls || !urls.length) return "";
  const sorted = [...urls].sort((a, b) => qualityScoreForPreferredSource(b) - qualityScoreForPreferredSource(a));
  return sorted[0] || "";
}

function qualityScoreForPreferredSource(url) {
  let score = 0;
  if (/backend\/generations\/gen_[^/]+\/download/i.test(url)) score += 4000;
  if (/\.png(?:[?#]|$)/i.test(url)) score += 3000;
  if (!/_thumb(?=\.[a-z0-9]+(?:[?#]|$))/i.test(url)) score += 600;
  if (/\.webp(?:[?#]|$)/i.test(url)) score += 100;
  if (/\.jpg|\.jpeg/i.test(url)) score += 120;
  return score;
}

function buildCsvRow(index, metadata) {
  return [
    String(index),
    csvEscape(metadata.taskId),
    csvEscape(metadata.prompt),
    csvEscape(metadata.imageUrl),
    csvEscape(metadata.pageUrl),
    csvEscape(metadata.collectedAt)
  ];
}

function appendToGroupState(groupState, imageBaseName, ext, metadata) {
  groupState.images.push({
    index: metadata.index,
    file: `${imageBaseName}${ext}`,
    imageUrl: metadata.imageUrl,
    detailUrl: metadata.detailUrl,
    taskUrl: metadata.taskUrl
  });
  if (!groupState.prompt && metadata.prompt) {
    groupState.prompt = metadata.prompt;
  }
}

async function writeGenerationSummariesAsFiles(cleanedPrefix, generationMap, runId) {
  for (const groupState of generationMap.values()) {
    if (groupState.prompt) {
      await downloadTextFile(`${groupState.prompt}\n`, `${cleanedPrefix}/${groupState.folder}/prompt.txt`, "text/plain");
    }

    const generationMeta = {
      runId,
      generatedAt: new Date().toISOString(),
      groupKey: groupState.groupKey,
      folder: groupState.folder,
      title: groupState.title,
      taskId: groupState.taskId,
      taskUrl: groupState.taskUrl,
      prompt: groupState.prompt,
      images: groupState.images
    };
    await downloadTextFile(
      JSON.stringify(generationMeta, null, 2),
      `${cleanedPrefix}/${groupState.folder}/metadata.json`,
      "application/json"
    );
  }
}

function writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId) {
  for (const groupState of generationMap.values()) {
    if (groupState.prompt) {
      zip.addTextFile(`${cleanedPrefix}/${groupState.folder}/prompt.txt`, `${groupState.prompt}\n`);
    }

    const generationMeta = {
      runId,
      generatedAt: new Date().toISOString(),
      groupKey: groupState.groupKey,
      folder: groupState.folder,
      title: groupState.title,
      taskId: groupState.taskId,
      taskUrl: groupState.taskUrl,
      prompt: groupState.prompt,
      images: groupState.images
    };
    zip.addTextFile(
      `${cleanedPrefix}/${groupState.folder}/metadata.json`,
      JSON.stringify(generationMeta, null, 2)
    );
  }
}

function buildManifest(runId, options, cleanedPrefix, requested, completed, failures, skipped, completedItems) {
  return {
    runId,
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    retryOnly: options.retryOnly,
    options: {
      folderPrefix: cleanedPrefix,
      exportCsv: options.exportCsv,
      exportManifest: options.exportManifest,
      exportImageJson: options.exportImageJson,
      skipExisting: options.skipExisting,
      organizeByGeneration: options.organizeByGeneration,
      exportZip: options.exportZip,
      preferPng: options.preferPng
    },
    stats: {
      requested,
      completed,
      failed: failures.length,
      skipped
    },
    failures,
    completedItems
  };
}

function buildRunSummaryText(manifest) {
  const lines = [];
  lines.push("SORA Export Run Summary");
  lines.push("=======================");
  lines.push(`Run ID: ${manifest.runId}`);
  lines.push(`Generated At: ${manifest.generatedAt}`);
  lines.push(`Mode: ${manifest.mode}`);
  lines.push(`Retry Only: ${manifest.retryOnly ? "Yes" : "No"}`);
  lines.push("");
  lines.push("Options");
  lines.push("-------");
  lines.push(`Folder Prefix: ${manifest.options.folderPrefix}`);
  lines.push(`ZIP Export: ${manifest.options.exportZip ? "Yes" : "No"}`);
  lines.push(`Organize by Generation: ${manifest.options.organizeByGeneration ? "Yes" : "No"}`);
  lines.push(`Prefer PNG: ${manifest.options.preferPng ? "Yes" : "No"}`);
  lines.push(`Per-Image JSON: ${manifest.options.exportImageJson ? "Yes" : "No"}`);
  lines.push(`CSV Export: ${manifest.options.exportCsv ? "Yes" : "No"}`);
  lines.push("");
  lines.push("Stats");
  lines.push("-----");
  lines.push(`Requested: ${manifest.stats.requested}`);
  lines.push(`Completed: ${manifest.stats.completed}`);
  lines.push(`Failed: ${manifest.stats.failed}`);
  lines.push(`Skipped: ${manifest.stats.skipped}`);
  lines.push("");
  if (manifest.failures.length) {
    lines.push("Failures");
    lines.push("--------");
    for (const failure of manifest.failures) {
      lines.push(`- #${failure.index}: ${failure.error}`);
      lines.push(`  URL: ${failure.imageUrl}`);
    }
  } else {
    lines.push("Failures: none");
  }
  return `${lines.join("\n")}\n`;
}

function downloadUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (typeof downloadId !== "number") return reject(new Error("Download did not start"));
        resolve(downloadId);
      }
    );
  });
}

function downloadBlob(blob, filename) {
  return blobToDataUrl(blob).then((dataUrl) => {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: dataUrl, filename, saveAs: false, conflictAction: "uniquify" },
        (downloadId) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (typeof downloadId !== "number") return reject(new Error("Blob download did not start"));
          resolve(downloadId);
        }
      );
    });
  });
}

async function downloadFromCandidates(urls, filename, attemptDelayMs) {
  if (!urls.length) throw new Error("No image URL candidates provided.");
  let lastError = null;
  for (let i = 0; i < urls.length; i += 1) {
    try {
      await downloadUrl(urls[i], filename);
      return urls[i];
    } catch (error) {
      lastError = error;
      if (i < urls.length - 1) await sleep(attemptDelayMs);
    }
  }
  throw lastError || new Error("No candidate URLs could be downloaded.");
}

async function fetchFromCandidates(urls, attemptDelayMs) {
  if (!urls.length) throw new Error("No image URL candidates provided.");
  let lastError = null;
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    try {
      const bytes = await fetchBinaryBytes(url, 20000);
      return { url, bytes };
    } catch (error) {
      lastError = error;
      if (i < urls.length - 1) await sleep(attemptDelayMs);
    }
  }
  throw lastError || new Error("No candidate URLs could be fetched.");
}

async function processImageBytes(bytes, sourceUrl, preferPng) {
  const sourceExt = guessExtension(sourceUrl);
  const sourceMime = extensionToMime(sourceExt);
  if (!preferPng) {
    return {
      bytes,
      ext: sourceExt || ".bin",
      mimeType: sourceMime || "application/octet-stream"
    };
  }

  const pngConverted = await tryConvertToPng(bytes, sourceMime);
  if (pngConverted) {
    return {
      bytes: pngConverted,
      ext: ".png",
      mimeType: "image/png"
    };
  }

  return {
    bytes,
    ext: sourceExt || ".bin",
    mimeType: sourceMime || "application/octet-stream"
  };
}

async function tryConvertToPng(bytes, sourceMime) {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    return null;
  }
  try {
    const blob = new Blob([bytes], { type: sourceMime || "image/webp" });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pngBlob = await canvas.convertToBlob({ type: "image/png", quality: 1 });
    const outBuffer = await pngBlob.arrayBuffer();
    return new Uint8Array(outBuffer);
  } catch {
    return null;
  }
}

async function fetchBinaryBytes(url, timeoutMs) {
  try {
    return await fetchBinaryViaXhr(url, timeoutMs);
  } catch {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        credentials: "include",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } finally {
      clearTimeout(timer);
    }
  }
}

function fetchBinaryViaXhr(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.timeout = timeoutMs;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        resolve(new Uint8Array(xhr.response));
      } else {
        reject(new Error(`XHR HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("XHR network error"));
    xhr.ontimeout = () => reject(new Error("XHR timeout"));
    xhr.send();
  });
}

function downloadTextFile(content, filename, mimeType) {
  return downloadBlob(new Blob([content], { type: mimeType }), filename);
}

function getModeProfile(mode) {
  if (mode === "fast") {
    return { itemDelayMs: 120, attemptDelayMs: 80 };
  }
  return { itemDelayMs: 900, attemptDelayMs: 300 };
}

function getItemIdentityKey(item) {
  if (!item) return "";
  if (item.detailUrl) return `detail:${item.detailUrl}`;
  if (item.taskId && item.imageUrl) return `task-image:${item.taskId}:${item.imageUrl}`;
  if (item.imageUrl) return `image:${item.imageUrl}`;
  return "";
}

function getGenerationGroup(item, index) {
  const taskId = String(item?.taskId || "");
  const titleRaw = String(item?.title || "").trim();
  const detailUrl = String(item?.detailUrl || "");
  const taskUrl = String(item?.taskUrl || "");
  const groupKey = taskId || detailUrl || `untitled_${index}`;
  const baseLabel = taskId || titleRaw || extractGenId(detailUrl) || `untitled_${index}`;
  const shortLabel = truncateForPath(sanitizePathSegment(baseLabel), 80);
  const folder = shortLabel || `untitled_${index}`;
  return { groupKey, folder, title: titleRaw, taskId, taskUrl };
}

function getOrCreateGroupState(map, group) {
  if (map.has(group.groupKey)) return map.get(group.groupKey);
  const state = {
    groupKey: group.groupKey,
    folder: group.folder,
    title: group.title,
    taskId: group.taskId,
    taskUrl: group.taskUrl,
    prompt: "",
    images: []
  };
  map.set(group.groupKey, state);
  return state;
}

function extractGenId(detailUrl) {
  const match = String(detailUrl || "").match(/gen_[A-Za-z0-9]+/);
  return match ? match[0] : "";
}

function truncateForPath(value, maxLen) {
  if (!value) return "";
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

function sanitizePathSegment(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\.+$/g, "").trim() || "SORA_EXPORT";
}

function guessExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return ".png";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return ".jpg";
    if (pathname.endsWith(".webp")) return ".webp";
    if (pathname.endsWith(".gif")) return ".gif";
  } catch {
    return ".png";
  }
  return ".png";
}

function extensionToMime(ext) {
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "";
}

function csvEscape(value) {
  const input = String(value ?? "");
  return `"${input.replace(/"/g, "\"\"")}"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRunId() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${min}${sec}`;
}

function getDownloadedKeySet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      if (chrome.runtime.lastError) return resolve(new Set());
      const list = Array.isArray(result[key]) ? result[key] : [];
      resolve(new Set(list.filter((v) => typeof v === "string" && v.length > 0)));
    });
  });
}

function setDownloadedKeySet(key, keySet) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: Array.from(keySet) }, () => resolve());
  });
}

function buildResumeStorageKey(folderPrefix, outputKind) {
  return `sora_downloaded::${folderPrefix}::${outputKind}`;
}

class SimpleZipWriter {
  constructor() {
    this.entries = [];
    this.textEncoder = new TextEncoder();
  }

  addTextFile(path, text) {
    this.addFile(path, this.textEncoder.encode(text));
  }

  addFile(path, bytes) {
    const normalizedPath = normalizeZipPath(path);
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const nameBytes = this.textEncoder.encode(normalizedPath);
    const crc = crc32(data);
    const now = new Date();
    const dos = toDosDateTime(now);
    this.entries.push({
      name: nameBytes,
      data,
      crc,
      date: dos.date,
      time: dos.time
    });
  }

  finalize() {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of this.entries) {
      const localHeader = writeLocalHeader(entry);
      localParts.push(localHeader, entry.name, entry.data);

      const centralHeader = writeCentralHeader(entry, offset);
      centralParts.push(centralHeader, entry.name);

      offset += localHeader.length + entry.name.length + entry.data.length;
    }

    const centralSize = sumLengths(centralParts);
    const end = writeEndOfCentral(this.entries.length, centralSize, offset);
    return concatBytes([...localParts, ...centralParts, end]);
  }
}

function normalizeZipPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function writeLocalHeader(entry) {
  const out = new Uint8Array(30);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, 0, true);
  dv.setUint16(10, entry.time, true);
  dv.setUint16(12, entry.date, true);
  dv.setUint32(14, entry.crc >>> 0, true);
  dv.setUint32(18, entry.data.length, true);
  dv.setUint32(22, entry.data.length, true);
  dv.setUint16(26, entry.name.length, true);
  dv.setUint16(28, 0, true);
  return out;
}

function writeCentralHeader(entry, offset) {
  const out = new Uint8Array(46);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, 20, true);
  dv.setUint16(8, 0, true);
  dv.setUint16(10, 0, true);
  dv.setUint16(12, entry.time, true);
  dv.setUint16(14, entry.date, true);
  dv.setUint32(16, entry.crc >>> 0, true);
  dv.setUint32(20, entry.data.length, true);
  dv.setUint32(24, entry.data.length, true);
  dv.setUint16(28, entry.name.length, true);
  dv.setUint16(30, 0, true);
  dv.setUint16(32, 0, true);
  dv.setUint16(34, 0, true);
  dv.setUint16(36, 0, true);
  dv.setUint32(38, 0, true);
  dv.setUint32(42, offset, true);
  return out;
}

function writeEndOfCentral(entryCount, centralSize, centralOffset) {
  const out = new Uint8Array(22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, entryCount, true);
  dv.setUint16(10, entryCount, true);
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, centralOffset, true);
  dv.setUint16(20, 0, true);
  return out;
}

function concatBytes(parts) {
  const total = sumLengths(parts);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sumLengths(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  return n;
}

function toDosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | (month << 5) | day;
  const time = (hours << 11) | (minutes << 5) | seconds;
  return { date, time };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function blobToDataUrl(blob) {
  const type = blob.type || "application/octet-stream";
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return `data:${type};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
