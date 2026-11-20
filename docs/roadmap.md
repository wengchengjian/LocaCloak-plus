# LocaCloak-plus Enhancement Roadmap

Status: Phase 0 implemented and verified; Phase 1 next.

## Phase 0 — MAIN-world injection

Move the page bootstrap from `<script data-cfg>` injection to a MAIN-world content script registered at `document_start`, with closure-only state. Remove `__lc__`, `__locacloak_update__`, `__locacloak_protect_update__`, and the script element. Keep the isolated content script for storage, allowlist, and frame coordination.

Gate: existing timezone, language, geolocation, WebRTC, Canvas, and WebGL tests pass before any new Surface is added.

Result: `page-main.js` is now a MAIN-world content script at `document_start`; `content.js` posts per-frame config; update globals are captured and deleted. Integration and famous-site suites pass, including the BrowserLeaks Canvas sandboxed iframe.

## Phase 1 — Tier 1 consistency

Status: complete. Client Hints remain intentionally real; the integration test verifies UA/platform/Client Hints do not contradict each other. Phase 2 is next.

- Quantized host-derived Persona: GPU/CPU/memory/screen buckets, with `screen.*` never smaller than the current window.
- Locale family: `Intl.DateTimeFormat`/`NumberFormat`/`Collator`/`PluralRules`/`RelativeTimeFormat`/`ListFormat`/`DisplayNames`, default locale, `navigator.languages`, and `Accept-Language` fallback chain.
- Client Hints and UA/platform consistency.
- Geolocation permission, `watchPosition`, error, and timestamp semantics.
- WebRTC candidate filtering; `disable_non_proxied_udp` kept; strict-relay toggle.
- Manual Persona lock with a visible "manual override" state and a one-click return to auto.

Gate: no new consistency errors in the baseline matrix; common sites and a WebRTC smoke test still work.

## Phase 2 — Tier 2 experiments

Status: implemented behind off-by-default experimental toggles. Audio uses deterministic OfflineAudioContext noise; fonts use measureText noise plus uncommon-font masking; WebGL limits/extensions extend the existing WebGL toggle; WebGPU masks GPUAdapter.info when `navigator.gpu` is available. Each has an experimental confirmation; WebGPU is skipped on browsers without WebGPU.

AudioContext/OfflineAudioContext, `document.fonts.check`, `measureText`, WebGL limits/extensions, and WebGPU adapter info. Each gets an experimental toggle and a documented breakage boundary.

## Phase 3 — Coverage

Status: complete for the planned surfaces. `createImageBitmap(canvas)` uses the noisy Canvas copy; `iframeCoverage` extends to cross-origin child frames whose ancestor host is allowlisted; same-origin classic and module Workers get a Blob bootstrap for language, timezone, Intl, and `getTimezoneOffset`. Service Workers remain out of scope because registration requires a same-origin script the extension cannot rewrite without site cooperation; strict-CSP and `self.location`-dependent workers remain documented compatibility limits.

Worker injection, cross-origin/sandboxed iframe coverage, and `createImageBitmap(canvas)`. These are separate from Tier 1 because injection cost and breakage risk are materially higher.

## Acceptance

Use a relative baseline: record CreepJS, BrowserScan, BrowserLeaks, EFF Cover Your Tracks, and DeviceInfo before the change; require no new core consistency errors, a reduction in the targeted high-entropy value, and no regression on Google, YouTube, ChatGPT, GitHub, or the WebRTC smoke test. Do not target a perfect uniqueness score.

## Out of scope

Firefox, Safari, mobile Chromium, and resistance to targeted manual analysis.
