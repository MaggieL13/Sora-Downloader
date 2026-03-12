(function initContentScript() {
  const accumulatedItemsByKey = new Map();
  let scanPaused = false;
  let scanCanceled = false;
  let resetStagnant = false;
  const HIGHLIGHT_STYLE_ID = "sora-downloader-scan-highlight-style";
  const SELECTION_STYLE_ID = "sora-downloader-selection-style";
  const selectedItemKeys = new Set();
  const selectedItemsMap = new Map(); // key → full item object (scan-free selection)
  let selectionModeActive = false;
  let selectionObserver = null;
  let lastCheckedKey = null;
  const PROMPT_SELECTORS = [
    'div.truncate.text-token-text-primary',
    '[class*="text-token-text-primary"]',
    '[data-testid*="prompt"]',
    '[class*="prompt"]',
    "figcaption",
    "p",
    ".caption",
    ".description"
  ];

  const CARD_SELECTORS = [
    '[class*="group/tile"]',
    ".group\\/tile",
    "article",
    "figure",
    "li",
    '[role="listitem"]'
  ];
  const REFERENCE_LINK_SELECTOR = 'a[href*="media_"], a[href*="gen_"]';

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) {
      return;
    }

    if (message.type === "SORA_CLEAR_SCAN_CACHE") {
      accumulatedItemsByKey.clear();
      clearScanHighlights();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "SORA_SET_SCAN_PAUSED") {
      scanPaused = Boolean(message.paused);
      sendResponse({ ok: true, paused: scanPaused });
      return;
    }

    if (message.type === "SORA_CANCEL_SCAN") {
      scanCanceled = true;
      scanPaused = false;
      sendResponse({ ok: true, canceled: true });
      return;
    }

    if (message.type === "SORA_CONTINUE_PAST_STALL") {
      resetStagnant = true;
      scanPaused = false;
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "SORA_GET_SCAN_SNAPSHOT") {
      sendResponse({
        ok: true,
        items: Array.from(accumulatedItemsByKey.values())
      });
      return;
    }

    if (message.type === "SORA_ENTER_SELECTION_MODE") {
      selectionModeActive = true;
      ensureSelectionStyle();
      addSelectionCheckboxesToAllCards();
      startSelectionObserver();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "SORA_EXIT_SELECTION_MODE") {
      selectionModeActive = false;
      lastCheckedKey = null;
      stopSelectionObserver();
      removeSelectionCheckboxes();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "SORA_GET_SELECTED_ITEMS") {
      sendResponse({ ok: true, keys: Array.from(selectedItemKeys) });
      return;
    }

    if (message.type === "SORA_GET_SELECTED_ITEM_DATA") {
      sendResponse({ ok: true, items: Array.from(selectedItemsMap.values()) });
      return;
    }

    if (message.type === "SORA_SELECT_ALL") {
      document.querySelectorAll(".sora-dl-select-checkbox").forEach((cb) => {
        cb.checked = true;
        const key = cb.dataset.soraDlKey;
        if (key) {
          selectedItemKeys.add(key);
          const item = extractItemFromCard(cb.closest("[data-sora-dl-card]") || cb.closest("li, article, figure, [class*='group/tile']"));
          if (item) selectedItemsMap.set(key, item);
        }
      });
      updateSelectionBadges();
      sendResponse({ ok: true, count: selectedItemKeys.size });
      return;
    }

    if (message.type === "SORA_DESELECT_ALL") {
      document.querySelectorAll(".sora-dl-select-checkbox").forEach((cb) => {
        cb.checked = false;
        const card = cb.closest("[data-sora-dl-card]") || cb.closest("li, article, figure, [class*='group/tile']");
        if (card) card.classList.remove("sora-dl-selected");
      });
      selectedItemKeys.clear();
      selectedItemsMap.clear();
      updateSelectionBadges();
      sendResponse({ ok: true, count: 0 });
      return;
    }

    if (message.type !== "SORA_SCAN" && message.type !== "SORA_SCAN_WITH_SCROLL") {
      return;
    }

    if (message.type === "SORA_SCAN_WITH_SCROLL") {
      scanWithAutoScroll(message.options || {})
        .then((items) => {
          const merged = mergeIntoAccumulator(items);
          sendResponse({ ok: true, items: merged });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: String(error) });
        });
      return true;
    }

    try {
      const items = scanGenerationItems();
      const merged = mergeIntoAccumulator(items);
      sendResponse({ ok: true, items: merged });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
  });

  function scanGenerationItems() {
    ensureHighlightStyle();
    const images = Array.from(document.querySelectorAll("img"));
    const seen = new Set();
    const items = [];

    images.forEach((img, index) => {
      const candidateUrls = getImageCandidates(img);
      const imageUrl = candidateUrls[0] || "";
      if (!imageUrl || imageUrl.startsWith("data:")) {
        return;
      }
      if (isReferenceThumbnailImage(img, imageUrl)) {
        return;
      }

      const card = findCardContainer(img);
      const record = findRecordContainer(card || img);
      const detailLink = extractDetailLink(card || img);
      const altText = (img.alt || "").toLowerCase();
      const seemsGeneratedImage = altText.includes("generated image");
      if (!detailLink && !seemsGeneratedImage) {
        return;
      }
      const inferredTaskId = extractTaskIdFromAssetUrl(imageUrl);
      const taskLink = extractTaskLink(record, inferredTaskId);
      const title = extractTitle(record);
      const prompt = extractPrompt(record, card, img);
      const preset = extractPreset(record, card);
      const referenceImages = extractReferenceImages(record, card, img);
      const dedupeKey = `${detailLink || imageUrl}::${prompt}`;

      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);
      markAsScanned(card || img);

      items.push({
        id: crypto.randomUUID(),
        imageUrl,
        imageCandidates: candidateUrls,
        detailUrl: detailLink,
        taskUrl: taskLink,
        taskId: inferredTaskId,
        presetName: preset.name,
        presetId: preset.id,
        presetUrl: preset.url,
        presetDescription: preset.description,
        referenceImages,
        referenceMediaIds: referenceImages.map((ref) => ref.mediaId).filter(Boolean),
        referenceCount: referenceImages.length,
        title,
        prompt,
        alt: img.alt || "",
        pageTitle: document.title || "",
        pageUrl: location.href,
        collectedAt: new Date().toISOString(),
        index: index + 1
      });
    });

    return items;
  }

  /**
   * Find the actual scrollable container. SORA's explore/grid view often uses
   * an inner scrollable div rather than the window/document scroll.
   */
  function findScrollContainer() {
    // Common SORA scroll container selectors
    const candidates = [
      'main',
      '[role="main"]',
      'div.overflow-y-auto',
      'div.overflow-auto',
      'div[class*="overflow-y"]',
      'div[class*="overflow-auto"]'
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        // Must be significantly tall and actually scrollable
        if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
          const style = getComputedStyle(el);
          const overflow = style.overflowY || style.overflow;
          if (overflow === "auto" || overflow === "scroll") {
            return el;
          }
        }
      }
    }
    return null;
  }

  function getScrollInfo(container) {
    if (container) {
      return {
        scrollY: container.scrollTop,
        viewportHeight: container.clientHeight,
        scrollHeight: container.scrollHeight
      };
    }
    return {
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight
    };
  }

  function scrollDown(container, amount) {
    if (container) {
      container.scrollBy(0, amount);
    } else {
      window.scrollBy(0, amount);
    }
  }

  async function scanWithAutoScroll(options) {
    scanCanceled = false;
    const maxSteps = clampNumber(options.maxSteps, 1, 500, 90);
    const totalMaxSteps = clampNumber(options.totalMaxSteps, maxSteps, 10000, 5000);
    const baseSettleMs = clampNumber(options.settleMs, 100, 3000, 350);
    const stagnantLimit = 12;
    let stagnantRounds = 0;
    let currentSettleMs = baseSettleMs;
    let prevScrollY = -1;
    let totalSteps = 0;

    // Detect the scroll container (inner div or window)
    const scrollContainer = findScrollContainer();

    const byKey = new Map();

    while (totalSteps < totalMaxSteps) {
      if (scanCanceled) {
        break;
      }

      // Check if we've hit the stagnant limit — pause and ask user
      if (stagnantRounds >= stagnantLimit) {
        scanPaused = true;
        reportScanStalled({
          found: byKey.size,
          step: totalSteps,
          maxSteps: totalMaxSteps,
          scrollY: Math.round(getScrollInfo(scrollContainer).scrollY)
        });
        await waitWhilePaused();
        if (scanCanceled) break;
        // User chose "Keep Scanning" — reset stagnant counter
        if (resetStagnant) {
          resetStagnant = false;
          stagnantRounds = 0;
          currentSettleMs = baseSettleMs;
        }
      }

      await waitWhilePaused();
      const current = scanGenerationItems();
      for (const item of current) {
        const key = item.detailUrl || item.imageUrl;
        if (!key) continue;
        if (!byKey.has(key)) {
          byKey.set(key, item);
        } else {
          const existing = byKey.get(key);
          byKey.set(key, mergeItemRecords(existing, item));
        }
      }

      const beforeCount = byKey.size;
      const scrollInfo = getScrollInfo(scrollContainer);
      scrollDown(scrollContainer, Math.floor(scrollInfo.viewportHeight * 0.9));
      if (scanCanceled) {
        break;
      }
      await waitWhilePaused();

      // Wait for the DOM to settle: base timer + wait for lazy images + MutationObserver
      await sleep(currentSettleMs);
      await waitForDomSettle();

      const afterStepItems = scanGenerationItems();
      for (const item of afterStepItems) {
        const key = item.detailUrl || item.imageUrl;
        if (!key) continue;
        if (!byKey.has(key)) {
          byKey.set(key, item);
        } else {
          const existing = byKey.get(key);
          byKey.set(key, mergeItemRecords(existing, item));
        }
      }

      const afterScrollInfo = getScrollInfo(scrollContainer);
      const noGrowth = byKey.size === beforeCount;
      const noMovement = Math.abs(afterScrollInfo.scrollY - prevScrollY) < 2;
      const nearBottom = afterScrollInfo.viewportHeight + afterScrollInfo.scrollY >= afterScrollInfo.scrollHeight - 20;
      const soraIsLoading = isSoraLoading();

      if (soraIsLoading) {
        // SORA's spinner is visible — content is still loading, don't count as stagnant
        stagnantRounds = Math.max(0, stagnantRounds - 1);
        currentSettleMs = Math.min(currentSettleMs + 200, 3000);
      } else if (noGrowth && (noMovement || nearBottom)) {
        stagnantRounds += 1;
        // Adaptive settle: double the wait time each stagnant round (cap at 3000ms)
        currentSettleMs = Math.min(currentSettleMs * 2, 3000);
      } else {
        stagnantRounds = 0;
        // Reset settle time when new items appear
        currentSettleMs = baseSettleMs;
      }

      // Keep global snapshot fresh so popup can live-refresh found items.
      mergeIntoAccumulator(Array.from(byKey.values()));

      reportScanProgress({
        step: totalSteps + 1,
        maxSteps: totalMaxSteps,
        found: byKey.size,
        stagnantRounds,
        stagnantLimit,
        scrollY: Math.round(afterScrollInfo.scrollY),
        nearBottom
      });

      prevScrollY = afterScrollInfo.scrollY;
      totalSteps += 1;
    }

    return Array.from(byKey.values());
  }

  /**
   * Wait for the visible DOM to settle:
   * 1. Wait for all in-viewport images to have naturalWidth > 0 (loaded)
   * 2. Use a MutationObserver to catch late-arriving img elements
   * Gives up after maxWaitMs to avoid blocking forever.
   */
  function waitForDomSettle(maxWaitMs = 4000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + maxWaitMs;
      let observer = null;
      let resolved = false;

      function done() {
        if (resolved) return;
        resolved = true;
        if (observer) observer.disconnect();
        resolve();
      }

      function allViewportImagesLoaded() {
        const viewportBottom = window.scrollY + window.innerHeight;
        const viewportTop = window.scrollY;
        const imgs = document.querySelectorAll("img");
        for (const img of imgs) {
          const rect = img.getBoundingClientRect();
          const absTop = rect.top + window.scrollY;
          const absBottom = rect.bottom + window.scrollY;
          // Only check images in or near the viewport
          if (absBottom < viewportTop - 200 || absTop > viewportBottom + 200) continue;
          // Skip tiny placeholders and data URIs
          if (rect.width < 10 || rect.height < 10) continue;
          const src = img.currentSrc || img.src || "";
          if (!src || src.startsWith("data:")) continue;
          // Image not yet loaded
          if (!img.complete || img.naturalWidth === 0) return false;
        }
        return true;
      }

      // Poll for image loading + watch for new img elements via MutationObserver
      observer = new MutationObserver(() => {
        // New nodes arrived — give images a moment to start loading, then re-check
        setTimeout(() => {
          if (Date.now() >= deadline) { done(); return; }
          if (allViewportImagesLoaded()) done();
        }, 120);
      });

      observer.observe(document.body, { childList: true, subtree: true });

      // Also poll periodically in case images load without DOM mutations
      const pollInterval = setInterval(() => {
        if (Date.now() >= deadline || resolved) {
          clearInterval(pollInterval);
          done();
          return;
        }
        if (allViewportImagesLoaded()) {
          clearInterval(pollInterval);
          done();
        }
      }, 150);

      // Immediate check
      if (allViewportImagesLoaded()) {
        clearInterval(pollInterval);
        done();
      }
    });
  }

  function mergeIntoAccumulator(items) {
    for (const item of items || []) {
      const key = item.detailUrl || item.imageUrl;
      if (!key) continue;
      if (!accumulatedItemsByKey.has(key)) {
        accumulatedItemsByKey.set(key, item);
        continue;
      }
      const existing = accumulatedItemsByKey.get(key);
      accumulatedItemsByKey.set(key, mergeItemRecords(existing, item));
    }
    return Array.from(accumulatedItemsByKey.values());
  }

  function mergeItemRecords(existing, incoming) {
    const left = existing || {};
    const right = incoming || {};
    const mergedRefs = mergeReferenceImages(left.referenceImages, right.referenceImages);
    const mergedMediaIds = Array.from(
      new Set([
        ...(Array.isArray(left.referenceMediaIds) ? left.referenceMediaIds : []),
        ...(Array.isArray(right.referenceMediaIds) ? right.referenceMediaIds : []),
        ...mergedRefs.map((r) => r.mediaId).filter(Boolean)
      ])
    );

    return {
      ...left,
      ...right,
      imageUrl: preferLongerString(left.imageUrl, right.imageUrl),
      detailUrl: preferLongerString(left.detailUrl, right.detailUrl),
      taskUrl: preferLongerString(left.taskUrl, right.taskUrl),
      taskId: preferLongerString(left.taskId, right.taskId),
      title: preferLongerString(left.title, right.title),
      prompt: preferLongerString(left.prompt, right.prompt),
      presetName: preferLongerString(left.presetName, right.presetName),
      presetId: preferLongerString(left.presetId, right.presetId),
      presetUrl: preferLongerString(left.presetUrl, right.presetUrl),
      presetDescription: preferLongerString(left.presetDescription, right.presetDescription),
      imageCandidates: Array.from(new Set([...(left.imageCandidates || []), ...(right.imageCandidates || [])].filter(Boolean))),
      referenceImages: mergedRefs,
      referenceMediaIds: mergedMediaIds,
      referenceCount: mergedRefs.length,
      collectedAt: preferLongerString(left.collectedAt, right.collectedAt)
    };
  }

  function mergeReferenceImages(a, b) {
    const byKey = new Map();
    const push = (ref) => {
      if (!ref || typeof ref !== "object") return;
      const mediaId = String(ref.mediaId || "");
      const genId = String(ref.genId || "");
      const mediaUrl = String(ref.mediaUrl || "");
      const thumbUrl = String(ref.thumbUrl || "");
      const alt = String(ref.alt || "");
      const key = mediaId || genId || thumbUrl || mediaUrl;
      if (!key) return;
      if (!byKey.has(key)) {
        byKey.set(key, { mediaId, genId, mediaUrl, thumbUrl, alt });
        return;
      }
      const existing = byKey.get(key);
      byKey.set(key, {
        mediaId: preferLongerString(existing.mediaId, mediaId),
        genId: preferLongerString(existing.genId, genId),
        mediaUrl: preferLongerString(existing.mediaUrl, mediaUrl),
        thumbUrl: preferLongerString(existing.thumbUrl, thumbUrl),
        alt: preferLongerString(existing.alt, alt)
      });
    };
    for (const ref of Array.isArray(a) ? a : []) push(ref);
    for (const ref of Array.isArray(b) ? b : []) push(ref);
    return Array.from(byKey.values());
  }

  function preferLongerString(a, b) {
    const left = String(a || "");
    const right = String(b || "");
    return right.length > left.length ? right : left;
  }

  function getImageCandidates(img) {
    const urls = [];
    const srcset = img.getAttribute("srcset") || img.srcset || "";
    if (srcset) {
      const rankedSrcset = parseSrcset(srcset)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.url);
      urls.push(...rankedSrcset.flatMap(expandUrlVariants));
    }

    const src = img.currentSrc || img.src || "";
    if (src) {
      urls.push(...expandUrlVariants(toAbsoluteUrl(src)));
    }

    const unique = Array.from(new Set(urls.filter(Boolean)));
    unique.sort(compareCandidateQuality);
    return unique;
  }

  function toAbsoluteUrl(url) {
    try {
      return new URL(url, location.href).toString();
    } catch {
      return "";
    }
  }

  function findCardContainer(node) {
    for (const selector of CARD_SELECTORS) {
      const container = node.closest(selector);
      if (container) {
        return container;
      }
    }
    return node.parentElement || null;
  }

  function findRecordContainer(node) {
    return node.closest('[data-index]') || node.closest(".flex.flex-col.gap-4") || node.parentElement || document.body;
  }

  function extractDetailLink(node) {
    const link = node.querySelector('a[href^="/g/gen_"]') || node.closest('a[href^="/g/gen_"]');
    return link?.href || "";
  }

  function extractTaskLink(recordContainer, taskIdHint) {
    if (recordContainer) {
      const link = recordContainer.querySelector('a[href^="/t/task_"]');
      if (link?.href) return link.href;
    }

    if (taskIdHint) {
      const exact = document.querySelector(`a[href*="${taskIdHint}"]`);
      if (exact?.href) return exact.href;
    }

    const global = document.querySelector('a[href^="/t/task_"]');
    return global?.href || "";
  }

  function extractTitle(recordContainer) {
    if (!recordContainer) return "";
    const taskLink = recordContainer.querySelector('a[href^="/t/task_"], a[href^="/g/gen_"]');
    return normalizeText(taskLink?.textContent || "");
  }

  function extractPrompt(recordContainer, cardContainer, imageNode) {
    if (recordContainer) {
      for (const selector of PROMPT_SELECTORS) {
        const elements = Array.from(recordContainer.querySelectorAll(selector));
        if (!elements.length) continue;
        const best = elements
          .map((el) => normalizeText(el.textContent || ""))
          .filter((text) => looksLikePrompt(text))
          .sort((a, b) => b.length - a.length)[0];
        if (best) {
          return best;
        }
      }
    }

    if (cardContainer) {
      for (const selector of PROMPT_SELECTORS) {
        const element = cardContainer.querySelector(selector);
        if (element) {
          const text = normalizeText(element.textContent || "");
          if (looksLikePrompt(text)) {
            return text;
          }
        }
      }
    }

    if (recordContainer) {
      const containerText = normalizeText(recordContainer.textContent || "");
      if (looksLikePrompt(containerText)) {
        return containerText;
      }
    }

    const fallbackText = normalizeText(imageNode.alt || "");
    if (looksLikePrompt(fallbackText)) {
      return fallbackText;
    }

    return "Prompt not detected";
  }

  function extractPreset(recordContainer, cardContainer) {
    const scope = recordContainer || cardContainer || document;
    const presetLink = scope.querySelector('a[href*="/explore/presets?pid="]');
    const presetUrl = presetLink?.href || "";
    const presetId = extractPresetIdFromUrl(presetUrl);

    let presetName = "";
    let presetDescription = "";

    // Closed state often shows preset button text, e.g. "WISHFALL".
    const presetButton = scope.querySelector('button[aria-haspopup="dialog"]');
    if (presetButton) {
      const btnText = normalizeText(presetButton.textContent || "");
      if (looksLikePresetName(btnText)) {
        presetName = btnText;
      }
    }

    // Open popover title + description can be present when user expands preset details.
    const popoverTitle = scope.querySelector('[role="dialog"] [title]');
    if (!presetName && popoverTitle) {
      const titleText = normalizeText(popoverTitle.textContent || "");
      if (looksLikePresetName(titleText)) {
        presetName = titleText;
      }
    }

    const descNode = scope.querySelector('[role="dialog"] .whitespace-pre-line');
    if (descNode) {
      const descText = normalizeText(descNode.textContent || "");
      if (descText.length > 20) {
        presetDescription = descText;
      }
    }

    return {
      name: presetName,
      id: presetId,
      url: presetUrl,
      description: presetDescription
    };
  }

  function extractReferenceImages(recordContainer, cardContainer, imageNode) {
    const scope = recordContainer || cardContainer || document;
    let anchors = getReferenceAnchors(scope);
    if (!anchors.length) {
      anchors = getClosestDocumentReferenceAnchors(imageNode);
    }
    const byRefKey = new Map();

    const currentGenId = extractGenIdFromText(extractDetailLink(cardContainer || imageNode));
    for (const anchor of anchors) {
      const href = toAbsoluteUrl(anchor.getAttribute("href") || anchor.href || "");
      const mediaId = extractMediaIdFromText(href);
      const genId = extractGenIdFromText(href);
      if (genId && currentGenId && genId === currentGenId) {
        continue;
      }
      const refKey = mediaId || genId || href;
      if (!refKey) {
        continue;
      }
      if (byRefKey.has(refKey)) {
        continue;
      }

      const img = anchor.querySelector("img");
      const rawImageUrl = img?.currentSrc || img?.src || "";
      const thumbUrl = rawImageUrl ? toAbsoluteUrl(rawImageUrl) : "";
      const mediaUrl = thumbUrl ? toAbsoluteUrl(thumbUrl.replace(/_thumb(?=\.[a-z0-9]+(?:[?#]|$))/i, "")) : "";
      byRefKey.set(refKey, {
        mediaId: mediaId || extractMediaIdFromText(thumbUrl),
        genId: genId || extractGenIdFromText(thumbUrl),
        mediaUrl,
        thumbUrl,
        alt: img?.alt || ""
      });
    }

    if (byRefKey.size === 0) {
      const fallbackRefs = getReferenceImagesFromThumbnails(scope, imageNode, currentGenId);
      for (const ref of fallbackRefs) {
        const key = ref.mediaId || ref.genId || ref.thumbUrl || ref.mediaUrl;
        if (!key || byRefKey.has(key)) continue;
        byRefKey.set(key, ref);
      }
    }

    return Array.from(byRefKey.values());
  }

  function getClosestDocumentReferenceAnchors(imageNode) {
    const strips = getReferenceStripNodes(document);
    if (!strips.length) return [];
    if (!imageNode || !imageNode.getBoundingClientRect) {
      const first = strips[0];
      return Array.from(first.querySelectorAll(REFERENCE_LINK_SELECTOR));
    }

    const imageRect = imageNode.getBoundingClientRect();
    const imageCx = imageRect.left + imageRect.width / 2;
    const imageCy = imageRect.top + imageRect.height / 2;
    let bestStrip = strips[0];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const strip of strips) {
      const r = strip.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = cx - imageCx;
      const dy = cy - imageCy;
      const score = Math.hypot(dx, dy);
      if (score < bestScore) {
        bestScore = score;
        bestStrip = strip;
      }
    }

    return Array.from(bestStrip.querySelectorAll(REFERENCE_LINK_SELECTOR));
  }

  function getReferenceAnchors(scope) {
    const byKey = new Map();
    const pushAnchor = (anchor) => {
      const key = anchor.href || anchor.getAttribute("href") || "";
      if (!key) return;
      byKey.set(key, anchor);
    };

    // First pass: robust global/local detection of thumbnail-style reference anchors.
    const localCandidates = Array.from(scope.querySelectorAll(REFERENCE_LINK_SELECTOR));
    for (const anchor of localCandidates) {
      if (isLikelyReferenceAnchor(anchor)) pushAnchor(anchor);
    }
    const globalCandidates = Array.from(document.querySelectorAll(REFERENCE_LINK_SELECTOR));
    for (const anchor of globalCandidates) {
      if (isLikelyReferenceAnchor(anchor)) pushAnchor(anchor);
    }
    if (byKey.size) {
      return Array.from(byKey.values());
    }

    const strips = getReferenceStripNodes(scope);
    const collected = [];
    for (const strip of strips) {
      const stripText = normalizeText(strip.textContent || "").toLowerCase();
      if (!stripText.includes("remix") && !stripText.includes("prompt")) {
        continue;
      }
      const anchors = Array.from(strip.querySelectorAll(REFERENCE_LINK_SELECTOR));
      for (const anchor of anchors) {
        const img = anchor.querySelector("img");
        if (!img) continue;
        const src = toAbsoluteUrl(img.currentSrc || img.src || "");
        const href = toAbsoluteUrl(anchor.getAttribute("href") || anchor.href || "");
        if (extractMediaIdFromText(href) || isThumbUrl(src) || hasTinyThumbContainer(img)) {
          collected.push(anchor);
        }
      }
    }
    if (collected.length) {
      return collected;
    }

    // Fallback: only keep clearly thumbnail-like/media-upload references.
    return Array.from(scope.querySelectorAll(REFERENCE_LINK_SELECTOR)).filter((anchor) => {
      const img = anchor.querySelector("img");
      if (!img) return false;
      const src = toAbsoluteUrl(img.currentSrc || img.src || "");
      const href = toAbsoluteUrl(anchor.getAttribute("href") || anchor.href || "");
      return Boolean(extractMediaIdFromText(href) || isThumbUrl(src) || hasTinyThumbContainer(img));
    });
  }

  function getReferenceStripNodes(scope) {
    return Array.from(
      scope.querySelectorAll('div.flex.max-w-full.items-center.gap-3, div[class*="max-w-full"][class*="items-center"][class*="gap-3"]')
    );
  }

  function isReferenceThumbnailImage(img, imageUrl) {
    if (isThumbUrl(imageUrl)) return true;
    if (hasTinyThumbContainer(img)) return true;
    const link = img.closest("a");
    if (link) {
      const href = link.getAttribute("href") || link.href || "";
      // Only treat as reference if it links to a media_ upload (not gen_ detail links)
      if (extractMediaIdFromText(href) && !href.includes("/g/gen_")) return true;
    }
    return false;
  }

  function isLikelyReferenceAnchor(anchor) {
    const href = toAbsoluteUrl(anchor.getAttribute("href") || anchor.href || "");
    const mediaId = extractMediaIdFromText(href);
    const genId = extractGenIdFromText(href);
    if (!mediaId && !genId) {
      return false;
    }
    const img = anchor.querySelector("img");
    if (!img) return false;
    const src = toAbsoluteUrl(img.currentSrc || img.src || "");
    const cls = String(img.className || "");
    const isCover = /\bobject-cover\b/.test(cls);
    const isTiny = hasTinyThumbContainer(img);
    const isThumb = isThumbUrl(src);
    if (mediaId) {
      return true;
    }
    return isCover || isTiny || isThumb;
  }

  function hasTinyThumbContainer(img) {
    if (img.closest('div[class~="h-8"][class~="w-8"], div[class*="size-8"]')) {
      return true;
    }
    const rect = typeof img.getBoundingClientRect === "function" ? img.getBoundingClientRect() : null;
    return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.width <= 72 && rect.height <= 72);
  }

  function isThumbUrl(url) {
    return /_thumb(?=\.[a-z0-9]+(?:[?#]|$))/i.test(String(url || ""));
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

  function getReferenceImagesFromThumbnails(scope, imageNode, currentGenId) {
    const refsByKey = new Map();
    const mainUrl = toAbsoluteUrl(imageNode?.currentSrc || imageNode?.src || "");
    const imgs = Array.from(scope.querySelectorAll("img"));
    for (const img of imgs) {
      const thumbUrl = toAbsoluteUrl(img.currentSrc || img.src || "");
      if (!thumbUrl || thumbUrl === mainUrl || thumbUrl.startsWith("data:")) {
        continue;
      }
      const cls = String(img.className || "");
      if (!isThumbUrl(thumbUrl) && !hasTinyThumbContainer(img) && !/\bobject-cover\b/.test(cls)) {
        continue;
      }

      const anchor = img.closest("a");
      const href = toAbsoluteUrl(anchor?.getAttribute("href") || anchor?.href || "");
      const mediaId = extractMediaIdFromText(href) || extractMediaIdFromText(thumbUrl);
      const genId = extractGenIdFromText(href) || extractGenIdFromText(thumbUrl);
      if (!mediaId && !genId) {
        continue;
      }
      if (genId && currentGenId && genId === currentGenId) {
        continue;
      }
      const key = mediaId || genId || thumbUrl;
      if (refsByKey.has(key)) continue;
      refsByKey.set(key, {
        mediaId,
        genId,
        mediaUrl: toAbsoluteUrl(thumbUrl.replace(/_thumb(?=\.[a-z0-9]+(?:[?#]|$))/i, "")),
        thumbUrl,
        alt: img.alt || ""
      });
    }
    return Array.from(refsByKey.values());
  }

  function extractPresetIdFromUrl(url) {
    if (!url) return "";
    try {
      const u = new URL(url, location.href);
      const pid = u.searchParams.get("pid");
      if (pid) return pid;
      const m = u.href.match(/preset_[A-Za-z0-9]+/);
      return m ? m[0] : "";
    } catch {
      return "";
    }
  }

  function looksLikePresetName(text) {
    if (!text) return false;
    if (text.length < 2 || text.length > 60) return false;
    if (/^(save preset|use preset|view preset details)$/i.test(text)) return false;
    return true;
  }

  function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function looksLikePrompt(text) {
    if (!text || text.length < 16) {
      return false;
    }
    const blacklist = [
      "remix",
      "generated image",
      "favorite",
      "image generation"
    ];
    if (blacklist.includes(text.toLowerCase())) {
      return false;
    }
    return true;
  }

  function parseSrcset(srcset) {
    return srcset
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [rawUrl, rawDescriptor] = entry.split(/\s+/, 2);
        const url = toAbsoluteUrl(rawUrl || "");
        const descriptor = rawDescriptor || "";
        let score = 0;
        if (descriptor.endsWith("w")) {
          score = Number.parseInt(descriptor, 10) || 0;
        } else if (descriptor.endsWith("x")) {
          const multiplier = Number.parseFloat(descriptor);
          score = Number.isFinite(multiplier) ? Math.floor(multiplier * 1000) : 0;
        }
        return { url, score };
      })
      .filter((item) => Boolean(item.url));
  }

  function expandUrlVariants(url) {
    if (!url) return [];
    const normalized = toAbsoluteUrl(url);
    if (!normalized) return [];
    const variants = [normalized];

    // In SORA detail strips, companion images often use *_thumb.webp.
    // Try the non-thumb variant first for better quality.
    const dethumbed = normalized.replace(/_thumb(?=\.[a-z0-9]+(?:[?#]|$))/i, "");
    if (dethumbed !== normalized) {
      variants.unshift(dethumbed);
    }

    return Array.from(new Set(variants));
  }

  function compareCandidateQuality(a, b) {
    return qualityScore(b) - qualityScore(a);
  }

  function qualityScore(url) {
    let score = 0;
    if (!/_thumb(?=\.[a-z0-9]+(?:[?#]|$))/i.test(url)) score += 5000;
    if (/img_\d+\.(png|webp|jpe?g)(?:[?#]|$)/i.test(url)) score += 1000;
    return score;
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

  function isSoraLoading() {
    const spinner = document.querySelector('.spin_loader');
    if (!spinner) return false;
    // Check that the spinner is actually visible (not hidden/zero-size)
    const rect = spinner.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(spinner);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    return true;
  }

  function sleep(ms) {
    // Break long sleeps into 200ms chunks so pause/cancel is responsive
    return new Promise(async (resolve) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (scanPaused || scanCanceled) break;
        await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
      }
      resolve();
    });
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function ensureHighlightStyle() {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
      .sora-downloader-scanned {
        outline: 2px solid #1dbf73 !important;
        outline-offset: -2px;
      }
      .sora-downloader-scanned::after {
        content: "Scanned";
        position: absolute;
        left: 4px;
        top: 4px;
        z-index: 5;
        background: rgba(29, 191, 115, 0.95);
        color: #fff;
        font-size: 10px;
        line-height: 1;
        padding: 3px 5px;
        border-radius: 4px;
        font-weight: 600;
        pointer-events: none;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function markAsScanned(node) {
    if (!node) return;
    const target = node.closest('[class*="group/tile"]') || node.parentElement || node;
    const el = target instanceof HTMLElement ? target : null;
    if (!el) return;
    if (getComputedStyle(el).position === "static") {
      el.style.position = "relative";
    }
    el.classList.add("sora-downloader-scanned");
  }

  function clearScanHighlights() {
    const nodes = document.querySelectorAll(".sora-downloader-scanned");
    nodes.forEach((node) => {
      node.classList.remove("sora-downloader-scanned");
    });
  }

  function reportScanProgress(progress) {
    try {
      chrome.runtime.sendMessage({
        type: "SORA_SCAN_PROGRESS",
        progress
      });
    } catch {
      // Best-effort progress updates; ignore when popup is closed.
    }
  }

  function reportScanStalled(info) {
    try {
      chrome.runtime.sendMessage({
        type: "SORA_SCAN_STALLED",
        info
      });
    } catch {
      // Best-effort; if popup is closed, scan stays paused until cancelled.
    }
  }

  async function waitWhilePaused() {
    while (scanPaused && !scanCanceled) {
      // Use raw setTimeout instead of sleep() — sleep() breaks immediately
      // when scanPaused is true, which would create a tight CPU loop here.
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ── Selection mode ──

  function ensureSelectionStyle() {
    if (document.getElementById(SELECTION_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SELECTION_STYLE_ID;
    style.textContent = `
      .sora-dl-select-wrap {
        position: absolute;
        left: 4px;
        top: 4px;
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 4px;
        pointer-events: auto;
      }
      .sora-dl-select-checkbox {
        appearance: auto;
        width: 18px;
        height: 18px;
        accent-color: #a175ff;
        cursor: pointer;
        filter: drop-shadow(0 1px 3px rgba(0,0,0,0.5));
      }
      .sora-dl-selected {
        outline: 3px solid #a175ff !important;
        outline-offset: -3px;
      }
      .sora-dl-select-badge {
        position: absolute;
        right: 4px;
        top: 4px;
        z-index: 10;
        background: rgba(161, 117, 255, 0.95);
        color: #fff;
        font-size: 9px;
        line-height: 1;
        padding: 3px 5px;
        border-radius: 4px;
        font-weight: 700;
        pointer-events: none;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function extractItemFromCard(card) {
    if (!card) return null;
    const detailLink = card.querySelector('a[href*="/g/gen_"]');
    const detailUrl = detailLink ? (detailLink.href || "") : "";
    const img = card.querySelector("img");
    const imageUrl = img ? (img.currentSrc || img.src || "") : "";
    if (!detailUrl && !imageUrl) return null;
    const key = detailUrl || imageUrl;
    const inferredTaskId = extractTaskIdFromAssetUrl(imageUrl);
    const taskLink = extractTaskLink(card, inferredTaskId);
    return {
      id: crypto.randomUUID(),
      imageUrl,
      imageCandidates: imageUrl ? [imageUrl] : [],
      detailUrl,
      taskUrl: taskLink,
      taskId: inferredTaskId,
      presetName: "",
      presetId: "",
      presetUrl: "",
      presetDescription: "",
      referenceImages: [],
      referenceMediaIds: [],
      referenceCount: 0,
      title: "",
      prompt: "Prompt not detected",
      alt: img?.alt || "",
      pageTitle: document.title || "",
      pageUrl: location.href,
      collectedAt: new Date().toISOString(),
      _key: key
    };
  }

  function addCheckboxToCard(card) {
    if (!card || card.querySelector(".sora-dl-select-wrap")) return;
    const detailLink = card.querySelector('a[href*="/g/gen_"]');
    const img = card.querySelector("img");
    const key = (detailLink?.href) || (img?.currentSrc || img?.src) || "";
    if (!key) return;

    card.style.position = card.style.position || "relative";
    card.dataset.soraDlCard = "1";

    const wrap = document.createElement("div");
    wrap.className = "sora-dl-select-wrap";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "sora-dl-select-checkbox";
    cb.dataset.soraDlKey = key;
    cb.checked = selectedItemKeys.has(key);

    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      lastCheckedKey = key;
      if (cb.checked) {
        selectedItemKeys.add(key);
        card.classList.add("sora-dl-selected");
        const item = extractItemFromCard(card);
        if (item) selectedItemsMap.set(key, item);
      } else {
        selectedItemKeys.delete(key);
        selectedItemsMap.delete(key);
        card.classList.remove("sora-dl-selected");
      }
      updateSelectionBadges();
      reportSelectionCount();
    });

    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!e.shiftKey || !lastCheckedKey || lastCheckedKey === key) return;
      e.preventDefault(); // block toggle + change event — we handle it manually
      const allCbs = Array.from(document.querySelectorAll(".sora-dl-select-checkbox"));
      const lastIdx = allCbs.findIndex((c) => c.dataset.soraDlKey === lastCheckedKey);
      const currIdx = allCbs.findIndex((c) => c.dataset.soraDlKey === key);
      if (lastIdx === -1 || currIdx === -1) return;
      const setTo = allCbs[lastIdx].checked;
      const [from, to] = lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
      for (let i = from; i <= to; i++) {
        const rangeCb = allCbs[i];
        const rangeKey = rangeCb.dataset.soraDlKey;
        if (!rangeKey) continue;
        rangeCb.checked = setTo;
        const rangeCard = rangeCb.closest("[data-sora-dl-card]");
        if (setTo) {
          selectedItemKeys.add(rangeKey);
          if (rangeCard) rangeCard.classList.add("sora-dl-selected");
          const item = extractItemFromCard(rangeCard);
          if (item) selectedItemsMap.set(rangeKey, item);
        } else {
          selectedItemKeys.delete(rangeKey);
          selectedItemsMap.delete(rangeKey);
          if (rangeCard) rangeCard.classList.remove("sora-dl-selected");
        }
      }
      updateSelectionBadges();
      reportSelectionCount();
    });

    wrap.appendChild(cb);
    card.appendChild(wrap);

    if (selectedItemKeys.has(key)) {
      card.classList.add("sora-dl-selected");
    }
  }

  function addSelectionCheckboxesToAllCards() {
    removeSelectionCheckboxes();
    const cardSelector = CARD_SELECTORS.join(", ");
    document.querySelectorAll(cardSelector).forEach((card) => {
      if (card.querySelector('a[href*="/g/gen_"], img[src*="videos.openai.com"]')) {
        addCheckboxToCard(card);
      }
    });
    updateSelectionBadges();
  }

  function startSelectionObserver() {
    stopSelectionObserver();
    selectionObserver = new MutationObserver(() => {
      if (!selectionModeActive) return;
      const cardSelector = CARD_SELECTORS.join(", ");
      document.querySelectorAll(cardSelector).forEach((card) => {
        if (!card.querySelector(".sora-dl-select-wrap") &&
            card.querySelector('a[href*="/g/gen_"], img[src*="videos.openai.com"]')) {
          addCheckboxToCard(card);
        }
      });
    });
    selectionObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopSelectionObserver() {
    if (selectionObserver) {
      selectionObserver.disconnect();
      selectionObserver = null;
    }
  }

  function removeSelectionCheckboxes() {
    document.querySelectorAll(".sora-dl-select-wrap").forEach((el) => el.remove());
    document.querySelectorAll(".sora-dl-select-badge").forEach((el) => el.remove());
    document.querySelectorAll(".sora-dl-selected").forEach((el) => el.classList.remove("sora-dl-selected"));
  }

  function updateSelectionBadges() {
    document.querySelectorAll(".sora-dl-select-badge").forEach((el) => el.remove());
  }

  function reportSelectionCount() {
    try {
      chrome.runtime.sendMessage({
        type: "SORA_SELECTION_COUNT",
        count: selectedItemKeys.size
      });
    } catch {
      // Best-effort.
    }
  }
})();
