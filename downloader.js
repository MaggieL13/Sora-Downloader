// ── Shared state ──
const sharedDetailCache = new Map();

// ── Download orchestration ──

async function downloadAll(items, options) {
  if (options.exportZip) {
    return downloadAllAsZipBatched(items, options);
  }
  return downloadAllAsFiles(items, options);
}

async function downloadAllAsFiles(items, options) {
  const cleanedPrefix = sanitizePathSegment(options.folderPrefix || "SORA_EXPORT");
  const profile = getModeProfile(options.mode);
  const runId = buildRunId();
  const failures = [];
  const failedItems = [];
  const generationMap = new Map();
  let completed = 0;
  let processed = 0;
  const nativeDownloadCache = new Map();

  await batchEnrichAllItems(items, sharedDetailCache, "files");

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const index = i + 1;

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

      completed += 1;
      appendToGroupState(groupState, imageBaseName, outputExt, metadata);
    } catch (error) {
      failures.push({ index, imageUrl: primaryUrl, error: String(error) });
      failedItems.push(item);
    }
    processed += 1;
    emitDownloadProgress({
      phase: "downloading",
      mode: "files",
      processed,
      requested: items.length,
      completed,
      failed: failures.length,
      skipped: 0,
      currentIndex: index
    });

    await sleep(profile.itemDelayMs);
  }

  if (options.organizeByGeneration) {
    emitDownloadProgress({
      phase: "finalizing",
      mode: "files",
      processed,
      requested: items.length,
      completed,
      failed: failures.length,
      skipped: 0
    });
    await writeGenerationSummariesAsFiles(cleanedPrefix, generationMap, runId, nativeDownloadCache, options);
  }

  return {
    requested: items.length,
    completed,
    failed: failures.length,
    skipped: 0,
    failures,
    failedItems,
    runId,
    output: "files"
  };
}

async function downloadAllAsZipBatched(items, options) {
  const batchSize = Math.max(50, Math.min(1000, options.batchSize || 300));
  const totalBatches = Math.ceil(items.length / batchSize);
  const cleanedPrefix = sanitizePathSegment(options.folderPrefix || "SORA_EXPORT");
  const profile = getModeProfile(options.mode);
  const runId = buildRunId();
  const cancelToken = options.cancelToken || { cancelled: false };
  const nativeDownloadCache = new Map();
  let overallCompleted = 0;
  let overallFailed = 0;
  let overallProcessed = 0;
  const allFailedItems = [];

  await batchEnrichAllItems(items, sharedDetailCache, "zip", cancelToken);
  if (cancelToken.cancelled) {
    return { requested: items.length, completed: 0, failed: 0, skipped: items.length, batches: 0, failedItems: [], runId, output: "zip" };
  }

  for (let batchNum = 0; batchNum < totalBatches; batchNum += 1) {
    if (cancelToken.cancelled) break;

    const batchStart = batchNum * batchSize;
    const batchItems = items.slice(batchStart, batchStart + batchSize);
    const batchSuffix = totalBatches > 1 ? `_batch${batchNum + 1}of${totalBatches}` : "";
    const zip = new SimpleZipWriter();
    const generationMap = new Map();
    let batchCompleted = 0;
    let batchFailed = 0;
    const failures = [];

    // Pre-compute slots in order (so organizeByGeneration sequencing is correct)
    const slots = [];
    for (let i = 0; i < batchItems.length; i += 1) {
      const item = batchItems[i];
      const globalIndex = batchStart + i + 1;
      const stem = `item_${String(globalIndex).padStart(4, "0")}`;
      const primaryUrl = item.imageUrl || "";
      const group = getGenerationGroup(item, globalIndex);
      // First time seeing this group in this batch? Number it with globalIndex for uniqueness
      if (!generationMap.has(group.groupKey)) {
        group.folder = `${String(globalIndex).padStart(4, "0")}_${group.folder}`;
      }
      const groupState = getOrCreateGroupState(generationMap, group);
      const imageBaseName = options.organizeByGeneration
        ? `img_${String(globalIndex).padStart(4, "0")}`
        : stem;
      const baseFolder = options.organizeByGeneration ? `${cleanedPrefix}/${groupState.folder}` : cleanedPrefix;
      slots.push({ item, globalIndex, stem, primaryUrl, group, groupState, imageBaseName, baseFolder, index: i });
    }

    // Concurrent worker pool for image fetching
    const CONCURRENCY = 5;
    let nextSlot = 0;
    const slotResults = new Array(slots.length);

    async function worker() {
      while (nextSlot < slots.length && !cancelToken.cancelled) {
        const slotIdx = nextSlot++;
        const slot = slots[slotIdx];
        const { item, globalIndex, primaryUrl, imageBaseName, baseFolder } = slot;
        const candidates = Array.isArray(item.imageCandidates) ? item.imageCandidates.filter(Boolean) : [];

        try {
          const candidateUrls = await buildCandidateUrls(item, primaryUrl, candidates, nativeDownloadCache);
          const ext = guessExtension(candidateUrls[0] || primaryUrl);
          const fetched = await fetchFromCandidates(candidateUrls, profile.attemptDelayMs);
          const processed = await processImageBytes(fetched.bytes, fetched.url, options.preferPng);
          const outputExt = processed.ext || ext;
          const imagePath = `${baseFolder}/${imageBaseName}${outputExt}`;
          const metadata = buildMetadata(item, globalIndex, runId, fetched.url, candidateUrls);
          metadata.outputFormat = outputExt.replace(".", "");
          metadata.sourceUrl = fetched.url;
          metadata.convertedToPng = outputExt === ".png" && !/\.png(?:[?#]|$)/i.test(fetched.url);
          slotResults[slotIdx] = { ok: true, imagePath, bytes: processed.bytes, imageBaseName, outputExt, metadata };
        } catch (error) {
          slotResults[slotIdx] = { ok: false, error: String(error), globalIndex, primaryUrl, item };
        }

        // Update progress (safe — JS is single-threaded between awaits)
        overallProcessed += 1;
        const doneCount = slotResults.filter(Boolean).length;
        const okSoFar = slotResults.filter(r => r && r.ok).length;
        const failSoFar = slotResults.filter(r => r && !r.ok).length;
        emitDownloadProgress({
          phase: "downloading",
          mode: "zip",
          processed: overallProcessed,
          requested: items.length,
          completed: overallCompleted + okSoFar,
          failed: overallFailed + failSoFar,
          skipped: 0,
          currentIndex: globalIndex,
          batchNumber: batchNum + 1,
          totalBatches,
          batchItemsProcessed: doneCount,
          batchItemsTotal: batchItems.length
        });
      }
    }

    // Launch workers
    const workers = [];
    for (let w = 0; w < CONCURRENCY; w += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Apply results to ZIP in original order (preserves consistent file ordering)
    for (let i = 0; i < slots.length; i += 1) {
      const result = slotResults[i];
      if (!result) continue;
      if (result.ok) {
        zip.addFile(result.imagePath, result.bytes);
        batchCompleted += 1;
        appendToGroupState(slots[i].groupState, result.imageBaseName, result.outputExt, result.metadata);
      } else {
        failures.push({ index: result.globalIndex, imageUrl: result.primaryUrl, error: result.error });
        allFailedItems.push(result.item);
        batchFailed += 1;
      }
    }

    overallCompleted += batchCompleted;
    overallFailed += batchFailed;

    if (options.organizeByGeneration && !cancelToken.cancelled) {
      emitDownloadProgress({ phase: "finalizing", mode: "zip", processed: overallProcessed, requested: items.length, completed: overallCompleted, failed: overallFailed, skipped: 0, batchNumber: batchNum + 1, totalBatches });
      await writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId, nativeDownloadCache, options);
    }

    if (zip.entries.length === 0) {
      zip.addTextFile(`${cleanedPrefix}/README.txt`, `No files were added to batch ${batchNum + 1}.\n`);
    }

    const zipBytes = zip.finalize();
    emitDownloadProgress({ phase: "finalizing", mode: "zip", processed: overallProcessed, requested: items.length, completed: overallCompleted, failed: overallFailed, skipped: 0, message: `Writing ZIP${batchSuffix}...`, batchNumber: batchNum + 1, totalBatches });
    await downloadBlob(new Blob([zipBytes], { type: "application/zip" }), `${cleanedPrefix}/${cleanedPrefix}_${runId}${batchSuffix}.zip`);

    if (batchNum < totalBatches - 1 && !cancelToken.cancelled) {
      emitDownloadProgress({ phase: "batch-transition", mode: "zip", processed: overallProcessed, requested: items.length, completed: overallCompleted, failed: overallFailed, skipped: 0, batchNumber: batchNum + 1, totalBatches, message: `Completed batch ${batchNum + 1}/${totalBatches}. Starting next...` });
      await sleep(500);
    }
  }

  return {
    requested: items.length,
    completed: overallCompleted,
    failed: overallFailed,
    skipped: 0,
    batches: totalBatches,
    failedItems: allFailedItems,
    runId,
    output: "zip"
  };
}

async function downloadAllAsZip(items, options) {
  const cleanedPrefix = sanitizePathSegment(options.folderPrefix || "SORA_EXPORT");
  const profile = getModeProfile(options.mode);
  const runId = buildRunId();
  const zip = new SimpleZipWriter();
  const failures = [];
  const failedItems = [];
  const generationMap = new Map();
  let completed = 0;
  let processed = 0;
  const nativeDownloadCache = new Map();

  await batchEnrichAllItems(items, sharedDetailCache, "zip");

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const index = i + 1;

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

      completed += 1;
      appendToGroupState(groupState, imageBaseName, outputExt, metadata);
    } catch (error) {
      failures.push({ index, imageUrl: primaryUrl, error: String(error) });
      failedItems.push(item);
    }
    processed += 1;
    emitDownloadProgress({
      phase: "downloading",
      mode: "zip",
      processed,
      requested: items.length,
      completed,
      failed: failures.length,
      skipped: 0,
      currentIndex: index
    });

    await sleep(profile.itemDelayMs);
  }

  if (options.organizeByGeneration) {
    emitDownloadProgress({
      phase: "finalizing",
      mode: "zip",
      processed,
      requested: items.length,
      completed,
      failed: failures.length,
      skipped: 0
    });
    await writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId, nativeDownloadCache, options);
  }

  if (zip.entries.length === 0) {
    zip.addTextFile(
      `${cleanedPrefix}/README.txt`,
      [
        "No files were added to this export.",
        "",
        `Requested: ${items.length}`,
        `Completed: ${completed}`,
        `Failed: ${failures.length}`,
        "",
        "Tip: Re-run scan and try download again."
      ].join("\n")
    );
  }

  const zipBytes = zip.finalize();
  emitDownloadProgress({
    phase: "finalizing",
    mode: "zip",
    processed,
    requested: items.length,
    completed,
    failed: failures.length,
    skipped: 0,
    message: "Writing ZIP file..."
  });
  await downloadBlob(
    new Blob([zipBytes], { type: "application/zip" }),
    `${cleanedPrefix}/${cleanedPrefix}_${runId}.zip`
  );

  return {
    requested: items.length,
    completed,
    failed: failures.length,
    skipped: 0,
    failures,
    failedItems,
    runId,
    output: "zip"
  };
}

// ── Metadata ──

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
    presetName: item.presetName || "",
    presetId: item.presetId || "",
    presetUrl: item.presetUrl || "",
    presetDescription: item.presetDescription || "",
    referenceImages: Array.isArray(item.referenceImages) ? item.referenceImages : [],
    referenceMediaIds: Array.isArray(item.referenceMediaIds) ? item.referenceMediaIds : [],
    referenceCount: Number(item.referenceCount || 0),
    pageUrl: item.pageUrl || "",
    pageTitle: item.pageTitle || "",
    collectedAt: item.collectedAt || new Date().toISOString(),
    downloadedAt: new Date().toISOString()
  };
}

// ── Candidate URL building ──

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

// ── Enrichment ──

/**
 * Live-enrich items during scanning. Processes items one at a time (gentle on API)
 * and skips items already enriched. Returns number of newly enriched items.
 * Designed to be called repeatedly as new items arrive from scan snapshots.
 */
const _liveEnrichedKeys = new Set();
let _liveEnrichRunning = false;

async function liveEnrichItems(items, detailCache, cancelToken) {
  if (_liveEnrichRunning) return 0;
  _liveEnrichRunning = true;
  let count = 0;
  try {
    for (const item of items) {
      if (cancelToken && cancelToken.cancelled) break;
      const key = item.detailUrl || item.imageUrl || "";
      if (!key || _liveEnrichedKeys.has(key)) continue;
      const genId = extractGenerationId(item);
      if (!genId) {
        _liveEnrichedKeys.add(key);
        continue;
      }
      try {
        await enrichItemReferences(item, detailCache);
        _liveEnrichedKeys.add(key);
        count++;
      } catch {
        // Non-fatal — will retry during full enrichment later
      }
      // Small delay to be gentle on the API during scanning
      await sleep(150);
    }
  } finally {
    _liveEnrichRunning = false;
  }
  return count;
}

function resetLiveEnrichState() {
  _liveEnrichedKeys.clear();
  _liveEnrichRunning = false;
}

async function batchEnrichAllItems(items, detailCache, mode, cancelToken) {
  const BATCH_SIZE = 8;
  let enriched = 0;
  const total = items.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    if (cancelToken && cancelToken.cancelled) break;
    const batch = items.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((item) => enrichItemReferences(item, detailCache)));
    enriched += batch.length;
    emitDownloadProgress({
      phase: "enriching",
      mode,
      processed: enriched,
      requested: total,
      completed: 0,
      failed: 0,
      skipped: 0,
      message: `Fetching references... ${enriched}/${total}`
    });
  }
}

async function enrichItemReferences(item, detailCache) {
  const token = await getAccessToken(detailCache);
  if (!token) return;

  const genId = extractGenerationId(item);
  if (!genId) return;

  const genData = await fetchApiJson(
    `https://sora.chatgpt.com/backend/generations/${genId}`,
    detailCache,
    `gen:${genId}`,
    token
  );
  if (!genData) return;

  // Pull prompt from API if we don't have one from the DOM
  if ((!item.prompt || item.prompt === "Prompt not detected") && genData.prompt) {
    item.prompt = genData.prompt;
  }

  // Pull preset from top-level API field first, then fall back to inpaint_items
  if (!item.presetId && genData.preset_id) {
    item.presetId = genData.preset_id;
    item.presetUrl = `https://sora.chatgpt.com/explore/presets?pid=${genData.preset_id}`;
  }
  if (!item.presetName && !item.presetId) {
    enrichPresetFromInpaintItems(item, genData.inpaint_items);
  }
  // Fetch preset details (name + description) if we have an ID but no name
  if (item.presetId && !item.presetName) {
    await enrichPresetDetails(item, detailCache, token);
  }

  // Only resolve references if we don't already have them
  if (!Array.isArray(item.referenceImages) || item.referenceImages.length === 0) {
    const refs = await resolveInpaintItems(genData.inpaint_items, detailCache, token);
    if (refs.length) {
      applyRefsToItem(item, refs);
    }
  }
}

function applyRefsToItem(item, refs) {
  item.referenceImages = refs;
  item.referenceMediaIds = refs.map((r) => r.mediaId).filter(Boolean);
  item.referenceCount = refs.length;
}

async function getAccessToken(cache) {
  if (cache.has("_accessToken")) return cache.get("_accessToken");
  try {
    const response = await fetch("https://sora.chatgpt.com/api/auth/session", {
      credentials: "include"
    });
    if (!response.ok) {
      cache.set("_accessToken", "");
      return "";
    }
    const data = await response.json();
    const token = data?.accessToken || "";
    cache.set("_accessToken", token);
    return token;
  } catch {
    cache.set("_accessToken", "");
    return "";
  }
}

async function fetchApiJson(url, cache, cacheKey, token) {
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  try {
    const headers = { Accept: "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const response = await fetch(url, { method: "GET", headers });
    if (!response.ok) {
      cache.set(cacheKey, null);
      return null;
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      cache.set(cacheKey, null);
      return null;
    }
    const data = await response.json();
    cache.set(cacheKey, data);
    return data;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
}

async function resolveInpaintItems(inpaintItems, cache, token) {
  if (!Array.isArray(inpaintItems) || !inpaintItems.length) return [];

  const validEntries = inpaintItems.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return Boolean(entry.upload_media_id || entry.generation_id);
  });

  const resolved = await Promise.all(validEntries.map((entry) => resolveSingleInpaintItem(entry, cache, token)));
  return resolved.filter(Boolean);
}

async function resolveSingleInpaintItem(entry, cache, token) {
  const mediaId = entry.upload_media_id || "";
  const genId = entry.generation_id || "";

  let mediaUrl = entry.servable_url || "";
  let thumbUrl = "";

  if (genId && !mediaUrl) {
    const refGenData = await fetchApiJson(
      `https://sora.chatgpt.com/backend/generations/${genId}`,
      cache,
      `gen:${genId}`,
      token
    );
    if (refGenData) {
      mediaUrl = refGenData.url || refGenData.encodings?.source?.path || "";
      thumbUrl = refGenData.encodings?.thumbnail?.path || "";
    }
  }

  if (mediaId && !mediaUrl) {
    const mediaEndpoints = [
      { url: `https://sora.chatgpt.com/backend/uploads/${mediaId}`, key: `uploads:${mediaId}` },
      { url: `https://sora.chatgpt.com/backend/media/${mediaId}`, key: `media:${mediaId}` },
      { url: `https://sora.chatgpt.com/backend/files/${mediaId}`, key: `files:${mediaId}` }
    ];
    for (const ep of mediaEndpoints) {
      const data = await fetchApiJson(ep.url, cache, ep.key, token);
      if (data) {
        mediaUrl = data.url || data.servable_url || data.download_url || "";
        if (!mediaUrl) {
          const urls = collectUrlsFromJson(data);
          mediaUrl = urls[0] || "";
        }
        if (mediaUrl) break;
      }
    }
  }

  return {
    mediaId,
    genId,
    mediaUrl,
    thumbUrl,
    alt: entry.description || ""
  };
}

async function enrichPresetDetails(item, detailCache, token) {
  if (!item.presetId || !token) return;
  const presetData = await fetchApiJson(
    `https://sora.chatgpt.com/backend/presets/${item.presetId}`,
    detailCache,
    `preset:${item.presetId}`,
    token
  );
  if (!presetData) return;
  if (presetData.title) item.presetName = presetData.title;
  if (presetData.prompt) item.presetDescription = presetData.prompt;
  if (!item.presetUrl) {
    item.presetUrl = `https://sora.chatgpt.com/explore/presets?pid=${item.presetId}`;
  }
}

function enrichPresetFromInpaintItems(item, inpaintItems) {
  if (!Array.isArray(inpaintItems)) return;
  for (const entry of inpaintItems) {
    if (entry?.preset_id) {
      item.presetId = item.presetId || entry.preset_id;
      item.presetName = item.presetName || entry.reference_display_name || "";
      break;
    }
  }
}

// ── URL helpers ──

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

// ── Group helpers ──

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
  if (!groupState.presetName && metadata.presetName) {
    groupState.presetName = metadata.presetName;
  }
  if (!groupState.presetId && metadata.presetId) {
    groupState.presetId = metadata.presetId;
  }
  if (!groupState.presetUrl && metadata.presetUrl) {
    groupState.presetUrl = metadata.presetUrl;
  }
  if (!groupState.presetDescription && metadata.presetDescription) {
    groupState.presetDescription = metadata.presetDescription;
  }
  if (Array.isArray(metadata.referenceImages)) {
    for (const ref of metadata.referenceImages) {
      const mediaId = String(ref.mediaId || "");
      const genId = String(ref.genId || "");
      const key = mediaId || genId || String(ref.thumbUrl || ref.mediaUrl || "");
      if (!key) continue;
      if (groupState.referencesByKey.has(key)) continue;
      groupState.referencesByKey.set(key, {
        mediaId,
        genId,
        mediaUrl: String(ref.mediaUrl || ""),
        thumbUrl: String(ref.thumbUrl || ""),
        alt: String(ref.alt || "")
      });
    }
  }
}

// ── Generation summaries ──

async function writeGenerationSummariesAsFiles(cleanedPrefix, generationMap, runId, nativeDownloadCache, options) {
  const includePrompts = options?.includePrompts !== false;
  const includePresets = options?.includePresets !== false;
  const includeReferences = options?.includeReferences !== false;

  for (const groupState of generationMap.values()) {
    if (includePrompts && groupState.prompt) {
      await downloadTextFile(`${groupState.prompt}\n`, `${cleanedPrefix}/${groupState.folder}/prompt.txt`, "text/plain");
    }
    if (includePresets && (groupState.presetName || groupState.presetId || groupState.presetDescription || groupState.presetUrl)) {
      await downloadTextFile(
        buildPresetText(groupState),
        `${cleanedPrefix}/${groupState.folder}/preset.txt`,
        "text/plain"
      );
    }
    if (includeReferences) {
      await exportReferenceImagesAsFiles(cleanedPrefix, groupState, nativeDownloadCache);
      await downloadTextFile(
        buildReferencesText(groupState),
        `${cleanedPrefix}/${groupState.folder}/references.txt`,
        "text/plain"
      );
    }

    const generationMeta = {
      runId,
      generatedAt: new Date().toISOString(),
      groupKey: groupState.groupKey,
      folder: groupState.folder,
      title: groupState.title,
      taskId: groupState.taskId,
      taskUrl: groupState.taskUrl,
      images: groupState.images
    };
    if (includePrompts) generationMeta.prompt = groupState.prompt;
    if (includePresets) {
      generationMeta.presetName = groupState.presetName || "";
      generationMeta.presetId = groupState.presetId || "";
      generationMeta.presetUrl = groupState.presetUrl || "";
      generationMeta.presetDescription = groupState.presetDescription || "";
    }
    if (includeReferences) {
      generationMeta.references = Array.from(groupState.referencesByKey.values());
    }
    await downloadTextFile(
      JSON.stringify(generationMeta, null, 2),
      `${cleanedPrefix}/${groupState.folder}/metadata.json`,
      "application/json"
    );
  }
}

async function writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId, nativeDownloadCache, options) {
  const includePrompts = options?.includePrompts !== false;
  const includePresets = options?.includePresets !== false;
  const includeReferences = options?.includeReferences !== false;

  for (const groupState of generationMap.values()) {
    if (includePrompts && groupState.prompt) {
      zip.addTextFile(`${cleanedPrefix}/${groupState.folder}/prompt.txt`, `${groupState.prompt}\n`);
    }
    if (includePresets && (groupState.presetName || groupState.presetId || groupState.presetDescription || groupState.presetUrl)) {
      zip.addTextFile(`${cleanedPrefix}/${groupState.folder}/preset.txt`, buildPresetText(groupState));
    }
    if (includeReferences) {
      await exportReferenceImagesToZip(zip, cleanedPrefix, groupState, nativeDownloadCache);
      zip.addTextFile(`${cleanedPrefix}/${groupState.folder}/references.txt`, buildReferencesText(groupState));
    }

    const generationMeta = {
      runId,
      generatedAt: new Date().toISOString(),
      groupKey: groupState.groupKey,
      folder: groupState.folder,
      title: groupState.title,
      taskId: groupState.taskId,
      taskUrl: groupState.taskUrl,
      images: groupState.images
    };
    if (includePrompts) generationMeta.prompt = groupState.prompt;
    if (includePresets) {
      generationMeta.presetName = groupState.presetName || "";
      generationMeta.presetId = groupState.presetId || "";
      generationMeta.presetUrl = groupState.presetUrl || "";
      generationMeta.presetDescription = groupState.presetDescription || "";
    }
    if (includeReferences) {
      generationMeta.references = Array.from(groupState.referencesByKey.values());
    }
    zip.addTextFile(
      `${cleanedPrefix}/${groupState.folder}/metadata.json`,
      JSON.stringify(generationMeta, null, 2)
    );
  }
}

// ── Download primitives (using URL.createObjectURL) ──

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
  const objectUrl = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: objectUrl, filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        URL.revokeObjectURL(objectUrl);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (typeof downloadId !== "number") return reject(new Error("Blob download did not start"));
        resolve(downloadId);
      }
    );
  });
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

// ── Image processing ──

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

// ── Fetch helpers ──

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

// ── Mode / identity / grouping ──

function getModeProfile(mode) {
  if (mode === "fast") {
    return { itemDelayMs: 120, attemptDelayMs: 80 };
  }
  return { itemDelayMs: 900, attemptDelayMs: 300 };
}

function getGenerationGroup(item, index) {
  const taskId = String(item?.taskId || "");
  const titleRaw = String(item?.title || "").trim();
  const detailUrl = String(item?.detailUrl || "");
  const taskUrl = String(item?.taskUrl || "");
  const genId = extractGenId(detailUrl);
  const groupKey = taskId || detailUrl || `untitled_${index}`;
  const baseLabel = taskId || titleRaw || genId || `untitled_${index}`;
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
    presetName: "",
    presetId: "",
    presetUrl: "",
    presetDescription: "",
    referencesByKey: new Map(),
    prompt: "",
    images: []
  };
  map.set(group.groupKey, state);
  return state;
}

// ── Reference image export ──

async function exportReferenceImagesAsFiles(cleanedPrefix, groupState, nativeDownloadCache) {
  const refs = Array.from(groupState.referencesByKey.values());
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const sourceUrls = await getReferenceSourceCandidates(ref, nativeDownloadCache);
    if (!sourceUrls.length) continue;
    let exported = false;
    for (const sourceUrl of sourceUrls) {
      try {
        const bytes = await fetchBinaryBytes(sourceUrl, 15000);
        const ext = guessExtension(sourceUrl);
        const mime = extensionToMime(ext) || "application/octet-stream";
        const filename = `${cleanedPrefix}/${groupState.folder}/references/reference_${String(i + 1).padStart(2, "0")}${ext}`;
        await downloadBlob(new Blob([bytes], { type: mime }), filename);
        exported = true;
        break;
      } catch {
        // Try the next candidate URL.
      }
    }
    if (!exported) {
      console.warn("[Sora Downloader] Failed to export reference image", ref);
    }
  }
}

async function exportReferenceImagesToZip(zip, cleanedPrefix, groupState, nativeDownloadCache) {
  const refs = Array.from(groupState.referencesByKey.values());
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const sourceUrls = await getReferenceSourceCandidates(ref, nativeDownloadCache);
    if (!sourceUrls.length) continue;
    let exported = false;
    for (const sourceUrl of sourceUrls) {
      try {
        const bytes = await fetchBinaryBytes(sourceUrl, 15000);
        const ext = guessExtension(sourceUrl);
        const filename = `${cleanedPrefix}/${groupState.folder}/references/reference_${String(i + 1).padStart(2, "0")}${ext}`;
        zip.addFile(filename, bytes);
        exported = true;
        break;
      } catch {
        // Try the next candidate URL.
      }
    }
    if (!exported) {
      console.warn("[Sora Downloader] Failed to export reference image to ZIP", ref);
    }
  }
}

async function getReferenceSourceCandidates(ref, nativeDownloadCache) {
  const candidates = [];
  const mediaUrl = String(ref?.mediaUrl || "");
  const thumbUrl = String(ref?.thumbUrl || "");
  const genId = String(ref?.genId || "");

  if (mediaUrl) candidates.push(mediaUrl);
  if (thumbUrl) candidates.push(thumbUrl);
  if (genId) {
    const nativeUrl = await getNativeDownloadUrl({ detailUrl: `https://sora.chatgpt.com/g/${genId}` }, nativeDownloadCache || new Map());
    if (nativeUrl) candidates.unshift(nativeUrl);
  }

  const deThumbed = candidates
    .map((url) => String(url || "").replace(/_thumb(?=\.[a-z0-9]+(?:[?#]|$))/i, ""))
    .filter(Boolean);
  return Array.from(new Set([...deThumbed, ...candidates].filter(Boolean)));
}

// ── Text builders ──

function buildReferencesText(groupState) {
  const refs = Array.from(groupState.referencesByKey.values());
  const lines = [];
  lines.push("References");
  lines.push("==========");
  if (!refs.length) {
    lines.push("None captured.");
    return `${lines.join("\n")}\n`;
  }
  for (let i = 0; i < refs.length; i += 1) {
    const r = refs[i];
    lines.push(`${i + 1}. ${r.mediaId || r.genId || "(no media/gen id)"}`);
    if (r.genId) lines.push(`   genId: ${r.genId}`);
    if (r.mediaUrl) lines.push(`   mediaUrl: ${r.mediaUrl}`);
    if (r.thumbUrl) lines.push(`   thumbUrl: ${r.thumbUrl}`);
    if (r.alt) lines.push(`   alt: ${r.alt}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildPresetText(groupState) {
  const lines = [];
  lines.push("Preset");
  lines.push("======");
  if (groupState.presetName) lines.push(`Name: ${groupState.presetName}`);
  if (groupState.presetId) lines.push(`ID: ${groupState.presetId}`);
  if (groupState.presetUrl) lines.push(`URL: ${groupState.presetUrl}`);
  lines.push("");
  if (groupState.presetDescription) {
    lines.push("Description");
    lines.push("-----------");
    lines.push(groupState.presetDescription);
  } else {
    lines.push("Description: (not captured)");
  }
  return `${lines.join("\n")}\n`;
}

// ── Utility ──

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

function emitDownloadProgress(progress) {
  window.dispatchEvent(new CustomEvent("sora-download-progress", { detail: progress }));
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

// ── ZIP Writer ──

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
