# Persona derivation and compatibility tiers

A Persona is derived from the real host and then quantized into common device buckets instead of being fully synthetic or fully real. Locale uses a country default with an explicit user override and a language-tag fallback chain; city-level language inference is rejected. Surfaces are split into Tier 1 (low-risk, default on), Tier 2 (audio, fonts, WebGL limits, WebGPU; experimental), and Tier 3 (full readPixels noise, forced relay, Worker/cross-origin injection; explicit opt-in).
