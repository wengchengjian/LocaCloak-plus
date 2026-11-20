const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION = path.join(ROOT, "extension");
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "locacloak-alarm-"));
const CHROME = process.env.LOCACLOAK_CHROME || path.join(os.homedir(), "AppData", "Local", "ms-playwright", "chromium-1248", "chrome-win64", "chrome.exe");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeout = 20000, interval = 250) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {}
    await sleep(interval);
  }
  throw new Error("timeout");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function findWorker(cdp) {
  return waitFor(async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const candidates = targetInfos.filter((target) => target.type === "service_worker"
      && target.url.startsWith("chrome-extension://")
      && /\/background\.js$/.test(target.url));
    for (const candidate of candidates) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: candidate.targetId, flatten: true });
      try {
        await cdp.send("Runtime.enable", {}, sessionId);
        const manifest = await evaluate(cdp, sessionId, "chrome.runtime.getManifest()");
        if (manifest.name === "LocaCloak-plus") return { sessionId, url: candidate.url };
      } catch (error) {}
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    return null;
  }, 30000);
}

async function openOptions(cdp, extensionId) {
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/options.html` });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await waitFor(async () => (await evaluate(cdp, sessionId, "document.readyState")) === "complete", 30000);
  return { targetId, sessionId };
}

async function main() {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXTENSION}`,
    "--window-size=1280,900"
  ];
  const chrome = spawn(CHROME, args, { stdio: "ignore", windowsHide: true });
  let cdp = null;
  try {
    const portFile = path.join(PROFILE, "DevToolsActivePort");
    const port = await waitFor(() => {
      if (!fs.existsSync(portFile)) return null;
      return Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]) || null;
    }, 20000);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = await CDP.connect(version.webSocketDebuggerUrl);
    const worker = await findWorker(cdp);
    const extensionId = new URL(worker.url).host;
    console.log("extension:", extensionId);

    await sleep(4000);
    const before = await evaluate(cdp, worker.sessionId, `(async () => ({
      config: (await chrome.storage.local.get("locaCloakConfig")).locaCloakConfig,
      state: (await chrome.storage.local.get("locaCloakVpnState")).locaCloakVpnState,
      alarms: await chrome.alarms.getAll()
    }))()`);
    console.log("before:", JSON.stringify({ country: before.config?.country, lat: before.config?.latitude, state: before.state, alarms: before.alarms }));

    await evaluate(cdp, worker.sessionId, `chrome.storage.local.set({
      locaCloakVpnState: { ip: "203.0.113.1", country: "ZZ", city: "Fake", changedAt: Date.now() }
    })`);
    console.log("set fake state; opening options page for stable storage polling");
    const options = await openOptions(cdp, extensionId);

    const start = Date.now();
    let last = null;
    for (let i = 0; i < 40; i++) {
      last = await evaluate(cdp, options.sessionId, `(async () => ({
        config: (await chrome.storage.local.get("locaCloakConfig")).locaCloakConfig,
        state: (await chrome.storage.local.get("locaCloakVpnState")).locaCloakVpnState,
        alarms: await chrome.alarms.getAll()
      }))()`);
      if (last.state && last.state.ip !== "203.0.113.1") {
        console.log(`alarm fired after ${((Date.now() - start) / 1000).toFixed(1)}s`);
        console.log("after:", JSON.stringify({
          country: last.config?.country,
          city: last.config?.city,
          lat: last.config?.latitude,
          timezone: last.config?.timezone,
          state: last.state,
          alarms: last.alarms
        }, null, 2));
        return;
      }
      if (i % 5 === 0) {
        console.log(`waiting ${((Date.now() - start) / 1000).toFixed(0)}s; alarms=${JSON.stringify(last.alarms)}; state.ip=${last.state?.ip}`);
      }
      await sleep(2000);
    }
    console.log("FAILED: alarm did not update state");
    console.log("last:", JSON.stringify({ state: last?.state, alarms: last?.alarms }, null, 2));
    process.exitCode = 1;
  } finally {
    try { cdp?.ws.close(); } catch (error) {}
    try { chrome.kill(); } catch (error) {}
    await sleep(800);
    try { execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch (error) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (error) {}
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
