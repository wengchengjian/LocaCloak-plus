/*
 * Page-world Canvas / WebGL protection.
 *
 * Installed in the top frame and in same-origin child frames. The iframe
 * contentWindow/contentDocument getters are wrapped so a sandboxed
 * about:blank frame (no allow-scripts) is still patched from its parent.
 * All noise is deterministic for a given canvasSeed + hostname + coordinate.
 */
(function () {
  "use strict";

  const script = document.currentScript;
  let incoming = {};
  try {
    incoming = JSON.parse(script ? script.getAttribute("data-cfg") : "{}");
  } catch (error) {
    incoming = {};
  }
  try {
    if (script && script.parentNode) script.parentNode.removeChild(script);
  } catch (error) {}

  const symbol = typeof Symbol !== "undefined" ? Symbol.for("__lc_protect__") : "__lc_protect__";
  if (window[symbol]) {
    if (window.__locacloak_protect_update__) window.__locacloak_protect_update__(incoming);
    return;
  }
  window[symbol] = true;

  const state = {
    canvas: incoming.canvasProtection === true,
    webgl: incoming.webglProtection === true,
    seed: incoming.canvasSeed ? String(incoming.canvasSeed) : "locacloak"
  };
  let noiseHost = incoming.host || location.hostname || "";
  let noiseKey = hashString(`${state.seed}|${noiseHost}`);

  const realmSymbol = typeof Symbol !== "undefined" ? Symbol.for("__lc_protect_realm__") : "__lc_protect_realm__";
  const canvasTypes = new WeakMap();
  const offscreenTypes = new WeakMap();
  const patchedRealms = new WeakSet();
  const realmNatives = new WeakMap();
  const debugInfo = Object.freeze({
    UNMASKED_VENDOR_WEBGL: 0x9245,
    UNMASKED_RENDERER_WEBGL: 0x9246
  });
  const gpu = detectGpu();

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function hash2(key, x, y) {
    let hash = key ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    return (hash ^ (hash >>> 16)) >>> 0;
  }

  function clampByte(value) {
    return value < 0 ? 0 : value > 255 ? 255 : value;
  }

  function applyNoise(data, width, offsetX, offsetY) {
    if (!data || !width || data.length < 4) return;
    for (let index = 0; index < data.length; index += 4) {
      const pixel = index >>> 2;
      const x = offsetX + (pixel % width);
      const y = offsetY + ((pixel / width) | 0);
      const hash = hash2(noiseKey, x, y);
      if ((hash & 0x3ff) >= 26) continue;
      data[index] = clampByte(data[index] + (hash & 0x400 ? 1 : -1));
      data[index + 1] = clampByte(data[index + 1] + (hash & 0x800 ? 1 : -1));
      data[index + 2] = clampByte(data[index + 2] + (hash & 0x1000 ? 1 : -1));
    }
  }

  function maskNative(fn, name) {
    try {
      Object.defineProperty(fn, "toString", {
        value: function () {
          return `function ${name}() { [native code] }`;
        },
        configurable: true,
        writable: true
      });
    } catch (error) {}
  }

  function replaceMethod(proto, name, replacement) {
    if (!proto || typeof proto[name] !== "function") return false;
    try {
      Object.defineProperty(proto, name, {
        value: replacement,
        writable: true,
        configurable: true,
        enumerable: false
      });
    } catch (error) {
      try {
        proto[name] = replacement;
      } catch (error2) {
        return false;
      }
    }
    maskNative(replacement, name);
    return true;
  }

  function replaceGetter(proto, name, transform) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.get !== "function") return false;
    const original = descriptor.get;
    const replacement = function () {
      const value = original.call(this);
      try {
        transform(value);
      } catch (error) {}
      return value;
    };
    try {
      Object.defineProperty(proto, name, { ...descriptor, get: replacement });
    } catch (error) {
      return false;
    }
    maskNative(replacement, `get ${name}`);
    return true;
  }

  function detectGpu() {
    const userAgent = navigator.userAgent || "";
    if (/Android/i.test(userAgent)) {
      return {
        vendor: "Google Inc. (Qualcomm)",
        renderer: "ANGLE (Qualcomm, Adreno (TM) 640, OpenGL ES 3.2)"
      };
    }
    if (/Macintosh|Mac OS X/i.test(userAgent)) {
      return {
        vendor: "Google Inc. (Apple)",
        renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)"
      };
    }
    if (/Windows/i.test(userAgent)) {
      return {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)"
      };
    }
    return {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6 (Core Profile) Mesa 22.0.5)"
    };
  }

  const native2DGetImageData = typeof CanvasRenderingContext2D !== "undefined"
    ? CanvasRenderingContext2D.prototype.getImageData
    : null;
  const nativeOffscreenGetImageData = typeof OffscreenCanvasRenderingContext2D !== "undefined"
    ? OffscreenCanvasRenderingContext2D.prototype.getImageData
    : null;

  function nativeGetImageDataFor(doc) {
    try {
      const win = doc && doc.defaultView;
      const natives = win && realmNatives.get(win);
      if (natives && natives.getImageData) return natives.getImageData;
    } catch (error) {}
    return native2DGetImageData;
  }

  function noisyCanvasCopy(source) {
    try {
      const doc = source.ownerDocument || document;
      const copy = doc.createElement("canvas");
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext("2d");
      if (!context) return null;
      context.drawImage(source, 0, 0);
      const nativeGetImageData = nativeGetImageDataFor(doc);
      if (!nativeGetImageData) return null;
      const image = nativeGetImageData.call(context, 0, 0, source.width, source.height);
      applyNoise(image.data, source.width, 0, 0);
      context.putImageData(image, 0, 0);
      return copy;
    } catch (error) {
      return null;
    }
  }

  function noisyOffscreenCopy(source) {
    try {
      if (typeof OffscreenCanvas === "undefined" || !nativeOffscreenGetImageData) return null;
      if (!source.width || !source.height) return null;
      const copy = new OffscreenCanvas(source.width, source.height);
      const context = copy.getContext("2d");
      if (!context) return null;
      context.drawImage(source, 0, 0);
      const image = nativeOffscreenGetImageData.call(context, 0, 0, source.width, source.height);
      applyNoise(image.data, source.width, 0, 0);
      context.putImageData(image, 0, 0);
      return copy;
    } catch (error) {
      return null;
    }
  }

  function trackGetContext(proto, types) {
    const original = proto && proto.getContext;
    if (typeof original !== "function") return;
    replaceMethod(proto, "getContext", function (type) {
      const context = original.apply(this, arguments);
      if (context) {
        const name = String(type).toLowerCase();
        if (name === "2d") types.set(this, "2d");
        else if (name.indexOf("webgl") !== -1) types.set(this, "webgl");
        else if (name === "bitmaprenderer") types.set(this, "bitmaprenderer");
        else types.set(this, name);
      }
      return context;
    });
  }

  function shouldNoise(type) {
    if (!type) return false;
    return type === "2d" ? state.canvas : state.webgl;
  }

  function patch2D(proto) {
    if (!proto || typeof proto.getImageData !== "function") return;
    const original = proto.getImageData;
    replaceMethod(proto, "getImageData", function (sx, sy) {
      const image = original.apply(this, arguments);
      if (state.canvas) {
        try {
          applyNoise(image.data, image.width, Number(sx) || 0, Number(sy) || 0);
        } catch (error) {}
      }
      return image;
    });
  }

  function patchWebGL(proto) {
    if (!proto) return;

    const originalGetParameter = proto.getParameter;
    if (typeof originalGetParameter === "function") {
      replaceMethod(proto, "getParameter", function (pname) {
        if (state.webgl) {
          if (pname === 0x1f00) return "WebKit";
          if (pname === 0x1f01) return "WebKit WebGL";
          if (pname === 0x9245) return gpu.vendor;
          if (pname === 0x9246) return gpu.renderer;
          if (pname === 0x0d33 || pname === 0x84e8 || pname === 0x851c) return 16384;
          if (pname === 0x8b4d) return 32;
          if (pname === 0x8872 || pname === 0x8b4c) return 16;
          if (pname === 0x8dfb) return 4096;
          if (pname === 0x8dfd) return 1024;
          if (pname === 0x8dfc) return 30;
          if (pname === 0x8869) return 16;
          if (pname === 0x0d3a) return new Int32Array([16384, 16384]);
          if (pname === 0x846d) return new Float32Array([1, 255]);
          if (pname === 0x846e) return new Float32Array([1, 1]);
        }
        return originalGetParameter.apply(this, arguments);
      });
    }

    const originalGetSupportedExtensions = proto.getSupportedExtensions;
    if (typeof originalGetSupportedExtensions === "function") {
      replaceMethod(proto, "getSupportedExtensions", function () {
        const extensions = originalGetSupportedExtensions.apply(this, arguments);
        if (!state.webgl || !Array.isArray(extensions)) return extensions;
        return extensions.filter((name) => name !== "WEBGL_debug_renderer_info");
      });
    }

    const originalGetExtension = proto.getExtension;
    if (typeof originalGetExtension === "function") {
      replaceMethod(proto, "getExtension", function (name) {
        if (state.webgl && name === "WEBGL_debug_renderer_info") return debugInfo;
        return originalGetExtension.apply(this, arguments);
      });
    }

    const originalReadPixels = proto.readPixels;
    if (typeof originalReadPixels === "function") {
      replaceMethod(proto, "readPixels", function (x, y, width, height, format, type, pixels) {
        const result = originalReadPixels.apply(this, arguments);
        if (
          state.webgl
          && format === 0x1908
          && type === 0x1401
          && pixels
          && pixels.BYTES_PER_ELEMENT === 1
          && typeof pixels.length === "number"
          && pixels.length >= width * height * 4
        ) {
          try {
            applyNoise(pixels, width, x, y);
          } catch (error) {}
        }
        return result;
      });
    }
  }

  function hookFrameGetters(win) {
    try {
      const proto = win.HTMLIFrameElement && win.HTMLIFrameElement.prototype;
      if (!proto) return;
      replaceGetter(proto, "contentDocument", (doc) => {
        if (doc && doc.defaultView) installRealm(doc.defaultView);
      });
      replaceGetter(proto, "contentWindow", (frameWin) => {
        if (frameWin) installRealm(frameWin);
      });
    } catch (error) {}
  }

  function patchCreateImageBitmap(win) {
    const native = win.createImageBitmap;
    if (typeof native !== "function") return;
    const replacement = function (source) {
      const rest = Array.prototype.slice.call(arguments, 1);
      if (state.canvas && source) {
        try {
          if (win.HTMLCanvasElement && source instanceof win.HTMLCanvasElement) {
            const type = canvasTypes.get(source);
            if (shouldNoise(type)) {
              const copy = noisyCanvasCopy(source);
              if (copy) return native.apply(win, [copy].concat(rest));
            }
          } else if (win.OffscreenCanvas && source instanceof win.OffscreenCanvas) {
            const type = offscreenTypes.get(source);
            if (shouldNoise(type)) {
              const copy = noisyOffscreenCopy(source);
              if (copy) return native.apply(win, [copy].concat(rest));
            }
          }
        } catch (error) {}
      }
      return native.apply(win, arguments);
    };
    try {
      Object.defineProperty(win, "createImageBitmap", {
        value: replacement,
        writable: true,
        configurable: true,
        enumerable: false
      });
      maskNative(replacement, "createImageBitmap");
    } catch (error) {}
  }

  function installRealm(win) {
    if (!win || patchedRealms.has(win)) return;
    try {
      if (win[realmSymbol]) {
        patchedRealms.add(win);
        return;
      }
    } catch (error) {
      return;
    }

    try {
      const HTMLCanvas = win.HTMLCanvasElement;
      const Canvas2D = win.CanvasRenderingContext2D;
      const Offscreen = win.OffscreenCanvas;
      const Offscreen2D = win.OffscreenCanvasRenderingContext2D;
      const WebGL = win.WebGLRenderingContext;
      const WebGL2 = win.WebGL2RenderingContext;
      win[realmSymbol] = true;

      if (Canvas2D && Canvas2D.prototype) {
        realmNatives.set(win, {
          getImageData: Canvas2D.prototype.getImageData,
          offscreenGetImageData: Offscreen2D && Offscreen2D.prototype ? Offscreen2D.prototype.getImageData : null
        });
      }

      if (HTMLCanvas && HTMLCanvas.prototype) {
        const proto = HTMLCanvas.prototype;
        trackGetContext(proto, canvasTypes);

        const originalToDataURL = proto.toDataURL;
        if (typeof originalToDataURL === "function") {
          replaceMethod(proto, "toDataURL", function () {
            const type = canvasTypes.get(this);
            if (shouldNoise(type)) {
              const copy = noisyCanvasCopy(this);
              if (copy) return originalToDataURL.apply(copy, arguments);
            }
            return originalToDataURL.apply(this, arguments);
          });
        }

        const originalToBlob = proto.toBlob;
        if (typeof originalToBlob === "function") {
          replaceMethod(proto, "toBlob", function (callback) {
            if (typeof callback !== "function") return originalToBlob.apply(this, arguments);
            const type = canvasTypes.get(this);
            if (shouldNoise(type)) {
              const copy = noisyCanvasCopy(this);
              if (copy) return originalToBlob.apply(copy, arguments);
            }
            return originalToBlob.apply(this, arguments);
          });
        }
      }

      if (Canvas2D && Canvas2D.prototype) patch2D(Canvas2D.prototype);
      if (Offscreen2D && Offscreen2D.prototype) patch2D(Offscreen2D.prototype);

      if (Offscreen && Offscreen.prototype) {
        trackGetContext(Offscreen.prototype, offscreenTypes);
        const originalConvertToBlob = Offscreen.prototype.convertToBlob;
        if (typeof originalConvertToBlob === "function") {
          replaceMethod(Offscreen.prototype, "convertToBlob", function () {
            const type = offscreenTypes.get(this);
            if (shouldNoise(type)) {
              const copy = noisyOffscreenCopy(this);
              if (copy) return originalConvertToBlob.apply(copy, arguments);
            }
            return originalConvertToBlob.apply(this, arguments);
          });
        }
      }

      if (WebGL && WebGL.prototype) patchWebGL(WebGL.prototype);
      if (WebGL2 && WebGL2.prototype) patchWebGL(WebGL2.prototype);
      patchCreateImageBitmap(win);
      hookFrameGetters(win);
      patchedRealms.add(win);
    } catch (error) {}
  }

  installRealm(window);

  function scanFrames() {
    try {
      document.querySelectorAll("iframe").forEach((frame) => {
        try {
          installRealm(frame.contentWindow);
        } catch (error) {}
      });
    } catch (error) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanFrames, { once: true });
  } else {
    scanFrames();
  }

  Object.defineProperty(window, "__locacloak_protect_update__", {
    value: function (next) {
      if (!next) return;
      if (typeof next.canvasProtection === "boolean") state.canvas = next.canvasProtection;
      if (typeof next.webglProtection === "boolean") state.webgl = next.webglProtection;
      if (next.host && next.host !== noiseHost) {
        noiseHost = String(next.host);
        noiseKey = hashString(`${state.seed}|${noiseHost}`);
      }
      if (next.canvasSeed) {
        const seed = String(next.canvasSeed);
        if (seed !== state.seed) {
          state.seed = seed;
          noiseKey = hashString(`${seed}|${noiseHost}`);
        }
      }
    },
    configurable: false,
    enumerable: false,
    writable: false
  });
})();
