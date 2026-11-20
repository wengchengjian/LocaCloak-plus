/*
 * Exit-location detection used by the background service worker.
 *
 * The cheap probe (Cloudflare trace, then ipify) only answers "what is the
 * current public IP?". A full geo lookup is performed only after that IP
 * changes, which keeps provider quota usage low even with 30s polling.
 */
const LocaCloakVpn = (() => {
  const FETCH_TIMEOUT_MS = 6000;

  function isIp(value) {
    const ip = String(value || "").trim();
    if (!ip) return false;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return ip.split(".").every((part) => Number(part) <= 255);
    }
    return /^[0-9a-f:]+$/i.test(ip) && ip.includes(":");
  }

  function textIp(value) {
    const ip = String(value || "").trim();
    return isIp(ip) ? { ip } : null;
  }

  const COUNTRY_LANGUAGE = {
    US: "en-US", GB: "en-GB", AU: "en-US", CA: "en-US", NZ: "en-US",
    IE: "en-IE", SG: "en-US", ZA: "en-US", NG: "en-US", KE: "en-US", GH: "en-US",
    JP: "ja-JP", KR: "ko-KR", CN: "zh-CN", TW: "zh-TW", HK: "zh-TW", MO: "zh-TW",
    FR: "fr-FR", DE: "de-DE", AT: "de-AT", CH: "de-CH", ES: "es-ES", IT: "it-IT",
    PT: "pt-PT", NL: "nl-NL", BE: "nl-BE", LU: "fr-LU", RU: "ru-RU", SE: "sv-SE",
    NO: "nb-NO", DK: "da-DK", FI: "fi-FI", IS: "is-IS", PL: "pl-PL", CZ: "cs-CZ",
    SK: "sk-SK", HU: "hu-HU", RO: "ro-RO", BG: "bg-BG", HR: "hr-HR", RS: "sr-RS",
    SI: "sl-SI", LT: "lt-LT", LV: "lv-LV", EE: "et-EE", UA: "uk-UA", TR: "tr-TR",
    TH: "th-TH", VN: "vi-VN", ID: "id-ID", MY: "ms-MY", PH: "fil-PH", IN: "hi-IN",
    PK: "ur-PK", BD: "bn-BD", LK: "si-LK", NP: "ne-NP", SA: "ar-SA", EG: "ar-EG",
    AE: "ar-AE", IR: "fa-IR", IL: "he-IL", GR: "el-GR", BR: "pt-BR", MX: "es-MX",
    AR: "es-AR", CL: "es-CL", CO: "es-CO", PE: "es-PE", VE: "es-VE"
  };

  const PROBE_PROVIDERS = [
    {
      name: "cloudflare",
      url: "https://www.cloudflare.com/cdn-cgi/trace",
      parse(text) {
        const fields = {};
        for (const line of String(text).trim().split(/\r?\n/)) {
          const separator = line.indexOf("=");
          if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 1);
        }
        if (!isIp(fields.ip)) return null;
        return {
          ip: fields.ip,
          country: fields.loc && fields.loc !== "XX" ? fields.loc.toUpperCase() : null
        };
      }
    },
    {
      name: "ipify",
      url: "https://api.ipify.org?format=json",
      json: true,
      parse(data) {
        return data && isIp(data.ip) ? { ip: String(data.ip) } : null;
      }
    },
    {
      name: "ipwho",
      url: "https://ipwho.is/",
      json: true,
      parse(data) {
        if (!data || data.success === false || !isIp(data.ip)) return null;
        return {
          ip: String(data.ip),
          country: (data.country_code || "").toUpperCase() || null
        };
      }
    }
  ];

  // Used only when the three core probes all return the previous IP. A
  // long-lived keep-alive connection can survive a Clash node switch, so a
  // random host that has not been seen recently is a useful freshness check.
  const FRESH_PROBE_PROVIDERS = [
    {
      name: "ipify64",
      url: "https://api64.ipify.org?format=json",
      json: true,
      parse(data) {
        return data && isIp(data.ip) ? { ip: String(data.ip) } : null;
      }
    },
    {
      name: "icanhazip",
      url: "https://ipv4.icanhazip.com",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "checkip",
      url: "https://checkip.amazonaws.com",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "ifconfig",
      url: "https://ifconfig.me/ip",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "ipinfo",
      url: "https://ipinfo.io/ip",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "myexternalip",
      url: "https://myexternalip.com/raw",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "httpbin",
      url: "https://httpbin.org/ip",
      json: true,
      parse(data) {
        const ip = String((data && data.origin) || "").split(",")[0].trim();
        return isIp(ip) ? { ip } : null;
      }
    },
    {
      name: "postman",
      url: "https://postman-echo.com/ip",
      json: true,
      parse(data) {
        return data && isIp(data.ip) ? { ip: String(data.ip) } : null;
      }
    },
    {
      name: "ident",
      url: "https://ident.me",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "ident4",
      url: "https://v4.ident.me",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "ifconfigco",
      url: "https://ifconfig.co/ip",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "ipecho",
      url: "https://ipecho.net/plain",
      parse(text) {
        return textIp(text);
      }
    },
    {
      name: "akamai",
      url: "https://whatismyip.akamai.com",
      parse(text) {
        return textIp(text);
      }
    }
  ];

  const GEO_PROVIDERS = [
    {
      name: "freeipapi",
      urlFor: (ip) => ip ? `https://freeipapi.com/api/json/${encodeURIComponent(ip)}` : "https://freeipapi.com/api/json",
      json: true,
      parse(data) {
        if (!data || !data.ipAddress) return null;
        const latitude = Number(data.latitude);
        const longitude = Number(data.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return {
          ip: data.ipAddress,
          country: (data.countryCode || "").toUpperCase() || null,
          city: String(data.cityName || "").split(" (")[0] || "",
          latitude,
          longitude,
          timezone: Array.isArray(data.timeZones) ? data.timeZones[0] : data.timezone
        };
      }
    },
    {
      name: "freegeoip",
      urlFor: (ip) => ip ? `https://freegeoip.app/json/${encodeURIComponent(ip)}` : "https://freegeoip.app/json/",
      json: true,
      parse(data) {
        if (!data || !data.country_code) return null;
        const latitude = Number(data.latitude);
        const longitude = Number(data.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return {
          ip: data.ip,
          country: (data.country_code || "").toUpperCase() || null,
          city: data.city || "",
          latitude,
          longitude,
          timezone: data.time_zone
        };
      }
    },
    {
      name: "ipwhois",
      urlFor: (ip) => ip ? `https://ipwhois.app/json/${encodeURIComponent(ip)}` : "https://ipwhois.app/json/",
      json: true,
      parse(data) {
        if (!data || data.success === false) return null;
        const latitude = Number(data.latitude);
        const longitude = Number(data.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return {
          ip: data.ip,
          country: (data.country_code || "").toUpperCase() || null,
          city: data.city || "",
          latitude,
          longitude,
          timezone: data.timezone
        };
      }
    },
    {
      name: "ipapi",
      urlFor: (ip) => ip ? `https://ipapi.co/${encodeURIComponent(ip)}/json/` : "https://ipapi.co/json/",
      json: true,
      parse(data) {
        if (!data || data.error) return null;
        const latitude = Number(data.latitude);
        const longitude = Number(data.longitude);
        if (data.latitude == null || data.longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return {
          ip: data.ip,
          country: (data.country_code || data.country || "").toUpperCase() || null,
          city: data.city || "",
          latitude,
          longitude,
          timezone: data.timezone
        };
      }
    },
    {
      name: "ipwho",
      urlFor: (ip) => ip ? `https://ipwho.is/${encodeURIComponent(ip)}` : "https://ipwho.is/",
      json: true,
      parse(data) {
        if (!data || data.success === false) return null;
        const latitude = Number(data.latitude);
        const longitude = Number(data.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return {
          ip: data.ip,
          country: (data.country_code || "").toUpperCase() || null,
          city: data.city || "",
          latitude,
          longitude,
          timezone: data.timezone && data.timezone.id
        };
      }
    },
    {
      name: "ipinfo",
      urlFor: (ip) => ip ? `https://ipinfo.io/${encodeURIComponent(ip)}/json` : "https://ipinfo.io/json",
      json: true,
      parse(data) {
        if (!data || !data.loc) return null;
        const [latitude, longitude] = String(data.loc).split(",").map(Number);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return {
          ip: data.ip,
          country: (data.country || "").toUpperCase() || null,
          city: data.city || "",
          latitude,
          longitude,
          timezone: data.timezone
        };
      }
    }
  ];

  async function request(provider, ip) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const url = typeof provider.urlFor === "function" ? provider.urlFor(ip) : provider.url;
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal
      });
      if (!response.ok) return null;
      const body = provider.json ? await response.json() : await response.text();
      return provider.parse(body);
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function firstValid(providers, ip) {
    for (const provider of providers) {
      const result = await request(provider, ip);
      if (result) return { ...result, source: provider.name };
    }
    return null;
  }

  async function probeExitAll() {
    const results = await Promise.all(PROBE_PROVIDERS.map(async (provider) => {
      const result = await request(provider);
      return result ? { ...result, source: provider.name } : null;
    }));
    return results.filter(Boolean);
  }

  async function probeExitFresh() {
    const total = FRESH_PROBE_PROVIDERS.length;
    const start = Math.floor(Date.now() / 1000) % total;
    for (let offset = 0; offset < Math.min(2, total); offset++) {
      const provider = FRESH_PROBE_PROVIDERS[(start + offset) % total];
      const result = await request(provider);
      if (result) return { ...result, source: provider.name };
    }
    return null;
  }

  function normalizeTimeZone(timeZone) {
    if (!timeZone || typeof timeZone !== "string") return null;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    } catch (error) {
      return null;
    }
  }

  function languageFor(country) {
    return COUNTRY_LANGUAGE[String(country || "").toUpperCase()] || "en-US";
  }

  const geoCache = new Map();

  return {
    probeExit: () => firstValid(PROBE_PROVIDERS),
    probeExitAll,
    probeExitFresh,
    lookupGeo: async (ip) => {
      if (ip && geoCache.has(ip)) return geoCache.get(ip);
      for (const provider of GEO_PROVIDERS) {
        const geo = await request(provider, ip);
        if (!geo) continue;
        if (ip && geo.ip && geo.ip !== ip) continue;
        const result = { ...geo, timezone: normalizeTimeZone(geo.timezone) };
        if (ip) {
          if (geoCache.size >= 30) geoCache.clear();
          geoCache.set(ip, result);
        }
        return result;
      }
      return null;
    },
    normalizeTimeZone,
    languageFor,
    COUNTRY_LANGUAGE
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LocaCloakVpn;
