(function initContentScript() {
  const accumulatedItemsByKey = new Map();
  const HIGHLIGHT_STYLE_ID = "sora-downloader-scan-highlight-style";
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

  async function scanWithAutoScroll(options) {
    const maxSteps = clampNumber(options.maxSteps, 1, 300, 90);
    const settleMs = clampNumber(options.settleMs, 100, 3000, 350);
    const stagnantLimit = 8;
    let stagnantRounds = 0;
    let prevScrollY = -1;

    const byKey = new Map();

    for (let step = 0; step < maxSteps; step += 1) {
      const current = scanGenerationItems();
      for (const item of current) {
        const key = item.detailUrl || item.imageUrl;
        if (!key) continue;
        if (!byKey.has(key)) {
          byKey.set(key, item);
        } else {
          const existing = byKey.get(key);
          if ((item.prompt || "").length > (existing.prompt || "").length) {
            byKey.set(key, item);
          }
        }
      }

      const beforeCount = byKey.size;
      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
      await sleep(settleMs);

      const afterStepItems = scanGenerationItems();
      for (const item of afterStepItems) {
        const key = item.detailUrl || item.imageUrl;
        if (!key) continue;
        if (!byKey.has(key)) {
          byKey.set(key, item);
        } else {
          const existing = byKey.get(key);
          if ((item.prompt || "").length > (existing.prompt || "").length) {
            byKey.set(key, item);
          }
        }
      }

      const noGrowth = byKey.size === beforeCount;
      const noMovement = Math.abs(window.scrollY - prevScrollY) < 2;
      const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 20;

      if (noGrowth && (noMovement || nearBottom)) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
      }

      prevScrollY = window.scrollY;
      if (stagnantRounds >= stagnantLimit) {
        break;
      }
    }

    return Array.from(byKey.values());
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
      if ((item.prompt || "").length > (existing.prompt || "").length) {
        accumulatedItemsByKey.set(key, item);
      }
    }
    return Array.from(accumulatedItemsByKey.values());
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
      "favorite"
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
})();
