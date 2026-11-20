const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION = path.join(ROOT, "extension");
const DEFAULT_CHROME = path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1248", "chrome-win64", "chrome.exe");
const CHROME = process.env.LOCACLOAK_CHROME || DEFAULT_CHROME;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "locacloak-sites-"));
const ARTIFACT_DIR = path.join(ROOT, "tests", "artifacts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[sites] ${message}`);
}

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

  _onMessage(raw) {
    const message = JSON.parse(raw);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
    else pending.resolve(message.result);
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluation failed");
  }
  return result.result.value;
}

async function openPage(cdp, url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { targetId } = await cdp.send("Target.createTarget", { url });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    try {
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      await waitFor(async () => (await evaluate(cdp, sessionId, "document.readyState")) === "complete", 45000);
      return { targetId, sessionId };
    } catch (error) {
      lastError = error;
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      await sleep(500);
    }
  }
  throw lastError || new Error("openPage failed");
}

const CANVAS_SITE = {
  name: "BrowserLeaks Canvas",
  url: "https://browserleaks.com/canvas",
  ready: `document.querySelector("#canvas-hash")?.textContent?.trim() || ""`,
  read: `({
    hash: document.querySelector("#canvas-hash")?.textContent?.trim() || "",
    support: document.querySelector("#canvas-support-2d")?.textContent?.trim() || ""
  })`
};

const WEBGL_SITE = {
  name: "BrowserLeaks WebGL",
  url: "https://browserleaks.com/webgl",
  ready: `document.querySelector("#UNMASKED_RENDERER_WEBGL")?.textContent?.trim() || ""`,
  read: `({
    vendor: document.querySelector("#VENDOR")?.textContent?.trim() || "",
    renderer: document.querySelector("#RENDERER")?.textContent?.trim() || "",
    unmaskedVendor: document.querySelector("#UNMASKED_VENDOR_WEBGL")?.textContent?.trim() || "",
    unmaskedRenderer: document.querySelector("#UNMASKED_RENDERER_WEBGL")?.textContent?.trim() || "",
    imageHash: document.querySelector("#gl-image-hash")?.textContent?.trim() || ""
  })`
};

const WEBGL_REPORT_SITE = {
  name: "WebGL Report",
  url: "https://webglreport.com/",
  ready: `document.body.innerText.includes("Unmasked Renderer") ? "ready" : ""`,
  read: `(() => {
    const text = document.body.innerText;
    return {
      hasUnmasked: text.includes("Unmasked Renderer"),
      hasFakeGpu: text.includes("Intel(R) UHD Graphics 620"),
      hasSwiftShader: text.includes("SwiftShader"),
      sample: text.slice(0, 500)
    };
  })()`
};

const DEVICE_INFO_SITE = {
  name: "Device Info",
  url: "https://deviceinfo.me/",
  optional: true,
  ready: `document.body && document.body.innerText.includes("Canvas Fingerprinting") ? "ready" : ""`,
  read: `(() => {
    const text = document.body.innerText;
    return {
      hasCanvas: text.includes("Canvas"),
      hasWebGL: text.includes("WebGL"),
      hasFakeGpu: text.includes("Intel(R) UHD Graphics 620"),
      sample: text.slice(0, 500)
    };
  })()`
};

const SITES = [CANVAS_SITE, WEBGL_SITE, WEBGL_REPORT_SITE, DEVICE_INFO_SITE];

async function readSite(cdp, site) {
  const page = await openPage(cdp, site.url);
  await waitFor(async () => evaluate(cdp, page.sessionId, site.ready), site.timeout || 45000);
  return { page, value: await evaluate(cdp, page.sessionId, site.read) };
}

async function reloadSite(cdp, page, site) {
  await cdp.send("Page.reload", { ignoreCache: true }, page.sessionId);
  await waitFor(async () => (await evaluate(cdp, page.sessionId, "document.readyState")) === "complete", 45000);
  await waitFor(async () => evaluate(cdp, page.sessionId, site.ready), site.timeout || 45000);
  return evaluate(cdp, page.sessionId, site.read);
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chromium not found: ${CHROME}`);
  if (!fs.existsSync(path.join(EXTENSION, "manifest.json"))) throw new Error(`Extension not found: ${EXTENSION}`);

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
    "--disable-sync",
    "--metrics-recording-only",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXTENSION}`,
    "--window-size=1280,1000",
    `--log-file=${path.join(PROFILE, "chrome.log")}`,
    "--enable-logging"
  ];
  const chrome = spawn(CHROME, args, { stdio: "ignore", windowsHide: true });
  let browser = null;
  const report = { startedAt: new Date().toISOString(), sites: [], checks: [] };

  try {
    const portFile = path.join(PROFILE, "DevToolsActivePort");
    const port = await waitFor(() => {
      if (!fs.existsSync(portFile)) return null;
      const lines = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
      return lines[0] ? Number(lines[0]) : null;
    }, 20000);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browser = await CDP.connect(version.webSocketDebuggerUrl);

    const found = await waitFor(async () => {
      const { targetInfos } = await browser.send("Target.getTargets");
      const candidates = targetInfos.filter((target) => target.type === "service_worker"
        && target.url.startsWith("chrome-extension://")
        && /\/background\.js$/.test(target.url));
      for (const candidate of candidates) {
        const { sessionId } = await browser.send("Target.attachToTarget", { targetId: candidate.targetId, flatten: true });
        try {
          await browser.send("Runtime.enable", {}, sessionId);
          const manifest = await evaluate(browser, sessionId, "chrome.runtime.getManifest()");
          if (manifest.name === "LocaCloak-plus") return { target: candidate, sessionId, manifest };
        } catch (error) {}
        await browser.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
      return null;
    }, 30000);

    const sw = found.sessionId;
    log(`extension ${found.manifest.version} loaded (${new URL(found.target.url).host})`);

    // Stop the 30s VPN watcher first; an in-flight sync would otherwise be
    // able to replace the test allowlist with its stale copy mid-test.
    await evaluate(browser, sw, `chrome.storage.local.get("locaCloakConfig").then(async (result) => {
      const config = { ...(result.locaCloakConfig || {}), autoSyncVpn: false };
      await chrome.storage.local.set({ locaCloakConfig: config });
    })`);
    await sleep(1500);

    const original = await evaluate(browser, sw, `chrome.storage.local.get("locaCloakConfig").then((result) => result.locaCloakConfig)`);
    const testDomains = [
      "browserleaks.com", "*.browserleaks.com",
      "webglreport.com", "*.webglreport.com",
      "deviceinfo.me", "*.deviceinfo.me",
      "amiunique.org", "*.amiunique.org"
    ];
    const domains = Array.from(new Set([...(original.domains || []), ...testDomains]));
    const protectedConfig = { ...original, domains, canvasProtection: true, webglProtection: true, enabled: true, autoSyncVpn: false };

    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakCanvasSeed: "famous-sites-seed" })`);
    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify(protectedConfig)} })`);
    await sleep(500);

    log("reading protected results");
    for (const site of SITES) {
      try {
        const { page, value } = await readSite(browser, site);
        report.sites.push({ name: site.name, url: site.url, protected: value, page });
        log(`${site.name}: ${JSON.stringify(value)}`);
      } catch (error) {
        log(`${site.name} skipped: ${error.message}`);
        report.sites.push({ name: site.name, url: site.url, error: String(error) });
        if (!site.optional) throw error;
      }
    }

    const canvasProtected = report.sites.find((entry) => entry.name === CANVAS_SITE.name).protected;
    const webglProtected = report.sites.find((entry) => entry.name === WEBGL_SITE.name).protected;
    const reportProtected = report.sites.find((entry) => entry.name === WEBGL_REPORT_SITE.name).protected;

    report.checks.push({ name: "BrowserLeaks Canvas hash present", ok: canvasProtected.hash.length >= 16 });
    report.checks.push({ name: "BrowserLeaks Canvas supported", ok: canvasProtected.support.includes("True") });
    report.checks.push({ name: "BrowserLeaks WebGL vendor masked", ok: webglProtected.unmaskedVendor.includes("Google Inc. (Intel)") });
    report.checks.push({ name: "BrowserLeaks WebGL renderer masked", ok: webglProtected.unmaskedRenderer.includes("Intel(R) UHD Graphics 620") });
    report.checks.push({ name: "BrowserLeaks WebGL image hash present", ok: webglProtected.imageHash.length >= 16 });
    report.checks.push({ name: "WebGL Report shows fake GPU", ok: reportProtected.hasFakeGpu });

    const rawConfig = { ...protectedConfig, canvasProtection: false, webglProtection: false };
    await evaluate(browser, sw, `chrome.storage.local.set({ locaCloakConfig: ${JSON.stringify(rawConfig)} })`);
    await sleep(500);

    log("reloading for unprotected baseline");
    for (const entry of report.sites) {
      if (!entry.page) continue;
      const site = SITES.find((candidate) => candidate.name === entry.name);
      const raw = await reloadSite(browser, entry.page, site);
      entry.raw = raw;
      log(`${site.name} raw: ${JSON.stringify(raw)}`);
    }

    const canvasRaw = report.sites.find((entry) => entry.name === CANVAS_SITE.name).raw;
    const webglRaw = report.sites.find((entry) => entry.name === WEBGL_SITE.name).raw;
    const reportRaw = report.sites.find((entry) => entry.name === WEBGL_REPORT_SITE.name).raw;

    report.checks.push({ name: "Canvas hash changes when protection is off", ok: canvasRaw.hash !== canvasProtected.hash });
    report.checks.push({ name: "WebGL unmasked vendor changes when protection is off", ok: webglRaw.unmaskedVendor !== webglProtected.unmaskedVendor });
    report.checks.push({ name: "WebGL unmasked renderer changes when protection is off", ok: webglRaw.unmaskedRenderer !== webglProtected.unmaskedRenderer });
    report.checks.push({ name: "WebGL image hash changes when protection is off", ok: webglRaw.imageHash !== webglProtected.imageHash });
    report.checks.push({ name: "WebGL Report no longer shows fake GPU", ok: !reportRaw.hasFakeGpu });

    const failed = report.checks.filter((check) => !check.ok);
    report.finishedAt = new Date().toISOString();
    report.ok = failed.length === 0;
    for (const entry of report.sites) delete entry.page;
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, "famous-sites-report.json"), JSON.stringify(report, null, 2));

    for (const check of report.checks) log(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
    log(`report: ${path.join(ARTIFACT_DIR, "famous-sites-report.json")}`);
    if (failed.length > 0) throw new Error(`${failed.length} checks failed`);
    log("ALL SITE CHECKS PASSED");
  } finally {
    try { browser?.ws.close(); } catch (error) {}
    try { chrome.kill(); } catch (error) {}
    await sleep(800);
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
