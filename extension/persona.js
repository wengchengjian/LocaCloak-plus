/*
 * Tier 1 consistency layer (page world).
 *
 * Runs after the locale/Canvas/WebGL bootstraps on the same config message.
 * It keeps the profile-scoped parts stable (locale, screen class, hardware
 * class) while letting the auto-sync update only location-dependent values.
 */
(function () {
  "use strict";

  const state = {
    language: "en-US",
    latitude: 34.0522,
    longitude: -118.2437,
    webrtc: true,
    audio: false,
    fonts: false,
    webgpu: false,
    workers: false,
    seed: "locacloak"
  };
  let installed = false;
  let languageCache = [];

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function hash2(key, first, second) {
    let hash = key ^ Math.imul(first, 374761393) ^ Math.imul(second, 668265263);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    return (hash ^ (hash >>> 16)) >>> 0;
  }

  function signedNoise(key, first, second) {
    return hash2(key, first, second) / 4294967296 - 0.5;
  }

  function languageChain(value) {
    const tag = String(value || "en-US");
    const base = tag.split("-")[0];
    const chain = [tag];
    if (base && base !== tag) chain.push(base);
    if (base !== "en" && chain.indexOf("en") === -1) chain.push("en");
    return chain;
  }

  function bucket(value, thresholds, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    for (const threshold of thresholds) {
      if (number >= threshold) return threshold;
    }
    return thresholds[thresholds.length - 1];
  }

  function pickScreen(minWidth, minHeight) {
    const realWidth = Number(screen.width) || 1920;
    const realHeight = Number(screen.height) || 1080;
    const options = [[1280, 720], [1366, 768], [1600, 900], [1920, 1080]];
    let fallback = null;
    for (const option of options) {
      if (option[0] < minWidth || option[1] < minHeight) continue;
      if (option[0] <= realWidth && option[1] <= realHeight) return { width: option[0], height: option[1] };
      if (!fallback) fallback = { width: option[0], height: option[1] };
    }
    if (fallback) return fallback;
    return { width: Math.max(realWidth, minWidth), height: Math.max(realHeight, minHeight) };
  }

  function maskNative(fn, name) {
    try {
      Object.defineProperty(fn, "toString", {
        value: function () { return `function ${name}() { [native code] }`; },
        configurable: true
      });
    } catch (error) {}
  }

  function installScreen() {
    if (!window.Screen || !Screen.prototype) return;
    const minWidth = Math.max(Number(window.outerWidth) || 0, Number(window.innerWidth) || 0);
    const minHeight = Math.max(Number(window.outerHeight) || 0, Number(window.innerHeight) || 0);
    const chosen = pickScreen(minWidth, minHeight);
    const values = {
      width: chosen.width,
      height: chosen.height,
      availWidth: chosen.width,
      availHeight: Math.max(chosen.height - 40, minHeight),
      colorDepth: 24,
      pixelDepth: 24
    };
    for (const key of Object.keys(values)) {
      try {
        Object.defineProperty(Screen.prototype, key, {
          get: function () { return values[key]; },
          configurable: true
        });
        maskNative(Object.getOwnPropertyDescriptor(Screen.prototype, key).get, `get ${key}`);
      } catch (error) {}
      try {
        Object.defineProperty(screen, key, {
          get: function () { return values[key]; },
          configurable: true
        });
      } catch (error) {}
    }
  }

  function installHardware() {
    if (!window.Navigator || !Navigator.prototype) return;
    const cores = bucket(navigator.hardwareConcurrency, [16, 8, 4, 2], 4);
    const memory = bucket(navigator.deviceMemory, [16, 8, 4], 4);
    try {
      Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
        get: function () { return cores; },
        configurable: true
      });
      maskNative(Object.getOwnPropertyDescriptor(Navigator.prototype, "hardwareConcurrency").get, "get hardwareConcurrency");
    } catch (error) {}
    try {
      Object.defineProperty(navigator, "hardwareConcurrency", { get: function () { return cores; }, configurable: true });
    } catch (error) {}
    try {
      if ("deviceMemory" in navigator) {
        Object.defineProperty(Navigator.prototype, "deviceMemory", {
          get: function () { return memory; },
          configurable: true
        });
        maskNative(Object.getOwnPropertyDescriptor(Navigator.prototype, "deviceMemory").get, "get deviceMemory");
        Object.defineProperty(navigator, "deviceMemory", { get: function () { return memory; }, configurable: true });
      }
    } catch (error) {}
  }

  function installLocale() {
    try {
      Object.defineProperty(navigator, "language", {
        get: function () { return state.language; },
        configurable: true
      });
    } catch (error) {}

    languageCache = languageChain(state.language);
    try {
      Object.defineProperty(navigator, "languages", {
        get: function () { return Object.freeze(languageCache.slice()); },
        configurable: true
      });
    } catch (error) {}

    for (const name of ["NumberFormat", "Collator", "PluralRules", "RelativeTimeFormat", "ListFormat", "DisplayNames", "Segmenter", "DateTimeFormat"]) {
      const Native = Intl[name];
      if (typeof Native !== "function") continue;
      function Wrapped(locale, options) {
        return new Native(locale === undefined ? state.language : locale, options);
      }
      Wrapped.prototype = Native.prototype;
      try {
        Object.defineProperty(Wrapped, "name", { value: name, configurable: true });
        if (Native.supportedLocalesOf) {
          Object.defineProperty(Wrapped, "supportedLocalesOf", {
            value: Native.supportedLocalesOf.bind(Native),
            configurable: true,
            writable: true
          });
        }
        maskNative(Wrapped, name);
      } catch (error) {}
      try { Intl[name] = Wrapped; } catch (error) {}
    }
  }

  function installPermissions() {
    if (!window.Permissions || !Permissions.prototype) return;
    const nativeQuery = Permissions.prototype.query;
    if (typeof nativeQuery !== "function") return;
    const status = {
      state: "granted",
      onchange: null,
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return true; }
    };
    const replacement = function (descriptor) {
      if (descriptor && descriptor.name === "geolocation") return Promise.resolve(status);
      return nativeQuery.call(this, descriptor);
    };
    try {
      Object.defineProperty(Permissions.prototype, "query", { value: replacement, configurable: true, writable: true });
      maskNative(replacement, "query");
    } catch (error) {}
  }

  function installGeolocation() {
    if (!window.Geolocation || !Geolocation.prototype) return;
    const watches = new Map();
    let sequence = 0;

    function position() {
      return {
        coords: {
          latitude: state.latitude,
          longitude: state.longitude,
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null
        },
        timestamp: Date.now()
      };
    }

    function failure(code, message) {
      return { code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
    }

    function getCurrentPosition(success, error) {
      setTimeout(function () {
        if (typeof success === "function") success(position());
      }, 0);
    }

    function watchPosition(success) {
      const id = ++sequence;
      const tick = function () {
        if (typeof success === "function") success(position());
      };
      tick();
      const timer = setInterval(tick, 30000);
      watches.set(id, timer);
      return id;
    }

    function clearWatch(id) {
      const timer = watches.get(id);
      if (timer) clearInterval(timer);
      watches.delete(id);
    }

    for (const [name, fn] of [["getCurrentPosition", getCurrentPosition], ["watchPosition", watchPosition], ["clearWatch", clearWatch]]) {
      try {
        delete navigator.geolocation[name];
        Object.defineProperty(Geolocation.prototype, name, { value: fn, configurable: true, writable: true });
        maskNative(fn, name);
      } catch (error) {}
    }
  }

  function installWebRTC() {
    if (!window.RTCPeerConnection) return;
    const proto = window.RTCPeerConnection.prototype;
    if (!proto) return;

    function isHost(candidate) {
      return typeof candidate === "string" && (/\btyp host\b/.test(candidate) || /\.local\b/.test(candidate));
    }

    const nativeAdd = proto.addEventListener;
    if (typeof nativeAdd === "function") {
      const replacement = function (type, listener, options) {
        if (type !== "icecandidate" || typeof listener !== "function" || !state.webrtc) {
          return nativeAdd.call(this, type, listener, options);
        }
        const filtered = function (event) {
          if (event && event.candidate && isHost(event.candidate.candidate)) return;
          return listener.call(this, event);
        };
        maskNative(filtered, listener.name || "listener");
        return nativeAdd.call(this, type, filtered, options);
      };
      try {
        Object.defineProperty(proto, "addEventListener", { value: replacement, configurable: true, writable: true });
        maskNative(replacement, "addEventListener");
      } catch (error) {}
    }

    const descriptor = Object.getOwnPropertyDescriptor(proto, "onicecandidate");
    if (descriptor && descriptor.set && descriptor.get) {
      try {
        Object.defineProperty(proto, "onicecandidate", {
          get: descriptor.get,
          set: function (listener) {
            if (typeof listener !== "function" || !state.webrtc) {
              return descriptor.set.call(this, listener);
            }
            descriptor.set.call(this, function (event) {
              if (event && event.candidate && isHost(event.candidate.candidate)) return;
              return listener.call(this, event);
            });
          },
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable
        });
      } catch (error) {}
    }
  }

  function installAudio() {
    if (!window.OfflineAudioContext || !OfflineAudioContext.prototype) return;
    const nativeStart = OfflineAudioContext.prototype.startRendering;
    if (typeof nativeStart !== "function") return;
    const replacement = function () {
      const rendered = nativeStart.apply(this, arguments);
      if (!rendered || typeof rendered.then !== "function") return rendered;
      return rendered.then(function (buffer) {
        if (!state.audio) return buffer;
        try {
          const key = hashString(`${state.seed}|audio`);
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const data = buffer.getChannelData(channel);
            for (let index = 0; index < data.length; index++) {
              data[index] += signedNoise(key, channel, index) * 1e-5;
            }
          }
        } catch (error) {}
        return buffer;
      });
    };
    try {
      Object.defineProperty(OfflineAudioContext.prototype, "startRendering", { value: replacement, configurable: true, writable: true });
      maskNative(replacement, "startRendering");
    } catch (error) {}
  }

  function installFonts() {
    if (window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype) {
      const nativeMeasure = CanvasRenderingContext2D.prototype.measureText;
      if (typeof nativeMeasure === "function") {
        const replacement = function (text) {
          const metrics = nativeMeasure.apply(this, arguments);
          if (!state.fonts || !metrics) return metrics;
          const key = hashString(`${state.seed}|font|${this.font || ""}|${String(text || "")}`);
          const delta = signedNoise(key, 0, 0) * 0.04;
          return new Proxy(metrics, {
            get: function (target, property) {
              const value = Reflect.get(target, property, target);
              if (typeof value === "number" && (property === "width" || String(property).indexOf("actualBoundingBox") === 0)) {
                return value + delta;
              }
              return typeof value === "function" ? value.bind(target) : value;
            }
          });
        };
        try {
          Object.defineProperty(CanvasRenderingContext2D.prototype, "measureText", { value: replacement, configurable: true, writable: true });
          maskNative(replacement, "measureText");
        } catch (error) {}
      }
    }

    if (!window.FontFaceSet || !FontFaceSet.prototype || typeof FontFaceSet.prototype.check !== "function") return;
    const nativeCheck = FontFaceSet.prototype.check;
    const common = /^(arial|helvetica|times new roman|times|courier new|courier|verdana|georgia|tahoma|trebuchet ms|calibri|cambria|segoe ui|microsoft yahei|simsun|sans-serif|serif|monospace|system-ui)$/i;
    const replacement = function (font, text) {
      if (!state.fonts) return nativeCheck.apply(this, arguments);
      const family = String(font || "").split(",").pop().replace(/["']/g, "").replace(/^\s*(?:italic|oblique|bold|normal|\d+)\s+/gi, "").replace(/^\s*\d+(?:\.\d+)?(?:px|pt|em|rem)\s+/i, "").trim();
      if (!family || common.test(family)) return nativeCheck.apply(this, arguments);
      return false;
    };
    try {
      Object.defineProperty(FontFaceSet.prototype, "check", { value: replacement, configurable: true, writable: true });
      maskNative(replacement, "check");
    } catch (error) {}
  }

  function installWebGPU() {
    if (!window.GPU || !GPU.prototype || typeof GPU.prototype.requestAdapter !== "function") return;
    const nativeRequest = GPU.prototype.requestAdapter;
    const info = {
      vendor: "intel",
      architecture: "gen-12lp",
      device: "0x9a49",
      description: "Intel(R) UHD Graphics 620"
    };
    const replacement = async function () {
      const adapter = await nativeRequest.apply(this, arguments);
      if (!adapter || !state.webgpu) return adapter;
      return new Proxy(adapter, {
        get: function (target, property) {
          if (property === "info") return info;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    };
    try {
      Object.defineProperty(GPU.prototype, "requestAdapter", { value: replacement, configurable: true, writable: true });
      maskNative(replacement, "requestAdapter");
    } catch (error) {}
  }

  function workerBootstrap(config) {
    "use strict";
    var state = {
      language: String(config.language || "en-US"),
      timezone: String(config.timezone || "UTC"),
      base: String(config.base || "")
    };

    function languageChain(tag) {
      var value = String(tag || "en-US");
      var base = value.split("-")[0];
      var chain = [value];
      if (base && base !== value) chain.push(base);
      if (base !== "en" && chain.indexOf("en") === -1) chain.push("en");
      return chain;
    }

    try {
      Object.defineProperty(self.navigator, "language", {
        get: function () { return state.language; },
        configurable: true
      });
      Object.defineProperty(self.navigator, "languages", {
        get: function () { return languageChain(state.language).slice(); },
        configurable: true
      });
    } catch (error) {}

    var names = ["DateTimeFormat", "NumberFormat", "Collator", "PluralRules", "RelativeTimeFormat", "ListFormat", "DisplayNames", "Segmenter"];
    for (var index = 0; index < names.length; index++) {
      var name = names[index];
      var Native = Intl[name];
      if (typeof Native !== "function") continue;
      var Wrapped = (function (Native, name) {
        function Wrapped(locale, options) {
          var args = Array.prototype.slice.call(arguments);
          if (!args[0]) args[0] = state.language;
          if (name === "DateTimeFormat") {
            var next = args[1] ? Object.assign({}, args[1]) : {};
            if (!next.timeZone) next.timeZone = state.timezone;
            args[1] = next;
          }
          var Bound = Function.prototype.bind.apply(Native, [null].concat(args));
          return new Bound();
        }
        Wrapped.prototype = Native.prototype;
        try { Object.setPrototypeOf(Wrapped, Native); } catch (error) {}
        return Wrapped;
      })(Native, name);
      try {
        Object.defineProperty(Intl, name, { value: Wrapped, configurable: true, writable: true });
      } catch (error) {}
    }

    function offsetMinutes(date) {
      try {
        var parts = new Intl.DateTimeFormat("en-US", {
          timeZone: state.timezone,
          hour12: false,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }).formatToParts(date);
        var values = {};
        for (var i = 0; i < parts.length; i++) values[parts[i].type] = parts[i].value;
        var hour = values.hour === "24" ? "00" : values.hour;
        var asUTC = Date.UTC(+values.year, +values.month - 1, +values.day, +hour, +values.minute, +values.second);
        return Math.round((date.getTime() - asUTC) / 60000);
      } catch (error) {
        return -nativeOffset.call(date);
      }
    }

    var nativeOffset = Date.prototype.getTimezoneOffset;
    try {
      Date.prototype.getTimezoneOffset = function () {
        return -offsetMinutes(this);
      };
    } catch (error) {}

    if (state.base) {
      try {
        var nativeImport = self.importScripts;
        self.importScripts = function () {
          var urls = [];
          for (var i = 0; i < arguments.length; i++) {
            try { urls.push(new URL(String(arguments[i]), state.base).href); }
            catch (error) { urls.push(arguments[i]); }
          }
          return nativeImport.apply(self, urls);
        };
      } catch (error) {}
    }
  }

  function installWorkers() {
    if (!window.Worker) return;
    const NativeWorker = window.Worker;
    const replacement = function Worker(url, options) {
      if (!state.workers || !url) return new NativeWorker(url, options);
      let absolute;
      try {
        absolute = new URL(String(url), location.href);
      } catch (error) {
        return new NativeWorker(url, options);
      }
      if (absolute.origin !== location.origin) return new NativeWorker(url, options);
      const moduleWorker = !!(options && options.type === "module");
      const config = {
        language: state.language,
        timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        base: absolute.href
      };
      const bootstrap = `(${workerBootstrap.toString()})(${JSON.stringify(config)});`;
      const source = moduleWorker
        ? `${bootstrap}\nimport(${JSON.stringify(absolute.href)});`
        : `${bootstrap}\nimportScripts(${JSON.stringify(absolute.href)});`;
      let blobUrl = null;
      try {
        blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const workerOptions = moduleWorker ? Object.assign({}, options, { type: "module" }) : options;
        const worker = new NativeWorker(blobUrl, workerOptions);
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 10000);
        return worker;
      } catch (error) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return new NativeWorker(url, options);
      }
    };
    replacement.prototype = NativeWorker.prototype;
    try { Object.setPrototypeOf(replacement, NativeWorker); } catch (error) {}
    try {
      Object.defineProperty(window, "Worker", { value: replacement, configurable: true, writable: true });
      maskNative(replacement, "Worker");
    } catch (error) {}
  }

  function install(config) {
    if (!config) return;
    state.language = String(config.language || state.language);
    state.latitude = Number.isFinite(Number(config.latitude)) ? Number(config.latitude) : state.latitude;
    state.longitude = Number.isFinite(Number(config.longitude)) ? Number(config.longitude) : state.longitude;
    state.webrtc = config.webrtcProtection !== false;
    state.audio = config.audioProtection === true;
    state.fonts = config.fontProtection === true;
    state.webgpu = config.webgpuProtection === true;
    state.workers = config.workerProtection === true;
    state.seed = String(config.canvasSeed || state.seed);
    installLocale();
    installScreen();
    installHardware();
    installPermissions();
    installGeolocation();
    installWebRTC();
    installAudio();
    installFonts();
    installWebGPU();
    installWorkers();
  }

  function update(config) {
    if (!config) return;
    state.language = String(config.language || state.language);
    state.latitude = Number.isFinite(Number(config.latitude)) ? Number(config.latitude) : state.latitude;
    state.longitude = Number.isFinite(Number(config.longitude)) ? Number(config.longitude) : state.longitude;
    state.webrtc = config.webrtcProtection !== false;
    state.audio = config.audioProtection === true;
    state.fonts = config.fontProtection === true;
    state.webgpu = config.webgpuProtection === true;
    state.workers = config.workerProtection === true;
    state.seed = String(config.canvasSeed || state.seed);
    languageCache = languageChain(state.language);
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.__lc_config !== true) return;
    if (!installed) {
      installed = true;
      install(event.data.core);
    } else {
      update(event.data.core);
    }
  });
})();
