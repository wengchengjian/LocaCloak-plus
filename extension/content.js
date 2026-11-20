(function () {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const DEFAULTS = {
    enabled: true,
    latitude: 34.0522,
    longitude: -118.2437,
    language: "en-US",
    timezone: "America/Los_Angeles",
    webrtcProtection: true,
    canvasProtection: false,
    webglProtection: false,
    audioProtection: false,
    fontProtection: false,
    webgpuProtection: false,
    canvasSeed: null,
    iframeCoverage: false
  };
  const DEFAULT_DOMAINS = ["*.google.com", "*.google.dev", "*.google.org", "*.google.net", "*.google.co.jp", "*.google.co.uk", "*.google.co.kr", "*.google.co.in", "*.google.de", "*.google.fr", "*.google.it", "*.google.es", "*.googleapis.com", "*.googleapis.cn", "*.googleusercontent.com", "*.googlevideo.com", "*.gstatic.com", "*.googlemaps.com", "*.gmail.com", "*.gvt1.com", "*.1e100.net", "*.appspot.com", "*.cloudfunctions.net", "*.run.app", "*.web.app", "*.firebaseapp.com", "*.gcr.io", "*.goo.gl", "*.g.co", "*.withgoogle.com", "*.chromium.org", "*.chrome.com", "*.kaggle.com", "*.web.dev", "*.idx.dev", "*.youtube.com", "*.youtu.be", "*.ytimg.com", "*.youtube-nocookie.com", "*.ggpht.com", "*.openai.com", "*.chatgpt.com", "*.chat.com", "*.sora.com", "*.oaistatic.com", "*.oaiusercontent.com", "*.gemini.google.com", "*.aistudio.google.com", "*.notebooklm.google.com", "*.deepmind.com", "*.generativelanguage.googleapis.com", "*.ai.google.dev", "*.jules.google", "*.anthropic.com", "*.claude.ai", "*.claude.com", "*.clau.de", "*.claudeusercontent.com", "*.cursor.com", "*.cursor.sh", "*.cursorapi.com", "*.windsurf.com", "*.codeium.com", "*.perplexity.com", "*.perplexity.ai", "*.pplx.ai", "*.x.ai", "*.grok.com", "*.copilot.microsoft.com", "*.githubcopilot.com", "*.meta.ai", "*.mistral.ai", "*.huggingface.co", "*.hf.co", "*.hf.space", "*.groq.com", "*.cerebras.ai", "*.elevenlabs.com", "*.elevenlabs.io", "*.poe.com", "*.cohere.ai", "*.cohere.com", "*.manus.im", "*.devin.ai", "*.dify.ai", "*.coderabbit.ai", "*.kiro.dev", "*.lovart.ai", "*.openrouter.ai", "*.comfy.org", "*.duck.ai", "*.openart.ai", "*.jasper.ai", "*.coze.com", "*.trae.ai", "*.marscode.com"];

  function matchesDomain(hostname, domains) {
    for (const domain of domains) {
      if (domain.startsWith("*.")) {
        const suffix = domain.slice(2);
        if (hostname === suffix || hostname.endsWith("." + suffix)) return true;
      } else if (hostname === domain) {
        return true;
      }
    }
    return false;
  }

  function ancestorHostnames() {
    const hosts = [];
    try {
      for (const origin of location.ancestorOrigins || []) {
        try {
          const host = new URL(origin).hostname;
          if (host) hosts.push(host);
        } catch (error) {}
      }
    } catch (error) {}
    return hosts;
  }

  function isAllowed(hostname, domains, iframeCoverage) {
    if (matchesDomain(hostname, domains)) return true;
    if (!iframeCoverage) return false;
    return ancestorHostnames().some((host) => matchesDomain(host, domains));
  }

  function frameHostname() {
    if (location.hostname) return location.hostname;
    try {
      const origins = location.ancestorOrigins;
      if (origins && origins.length > 0) {
        const host = new URL(origins[0]).hostname;
        if (host) return host;
      }
    } catch (error) {}
    try {
      if (document.referrer) return new URL(document.referrer).hostname;
    } catch (error) {}
    return "";
  }

  function toNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function sendToPage(config) {
    try {
      window.postMessage({ __lc_config: true, core: config.core, protect: config.protect }, "*");
    } catch (error) {
      // The page stays untouched if postMessage is unavailable.
    }
  }

  function readState() {
    return new Promise((resolve) => {
      api.storage.local.get(["locaCloakConfig", "locaCloakCanvasSeed"], (data) => resolve(data));
    });
  }

  async function applyConfig(update = false) {
    try {
      if (!api || !api.storage) return;
      const data = await readState();
      const config = { ...DEFAULTS, ...(data.locaCloakConfig || {}) };
      if (data.locaCloakCanvasSeed) config.canvasSeed = data.locaCloakCanvasSeed;
      if (!config.enabled) return;

      const configured = data.locaCloakConfig && data.locaCloakConfig.domains;
      const domains = Array.isArray(configured) ? configured : DEFAULT_DOMAINS;
      const hostname = frameHostname();
      if (!isAllowed(hostname, domains, config.iframeCoverage)) return;

      sendToPage({
        core: {
          timezone: String(config.timezone || "America/Los_Angeles"),
          latitude: toNumber(config.latitude, 34.0522),
          longitude: toNumber(config.longitude, -118.2437),
          language: String(config.language || "en-US"),
          webrtcProtection: config.webrtcProtection !== false,
          canvasProtection: false,
          webglProtection: false,
          audioProtection: !!config.audioProtection,
          fontProtection: !!config.fontProtection,
          webgpuProtection: !!config.webgpuProtection,
          workerProtection: !!config.workerProtection,
          canvasSeed: config.canvasSeed ? String(config.canvasSeed) : null
        },
        protect: {
          canvasProtection: !!config.canvasProtection,
          webglProtection: !!config.webglProtection,
          canvasSeed: config.canvasSeed ? String(config.canvasSeed) : null,
          host: hostname
        }
      });
    } catch (error) {
      // Never break the host page because of a storage or injection failure.
    }
  }

  applyConfig();

  if (api && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.locaCloakConfig || changes.locaCloakCanvasSeed) applyConfig();
    });
  }
})();
