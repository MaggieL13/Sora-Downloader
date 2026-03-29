// ── Shared state ──
const sharedDetailCache = new Map();
// Run-lifetime cache for resolved reference source candidates. Export registries remain batch-local.
const sharedReferenceCandidateCache = new Map();

// ── Download orchestration ──

async function downloadAll(items, options) {
  if (options.exportZip) {
    return downloadAllAsZipBatchedAdaptive(items, options);
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
  const batchReferenceRegistry = createBatchReferenceRegistry();
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
      appendToGroupState(groupState, imageBaseName, outputExt, metadata, batchReferenceRegistry);
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
    await writeGenerationSummariesAsFiles(cleanedPrefix, generationMap, runId, nativeDownloadCache, options, batchReferenceRegistry);
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
  const batchSize = Math.max(25, Math.min(500, options.batchSize || 100));
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
    const batchReferenceRegistry = createBatchReferenceRegistry();
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
        appendToGroupState(slots[i].groupState, result.imageBaseName, result.outputExt, result.metadata, batchReferenceRegistry);
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
      await writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId, nativeDownloadCache, options, batchReferenceRegistry);
    }

    if (zip.entries.length === 0) {
      zip.addTextFile(`${cleanedPrefix}/README.txt`, `No files were added to batch ${batchNum + 1}.\n`);
    }

    const viewerHtml = await fetchViewerHtml();
    if (viewerHtml) zip.addTextFile(`${cleanedPrefix}/viewer.html`, viewerHtml);

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
  const batchReferenceRegistry = createBatchReferenceRegistry();
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
    await writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId, nativeDownloadCache, options, batchReferenceRegistry);
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

  const viewerHtml = await fetchViewerHtml();
  if (viewerHtml) zip.addTextFile(`${cleanedPrefix}/viewer.html`, viewerHtml);

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

async function downloadAllAsZipBatchedAdaptive(items, options) {
  const batchSize = Math.max(25, Math.min(500, options.batchSize || 100));
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
  let writtenZipCount = 0;

  await batchEnrichAllItems(items, sharedDetailCache, "zip", cancelToken);
  if (cancelToken.cancelled) {
    return { requested: items.length, completed: 0, failed: 0, skipped: items.length, batches: 0, failedItems: [], runId, output: "zip" };
  }

  async function processBatchSlice(batchItems, batchStart, labelSuffix, depth = 0) {
    if (cancelToken.cancelled) {
      return { completed: 0, failed: 0, failedItems: [], zipCount: 0 };
    }

    const zip = new SimpleZipWriter();
    const generationMap = new Map();
    const batchReferenceRegistry = createBatchReferenceRegistry();
    let batchCompleted = 0;
    let batchFailed = 0;
    const failedItems = [];

    const slots = [];
    for (let i = 0; i < batchItems.length; i += 1) {
      const item = batchItems[i];
      const globalIndex = batchStart + i + 1;
      const stem = `item_${String(globalIndex).padStart(4, "0")}`;
      const primaryUrl = item.imageUrl || "";
      const group = getGenerationGroup(item, globalIndex);
      if (!generationMap.has(group.groupKey)) {
        group.folder = `${String(globalIndex).padStart(4, "0")}_${group.folder}`;
      }
      const groupState = getOrCreateGroupState(generationMap, group);
      const imageBaseName = options.organizeByGeneration
        ? `img_${String(globalIndex).padStart(4, "0")}`
        : stem;
      const baseFolder = options.organizeByGeneration ? `${cleanedPrefix}/${groupState.folder}` : cleanedPrefix;
      slots.push({ item, globalIndex, primaryUrl, groupState, imageBaseName, baseFolder });
    }

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

        overallProcessed += 1;
        const doneCount = slotResults.filter(Boolean).length;
        const okSoFar = slotResults.filter(r => r && r.ok).length;
        const failSoFar = slotResults.filter(r => r && !r.ok).length;
        emitDownloadProgress({
          phase: "downloading",
          mode: "zip",
          processed: Math.min(overallProcessed, items.length),
          requested: items.length,
          completed: overallCompleted + okSoFar,
          failed: overallFailed + failSoFar,
          skipped: 0,
          currentIndex: globalIndex,
          batchNumber: Math.floor(batchStart / batchSize) + 1,
          totalBatches,
          batchItemsProcessed: doneCount,
          batchItemsTotal: batchItems.length,
          message: depth > 0 ? `Retrying smaller ZIP chunk ${labelSuffix}...` : undefined
        });
      }
    }

    const workers = [];
    for (let w = 0; w < CONCURRENCY; w += 1) workers.push(worker());
    await Promise.all(workers);

    for (let i = 0; i < slots.length; i += 1) {
      const result = slotResults[i];
      if (!result) continue;
      if (result.ok) {
        zip.addFile(result.imagePath, result.bytes);
        batchCompleted += 1;
        appendToGroupState(slots[i].groupState, result.imageBaseName, result.outputExt, result.metadata, batchReferenceRegistry);
      } else {
        failedItems.push(result.item);
        batchFailed += 1;
      }
    }

    if (options.organizeByGeneration && !cancelToken.cancelled) {
      emitDownloadProgress({
        phase: "finalizing",
        mode: "zip",
        processed: Math.min(overallProcessed, items.length),
        requested: items.length,
        completed: overallCompleted + batchCompleted,
        failed: overallFailed + batchFailed,
        skipped: 0,
        batchNumber: Math.floor(batchStart / batchSize) + 1,
        totalBatches,
        message: depth > 0 ? `Building smaller ZIP chunk ${labelSuffix}...` : undefined
      });
      await writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId, nativeDownloadCache, options, batchReferenceRegistry);
    }

    if (zip.entries.length === 0) {
      zip.addTextFile(`${cleanedPrefix}/README.txt`, `No files were added to chunk ${labelSuffix}.\n`);
    }

    const viewerHtml = await fetchViewerHtml();
    if (viewerHtml) zip.addTextFile(`${cleanedPrefix}/viewer.html`, viewerHtml);

    try {
      const zipBytes = zip.finalize();
      emitDownloadProgress({
        phase: "finalizing",
        mode: "zip",
        processed: Math.min(overallProcessed, items.length),
        requested: items.length,
        completed: overallCompleted + batchCompleted,
        failed: overallFailed + batchFailed,
        skipped: 0,
        message: `Writing ZIP ${labelSuffix}...`,
        batchNumber: Math.floor(batchStart / batchSize) + 1,
        totalBatches
      });
      await downloadBlob(new Blob([zipBytes], { type: "application/zip" }), `${cleanedPrefix}/${cleanedPrefix}_${runId}_${labelSuffix}.zip`);
      return { completed: batchCompleted, failed: batchFailed, failedItems, zipCount: 1 };
    } catch (error) {
      if (isAllocationError(error) && batchItems.length > 1) {
        const splitPoint = Math.max(1, Math.floor(batchItems.length / 2));
        emitDownloadProgress({
          phase: "finalizing",
          mode: "zip",
          processed: Math.min(overallProcessed, items.length),
          requested: items.length,
          completed: overallCompleted,
          failed: overallFailed,
          skipped: 0,
          message: `ZIP ${labelSuffix} was too large. Retrying as smaller chunks...`
        });
        const left = await processBatchSlice(batchItems.slice(0, splitPoint), batchStart, `${labelSuffix}_part1`, depth + 1);
        const right = await processBatchSlice(batchItems.slice(splitPoint), batchStart + splitPoint, `${labelSuffix}_part2`, depth + 1);
        return {
          completed: left.completed + right.completed,
          failed: left.failed + right.failed,
          failedItems: [...left.failedItems, ...right.failedItems],
          zipCount: left.zipCount + right.zipCount
        };
      }
      throw error;
    }
  }

  for (let batchNum = 0; batchNum < totalBatches; batchNum += 1) {
    if (cancelToken.cancelled) break;

    const batchStart = batchNum * batchSize;
    const batchItems = items.slice(batchStart, batchStart + batchSize);
    const labelSuffix = totalBatches > 1 ? `batch${batchNum + 1}of${totalBatches}` : `batch${batchNum + 1}`;
    const result = await processBatchSlice(batchItems, batchStart, labelSuffix);
    overallCompleted += result.completed;
    overallFailed += result.failed;
    allFailedItems.push(...result.failedItems);
    writtenZipCount += result.zipCount;

    if (batchNum < totalBatches - 1 && !cancelToken.cancelled) {
      emitDownloadProgress({
        phase: "batch-transition",
        mode: "zip",
        processed: Math.min(overallProcessed, items.length),
        requested: items.length,
        completed: overallCompleted,
        failed: overallFailed,
        skipped: 0,
        batchNumber: batchNum + 1,
        totalBatches,
        message: `Completed planned batch ${batchNum + 1}/${totalBatches}. Starting next...`
      });
      await sleep(500);
    }
  }

  return {
    requested: items.length,
    completed: overallCompleted,
    failed: overallFailed,
    skipped: 0,
    batches: writtenZipCount,
    failedItems: allFailedItems,
    runId,
    output: "zip"
  };
}

// ── Metadata ──

function buildMetadata(item, index, runId, selectedUrl, candidateUrls) {
  const metadata = {
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
  if (item.referenceDebug) {
    metadata.referenceDebug = item.referenceDebug;
  }
  if (item.referenceDomDebug) {
    metadata.referenceDomDebug = item.referenceDomDebug;
  }
  if (item.networkDebug) {
    metadata.networkDebug = item.networkDebug;
  }
  return metadata;
}

function createBatchReferenceRegistry() {
  return {
    entriesByKey: new Map(),
    orderedEntries: [],
    nextFallbackOrdinal: 1
  };
}

function registerMetadataReferencesInBatchRegistry(metadata, registry) {
  if (!registry || !Array.isArray(metadata?.referenceImages)) {
    return [];
  }
  const ids = [];
  for (const ref of metadata.referenceImages) {
    const entry = registerReferenceInBatchRegistry(ref, registry);
    if (entry?.id) ids.push(entry.id);
  }
  return Array.from(new Set(ids));
}

function registerReferenceInBatchRegistry(ref, registry) {
  if (!registry || !ref || typeof ref !== "object") {
    return null;
  }

  const key = buildReferenceRegistryKey(ref);
  if (!key) {
    return null;
  }
  if (registry.entriesByKey.has(key)) {
    return registry.entriesByKey.get(key);
  }

  const fallbackOrdinal = registry.nextFallbackOrdinal++;
  const entry = {
    id: buildReferenceLogicalId(ref, fallbackOrdinal),
    type: inferReferenceType(ref),
    mediaId: String(ref?.mediaId || ""),
    genId: String(ref?.genId || ""),
    sourceTaskId: String(ref?.sourceTaskId || ""),
    mediaUrl: String(ref?.mediaUrl || ""),
    thumbUrl: String(ref?.thumbUrl || ""),
    alt: String(ref?.alt || ""),
    file: "",
    thumbFile: "",
    status: "pending"
  };

  registry.entriesByKey.set(key, entry);
  registry.orderedEntries.push(entry);
  return entry;
}

function buildReferenceRegistryKey(ref) {
  const mediaId = String(ref?.mediaId || "");
  if (mediaId) return `media:${mediaId}`;

  const genId = String(ref?.genId || "");
  if (genId) return `gen:${genId}`;

  const sourceTaskId = String(ref?.sourceTaskId || "");
  if (sourceTaskId) return `task:${sourceTaskId}`;

  const mediaPath = normalizeReferenceAssetPath(ref?.mediaUrl);
  if (mediaPath) return `path:${mediaPath}`;

  const thumbPath = normalizeReferenceAssetPath(ref?.thumbUrl);
  if (thumbPath) return `path:${thumbPath}`;

  const fallbackText = [
    String(ref?.mediaUrl || ""),
    String(ref?.thumbUrl || ""),
    String(ref?.alt || "")
  ].filter(Boolean).join("|");
  if (!fallbackText) return "";
  return `fallback:${hashStringForReferenceId(fallbackText)}`;
}

function buildReferenceLogicalId(ref, fallbackOrdinal) {
  const mediaId = String(ref?.mediaId || "");
  if (mediaId) return `ref_media_${mediaId}`;

  const genId = String(ref?.genId || "");
  if (genId) return `ref_gen_${genId}`;

  const sourceTaskId = String(ref?.sourceTaskId || "");
  if (sourceTaskId) return `ref_task_${sourceTaskId}`;

  const normalizedPath = normalizeReferenceAssetPath(ref?.mediaUrl) || normalizeReferenceAssetPath(ref?.thumbUrl);
  if (normalizedPath) {
    return `ref_path_${hashStringForReferenceId(normalizedPath)}`;
  }

  return `ref_fallback_${String(fallbackOrdinal).padStart(6, "0")}`;
}

function inferReferenceType(ref) {
  return String(ref?.genId || ref?.sourceTaskId || "") ? "generation" : "upload";
}

function normalizeReferenceAssetPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  try {
    const url = new URL(text, "https://sora.chatgpt.com/");
    return decodePathForReferenceKey(url.pathname || "");
  } catch {
    const stripped = text.split("#")[0].split("?")[0];
    return decodePathForReferenceKey(stripped);
  }
}

function decodePathForReferenceKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function hashStringForReferenceId(input) {
  let hash = 2166136261;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

async function batchEnrichAllItems(items, detailCache, mode, cancelToken) {
  const BATCH_SIZE = 8;
  let enriched = 0;
  let failed = 0;
  const total = items.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    if (cancelToken && cancelToken.cancelled) break;
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((item) => enrichItemReferences(item, detailCache)));
    for (const result of results) {
      if (result.status === "fulfilled") {
        enriched += 1;
      } else {
        failed += 1;
      }
    }
    emitDownloadProgress({
      phase: "enriching",
      mode,
      processed: enriched,
      requested: total,
      completed: 0,
      failed,
      skipped: 0,
      message: failed > 0
        ? `Fetching references... ${enriched}/${total} (${failed} failed)`
        : `Fetching references... ${enriched}/${total}`
    });
  }

  return { enriched, failed };
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

  const domRefs = sanitizeDomReferences(item, item.referenceImages);
  const apiRefs = await resolveInpaintItems(genData.inpaint_items, detailCache, token);
  const topLevelRefs = await resolveTopLevelGenerationReferences(genData, detailCache, token, genId);
  const networkRefs = await resolveNetworkReferencesFromDebug(item.networkDebug, detailCache, token, genId);
  const mergedPrimaryRefs = mergeReferenceSets(
    mergeReferenceSets(mergeReferenceSets(domRefs, apiRefs), topLevelRefs),
    networkRefs
  );
  const needsDetailFallback = !mergedPrimaryRefs.some((ref) => String(ref?.genId || "").startsWith("gen_"));
  const detailPageRefs = needsDetailFallback
    ? await resolveDetailPageReferences(item, detailCache)
    : [];
  const finalRefs = mergeReferenceSets(mergedPrimaryRefs, detailPageRefs);
  item.referenceDebug = buildReferenceDebug(genData, domRefs, apiRefs, item.referenceDomDebug, detailPageRefs, item.networkDebug, networkRefs);
  if (finalRefs.length) {
    applyRefsToItem(item, finalRefs);
  }
}

function applyRefsToItem(item, refs) {
  item.referenceImages = refs;
  item.referenceMediaIds = refs.map((r) => r.mediaId).filter(Boolean);
  item.referenceCount = refs.length;
}

function sanitizeDomReferences(item, refs) {
  const currentGenId = extractGenerationId(item);
  const byKey = new Map();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const mediaId = String(ref?.mediaId || "");
    const genId = String(ref?.genId || "");
    const sourceTaskId = String(ref?.sourceTaskId || "");
    if (genId && currentGenId && genId === currentGenId) {
      continue;
    }
    const key = mediaId || genId || sourceTaskId || String(ref?.thumbUrl || ref?.mediaUrl || "");
    if (!key || byKey.has(key)) {
      continue;
    }
    byKey.set(key, {
      mediaId,
      genId,
      sourceTaskId,
      mediaUrl: String(ref?.mediaUrl || ""),
      thumbUrl: String(ref?.thumbUrl || ""),
      alt: String(ref?.alt || "")
    });
  }
  return Array.from(byKey.values());
}

function mergeReferenceSets(leftRefs, rightRefs) {
  const byKey = new Map();
  const push = (ref) => {
    const mediaId = String(ref?.mediaId || "");
    const genId = String(ref?.genId || "");
    const sourceTaskId = String(ref?.sourceTaskId || "");
    const mediaUrl = String(ref?.mediaUrl || "");
    const thumbUrl = String(ref?.thumbUrl || "");
    const alt = String(ref?.alt || "");
    const key = mediaId || genId || sourceTaskId || thumbUrl || mediaUrl;
    if (!key) {
      return;
    }
    if (!byKey.has(key)) {
      byKey.set(key, { mediaId, genId, sourceTaskId, mediaUrl, thumbUrl, alt });
      return;
    }
    const existing = byKey.get(key);
    byKey.set(key, {
      mediaId: existing.mediaId || mediaId,
      genId: existing.genId || genId,
      sourceTaskId: existing.sourceTaskId || sourceTaskId,
      mediaUrl: existing.mediaUrl || mediaUrl,
      thumbUrl: existing.thumbUrl || thumbUrl,
      alt: existing.alt || alt
    });
  };
  for (const ref of Array.isArray(leftRefs) ? leftRefs : []) push(ref);
  for (const ref of Array.isArray(rightRefs) ? rightRefs : []) push(ref);
  return Array.from(byKey.values());
}

function buildReferenceDebug(genData, domRefs, apiRefs, domDebug, detailPageRefs, networkDebug, networkRefs) {
  const topLevelKeys = [
    "id",
    "generation_id",
    "gen_id",
    "parent_id",
    "parent_generation_id",
    "source_id",
    "source_gen_id",
    "source_generation_id",
    "reference_generation_id",
    "reference_media_id",
    "upload_media_id",
    "prompt",
    "preset_id"
  ];
  const topLevel = {};
  for (const key of topLevelKeys) {
    if (Object.prototype.hasOwnProperty.call(genData || {}, key)) {
      topLevel[key] = genData[key];
    }
  }

  const inpaintItems = Array.isArray(genData?.inpaint_items)
    ? genData.inpaint_items.map((entry, index) => ({
        index,
        upload_media_id: entry?.upload_media_id || "",
        generation_id: entry?.generation_id || "",
        gen_id: entry?.gen_id || "",
        source_id: entry?.source_id || "",
        source_gen_id: entry?.source_gen_id || "",
        source_generation_id: entry?.source_generation_id || "",
        parent_id: entry?.parent_id || "",
        parent_generation_id: entry?.parent_generation_id || "",
        reference_display_name: entry?.reference_display_name || "",
        servable_url: entry?.servable_url || ""
      }))
    : [];

  return {
    domRefs: Array.isArray(domRefs) ? domRefs : [],
    apiRefs: Array.isArray(apiRefs) ? apiRefs : [],
    networkRefs: Array.isArray(networkRefs) ? networkRefs : [],
    detailPageRefs: Array.isArray(detailPageRefs) ? detailPageRefs : [],
    networkDebug: networkDebug || null,
    domDebug: domDebug || null,
    topLevel,
    inpaintItems
  };
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

async function fetchTextWithCredentials(url, cache, cacheKey) {
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });
    if (!response.ok) {
      cache.set(cacheKey, "");
      return "";
    }
    const text = await response.text();
    cache.set(cacheKey, text);
    return text;
  } catch {
    cache.set(cacheKey, "");
    return "";
  }
}

async function resolveNetworkReferencesFromDebug(networkDebug, cache, token, currentGenId) {
  const events = Array.isArray(networkDebug?.matched) ? networkDebug.matched : [];
  if (!events.length) return [];

  const refsByKey = new Map();
  for (const event of events) {
    const snippet = String(event?.bodySnippet || "");
    if (!snippet) continue;

    const genIds = Array.from(new Set([
      ...collectMatches(snippet, /"source_generation_id"\s*:\s*"([^"]+)"/g),
      ...collectMatches(snippet, /"generation_id"\s*:\s*"([^"]+)"/g),
      ...collectMatches(snippet, /"source_gen_id"\s*:\s*"([^"]+)"/g),
      ...collectMatches(snippet, /"gen_id"\s*:\s*"([^"]+)"/g),
      ...collectMatches(snippet, /"parent_generation_id"\s*:\s*"([^"]+)"/g),
      ...collectMatches(snippet, /"reference_generation_id"\s*:\s*"([^"]+)"/g)
    ])).filter((id) => id && id !== currentGenId);

    const mediaIds = Array.from(new Set([
      ...collectMatches(snippet, /"source_upload_media_id"\s*:\s*"([^"]+)"/g)
    ])).filter(Boolean);

    for (const genId of genIds) {
      const refGenData = await fetchApiJson(
        `https://sora.chatgpt.com/backend/generations/${genId}`,
        cache,
        `gen:${genId}`,
        token
      );
      const mediaUrl = refGenData?.url || refGenData?.encodings?.source?.path || "";
      const thumbUrl = refGenData?.encodings?.thumbnail?.path || "";
      const sourceTaskId = extractTaskIdFromAssetUrl(mediaUrl || thumbUrl);
      refsByKey.set(genId, {
        mediaId: "",
        genId,
        sourceTaskId,
        mediaUrl,
        thumbUrl,
        alt: ""
      });
    }

    for (const mediaId of mediaIds) {
      if (refsByKey.has(mediaId)) continue;
      const resolved = await resolveSingleInpaintItem({ upload_media_id: mediaId }, cache, token);
      if (!resolved) continue;
      refsByKey.set(mediaId, resolved);
    }
  }

  return Array.from(refsByKey.values());
}

async function resolveTopLevelGenerationReferences(genData, cache, token, currentGenId) {
  if (!genData || typeof genData !== "object") return [];

  const refsByKey = new Map();
  const candidateEntries = [];

  const topLevelGenId = getReferenceGenerationId(genData);
  const topLevelMediaId = getReferenceMediaId(genData);
  if (topLevelGenId || topLevelMediaId || genData.servable_url) {
    candidateEntries.push(genData);
  }

  const remixConfig = genData.remix_config;
  if (remixConfig && typeof remixConfig === "object") {
    const remixGenId = getReferenceGenerationId(remixConfig);
    const remixMediaId = getReferenceMediaId(remixConfig);
    if (remixGenId || remixMediaId || remixConfig.servable_url) {
      candidateEntries.push(remixConfig);
    }
  }

  for (const entry of candidateEntries) {
    const resolved = await resolveSingleInpaintItem(entry, cache, token);
    if (!resolved) continue;
    if (resolved.genId && resolved.genId === currentGenId) continue;
    const key =
      String(resolved.mediaId || "") ||
      String(resolved.genId || "") ||
      String(resolved.sourceTaskId || "") ||
      String(resolved.thumbUrl || resolved.mediaUrl || "");
    if (!key || refsByKey.has(key)) continue;
    refsByKey.set(key, resolved);
  }

  return Array.from(refsByKey.values());
}

function collectMatches(text, regex) {
  const results = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push(String(match[1] || ""));
  }
  return results;
}

async function resolveDetailPageReferences(item, cache) {
  const detailUrl = String(item?.detailUrl || "");
  if (!detailUrl) return [];
  const currentGenId = extractGenerationId(item);
  const html = await fetchTextWithCredentials(detailUrl, cache, `detail-html:${detailUrl}`);
  if (!html) return [];

  const refsByKey = new Map();
  const anchorRegex = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = toAbsoluteUrlSafe(match[1], detailUrl);
    const body = match[2] || "";
    const mediaId = extractMediaIdFromText(href);
    const genId = extractGenIdFromText(href);
    const imgSrcMatch = body.match(/<img\b[^>]*src="([^"]+)"/i);
    const thumbUrl = imgSrcMatch ? toAbsoluteUrlSafe(imgSrcMatch[1], detailUrl) : "";
    const mediaUrl = thumbUrl ? thumbUrl.replace(/_thumb(?=\.[a-z0-9]+(?:[?#]|$))/i, "") : "";
    const sourceTaskId = extractTaskIdFromAssetUrl(mediaUrl || thumbUrl || href);
    if (genId && currentGenId && genId === currentGenId) {
      continue;
    }
    if (!mediaId && !genId && !sourceTaskId) {
      continue;
    }
    const key = mediaId || genId || sourceTaskId || thumbUrl || mediaUrl;
    if (!key || refsByKey.has(key)) {
      continue;
    }
    refsByKey.set(key, {
      mediaId,
      genId,
      sourceTaskId,
      mediaUrl,
      thumbUrl,
      alt: ""
    });
  }

  return Array.from(refsByKey.values());
}

async function resolveInpaintItems(inpaintItems, cache, token) {
  if (!Array.isArray(inpaintItems) || !inpaintItems.length) return [];

  const validEntries = inpaintItems.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return Boolean(
      getReferenceMediaId(entry) ||
      getReferenceGenerationId(entry) ||
      entry.servable_url
    );
  });

  const resolved = await Promise.all(validEntries.map((entry) => resolveSingleInpaintItem(entry, cache, token)));
  return resolved.filter(Boolean);
}

function toAbsoluteUrlSafe(value, base) {
  try {
    return new URL(value, base || "https://sora.chatgpt.com/").toString();
  } catch {
    return String(value || "");
  }
}

function extractMediaIdFromText(value) {
  const text = decodeTextForIdMatch(value);
  const m = text.match(/media_[A-Za-z0-9]+/);
  return m ? m[0] : "";
}

function extractGenIdFromText(value) {
  const text = decodeTextForIdMatch(value);
  const m = text.match(/gen_[A-Za-z0-9]+/);
  return m ? m[0] : "";
}

function decodeTextForIdMatch(value) {
  const text = String(value || "");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

async function resolveSingleInpaintItem(entry, cache, token) {
  const mediaId = getReferenceMediaId(entry);
  const genId = getReferenceGenerationId(entry);

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

  const sourceTaskId = extractTaskIdFromAssetUrl(mediaUrl || thumbUrl);

  if (!mediaId && !genId && !mediaUrl && !thumbUrl && !sourceTaskId) {
    return null;
  }

  return {
    mediaId,
    genId,
    sourceTaskId,
    mediaUrl,
    thumbUrl,
    alt: entry.description || ""
  };
}

function getReferenceMediaId(entry) {
  return String(
    entry?.upload_media_id ||
    entry?.source_upload_media_id ||
    entry?.reference_media_id ||
    ""
  );
}

function getReferenceGenerationId(entry) {
  return String(
    entry?.generation_id ||
    entry?.gen_id ||
    entry?.source_generation_id ||
    entry?.source_gen_id ||
    entry?.parent_generation_id ||
    entry?.reference_generation_id ||
    entry?.parent_id ||
    entry?.source_id ||
    ""
  );
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

function appendToGroupState(groupState, imageBaseName, ext, metadata, batchReferenceRegistry = null) {
  const imageFile = `${imageBaseName}${ext}`;
  groupState.images.push({
    index: metadata.index,
    file: imageFile,
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
      const sourceTaskId = String(ref.sourceTaskId || "");
      const key = mediaId || genId || sourceTaskId || String(ref.thumbUrl || ref.mediaUrl || "");
      if (!key) continue;
      if (groupState.referencesByKey.has(key)) continue;
      groupState.referencesByKey.set(key, {
        mediaId,
        genId,
        sourceTaskId,
        mediaUrl: String(ref.mediaUrl || ""),
        thumbUrl: String(ref.thumbUrl || ""),
        alt: String(ref.alt || "")
      });
    }
  }
  if (metadata.referenceDebug) {
    groupState.referenceDebug.push({
      index: metadata.index,
      detailUrl: metadata.detailUrl,
      referenceDebug: metadata.referenceDebug
    });
  }
  if (batchReferenceRegistry) {
    const referenceIds = registerMetadataReferencesInBatchRegistry(metadata, batchReferenceRegistry);
    groupState.imageReferenceIdsByFile.set(imageFile, referenceIds);
  }
}

function buildGroupImagesMetadata(groupState) {
  return (Array.isArray(groupState?.images) ? groupState.images : []).map((image) => ({
    ...image,
    referenceIds: Array.isArray(groupState?.imageReferenceIdsByFile?.get(image.file))
      ? [...groupState.imageReferenceIdsByFile.get(image.file)]
      : []
  }));
}

function markRegistryReferenceMissing(registry, ref) {
  if (!registry) return;
  const key = buildReferenceRegistryKey(ref);
  if (!key || !registry.entriesByKey.has(key)) return;
  const entry = registry.entriesByKey.get(key);
  entry.status = "missing";
  if (!entry.file) entry.file = "";
}

function buildReferenceManifestPayload(registry) {
  const refs = Array.isArray(registry?.orderedEntries)
    ? registry.orderedEntries.map((entry) => {
        const out = {
          id: String(entry?.id || ""),
          type: String(entry?.type || ""),
          mediaId: String(entry?.mediaId || ""),
          genId: String(entry?.genId || ""),
          sourceTaskId: String(entry?.sourceTaskId || ""),
          file: String(entry?.file || ""),
          mediaUrl: String(entry?.mediaUrl || ""),
          thumbUrl: String(entry?.thumbUrl || ""),
          alt: String(entry?.alt || "")
        };
        if (entry?.thumbFile) out.thumbFile = String(entry.thumbFile);
        if (entry?.status && entry.status !== "pending") out.status = String(entry.status);
        return out;
      })
    : [];

  return {
    version: 1,
    refs
  };
}

function buildSharedReferenceFilename(cleanedPrefix, index, sourceUrl) {
  const ext = guessExtension(sourceUrl) || ".bin";
  return `${cleanedPrefix}/REFERENCES/ref_${String(index + 1).padStart(6, "0")}${ext}`;
}

async function exportSharedReferencesAsFiles(cleanedPrefix, registry, nativeDownloadCache) {
  const refs = Array.isArray(registry?.orderedEntries) ? registry.orderedEntries : [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const sourceUrls = await getReferenceSourceCandidates(ref, nativeDownloadCache);
    if (!sourceUrls.length) {
      ref.status = "missing";
      ref.file = "";
      continue;
    }
    let exported = false;
    for (const sourceUrl of sourceUrls) {
      const filename = buildSharedReferenceFilename(cleanedPrefix, i, sourceUrl);
      try {
        await downloadUrl(sourceUrl, filename);
        ref.file = filename;
        delete ref.status;
        exported = true;
        break;
      } catch {
        try {
          const bytes = await fetchBinaryBytes(sourceUrl, 15000);
          const ext = guessExtension(sourceUrl);
          const mime = extensionToMime(ext) || "application/octet-stream";
          await downloadBlob(new Blob([bytes], { type: mime }), filename);
          ref.file = filename;
          delete ref.status;
          exported = true;
          break;
        } catch {
          // Try next candidate
        }
      }
    }
    if (!exported) {
      ref.status = "missing";
      ref.file = "";
    }
  }
}

async function exportSharedReferencesToZip(zip, cleanedPrefix, registry, nativeDownloadCache) {
  const refs = Array.isArray(registry?.orderedEntries) ? registry.orderedEntries : [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const sourceUrls = await getReferenceSourceCandidates(ref, nativeDownloadCache);
    if (!sourceUrls.length) {
      ref.status = "missing";
      ref.file = "";
      continue;
    }
    let exported = false;
    for (const sourceUrl of sourceUrls) {
      try {
        const bytes = await fetchBinaryBytes(sourceUrl, 15000);
        const filename = buildSharedReferenceFilename(cleanedPrefix, i, sourceUrl);
        zip.addFile(filename, bytes);
        ref.file = filename;
        delete ref.status;
        exported = true;
        break;
      } catch {
        // Try next candidate
      }
    }
    if (!exported) {
      ref.status = "missing";
      ref.file = "";
    }
  }
}

// ── Generation summaries ──

async function writeGenerationSummariesAsFiles(cleanedPrefix, generationMap, runId, nativeDownloadCache, options, batchReferenceRegistry = null) {
  const includePrompts = options?.includePrompts !== false;
  const includePresets = options?.includePresets !== false;
  const includeReferences = options?.includeReferences !== false;

  if (includeReferences && batchReferenceRegistry) {
    await exportSharedReferencesAsFiles(cleanedPrefix, batchReferenceRegistry, nativeDownloadCache);
    await downloadTextFile(
      JSON.stringify(buildReferenceManifestPayload(batchReferenceRegistry), null, 2),
      `${cleanedPrefix}/references.json`,
      "application/json"
    );
  }

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
      await downloadTextFile(
        buildReferencesText(groupState, batchReferenceRegistry),
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
      images: buildGroupImagesMetadata(groupState)
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
      generationMeta.referenceDebug = groupState.referenceDebug;
    }
    await downloadTextFile(
      JSON.stringify(generationMeta, null, 2),
      `${cleanedPrefix}/${groupState.folder}/metadata.json`,
      "application/json"
    );
  }
}

async function writeGenerationSummariesToZip(zip, cleanedPrefix, generationMap, runId, nativeDownloadCache, options, batchReferenceRegistry = null) {
  const includePrompts = options?.includePrompts !== false;
  const includePresets = options?.includePresets !== false;
  const includeReferences = options?.includeReferences !== false;

  if (includeReferences && batchReferenceRegistry) {
    await exportSharedReferencesToZip(zip, cleanedPrefix, batchReferenceRegistry, nativeDownloadCache);
    zip.addTextFile(
      `${cleanedPrefix}/references.json`,
      JSON.stringify(buildReferenceManifestPayload(batchReferenceRegistry), null, 2)
    );
  }

  for (const groupState of generationMap.values()) {
    if (includePrompts && groupState.prompt) {
      zip.addTextFile(`${cleanedPrefix}/${groupState.folder}/prompt.txt`, `${groupState.prompt}\n`);
    }
    if (includePresets && (groupState.presetName || groupState.presetId || groupState.presetDescription || groupState.presetUrl)) {
      zip.addTextFile(`${cleanedPrefix}/${groupState.folder}/preset.txt`, buildPresetText(groupState));
    }
    if (includeReferences) {
      zip.addTextFile(`${cleanedPrefix}/${groupState.folder}/references.txt`, buildReferencesText(groupState, batchReferenceRegistry));
    }

    const generationMeta = {
      runId,
      generatedAt: new Date().toISOString(),
      groupKey: groupState.groupKey,
      folder: groupState.folder,
      title: groupState.title,
      taskId: groupState.taskId,
      taskUrl: groupState.taskUrl,
      images: buildGroupImagesMetadata(groupState)
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
      generationMeta.referenceDebug = groupState.referenceDebug;
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
    const credentialModes = ["include", "omit"];
    let lastError = null;
    for (const credentials of credentialModes) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          credentials,
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("Failed to fetch binary bytes");
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

function isAllocationError(error) {
  return /array buffer allocation failed/i.test(String(error?.message || error || ""));
}

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
    referenceDebug: [],
    imageReferenceIdsByFile: new Map(),
    prompt: "",
    images: []
  };
  map.set(group.groupKey, state);
  return state;
}

// ── Reference image export ──

async function exportReferenceImagesAsFiles(cleanedPrefix, groupState, nativeDownloadCache, batchReferenceRegistry = null) {
  const refs = Array.from(groupState.referencesByKey.values());
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const sourceUrls = await getReferenceSourceCandidates(ref, nativeDownloadCache);
    if (!sourceUrls.length) {
      markRegistryReferenceMissing(batchReferenceRegistry, ref);
      continue;
    }
    let exported = false;
    for (const sourceUrl of sourceUrls) {
      try {
        const ext = guessExtension(sourceUrl);
        const filename = `${cleanedPrefix}/${groupState.folder}/references/reference_${String(i + 1).padStart(2, "0")}${ext}`;
        await downloadUrl(sourceUrl, filename);
        exported = true;
        break;
      } catch {
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
    }
    if (!exported) {
      markRegistryReferenceMissing(batchReferenceRegistry, ref);
      console.warn("[Sora Downloader] Failed to export reference image", ref);
    }
  }
}

async function exportReferenceImagesToZip(zip, cleanedPrefix, groupState, nativeDownloadCache, batchReferenceRegistry = null) {
  const refs = Array.from(groupState.referencesByKey.values());
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const sourceUrls = await getReferenceSourceCandidates(ref, nativeDownloadCache);
    if (!sourceUrls.length) {
      markRegistryReferenceMissing(batchReferenceRegistry, ref);
      continue;
    }
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
      markRegistryReferenceMissing(batchReferenceRegistry, ref);
      console.warn("[Sora Downloader] Failed to export reference image to ZIP", ref);
    }
  }
}

async function getReferenceSourceCandidates(ref, nativeDownloadCache, cache = sharedReferenceCandidateCache) {
  const cacheKey = buildReferenceRegistryKey(ref);
  if (cacheKey && cache.has(cacheKey)) {
    return [...(cache.get(cacheKey) || [])];
  }

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
  const resolved = Array.from(new Set([...deThumbed, ...candidates].filter(Boolean)));
  if (cacheKey) {
    cache.set(cacheKey, resolved);
  }
  return resolved;
}

// ── Text builders ──

function getReferenceRegistryEntry(ref, registry) {
  const key = buildReferenceRegistryKey(ref);
  if (!key || !registry?.entriesByKey?.has(key)) return null;
  return registry.entriesByKey.get(key) || null;
}

function getReferenceFileLabel(ref, registry) {
  const entry = getReferenceRegistryEntry(ref, registry);
  const filePath = String(entry?.file || "");
  if (filePath) {
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || filePath;
  }
  return ref.mediaId || ref.genId || ref.sourceTaskId || "(missing reference file)";
}

function getReferenceTypeLabel(ref, registry) {
  const entry = getReferenceRegistryEntry(ref, registry);
  const type = String(entry?.type || "");
  if (type === "upload" || type === "generation") return type;
  if (ref.mediaId) return "upload";
  if (ref.genId) return "generation";
  return "unknown";
}

function buildReferencesText(groupState, registry = null) {
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
    const fileLabel = getReferenceFileLabel(r, registry);
    const typeLabel = getReferenceTypeLabel(r, registry);
    lines.push(`${i + 1}. ${fileLabel}`);
    lines.push(`   Type: ${typeLabel}`);
    if (r.mediaId) lines.push(`   Media ID: ${r.mediaId}`);
    if (r.genId) lines.push(`   Gen ID: ${r.genId}`);
    if (r.sourceTaskId) lines.push(`   Source Task ID: ${r.sourceTaskId}`);
    const entry = getReferenceRegistryEntry(r, registry);
    if (entry?.status === "missing") lines.push("   Status: missing");
  }
  return `${lines.join("\n")}\n`;
}

function extractTaskIdFromAssetUrl(url) {
  if (!url) return "";
  try {
    const pathname = decodeURIComponent(new URL(url).pathname || "");
    const match = pathname.match(/task_[A-Za-z0-9]+/);
    return match ? match[0] : "";
  } catch {
    return "";
  }
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

let _viewerHtmlCache = null;
async function fetchViewerHtml() {
  if (_viewerHtmlCache) return _viewerHtmlCache;
  try {
    const url = chrome.runtime.getURL("viewer.html");
    const resp = await fetch(url);
    _viewerHtmlCache = await resp.text();
  } catch {
    _viewerHtmlCache = null;
  }
  return _viewerHtmlCache;
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
