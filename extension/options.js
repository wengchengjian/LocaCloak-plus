const DEFAULT_DOMAINS = ["*.google.com", "*.google.dev", "*.google.org", "*.google.net", "*.google.co.jp", "*.google.co.uk", "*.google.co.kr", "*.google.co.in", "*.google.de", "*.google.fr", "*.google.it", "*.google.es", "*.googleapis.com", "*.googleapis.cn", "*.googleusercontent.com", "*.googlevideo.com", "*.gstatic.com", "*.googlemaps.com", "*.gmail.com", "*.gvt1.com", "*.1e100.net", "*.appspot.com", "*.cloudfunctions.net", "*.run.app", "*.web.app", "*.firebaseapp.com", "*.gcr.io", "*.goo.gl", "*.g.co", "*.withgoogle.com", "*.chromium.org", "*.chrome.com", "*.kaggle.com", "*.web.dev", "*.idx.dev", "*.youtube.com", "*.youtu.be", "*.ytimg.com", "*.youtube-nocookie.com", "*.ggpht.com", "*.openai.com", "*.chatgpt.com", "*.chat.com", "*.sora.com", "*.oaistatic.com", "*.oaiusercontent.com", "*.gemini.google.com", "*.aistudio.google.com", "*.notebooklm.google.com", "*.deepmind.com", "*.generativelanguage.googleapis.com", "*.ai.google.dev", "*.jules.google", "*.anthropic.com", "*.claude.ai", "*.claude.com", "*.clau.de", "*.claudeusercontent.com", "*.cursor.com", "*.cursor.sh", "*.cursorapi.com", "*.windsurf.com", "*.codeium.com", "*.perplexity.com", "*.perplexity.ai", "*.pplx.ai", "*.x.ai", "*.grok.com", "*.copilot.microsoft.com", "*.githubcopilot.com", "*.meta.ai", "*.mistral.ai", "*.huggingface.co", "*.hf.co", "*.hf.space", "*.groq.com", "*.cerebras.ai", "*.elevenlabs.com", "*.elevenlabs.io", "*.poe.com", "*.cohere.ai", "*.cohere.com", "*.manus.im", "*.devin.ai", "*.dify.ai", "*.coderabbit.ai", "*.kiro.dev", "*.lovart.ai", "*.openrouter.ai", "*.comfy.org", "*.duck.ai", "*.openart.ai", "*.jasper.ai", "*.coze.com", "*.trae.ai", "*.marscode.com"];

const api = globalThis.browser ?? globalThis.chrome;
const MAP_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAP_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

document.addEventListener("DOMContentLoaded", async () => {
  await I18N.init();
  I18N.applyToDOM();

  if (!(await ActivationManager.check())) {
    ActivationManager.renderLockScreen(document.body);
    return;
  }

  CustomSelect.initAll();
  if (typeof CustomNumber !== "undefined") CustomNumber.initAll();

  const elements = {
    enabled: document.getElementById("enabled"),
    language: document.getElementById("language"),
    timezone: document.getElementById("timezone"),
    domains: document.getElementById("domains"),
    syncVpn: document.getElementById("sync-vpn"),
    restoreAuto: document.getElementById("restore-auto"),
    autoSyncVpn: document.getElementById("auto-sync-vpn"),
    vpnStatus: document.getElementById("vpn-sync-status"),
    resetLocation: document.getElementById("reset-location"),
    save: document.getElementById("save"),
    reset: document.getElementById("reset"),
    toast: document.getElementById("toast"),
    coords: document.getElementById("coords-display"),
    webrtc: document.getElementById("webrtc-protection"),
    canvas: document.getElementById("canvas-protection"),
    webgl: document.getElementById("webgl-protection"),
    audio: document.getElementById("audio-protection"),
    fonts: document.getElementById("font-protection"),
    webgpu: document.getElementById("webgpu-protection"),
    workers: document.getElementById("worker-protection"),
    iframe: document.getElementById("iframe-coverage"),
    refreshFingerprint: document.getElementById("refresh-fingerprint"),
    themeToggle: document.getElementById("theme-toggle"),
    uiLang: document.getElementById("ui-lang-switcher"),
    testEnable: document.getElementById("test-enable-protection"),
    testStatus: document.getElementById("test-protection-status")
  };

  document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
    item.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((node) => node.classList.remove("active"));
      item.classList.add("active");
      const page = item.dataset.page;
      document.querySelectorAll(".page-section").forEach((section) => {
        section.classList.toggle("active", section.id === `page-${page}`);
      });
      if (page === "preferences" && window._locaCloakMap) {
        setTimeout(() => window._locaCloakMap.invalidateSize(), 100);
      }
    });
  });

  if (elements.uiLang) {
    elements.uiLang.value = I18N.getLocale();
    CustomSelect.refresh(elements.uiLang);
    elements.uiLang.addEventListener("change", async () => {
      await I18N.setLocale(elements.uiLang.value);
      I18N.applyToDOM();
      CustomSelect.refreshAll();
      renderVpnStatus();
      renderTestStatus();
    });
  }

  const baseApplyTheme = ThemeManager.apply.bind(ThemeManager);
  ThemeManager.apply = function (theme) {
    baseApplyTheme(theme);
    if (!window._locaCloakMap || typeof L === "undefined") return;
    if (window._locaCloakTileLayer) window._locaCloakMap.removeLayer(window._locaCloakTileLayer);
    window._locaCloakTileLayer = L.tileLayer(MAP_TILE_URL, { maxZoom: 19, subdomains: "abc" }).addTo(window._locaCloakMap);
  };

  ThemeManager.init();
  if (elements.themeToggle) elements.themeToggle.addEventListener("click", () => ThemeManager.toggle());
  window.addEventListener("storage", (event) => ThemeManager.syncFromStorage(event));

  let config = await loadConfig();
  let latitude = toNumber(config.latitude, 34.0522);
  let longitude = toNumber(config.longitude, -118.2437);
  let vpnState = null;
  let map = null;
  let marker = null;
  let toastTimer = null;

  function toNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  async function loadConfig() {
    const next = await SharedConfig.load();
    if (!Array.isArray(next.domains) || next.domains.length === 0) next.domains = DEFAULT_DOMAINS.slice();
    return next;
  }

  async function saveConfig(next) {
    await SharedConfig.save(next);
  }

  function ensureOption(select, value, label) {
    if (!select || !value) return;
    const exists = Array.from(select.options).some((option) => option.value === value);
    if (!exists) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label || value;
      select.appendChild(option);
      if (CustomSelect.rebuild) CustomSelect.rebuild(select);
    }
    select.value = value;
    CustomSelect.refresh(select);
  }

  function renderCoords() {
    if (elements.coords) elements.coords.textContent = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  }

  function setLocation(nextLatitude, nextLongitude, pan = true) {
    latitude = +toNumber(nextLatitude, latitude).toFixed(4);
    longitude = +toNumber(nextLongitude, longitude).toFixed(4);
    if (marker) marker.setLatLng([latitude, longitude]);
    if (pan && map) map.panTo([latitude, longitude]);
    renderCoords();
  }

  function initMap(initialLatitude, initialLongitude) {
    const container = document.getElementById("map");
    if (!container || typeof L === "undefined") return;
    map = L.map("map", {
      center: [initialLatitude, initialLongitude],
      zoom: 10,
      zoomControl: false,
      attributionControl: false
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    window._locaCloakTileLayer = L.tileLayer(MAP_TILE_URL, { maxZoom: 19, subdomains: "abc" }).addTo(map);
    L.control.attribution({ prefix: false })
      .addAttribution(MAP_ATTRIBUTION)
      .addTo(map);

    const icon = L.divIcon({
      className: "locacloak-marker",
      html: '<div class="marker-dot"></div><div class="marker-pulse"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    marker = L.marker([initialLatitude, initialLongitude], { icon }).addTo(map);
    renderCoords();
    map.on("click", (event) => setLocation(event.latlng.lat, event.latlng.lng));
    window._locaCloakMap = map;
  }

  function formatStatusTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (error) {
      return "";
    }
  }

  function renderVpnStatus() {
    const container = elements.vpnStatus;
    if (!container) return;
    const text = container.querySelector(".vpn-status-text");
    const autoSync = !!elements.autoSyncVpn && elements.autoSyncVpn.checked;
    const locked = autoSync && config.manualOverride === true;
    if (elements.restoreAuto) elements.restoreAuto.hidden = !locked;
    container.classList.remove("on", "off", "error", "locked");
    if (!autoSync) {
      container.classList.add("off");
      if (text) text.textContent = I18N.t("vpn_status_off");
      container.title = "";
      return;
    }
    if (!vpnState || (!vpnState.changedAt && !vpnState.checkedAt)) {
      container.classList.add(locked ? "locked" : "on");
      if (text) text.textContent = locked ? I18N.t("vpn_status_manual") : I18N.t("vpn_status_waiting");
      container.title = "";
      return;
    }
    const place = [vpnState.city, vpnState.country].filter(Boolean).join(", ");
    const parts = [locked ? I18N.t("vpn_status_manual") : I18N.t("vpn_status_active")];
    if (place) parts.push(locked ? `VPN: ${place}` : place);
    if (vpnState.ip) parts.push(vpnState.ip);
    const time = formatStatusTime(vpnState.checkedAt || vpnState.changedAt);
    if (time) parts.push(`${I18N.t("vpn_status_checked")} ${time}`);
    if (vpnState.lastError) {
      container.classList.add("error");
      parts.push(I18N.t("vpn_status_error"));
    }
    container.classList.add(locked ? "locked" : "on");
    if (text) text.textContent = parts.join(" · ");
    container.title = [
      `Exit IP: ${vpnState.ip || "-"}`,
      `Last change: ${formatStatusTime(vpnState.changedAt) || "-"}`,
      `Last check: ${formatStatusTime(vpnState.checkedAt) || "-"}`,
      `Timezone: ${vpnState.timezone || "-"}`,
      locked ? "Manual override: location and locale are locked" : ""
    ].filter(Boolean).join(" | ");
  }

  function renderTestStatus() {
    const container = elements.testStatus;
    if (!container) return;
    const text = container.querySelector(".vpn-status-text");
    const canvasOn = config.canvasProtection === true;
    const webglOn = config.webglProtection === true;
    container.classList.remove("on", "off", "error");
    if (canvasOn && webglOn) {
      container.classList.add("on");
      if (text) text.textContent = I18N.t("test_status_on");
    } else {
      container.classList.add("off");
      if (text) text.textContent = I18N.t("test_status_partial");
    }
  }

  function renderForm(next, full = true) {
    if (!next) return;
    if (full) {
      if (elements.enabled) elements.enabled.checked = next.enabled !== false;
      if (elements.domains) elements.domains.value = (next.domains || DEFAULT_DOMAINS).join("\n");
      if (elements.webrtc) elements.webrtc.checked = next.webrtcProtection !== false;
      if (elements.canvas) elements.canvas.checked = next.canvasProtection === true;
      if (elements.webgl) elements.webgl.checked = next.webglProtection === true;
      if (elements.audio) elements.audio.checked = next.audioProtection === true;
      if (elements.fonts) elements.fonts.checked = next.fontProtection === true;
      if (elements.webgpu) elements.webgpu.checked = next.webgpuProtection === true;
      if (elements.workers) elements.workers.checked = next.workerProtection === true;
      if (elements.iframe) elements.iframe.checked = next.iframeCoverage === true;
    }
    if (elements.autoSyncVpn) elements.autoSyncVpn.checked = next.autoSyncVpn !== false;
    ensureOption(elements.language, next.language || "en-US");
    ensureOption(elements.timezone, next.timezone || "America/Los_Angeles");
    const nextLatitude = +toNumber(next.latitude, 34.0522).toFixed(4);
    const nextLongitude = +toNumber(next.longitude, -118.2437).toFixed(4);
    const moved = nextLatitude !== latitude || nextLongitude !== longitude;
    setLocation(nextLatitude, nextLongitude, full || moved);
    renderVpnStatus();
    renderTestStatus();
  }

  function showToast(message) {
    if (!elements.toast) return;
    const text = elements.toast.querySelector("span");
    if (text) text.textContent = message || I18N.t("toast_saved");
    elements.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3000);
  }

  function buttonBusy(button, label) {
    if (!button) return null;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="spin" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> ${label}`;
    return original;
  }

  function buttonRestore(button, original) {
    if (!button || original === null) return;
    button.innerHTML = original;
    button.disabled = false;
    I18N.applyToDOM();
    renderVpnStatus();
  }

  initMap(latitude, longitude);
  vpnState = (await api.storage.local.get(["locaCloakVpnState"])).locaCloakVpnState || null;
  renderForm(config, true);

  elements.autoSyncVpn?.addEventListener("change", async () => {
    const next = { ...config, autoSyncVpn: elements.autoSyncVpn.checked };
    try {
      await saveConfig(next);
      config = next;
    } catch (error) {
      elements.autoSyncVpn.checked = !elements.autoSyncVpn.checked;
    }
    renderVpnStatus();
  });

  elements.syncVpn?.addEventListener("click", async () => {
    const text = elements.syncVpn.querySelector(".btn-text");
    const original = text ? text.textContent : "";
    elements.syncVpn.disabled = true;
    if (text) text.textContent = I18N.t("syncing");
    try {
      const result = await api.runtime.sendMessage({ action: "syncVpnNow" });
      if (!result || !result.ok) throw new Error((result && result.error) || "sync_failed");
      const next = result.config || config;
      config = { ...config, ...next };
      setLocation(config.latitude, config.longitude, true);
      if (map) map.setZoom(12);
      ensureOption(elements.language, config.language || "en-US");
      ensureOption(elements.timezone, config.timezone || "America/Los_Angeles");
      vpnState = {
        ip: result.ip,
        country: config.country,
        city: config.city,
        timezone: config.timezone,
        language: config.language,
        changedAt: Date.now()
      };
      renderVpnStatus();
      const place = [config.city, config.country].filter(Boolean).join(", ");
      if (text) text.textContent = `${I18N.t("sync_done")}: ${place || config.timezone}`;
    } catch (error) {
      if (text) text.textContent = I18N.t("sync_failed");
    } finally {
      elements.syncVpn.disabled = false;
      setTimeout(() => { if (text) text.textContent = original; }, 3000);
    }
  });

  elements.restoreAuto?.addEventListener("click", async () => {
    const label = elements.restoreAuto.querySelector("[data-i18n]");
    const original = label ? label.textContent : "";
    elements.restoreAuto.disabled = true;
    if (label) label.textContent = I18N.t("syncing");
    try {
      const result = await api.runtime.sendMessage({ action: "syncVpnNow" });
      if (!result || !result.ok) throw new Error((result && result.error) || "sync_failed");
      config = { ...config, ...(result.config || {}), manualOverride: false };
      setLocation(config.latitude, config.longitude, true);
      if (map) map.setZoom(12);
      ensureOption(elements.language, config.language || "en-US");
      ensureOption(elements.timezone, config.timezone || "America/Los_Angeles");
      vpnState = {
        ip: result.ip,
        country: config.country,
        city: config.city,
        timezone: config.timezone,
        language: config.language,
        changedAt: Date.now()
      };
      renderVpnStatus();
      showToast(I18N.t("auto_restored"));
    } catch (error) {
      showToast(I18N.t("sync_failed"));
    } finally {
      elements.restoreAuto.disabled = false;
      if (label) label.textContent = original;
    }
  });

  elements.testEnable?.addEventListener("click", async () => {
    elements.testEnable.disabled = true;
    try {
      const current = await loadConfig();
      const next = { ...current, canvasProtection: true, webglProtection: true };
      await saveConfig(next);
      config = next;
      renderForm(next, true);
      renderTestStatus();
      showToast(I18N.t("test_enabled"));
    } catch (error) {
      showToast(I18N.t("sync_failed"));
    } finally {
      elements.testEnable.disabled = false;
    }
  });

  document.querySelectorAll("[data-test-url]").forEach((link) => {
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const url = link.dataset.testUrl;
      const extraDomains = (link.dataset.testDomains || "")
        .split(",")
        .map((domain) => domain.trim())
        .filter(Boolean);
      try {
        const current = await loadConfig();
        const merged = Array.from(new Set([...(current.domains || DEFAULT_DOMAINS), ...extraDomains]));
        const next = { ...current, domains: merged };
        await saveConfig(next);
        config = next;
        if (elements.domains) elements.domains.value = merged.join("\n");
        renderTestStatus();
        showToast(I18N.t("test_opening"));
      } catch (error) {
        // The site can still be opened; the user can retry the allowlist save.
      }
      try {
        if (api.tabs && api.tabs.create) await api.tabs.create({ url });
        else window.open(url, "_blank", "noopener");
      } catch (error) {
        window.open(url, "_blank", "noopener");
      }
    });
  });

  elements.canvas?.addEventListener("change", (event) => {
    if (event.target.checked && !confirm(I18N.t("confirm_experimental_canvas"))) event.target.checked = false;
  });

  elements.webgl?.addEventListener("change", (event) => {
    if (event.target.checked && !confirm(I18N.t("confirm_experimental_webgl"))) event.target.checked = false;
  });

  elements.audio?.addEventListener("change", (event) => {
    if (event.target.checked && !confirm(I18N.t("confirm_experimental_audio"))) event.target.checked = false;
  });

  elements.fonts?.addEventListener("change", (event) => {
    if (event.target.checked && !confirm(I18N.t("confirm_experimental_fonts"))) event.target.checked = false;
  });

  elements.webgpu?.addEventListener("change", (event) => {
    if (event.target.checked && !confirm(I18N.t("confirm_experimental_webgpu"))) event.target.checked = false;
  });

  elements.workers?.addEventListener("change", (event) => {
    if (event.target.checked && !confirm(I18N.t("confirm_experimental_workers"))) event.target.checked = false;
  });

  elements.refreshFingerprint?.addEventListener("click", async () => {
    const button = elements.refreshFingerprint;
    const text = button.querySelector('[data-i18n="btn_refresh_fingerprint"]');
    const original = text ? text.textContent : "";
    button.disabled = true;
    if (text) text.textContent = "...";
    try {
      await api.runtime.sendMessage({ action: "refreshCanvasSeed" });
      if (text) text.textContent = I18N.t("fingerprint_refreshed");
    } catch (error) {
      if (text) text.textContent = original;
    } finally {
      button.disabled = false;
      setTimeout(() => { if (text) text.textContent = original; }, 2000);
    }
  });

  elements.resetLocation?.addEventListener("click", async () => {
    const seed = await SharedConfig.getSeed();
    setLocation(seed.latitude, seed.longitude, true);
    if (map) map.setZoom(10);
    const label = elements.resetLocation.querySelector('[data-i18n="btn_reset_geo"]');
    if (!label) return;
    const original = label.textContent;
    label.textContent = I18N.t("reset_done");
    setTimeout(() => { label.textContent = original; }, 1500);
  });

  elements.save?.addEventListener("click", async () => {
    let domains = elements.domains.value.split("\n").map((line) => line.trim()).filter(Boolean);
    if (domains.length === 0) {
      domains = DEFAULT_DOMAINS.slice();
      elements.domains.value = domains.join("\n");
    }

    const next = {
      ...config,
      enabled: elements.enabled.checked,
      latitude,
      longitude,
      language: elements.language.value,
      timezone: elements.timezone.value || "America/Los_Angeles",
      webrtcProtection: !elements.webrtc || elements.webrtc.checked,
      canvasProtection: !!elements.canvas && elements.canvas.checked,
      webglProtection: !!elements.webgl && elements.webgl.checked,
      audioProtection: !!elements.audio && elements.audio.checked,
      fontProtection: !!elements.fonts && elements.fonts.checked,
      webgpuProtection: !!elements.webgpu && elements.webgpu.checked,
      workerProtection: !!elements.workers && elements.workers.checked,
      iframeCoverage: !!elements.iframe && elements.iframe.checked,
      autoSyncVpn: !elements.autoSyncVpn || elements.autoSyncVpn.checked,
      domains
    };

    const autoLatitude = +toNumber(config.latitude, latitude).toFixed(4);
    const autoLongitude = +toNumber(config.longitude, longitude).toFixed(4);
    const autoLanguage = config.language || "en-US";
    const autoTimezone = config.timezone || "America/Los_Angeles";
    const locationChanged = latitude !== autoLatitude
      || longitude !== autoLongitude
      || (next.timezone !== autoTimezone);
    const personaChanged = locationChanged || next.language !== autoLanguage;
    next.manualOverride = personaChanged ? true : config.manualOverride === true;
    if (locationChanged) {
      next.country = "";
      next.city = "";
    }

    const original = buttonBusy(elements.save, I18N.t("saving"));
    try {
      await saveConfig(next);
      config = next;
      renderVpnStatus();
      showToast(I18N.t("toast_saved"));
    } catch (error) {
      showToast(I18N.t("sync_failed"));
    } finally {
      buttonRestore(elements.save, original);
    }
  });

  elements.reset?.addEventListener("click", async () => {
    if (!confirm(I18N.t("confirm_restore"))) return;
    const seed = await SharedConfig.getSeed();
    const next = {
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
      country: "",
      city: "",
      domains: DEFAULT_DOMAINS.slice()
    };
    try {
      await saveConfig(next);
      config = next;
      renderForm(next, true);
      if (map) map.setZoom(10);
      showToast(I18N.t("toast_restored"));
    } catch (error) {
      showToast(I18N.t("sync_failed"));
    }
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.locaCloakVpnState) {
      vpnState = changes.locaCloakVpnState.newValue || null;
      renderVpnStatus();
    }
    if (changes.locaCloakConfig && changes.locaCloakConfig.newValue) {
      config = { ...config, ...changes.locaCloakConfig.newValue };
      renderForm(config, false);
    }
  });
});
