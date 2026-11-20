const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CHROME = path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1248", "chrome-win64", "chrome.exe");
const CHROME = process.env.LOCACLOAK_CHROME || DEFAULT_CHROME;
const EXTENSION = path.resolve(__dirname, "..", "extension");
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "locacloak-cdp-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) { console.log(`[test] ${message}`); }

async function waitFor(fn, timeout = 30000, interval = 250) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`timeout${lastError ? `: ${lastError.message}` : ""}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (event) => this._onMessage(event.data);
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP closed"));
      this.pending.clear();
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (event) => reject(new Error(`WebSocket error: ${event.message || "unknown"}`));
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
  }

  _onMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
      return;
    }
    const handlers = this.handlers.get(message.method);
    if (handlers) for (const handler of handlers) handler(message.params, message.sessionId);
  }
}

async function evaluate(cdp, sessionId, expression, awaitPromise = true) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed");
  }
  return result.result.value;
}

async function openPage(cdp, id, url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { targetId } = await cdp.send("Target.createTarget", { url });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    try {
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      await waitFor(async () => (await evaluate(cdp, sessionId, "document.readyState")) === "complete", 30000);
      return { targetId, sessionId };
    } catch (error) {
      lastError = error;
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      await sleep(500);
    }
  }
  throw lastError || new Error("openPage failed");
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
  fs.mkdirSync(PROFILE, { recursive: true });

  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/frame.html")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body><script>
        window.__frameProbe = () => ({
          lang: navigator.language,
          langs: Array.from(navigator.languages),
          tz: new Intl.DateTimeFormat().resolvedOptions().timeZone
        });
      </script></body></html>`);
      return;
    }
    if (request.url.startsWith("/frame-host.html")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><body><iframe src="http://127.0.0.2:${testPort}/frame.html"></iframe></body></html>`);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>LocaCloak test</title></head><body>
      <h1>LocaCloak test page</h1>
      <script>
        window.__lcEqual = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
        window.__lcProbe = () => ({
          lang: navigator.language,
          langs: Array.from(navigator.languages),
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offset: new Date().getTimezoneOffset(),
          date: new Date().toString()
        });
        window.__lcCanvasProbe = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 200;
          canvas.height = 60;
          const context = canvas.getContext("2d");
          context.fillStyle = "#123456";
          context.fillRect(0, 0, 200, 60);
          context.fillStyle = "#ffffff";
          context.font = "20px sans-serif";
          context.fillText("LocaCloak", 10, 35);
          const first = canvas.toDataURL();
          const second = canvas.toDataURL();
          const data1 = Array.from(context.getImageData(10, 10, 40, 20).data);
          const data2 = Array.from(context.getImageData(10, 10, 40, 20).data);
          const a = context.getImageData(5, 5, 20, 20).data;
          const b = context.getImageData(15, 15, 10, 10).data;
          let overlapEqual = true;
          for (let y = 0; y < 10 && overlapEqual; y++) {
            for (let x = 0; x < 10 && overlapEqual; x++) {
              const ai = ((y + 10) * 20 + (x + 10)) * 4;
              const bi = (y * 10 + x) * 4;
              for (let channel = 0; channel < 4; channel++) {
                if (a[ai + channel] !== b[bi + channel]) overlapEqual = false;
              }
            }
          }
          return {
            equal: first === second,
            dataEqual: window.__lcEqual(data1, data2),
            overlapEqual,
            first,
            length: first.length
          };
        };
        window.__lcOffscreenProbe = async () => {
          if (typeof OffscreenCanvas === "undefined") return { supported: false };
          const canvas = new OffscreenCanvas(80, 40);
          const context = canvas.getContext("2d");
          context.fillStyle = "#336699";
          context.fillRect(0, 0, 80, 40);
          const data1 = Array.from(context.getImageData(0, 0, 80, 40).data);
          const data2 = Array.from(context.getImageData(0, 0, 80, 40).data);
          const blob1 = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
          const blob2 = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
          return {
            supported: true,
            dataEqual: window.__lcEqual(data1, data2),
            blobEqual: window.__lcEqual(Array.from(blob1), Array.from(blob2)),
            blobLength: blob1.length
          };
        };
        window.__lcWebglProbe = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 120;
          canvas.height = 80;
          const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true }) || canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true });
          if (!gl) return { supported: false };
          gl.clearColor(0.25, 0.5, 0.75, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          const pixels = new Uint8Array(20 * 20 * 4);
          gl.readPixels(0, 0, 20, 20, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const first = canvas.toDataURL();
          const second = canvas.toDataURL();
          return {
            supported: true,
            vendor: gl.getParameter(gl.VENDOR),
            renderer: gl.getParameter(gl.RENDERER),
            unmaskedVendor: gl.getParameter(0x9245),
            unmaskedRenderer: gl.getParameter(0x9246),
            debugExtension: !!gl.getExtension("WEBGL_debug_renderer_info"),
            equal: first === second,
            first,
            readData: Array.from(pixels)
          };
        };
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const testPort = server.address().port;
  log(`local test server on 127.0.0.1:${testPort}`);

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    "--window-size=1280,900",
    `--log-file=${path.join(PROFILE, "chrome.log")}`,
    "--enable-logging"
  ];
  const chrome = spawn(CHROME, args, { stdio: "ignore", windowsHide: true });
  let browser = null;

  try {
    const portFile = path.join(PROFILE, "DevToolsActivePort");
    const port = await waitFor(() => {
      if (!fs.existsSync(portFile)) return null;
      const lines = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
      return lines[0] ? Number(lines[0]) : null;
    }, 20000);
    log(`DevTools port ${port}`);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browser = await CDP.connect(version.webSocketDebuggerUrl);

    const found = await waitFor(async () => {
      const { targetInfos } = await browser.send("Target.getTargets");
      const candidates = targetInfos.filter((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://") && /\/background\.js$/.test(target.url));
      for (const candidate of candidates) {
        const attached = await browser.send("Target.attachToTarget", { targetId: candidate.targetId, flatten: true });
        const sessionId = attached.sessionId;
        try {
          await browser.send("Runtime.enable", {}, sessionId);
          const manifest = await evaluate(browser, sessionId, "chrome.runtime.getManifest()");
          if (manifest.name === "LocaCloak-plus") return { target: candidate, sessionId, manifest };
        } catch (error) {
          // Another extension worker may be shutting down; try the next one.
        }
        await browser.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
      return null;
    }, 30000);

    const swTarget = found.target;
    const sw = found.sessionId;
    const extensionId = new URL(swTarget.url).host;
    log(`extension id ${extensionId}, worker ${swTarget.url}`);
    const manifest = found.manifest;
    log(`manifest ${manifest.name} ${manifest.version}; permissions=${manifest.permissions.join(",")}`);
    if (manifest.version !== "1.4.0") throw new Error("unexpected manifest version");
    if (!manifest.permissions.includes("alarms")) throw new Error("alarms permission missing");

    const alarms = await waitFor(async () => {
      const list = await evaluate(browser, sw, "chrome.alarms.getAll()");
      return list.some((alarm) => alarm.name === "locaCloakVpnWatch") ? list : null;
    }, 15000);
    log(`alarms: ${JSON.stringify(alarms)}`);
    if (!alarms.some((alarm) => alarm.name === "locaCloakVpnWatch")) throw new Error("watch alarm missing");

    let config = await waitFor(async () => {
      const value = await evaluate(browser, sw, "chrome.storage.local.get('locaCloakConfig').then((r) => r.locaCloakConfig)");
      return value && value.country ? value : null;
    }, 45000);
    log(`auto-synced config: ${config.country} / ${config.city} / ${config.timezone} / ${config.language} / auto=${config.autoSyncVpn}`);

    const page = await openPage(browser, extensionId, `http://127.0.0.1:${testPort}/test.html`);
    const before = await evaluate(browser, page.sessionId, "window.__lcProbe()");
    log(`page before spoof: ${JSON.stringify(before)}`);

    config = {
      ...config,
      enabled: true,
      autoSyncVpn: true,
      domains: ["127.0.0.1"],
      latitude: 35.6895,
      longitude: 139.6917,
      timezone: "Asia/Tokyo",
      language: "ja-JP",
      country: "JP",
      city: "Tokyo"
    };
    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify(config)} })`);
    await sleep(800);

    const tokyo = await evaluate(browser, page.sessionId, "({ ...window.__lcProbe(), firstFormatter: (window.__lcFirstFormatter = new Intl.DateTimeFormat()).resolvedOptions().timeZone })");
    log(`page after Tokyo config: ${JSON.stringify(tokyo)}`);
    if (tokyo.lang !== "ja-JP") throw new Error("navigator.language was not spoofed");
    if (tokyo.tz !== "Asia/Tokyo") throw new Error("Intl timezone was not spoofed");

    const stealth = await evaluate(browser, page.sessionId, `({
      update: typeof window.__locacloak_update__,
      marker: typeof window[Symbol.for("__lc__")],
      protectUpdate: typeof window.__locacloak_protect_update__,
      protectMarker: typeof window[Symbol.for("__lc_protect__")],
      script: !!document.querySelector('script[data-cfg]')
    })`);
    log(`page stealth: ${JSON.stringify(stealth)}`);
    if (stealth.update !== "undefined" || stealth.marker !== "undefined" || stealth.protectUpdate !== "undefined" || stealth.protectMarker !== "undefined" || stealth.script) {
      throw new Error("page-world update artifacts are still visible");
    }

    const tier1 = await evaluate(browser, page.sessionId, `(async () => {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      const hints = navigator.userAgentData
        ? await navigator.userAgentData.getHighEntropyValues(["platform", "platformVersion", "architecture", "bitness"])
        : null;
      const position = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (value) => resolve({ latitude: value.coords.latitude, longitude: value.coords.longitude }),
          (error) => resolve({ error: error.code })
        );
      });
      let rtc = null;
      try {
        const pc = new RTCPeerConnection();
        rtc = pc.getConfiguration().iceTransportPolicy;
        pc.close();
      } catch (error) {
        rtc = String(error);
      }
      return {
        languages: navigator.languages,
        numberLocale: new Intl.NumberFormat().resolvedOptions().locale,
        dateLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
        screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
        inner: [innerWidth, innerHeight],
        cores: navigator.hardwareConcurrency,
        memory: navigator.deviceMemory,
        platform: navigator.platform,
        uaWindows: /Windows/.test(navigator.userAgent),
        hintsPlatform: hints && hints.platform,
        hintsArchitecture: hints && hints.architecture,
        permission: permission.state,
        position,
        rtc
      };
    })()`);
    log(`tier1 surface: ${JSON.stringify(tier1)}`);
    if (tier1.languages[0] !== "ja-JP" || !tier1.languages.includes("ja")) throw new Error("language fallback chain was not applied");
    if (tier1.numberLocale !== "ja-JP" || tier1.dateLocale !== "ja-JP") throw new Error("Intl default locale was not applied");
    if (tier1.screen[0] < tier1.inner[0] || tier1.screen[1] < tier1.inner[1]) throw new Error("spoofed screen is smaller than the viewport");
    if (!Number.isFinite(tier1.cores) || tier1.cores < 2) throw new Error("hardwareConcurrency was not quantized");
    if (tier1.uaWindows && !/^Win/.test(tier1.platform)) throw new Error("navigator.platform contradicts the UA");
    if (tier1.hintsPlatform && tier1.uaWindows && tier1.hintsPlatform !== "Windows") throw new Error("Client Hints platform contradicts the UA");
    if (tier1.permission !== "granted") throw new Error("geolocation permission was not aligned");
    if (!tier1.position || Math.abs(tier1.position.latitude - 35.6895) > 0.01) throw new Error("geolocation position was not spoofed");
    if (tier1.rtc === "relay") throw new Error("WebRTC still forces relay");

    config = { ...config, latitude: 51.5072, longitude: -0.1276, timezone: "Europe/London", language: "en-GB", country: "GB", city: "London" };
    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify(config)} })`);
    await sleep(800);

    const london = await evaluate(browser, page.sessionId, `({
      ...window.__lcProbe(),
      cachedFormatter: window.__lcFirstFormatter.resolvedOptions().timeZone
    })`);
    log(`page after live London update: ${JSON.stringify(london)}`);
    if (london.lang !== "en-GB") throw new Error("live navigator.language update failed");
    if (london.tz !== "Europe/London") throw new Error("live Intl update failed");
    if (london.cachedFormatter !== "Asia/Tokyo") throw new Error("cached formatter behavior changed unexpectedly");

    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify({ ...config, domains: ["example.com"] })} })`);
    await sleep(500);
    const rules = await evaluate(browser, sw, "chrome.declarativeNetRequest.getDynamicRules()");
    log(`DNR rules: ${JSON.stringify(rules)}`);
    if (!rules.some((rule) => rule.action.requestHeaders.some((header) => header.header === "Accept-Language" && header.value.startsWith("en-GB")))) {
      throw new Error("Accept-Language rule not updated");
    }

    log("simulating VPN exit change");
    const simulation = await evaluate(browser, sw, `
      (async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
          const target = String(url);
          if (target.includes("cloudflare.com/cdn-cgi/trace")) {
            return new Response("ip=203.0.113.77\\nloc=GB\\n", { status: 200, headers: { "Content-Type": "text/plain" } });
          }
          if (target.includes("ipapi.co")) {
            return new Response(JSON.stringify({
              ip: "203.0.113.77", country_code: "GB", city: "London",
              latitude: 51.5072, longitude: -0.1276, timezone: "Europe/London"
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return new Response("{}", { status: 500 });
        };
        await chrome.storage.local.set({
          locaCloakConfig: ${JSON.stringify({ ...config, domains: ["example.com"], autoSyncVpn: true, enabled: true })},
          locaCloakVpnState: { ip: "198.51.100.1" }
        });
        const result = await autoSyncVpn();
        globalThis.fetch = realFetch;
        return { result, config: (await chrome.storage.local.get("locaCloakConfig")).locaCloakConfig, state: (await chrome.storage.local.get("locaCloakVpnState")).locaCloakVpnState };
      })()
    `, true);
    log(`simulated auto-sync result: ${JSON.stringify(simulation.result)}`);
    log(`simulated auto-sync config: ${simulation.config.country} / ${simulation.config.city} / ${simulation.config.timezone} / ${simulation.config.language} / ${simulation.config.latitude},${simulation.config.longitude}`);
    log(`simulated auto-sync state: ${JSON.stringify(simulation.state)}`);
    if (simulation.config.country !== "GB" || simulation.config.timezone !== "Europe/London" || simulation.config.language !== "en-GB") {
      throw new Error("auto-sync did not apply simulated VPN change");
    }
    if (simulation.state.ip !== "203.0.113.77") throw new Error("auto-sync did not record probe IP");

    log("simulating auto-sync while Persona is locked");
    const lockedSimulation = await evaluate(browser, sw, `
      (async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
          const target = String(url);
          if (target.includes("cloudflare.com/cdn-cgi/trace")) {
            return new Response("ip=203.0.113.88\\nloc=SG\\n", { status: 200, headers: { "Content-Type": "text/plain" } });
          }
          if (target.includes("ipapi.co")) {
            return new Response(JSON.stringify({
              ip: "203.0.113.88", country_code: "SG", city: "Singapore",
              latitude: 1.2897, longitude: 103.8501, timezone: "Asia/Singapore"
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return new Response("{}", { status: 500 });
        };
        await chrome.storage.local.set({
          locaCloakConfig: ${JSON.stringify({
            ...simulation.config,
            manualOverride: true,
            latitude: 35.6895,
            longitude: 139.6917,
            timezone: "Asia/Tokyo",
            language: "ja-JP",
            country: "JP",
            city: "Tokyo"
          })},
          locaCloakVpnState: { ip: "198.51.100.1" }
        });
        const result = await autoSyncVpn({ force: true });
        globalThis.fetch = realFetch;
        return { result, config: (await chrome.storage.local.get("locaCloakConfig")).locaCloakConfig, state: (await chrome.storage.local.get("locaCloakVpnState")).locaCloakVpnState };
      })()
    `, true);
    log(`locked auto-sync: ${JSON.stringify(lockedSimulation.result)} / ${lockedSimulation.config.latitude},${lockedSimulation.config.longitude} ${lockedSimulation.config.country} / vpn=${lockedSimulation.state.country}`);
    if (lockedSimulation.result.locked !== true) throw new Error("auto-sync did not report locked persona");
    if (lockedSimulation.config.manualOverride !== true || lockedSimulation.config.latitude !== 35.6895 || lockedSimulation.config.language !== "ja-JP") {
      throw new Error("locked auto-sync overwrote the manual persona");
    }
    if (lockedSimulation.state.country !== "SG") throw new Error("locked auto-sync did not record the VPN state");

    const canvasBaseline = await evaluate(browser, page.sessionId, "window.__lcCanvasProbe()");
    const webglBaseline = await evaluate(browser, page.sessionId, "window.__lcWebglProbe()");
    const audioProbe = `(async () => {
      if (!window.OfflineAudioContext) return { supported: false };
      const context = new OfflineAudioContext(1, 128, 44100);
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      oscillator.connect(context.destination);
      oscillator.start();
      const buffer = await context.startRendering();
      const data = buffer.getChannelData(0);
      return { supported: true, sum: Array.from(data.slice(0, 64)).reduce((a, b) => a + b, 0), first: data[0] };
    })()`;
    const fontProbe = `(() => {
      const context = document.createElement("canvas").getContext("2d");
      context.font = "20px Arial";
      return context.measureText("LocaCloak").width;
    })()`;
    const bitmapProbe = `(async () => {
      if (!window.createImageBitmap) return { supported: false };
      const source = document.createElement("canvas");
      source.width = 32;
      source.height = 32;
      const context = source.getContext("2d");
      context.fillStyle = "#123456";
      context.fillRect(0, 0, 32, 32);
      const bitmap = await createImageBitmap(source);
      const target = document.createElement("canvas");
      target.width = 32;
      target.height = 32;
      const targetContext = target.getContext("2d");
      targetContext.drawImage(bitmap, 0, 0);
      const data = targetContext.getImageData(0, 0, 32, 32).data;
      return { supported: true, sum: Array.from(data).reduce((a, b) => a + b, 0) };
    })()`;
    const workerProbe = `(async () => {
      if (!window.Worker) return { supported: false };
      const code = 'postMessage({lang:navigator.language,langs:Array.from(navigator.languages),tz:new Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date(0).getTimezoneOffset()});';
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const worker = new Worker(url);
      const result = await new Promise((resolve) => {
        let settled = false;
        worker.onmessage = (event) => { settled = true; resolve(event.data); };
        worker.onerror = (event) => { settled = true; resolve({ error: event.message || "worker_error" }); };
        setTimeout(() => { if (!settled) resolve({ timeout: true }); }, 3000);
      });
      worker.terminate();
      URL.revokeObjectURL(url);
      return { supported: true, result };
    })()`;
    const workerModuleProbe = `(async () => {
      if (!window.Worker) return { supported: false };
      const code = 'postMessage({lang:navigator.language,tz:new Intl.DateTimeFormat().resolvedOptions().timeZone});';
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const worker = new Worker(url, { type: "module" });
      const result = await new Promise((resolve) => {
        let settled = false;
        worker.onmessage = (event) => { settled = true; resolve(event.data); };
        worker.onerror = (event) => { settled = true; resolve({ error: event.message || "worker_error" }); };
        setTimeout(() => { if (!settled) resolve({ timeout: true }); }, 3000);
      });
      worker.terminate();
      URL.revokeObjectURL(url);
      return { supported: true, result };
    })()`;
    const audioBaseline = await evaluate(browser, page.sessionId, audioProbe);
    const fontBaseline = await evaluate(browser, page.sessionId, fontProbe);
    const bitmapBaseline = await evaluate(browser, page.sessionId, bitmapProbe);
    const workerBaseline = await evaluate(browser, page.sessionId, workerProbe);
    const workerModuleBaseline = await evaluate(browser, page.sessionId, workerModuleProbe);

    const protectionConfig = {
      ...simulation.config,
      canvasProtection: true,
      webglProtection: true,
      audioProtection: true,
      fontProtection: true,
      webgpuProtection: true,
      workerProtection: true,
      domains: ["127.0.0.1"]
    };
    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakCanvasSeed: "test-seed-123" })`);
    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify(protectionConfig)} })`);
    await sleep(1200);

    const canvasProtected = await evaluate(browser, page.sessionId, "window.__lcCanvasProbe()");
    log(`canvas protected: equal=${canvasProtected.equal} dataEqual=${canvasProtected.dataEqual} overlapEqual=${canvasProtected.overlapEqual}`);
    if (!canvasProtected.equal || !canvasProtected.dataEqual || !canvasProtected.overlapEqual) throw new Error("canvas noise is not stable");
    if (canvasProtected.first === canvasBaseline.first) throw new Error("canvas protection did not change the baseline export");

    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakCanvasSeed: "test-seed-456" })`);
    await sleep(700);
    const canvasReseeded = await evaluate(browser, page.sessionId, "window.__lcCanvasProbe()");
    log(`canvas reseeded: exportDiffers=${canvasReseeded.first !== canvasProtected.first}`);
    if (canvasReseeded.first === canvasProtected.first) throw new Error("canvas seed refresh did not change the export");

    const offscreenProtected = await evaluate(browser, page.sessionId, "window.__lcOffscreenProbe()");
    log(`offscreen protected: ${JSON.stringify({ supported: offscreenProtected.supported, dataEqual: offscreenProtected.dataEqual, blobEqual: offscreenProtected.blobEqual })}`);
    if (offscreenProtected.supported && (!offscreenProtected.dataEqual || !offscreenProtected.blobEqual)) throw new Error("offscreen canvas noise is not stable");

    const webglProtected = await evaluate(browser, page.sessionId, "window.__lcWebglProbe()");
    log(`webgl protected: ${JSON.stringify({ supported: webglProtected.supported, vendor: webglProtected.vendor, renderer: webglProtected.renderer, unmaskedVendor: webglProtected.unmaskedVendor, unmaskedRenderer: webglProtected.unmaskedRenderer, debugExtension: webglProtected.debugExtension, equal: webglProtected.equal })}`);
    if (webglProtected.supported) {
      if (webglProtected.vendor !== "WebKit" || webglProtected.renderer !== "WebKit WebGL") throw new Error("WebGL vendor/renderer was not masked");
      if (!String(webglProtected.unmaskedVendor || "").includes("Google Inc.")) throw new Error("WebGL unmasked vendor was not spoofed");
      if (!String(webglProtected.unmaskedRenderer || "").includes("ANGLE (")) throw new Error("WebGL unmasked renderer was not spoofed");
      if (!webglProtected.debugExtension) throw new Error("WEBGL_debug_renderer_info was not faked");
      if (!webglProtected.equal) throw new Error("WebGL canvas export is not stable");
      if (webglBaseline.supported) {
        if (webglProtected.first === webglBaseline.first) throw new Error("WebGL canvas protection did not change the export");
        const readChanged = webglProtected.readData.some((value, index) => value !== webglBaseline.readData[index]);
        if (!readChanged) throw new Error("WebGL readPixels was not noised");
      }
    }

    const audioProtected = await evaluate(browser, page.sessionId, audioProbe);
    const audioProtectedAgain = await evaluate(browser, page.sessionId, audioProbe);
    const fontProtected = await evaluate(browser, page.sessionId, fontProbe);
    const bitmapProtected = await evaluate(browser, page.sessionId, bitmapProbe);
    const workerProtected = await evaluate(browser, page.sessionId, workerProbe);
    const workerModuleProtected = await evaluate(browser, page.sessionId, workerModuleProbe);
    const webglLimits = await evaluate(browser, page.sessionId, `(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) return { supported: false };
      return {
        supported: true,
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        debugSupported: gl.getSupportedExtensions().includes("WEBGL_debug_renderer_info")
      };
    })()`);
    log(`audio protected: ${JSON.stringify({ baseline: audioBaseline, protected: audioProtected, stable: audioProtected.sum === audioProtectedAgain.sum && audioProtected.first === audioProtectedAgain.first })}`);
    log(`font protected: baseline=${fontBaseline} protected=${fontProtected}`);
    log(`createImageBitmap protected: ${JSON.stringify({ baseline: bitmapBaseline, protected: bitmapProtected })}`);
    log(`worker protected: ${JSON.stringify({ baseline: workerBaseline, protected: workerProtected })}`);
    log(`worker module protected: ${JSON.stringify({ baseline: workerModuleBaseline, protected: workerModuleProtected })}`);
    log(`webgl limits: ${JSON.stringify(webglLimits)}`);
    if (audioBaseline.supported && audioProtected.supported) {
      if (audioProtected.sum === audioBaseline.sum && audioProtected.first === audioBaseline.first) throw new Error("audio protection did not change the render");
      if (audioProtected.sum !== audioProtectedAgain.sum || audioProtected.first !== audioProtectedAgain.first) throw new Error("audio protection is not deterministic");
    }
    if (fontProtected === fontBaseline) throw new Error("font metric protection did not change measureText");
    if (bitmapBaseline.supported && bitmapProtected.supported && bitmapBaseline.sum === bitmapProtected.sum) throw new Error("createImageBitmap protection did not change pixels");
    if (workerBaseline.supported && workerProtected.supported) {
      const result = workerProtected.result || {};
      if (result.timeout || result.error) throw new Error(`worker protection failed: ${JSON.stringify(result)}`);
      if (result.lang !== protectionConfig.language || result.tz !== protectionConfig.timezone) throw new Error(`worker locale/timezone was not patched: ${JSON.stringify(result)}`);
    }
    if (workerModuleBaseline.supported && workerModuleProtected.supported) {
      const result = workerModuleProtected.result || {};
      if (result.timeout || result.error) throw new Error(`module worker protection failed: ${JSON.stringify(result)}`);
      if (result.lang !== protectionConfig.language || result.tz !== protectionConfig.timezone) throw new Error(`module worker locale/timezone was not patched: ${JSON.stringify(result)}`);
    }
    if (webglLimits.supported && (webglLimits.maxTexture !== 16384 || webglLimits.debugSupported)) throw new Error("WebGL limits/extensions were not spoofed");

    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify({ ...protectionConfig, canvasProtection: false })} })`);
    await sleep(700);
    const canvasRaw = await evaluate(browser, page.sessionId, "window.__lcCanvasProbe()");
    log(`canvas raw: equal=${canvasRaw.equal}, matchesBaseline=${canvasRaw.first === canvasBaseline.first}`);
    if (!canvasRaw.equal) throw new Error("raw canvas export is not stable");
    if (canvasRaw.first !== canvasBaseline.first) throw new Error("raw canvas export changed after disabling protection");
    if (canvasRaw.first === canvasProtected.first) throw new Error("canvas protection did not change the export");

    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify({ ...protectionConfig, webglProtection: false })} })`);
    await sleep(700);
    const webglRaw = await evaluate(browser, page.sessionId, "window.__lcWebglProbe()");
    if (webglRaw.supported && webglBaseline.supported) {
      const readSame = webglRaw.readData.length === webglBaseline.readData.length
        && webglRaw.readData.every((value, index) => value === webglBaseline.readData[index]);
      log(`webgl raw: rendererMatchesBaseline=${webglRaw.unmaskedRenderer === webglBaseline.unmaskedRenderer}, exportMatchesBaseline=${webglRaw.first === webglBaseline.first}, readMatchesBaseline=${readSame}`);
      if (webglRaw.unmaskedRenderer !== webglBaseline.unmaskedRenderer) throw new Error("WebGL renderer was still spoofed after disabling protection");
      if (webglRaw.first !== webglBaseline.first) throw new Error("raw WebGL export changed after disabling protection");
      if (!readSame) throw new Error("raw WebGL readPixels changed after disabling protection");
    }

    const frameConfig = {
      ...protectionConfig,
      domains: ["127.0.0.1"],
      iframeCoverage: true,
      latitude: 35.6895,
      longitude: 139.6917,
      timezone: "Asia/Tokyo",
      language: "ja-JP"
    };
    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify(frameConfig)} })`);
    const frameHostPage = await openPage(browser, extensionId, `http://127.0.0.1:${testPort}/frame-host.html`);
    await sleep(1500);
    const frameTargets = await browser.send("Target.getTargets");
    const frameTarget = frameTargets.targetInfos.find((target) => target.url.includes("127.0.0.2") && target.url.includes("/frame.html"));
    if (frameTarget) {
      const frameAttached = await browser.send("Target.attachToTarget", { targetId: frameTarget.targetId, flatten: true });
      await browser.send("Runtime.enable", {}, frameAttached.sessionId);
      const frameProbe = await evaluate(browser, frameAttached.sessionId, "window.__frameProbe ? window.__frameProbe() : null");
      log(`cross-origin iframe probe: ${JSON.stringify(frameProbe)}`);
      if (!frameProbe || frameProbe.lang !== "ja-JP" || frameProbe.tz !== "Asia/Tokyo") throw new Error("cross-origin iframe was not patched");
    } else {
      log("cross-origin iframe target unavailable; skipped");
    }
    await browser.send("Target.closeTarget", { targetId: frameHostPage.targetId }).catch(() => {});

    const optionsPage = await openPage(browser, extensionId, `chrome-extension://${extensionId}/options.html`);
    const optionsState = await evaluate(browser, optionsPage.sessionId, `({
      autoToggle: !!document.getElementById("auto-sync-vpn"),
      status: document.querySelector("#vpn-sync-status .vpn-status-text")?.textContent,
      label: I18N.t("toggle_auto_sync"),
      map: !!window._locaCloakMap,
      tileUrl: window._locaCloakTileLayer?._url || "",
      timezoneOptions: document.querySelectorAll("#timezone option").length,
      languageOptions: document.querySelectorAll("#language option").length
    })`);
    log(`options page: ${JSON.stringify(optionsState)}`);
    if (!optionsState.autoToggle || !optionsState.map) throw new Error("options page did not initialize");
    if (!optionsState.tileUrl.includes("tile.openstreetmap.org") || optionsState.tileUrl.includes("cartocdn")) throw new Error("options map still uses a keyed CARTO basemap");

    const mapTiles = await waitFor(async () => {
      const tiles = await evaluate(browser, optionsPage.sessionId, `Array.from(document.querySelectorAll("#map img.leaflet-tile")).map((image) => ({
        src: image.src,
        complete: image.complete,
        width: image.naturalWidth
      }))`);
      return tiles.some((tile) => tile.complete && tile.width > 0) ? tiles : null;
    }, 15000);
    log(`map tiles: ${JSON.stringify(mapTiles.slice(0, 2))}`);
    if (!mapTiles.some((tile) => tile.complete && tile.width > 0)) throw new Error("OpenStreetMap tiles did not load");

    const testPageState = await evaluate(browser, optionsPage.sessionId, `(() => {
      document.querySelector('.nav-item[data-page="test"]').click();
      return {
        active: document.getElementById("page-test")?.classList.contains("active"),
        links: document.querySelectorAll("#page-test [data-test-url]").length,
        enable: !!document.getElementById("test-enable-protection"),
        status: document.querySelector("#test-protection-status .vpn-status-text")?.textContent || ""
      };
    })()`);
    log(`test sites page: ${JSON.stringify(testPageState)}`);
    if (!testPageState.active || testPageState.links < 5 || !testPageState.enable) throw new Error("test sites page did not initialize");

    await evaluate(browser, optionsPage.sessionId, `document.getElementById("test-enable-protection").click()`);
    await sleep(800);
    const testEnabledConfig = await evaluate(browser, sw, `chrome.storage.local.get("locaCloakConfig").then((result) => result.locaCloakConfig)`);
    log(`test enable button: canvas=${testEnabledConfig.canvasProtection} webgl=${testEnabledConfig.webglProtection}`);
    if (testEnabledConfig.canvasProtection !== true || testEnabledConfig.webglProtection !== true) throw new Error("test enable button did not enable both protections");

    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify({ ...simulation.config, language: "it-IT", timezone: "Europe/Lisbon" })} })`);
    await sleep(600);
    const dynamicOptions = await evaluate(browser, optionsPage.sessionId, `({
      langValue: document.getElementById("language").value,
      langHasOption: Array.from(document.getElementById("language").options).some((option) => option.value === "it-IT"),
      langTrigger: document.querySelector("#language + .cs-wrapper .cs-trigger-text")?.textContent,
      tzValue: document.getElementById("timezone").value,
      tzHasOption: Array.from(document.getElementById("timezone").options).some((option) => option.value === "Europe/Lisbon"),
      tzTrigger: document.querySelector("#timezone + .cs-wrapper .cs-trigger-text")?.textContent
    })`);
    log(`dynamic select options: ${JSON.stringify(dynamicOptions)}`);
    if (!dynamicOptions.langHasOption || !dynamicOptions.tzHasOption) throw new Error("newly auto-synced language/timezone option was not added");
    if (dynamicOptions.langTrigger !== "it-IT" || dynamicOptions.tzTrigger !== "Europe/Lisbon") throw new Error("custom select did not refresh after adding an option");

    await evaluate(browser, optionsPage.sessionId, `(() => {
      document.getElementById("language").value = "fr-FR";
      document.getElementById("timezone").value = "Europe/Paris";
      document.getElementById("domains").value = "example.com\\n*.example.org";
      document.getElementById("save").click();
      return true;
    })()`);
    await sleep(1200);
    const savedConfig = await evaluate(browser, sw, `chrome.storage.local.get("locaCloakConfig").then((result) => result.locaCloakConfig)`);
    log(`options save config: ${savedConfig.language} / ${savedConfig.timezone} / ${JSON.stringify(savedConfig.domains)} / country=${savedConfig.country || ""}`);
    if (savedConfig.language !== "fr-FR" || savedConfig.timezone !== "Europe/Paris") throw new Error("options save did not persist language/timezone");
    if (!savedConfig.domains.includes("example.com") || !savedConfig.domains.includes("*.example.org")) throw new Error("options save did not persist domains");
    if (savedConfig.country || savedConfig.city) throw new Error("manual timezone change should clear the stale country/city label");
    if (savedConfig.manualOverride !== true) throw new Error("manual location/locale save did not lock the persona");
    const lockedUi = await evaluate(browser, optionsPage.sessionId, `({
      status: document.querySelector("#vpn-sync-status .vpn-status-text")?.textContent || "",
      restoreVisible: !document.getElementById("restore-auto").hidden,
      restoreDisplay: getComputedStyle(document.getElementById("restore-auto")).display
    })`);
    log(`manual override UI: ${JSON.stringify(lockedUi)}`);
    if (!lockedUi.restoreVisible || lockedUi.restoreDisplay === "none" || !/手动覆盖|Manual override/.test(lockedUi.status)) throw new Error("manual override UI was not rendered");

    await evaluate(browser, optionsPage.sessionId, `document.getElementById("sync-vpn").click()`);
    const manualSyncText = await waitFor(async () => {
      const text = await evaluate(browser, optionsPage.sessionId, `document.querySelector("#sync-vpn .btn-text")?.textContent || ""`);
      return /已同步|Synced/.test(text) ? text : null;
    }, 45000);
    log(`manual sync button: ${manualSyncText}`);
    const manualConfig = await evaluate(browser, sw, `chrome.storage.local.get("locaCloakConfig").then((result) => result.locaCloakConfig)`);
    if (!manualConfig.country) throw new Error("manual sync did not persist a country");
    if (manualConfig.manualOverride === true) throw new Error("manual sync did not clear the persona lock");
    const restoreAfterSync = await evaluate(browser, optionsPage.sessionId, `({
      hidden: document.getElementById("restore-auto").hidden,
      display: getComputedStyle(document.getElementById("restore-auto")).display
    })`);
    log(`restore button after manual sync: ${JSON.stringify(restoreAfterSync)}`);
    if (!restoreAfterSync.hidden || restoreAfterSync.display !== "none") throw new Error("restore button stayed visible after auto-follow resumed");
    log(`manual sync config: ${manualConfig.country} / ${manualConfig.city} / ${manualConfig.timezone} / ${manualConfig.language}`);

    const zh = await evaluate(browser, optionsPage.sessionId, `I18N.setLocale("zh-CN").then(() => { I18N.applyToDOM(); return I18N.t("toggle_auto_sync"); })`);
    log(`zh-CN auto-sync label: ${zh}`);
    if (zh !== "自动跟随 VPN") throw new Error("zh-CN auto-sync strings missing");

    const popupPage = await openPage(browser, extensionId, `chrome-extension://${extensionId}/popup.html`);
    const popupDebug = await evaluate(browser, popupPage.sessionId, `(async () => {
      const result = { ready: document.readyState, hasShared: typeof SharedConfig, hasApi: typeof _api };
      try { result.config = await SharedConfig.load(); } catch (error) { result.configError = String(error); }
      try { result.activation = await ActivationManager.check(); } catch (error) { result.activationError = String(error); }
      return result;
    })()`);
    log(`popup debug: ${JSON.stringify(popupDebug)}`);
    const popupState = await waitFor(async () => {
      const state = await evaluate(browser, popupPage.sessionId, `(async () => {
        const config = await SharedConfig.load();
        return {
          coords: document.getElementById("location-coords")?.textContent,
          tz: document.getElementById("timezone-info")?.textContent,
          loaded: { latitude: config.latitude, country: config.country, city: config.city, timezone: config.timezone }
        };
      })()`);
      return state && state.coords && state.coords !== "34.0522, -118.2437" ? state : null;
    }, 15000);
    log(`popup: ${JSON.stringify(popupState)}`);
    const expectedPopupCoords = manualConfig.country && manualConfig.city
      ? `${manualConfig.country}, ${manualConfig.city}`
      : popupState.coords;
    if (!popupState.coords || popupState.coords !== expectedPopupCoords) throw new Error("popup did not render the synced location");

    await evaluate(browser, optionsPage.sessionId, `document.getElementById("auto-sync-vpn").click()`);
    await sleep(800);
    const uiOffConfig = await evaluate(browser, sw, `chrome.storage.local.get("locaCloakConfig").then((result) => result.locaCloakConfig)`);
    const alarmsOff = await evaluate(browser, sw, "chrome.alarms.getAll()");
    log(`UI toggle off -> autoSyncVpn=${uiOffConfig.autoSyncVpn}, alarms=${JSON.stringify(alarmsOff)}`);
    if (uiOffConfig.autoSyncVpn !== false) throw new Error("UI toggle did not persist autoSyncVpn=false");
    if (alarmsOff.some((alarm) => alarm.name === "locaCloakVpnWatch")) throw new Error("watch alarm was not cleared when auto-sync was disabled");

    const statusOff = await evaluate(browser, optionsPage.sessionId, `document.querySelector("#vpn-sync-status .vpn-status-text")?.textContent`);
    log(`options status while disabled: ${statusOff}`);
    if (!statusOff.includes("自动同步已关闭")) throw new Error("auto-sync off status was not rendered");

    await evaluate(browser, optionsPage.sessionId, `document.getElementById("auto-sync-vpn").click()`);
    await sleep(800);
    const uiOnConfig = await evaluate(browser, sw, `chrome.storage.local.get("locaCloakConfig").then((result) => result.locaCloakConfig)`);
    const alarmsOn = await evaluate(browser, sw, "chrome.alarms.getAll()");
    log(`UI toggle on -> autoSyncVpn=${uiOnConfig.autoSyncVpn}, alarms=${JSON.stringify(alarmsOn)}`);
    if (uiOnConfig.autoSyncVpn !== true) throw new Error("UI toggle did not persist autoSyncVpn=true");
    if (!alarmsOn.some((alarm) => alarm.name === "locaCloakVpnWatch")) throw new Error("watch alarm was not recreated");

    log("ALL CHECKS PASSED");
  } finally {
    server.close();
    try { browser?.ws.close(); } catch (error) {}
    try { chrome.kill(); } catch (error) {}
    await sleep(1000);
    try {
      execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    } catch (error) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (error) {}
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
