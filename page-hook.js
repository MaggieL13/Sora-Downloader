(() => {
  if (window.__SORA_DL_NETWORK_INSTALLED__) return;
  window.__SORA_DL_NETWORK_INSTALLED__ = true;

  const MAX_BODY = 1200;

  const shouldTrack = (url) => {
    try {
      const u = new URL(String(url || ""), location.href);
      return u.hostname === "sora.chatgpt.com" || u.hostname === "videos.openai.com";
    } catch {
      return false;
    }
  };

  const emit = (entry) => {
    try {
      window.dispatchEvent(new CustomEvent("SORA_DL_NETWORK_EVENT", { detail: entry }));
    } catch {
      // Best-effort logging only.
    }
  };

  const trim = (value) => String(value || "").slice(0, MAX_BODY);

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const request = args[0];
    const init = args[1] || {};
    const url = typeof request === "string" ? request : (request && request.url) || "";
    const method = (init.method || (request && request.method) || "GET").toUpperCase();
    const response = await originalFetch.apply(this, args);
    if (shouldTrack(url) || shouldTrack(response.url || "")) {
      const contentType = String(response.headers.get("content-type") || "");
      let bodySnippet = "";
      try {
        if (/json|text|html/i.test(contentType)) {
          bodySnippet = trim(await response.clone().text());
        }
      } catch {
        // Ignore unreadable bodies.
      }
      emit({
        ts: new Date().toISOString(),
        source: "fetch",
        url: String(response.url || url || ""),
        method,
        status: Number(response.status || 0),
        contentType,
        bodySnippet
      });
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__soraDlMethod = String(method || "GET").toUpperCase();
    this.__soraDlUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      const url = this.__soraDlUrl || this.responseURL || "";
      if (!shouldTrack(url)) return;
      const contentType = String(this.getResponseHeader("content-type") || "");
      let bodySnippet = "";
      try {
        if (typeof this.responseText === "string" && /json|text|html/i.test(contentType)) {
          bodySnippet = trim(this.responseText);
        }
      } catch {
        // Ignore unreadable bodies.
      }
      emit({
        ts: new Date().toISOString(),
        source: "xhr",
        url: String(this.responseURL || url || ""),
        method: this.__soraDlMethod || "GET",
        status: Number(this.status || 0),
        contentType,
        bodySnippet
      });
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
