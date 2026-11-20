importScripts("vpn.js");

const api = globalThis.browser ?? globalThis.chrome;

const LA_BOUNDS = { lat: { min: 33.85, max: 34.15 }, lng: { min: -118.5, max: -118.1 } };
const WATCH_ALARM = "locaCloakVpnWatch";
const WATCH_PERIOD_MINUTES = 0.5;

const DEFAULT_DOMAINS = ["*.google.com", "*.google.dev", "*.google.org", "*.google.net", "*.google.co.jp", "*.google.co.uk", "*.google.co.kr", "*.google.co.in", "*.google.de", "*.google.fr", "*.google.it", "*.google.es", "*.googleapis.com", "*.googleapis.cn", "*.googleusercontent.com", "*.googlevideo.com", "*.gstatic.com", "*.googlemaps.com", "*.gmail.com", "*.gvt1.com", "*.1e100.net", "*.appspot.com", "*.cloudfunctions.net", "*.run.app", "*.web.app", "*.firebaseapp.com", "*.gcr.io", "*.goo.gl", "*.g.co", "*.withgoogle.com", "*.chromium.org", "*.chrome.com", "*.kaggle.com", "*.web.dev", "*.idx.dev", "*.youtube.com", "*.youtu.be", "*.ytimg.com", "*.youtube-nocookie.com", "*.ggpht.com", "*.openai.com", "*.chatgpt.com", "*.chat.com", "*.sora.com", "*.oaistatic.com", "*.oaiusercontent.com", "*.gemini.google.com", "*.aistudio.google.com", "*.notebooklm.google.com", "*.deepmind.com", "*.generativelanguage.googleapis.com", "*.ai.google.dev", "*.jules.google", "*.anthropic.com", "*.claude.ai", "*.claude.com", "*.clau.de", "*.claudeusercontent.com", "*.cursor.com", "*.cursor.sh", "*.cursorapi.com", "*.windsurf.com", "*.codeium.com", "*.perplexity.com", "*.perplexity.ai", "*.pplx.ai", "*.x.ai", "*.grok.com", "*.copilot.microsoft.com", "*.githubcopilot.com", "*.meta.ai", "*.mistral.ai", "*.huggingface.co", "*.hf.co", "*.hf.space", "*.groq.com", "*.cerebras.ai", "*.elevenlabs.com", "*.elevenlabs.io", "*.poe.com", "*.cohere.ai", "*.cohere.com", "*.manus.im", "*.devin.ai", "*.dify.ai", "*.coderabbit.ai", "*.kiro.dev", "*.lovart.ai", "*.openrouter.ai", "*.comfy.org", "*.duck.ai", "*.openart.ai", "*.jasper.ai", "*.coze.com", "*.trae.ai", "*.marscode.com"];

function randomLA() {
  const latitude = LA_BOUNDS.lat.min + Math.random() * (LA_BOUNDS.lat.max - LA_BOUNDS.lat.min);
  const longitude = LA_BOUNDS.lng.min + Math.random() * (LA_BOUNDS.lng.max - LA_BOUNDS.lng.min);
  return { latitude: +latitude.toFixed(4), longitude: +longitude.toFixed(4) };
}

function languageChain(language) {
  const tag = String(language || "en-US");
  const base = tag.split("-")[0];
  const chain = [tag];
  if (base && base !== tag) chain.push(base);
  if (base !== "en" && chain.indexOf("en") === -1) chain.push("en");
  return chain;
}

function acceptLanguage(language) {
  return languageChain(language)
    .map((tag, index) => index === 0 ? tag : `${tag};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`)
    .join(",");
}

async function loadConfig() {
  return (await api.storage.local.get(["locaCloakConfig"])).locaCloakConfig || {};
}

let rulesChain = Promise.resolve();

function updateRules() {
  const run = rulesChain.then(applyRules, applyRules);
  rulesChain = run.catch(() => {});
  return run;
}

async function applyRules() {
  const config = (await loadConfig()) || {};
  try {
    const ids = (await api.declarativeNetRequest.getDynamicRules()).map((rule) => rule.id);
    if (ids.length > 0) await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  } catch (error) {
    // DNR can be unavailable while the extension is reloading.
  }

  if (config.enabled === false) return;
  const domains = config.domains || [];
  if (domains.length === 0) return;

  const requestDomains = domains.map((domain) => domain.replace(/^\*\./, ""));
  const language = config.language || "en-US";
  const rule = {
    id: 1000,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Accept-Language", operation: "set", value: acceptLanguage(language) }]
    },
    condition: {
      requestDomains,
      resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "stylesheet", "script", "image", "font", "media", "websocket", "other"]
    }
  };

  try {
    await api.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
  } catch (error) {
    // Keep the previous rule set if Chrome rejects this one.
  }
}

async function applyWebRTCProtection(enabled) {
  if (!api.privacy?.network?.webRTCIPHandlingPolicy) return;
  try {
    await api.privacy.network.webRTCIPHandlingPolicy.set({ value: enabled ? "disable_non_proxied_udp" : "default" });
  } catch (error) {
    // The policy API is not available on every platform.
  }
}

let syncInFlight = null;

function autoSyncVpn(options = {}) {
  if (!options.manual && syncInFlight) return syncInFlight;
  const task = performAutoSync(options)
    .catch((error) => ({ ok: false, error: String((error && error.message) || error) }))
    .finally(() => {
      if (syncInFlight === task) syncInFlight = null;
    });
  if (!options.manual) syncInFlight = task;
  return task;
}

function pickProbe(probes) {
  if (!probes.length) return null;
  const counts = new Map();
  for (const probe of probes) counts.set(probe.ip, (counts.get(probe.ip) || 0) + 1);
  return probes.slice().sort((a, b) => counts.get(b.ip) - counts.get(a.ip))[0];
}

async function performAutoSync({ force = false, manual = false } = {}) {
  const config = await loadConfig();
  if (!manual && (config.enabled === false || config.autoSyncVpn === false)) {
    return { ok: false, skipped: true, reason: "disabled" };
  }

  const state = (await api.storage.local.get(["locaCloakVpnState"])).locaCloakVpnState || {};
  const probes = await LocaCloakVpn.probeExitAll();
  const fresh = await LocaCloakVpn.probeExitFresh();
  if (!probes.length && !fresh) {
    await api.storage.local.set({
      locaCloakVpnState: { ...state, checkedAt: Date.now(), lastError: "ip_probe_failed" }
    });
    return { ok: false, error: "ip_probe_failed" };
  }

  let probe = null;
  if (fresh && (!state.ip || fresh.ip !== state.ip)) {
    // A host that has been idle for several minutes is the strongest signal
    // that a stale keep-alive connection is not hiding the new exit IP.
    probe = fresh;
  } else if (fresh && state.ip && !force) {
    // Fresh probe agrees with the current state: ignore warm/probably-stale
    // core connections instead of flip-flopping between old and new nodes.
    await api.storage.local.set({
      locaCloakVpnState: { ...state, checkedAt: Date.now(), lastError: null }
    });
    return { ok: true, unchanged: true, ip: state.ip, country: state.country, city: state.city };
  } else if (fresh) {
    probe = fresh;
  } else if (!force && state.ip) {
    const changed = probes.filter((item) => item.ip !== state.ip);
    if (changed.length === 0) {
      await api.storage.local.set({
        locaCloakVpnState: { ...state, checkedAt: Date.now(), lastError: null }
      });
      return { ok: true, unchanged: true, ip: state.ip, country: state.country, city: state.city };
    }
    probe = pickProbe(changed);
  } else {
    probe = pickProbe(probes);
  }

  const geo = await LocaCloakVpn.lookupGeo(probe.ip);
  if (!geo) {
    await api.storage.local.set({
      locaCloakVpnState: { ...state, checkedAt: Date.now(), lastError: "geo_lookup_failed" }
    });
    return { ok: false, error: "geo_lookup_failed", ip: probe.ip };
  }

  // The network lookup can take seconds. Re-read the latest config so a
  // concurrent options save (domains, protection toggles, etc.) is not lost.
  const latest = await loadConfig();
  if (!manual && (latest.enabled === false || latest.autoSyncVpn === false)) {
    return { ok: false, skipped: true, reason: "disabled" };
  }

  const country = geo.country || probe.country || latest.country || "";
  const city = geo.city || "";
  const timezone = geo.timezone || LocaCloakVpn.normalizeTimeZone(latest.timezone) || "America/Los_Angeles";
  const language = country ? LocaCloakVpn.languageFor(country) : latest.language || "en-US";
  const nextConfig = {
    ...latest,
    latitude: geo.latitude,
    longitude: geo.longitude,
    timezone,
    language,
    country,
    city,
    autoSyncVpn: latest.autoSyncVpn !== false,
    manualOverride: manual ? false : latest.manualOverride === true
  };
  const nextState = {
    ip: probe.ip,
    geoIp: geo.ip || null,
    country,
    city,
    timezone,
    language,
    checkedAt: Date.now(),
    changedAt: Date.now()
  };

  if (!manual && latest.manualOverride === true) {
    await api.storage.local.set({ locaCloakVpnState: nextState });
    return { ok: true, locked: true, changed: true, ip: probe.ip, config: latest, geo: { ...geo, timezone } };
  }

  await api.storage.local.set({
    locaCloakConfig: nextConfig,
    locaCloakVpnState: nextState
  });

  return { ok: true, changed: true, ip: probe.ip, config: nextConfig, geo: { ...geo, timezone } };
}

async function syncWatcher() {
  const config = await loadConfig();
  const shouldWatch = config.enabled !== false && config.autoSyncVpn !== false;
  if (!shouldWatch) {
    await api.alarms.clear(WATCH_ALARM);
    return;
  }

  const alarm = await api.alarms.get(WATCH_ALARM);
  if (!alarm) api.alarms.create(WATCH_ALARM, { periodInMinutes: WATCH_PERIOD_MINUTES });
  autoSyncVpn();
}

async function ensureInstallDefaults(reason) {
  if (reason === "install") {
    const seed = randomLA();
    await api.storage.local.set({
      locaCloakSeed: seed,
      locaCloakDeviceId: crypto.randomUUID(),
      locaCloakCanvasSeed: crypto.randomUUID(),
      locaCloakConfig: {
        enabled: true,
        latitude: seed.latitude,
        longitude: seed.longitude,
        language: "en-US",
        timezone: "America/Los_Angeles",
        webrtcProtection: true,
        canvasProtection: false,
        webglProtection: false,
        audioProtection: false,
        fontProtection: false,
        webgpuProtection: false,
        workerProtection: false,
        iframeCoverage: false,
        autoSyncVpn: true,
        manualOverride: false,
        domains: DEFAULT_DOMAINS
      }
    });
    return;
  }

  if (reason !== "update") return;
  const config = await loadConfig();
  let changed = false;
  if (!Array.isArray(config.domains) || config.domains.length === 0) {
    config.domains = DEFAULT_DOMAINS;
    changed = true;
  }
  if (config.autoSyncVpn === undefined) {
    config.autoSyncVpn = true;
    changed = true;
  }
  if (config.manualOverride === undefined) {
    config.manualOverride = false;
    changed = true;
  }
  for (const key of ["audioProtection", "fontProtection", "webgpuProtection", "workerProtection"]) {
    if (config[key] === undefined) {
      config[key] = false;
      changed = true;
    }
  }
  if (changed) await api.storage.local.set({ locaCloakConfig: config });
}

api.runtime.onInstalled.addListener(async (details) => {
  await ensureInstallDefaults(details.reason);
  const config = await loadConfig();
  await updateRules();
  await applyWebRTCProtection(config.webrtcProtection !== false);
  await syncWatcher();
});

api.runtime.onStartup.addListener(async () => {
  const config = await loadConfig();
  await updateRules();
  await applyWebRTCProtection(config.webrtcProtection !== false);
  await syncWatcher();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) autoSyncVpn();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.locaCloakConfig) return;
  const next = changes.locaCloakConfig.newValue || {};
  const previous = changes.locaCloakConfig.oldValue || {};
  updateRules();
  applyWebRTCProtection(next.webrtcProtection !== false);
  if (next.enabled !== previous.enabled || next.autoSyncVpn !== previous.autoSyncVpn) syncWatcher();
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "updateRules") {
    updateRules()
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.action === "refreshCanvasSeed") {
    const seed = crypto.randomUUID();
    api.storage.local.set({ locaCloakCanvasSeed: seed }).then(() => sendResponse({ success: true, seed }));
    return true;
  }

  if (message.action === "checkVpnNow") {
    autoSyncVpn().then((result) => sendResponse(result));
    return true;
  }

  if (message.action === "syncVpnNow") {
    autoSyncVpn({ force: true, manual: true }).then((result) => sendResponse(result));
    return true;
  }
});

if (typeof self !== "undefined" && self.addEventListener) {
  self.addEventListener("online", () => autoSyncVpn());
}

(async () => {
  const config = await loadConfig();
  await updateRules();
  await applyWebRTCProtection(config.webrtcProtection !== false);
  await syncWatcher();
})();
