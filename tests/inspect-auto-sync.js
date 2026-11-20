const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION = path.join(ROOT, "extension");
const PROFILE = process.argv[2] || path.join(ROOT, ".profile");
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

async function main() {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
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

    const found = await waitFor(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const candidates = targetInfos.filter((target) => target.type === "service_worker"
        && target.url.startsWith("chrome-extension://")
        && /\/background\.js$/.test(target.url));
      for (const candidate of candidates) {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: candidate.targetId, flatten: true });
        try {
          await cdp.send("Runtime.enable", {}, sessionId);
          const manifest = await evaluate(cdp, sessionId, "chrome.runtime.getManifest()");
          if (manifest.name === "LocaCloak-plus") return { sessionId, manifest, url: candidate.url };
        } catch (error) {}
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
      return null;
    }, 30000);

    const sw = found.sessionId;
    console.log("worker:", found.url, "version:", found.manifest.version);
    const state = await evaluate(cdp, sw, `(async () => ({
      config: (await chrome.storage.local.get("locaCloakConfig")).locaCloakConfig || null,
      vpnState: (await chrome.storage.local.get("locaCloakVpnState")).locaCloakVpnState || null,
      alarms: await chrome.alarms.getAll()
    }))()`);
    console.log("before:", JSON.stringify(state, null, 2));
    console.log("probe:", await evaluate(cdp, sw, "LocaCloakVpn.probeExit()"));
    console.log("geo:", await evaluate(cdp, sw, "LocaCloakVpn.lookupGeo()"));
    const result = await evaluate(cdp, sw, "autoSyncVpn()");
    console.log("autoSyncVpn:", JSON.stringify(result, null, 2));
    const after = await evaluate(cdp, sw, `(async () => ({
      config: (await chrome.storage.local.get("locaCloakConfig")).locaCloakConfig || null,
      vpnState: (await chrome.storage.local.get("locaCloakVpnState")).locaCloakVpnState || null,
      alarms: await chrome.alarms.getAll()
    }))()`);
    console.log("after:", JSON.stringify(after, null, 2));
  } finally {
    try { cdp?.ws.close(); } catch (error) {}
    try { chrome.kill(); } catch (error) {}
    await sleep(800);
    try { execFileSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }); } catch (error) {}
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
