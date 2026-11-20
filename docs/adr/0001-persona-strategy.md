# Persona strategy: consistency first, hybrid scope

LocaCloak-plus targets Commercial fingerprinting and anti-bot detection, with extension Stealth as a secondary goal; cross-site unlinkability is explicitly not a primary KPI. A Persona is profile-scoped for low-entropy traits (location, locale, timezone, screen class, hardware class) and site-scoped for high-entropy rendering traits (Canvas/WebGL), so a site sees a stable, plausible device while different sites do not share the same rendering fingerprint. Compatibility is tiered: low-risk surfaces are on by default, aggressive surfaces are opt-in.

## Consequences

- A site that compares rendering fingerprints across domains will see deliberate differences; this is accepted in exchange for lower cross-site linkability.
- Higher Coverage is not automatically better: a new Patch must preserve Consistency with the existing Persona.
- Workers and cross-origin iframes are phase-two coverage; the initial scope is the allowlist plus all frames with same-origin/about:blank access.
- Windows desktop Chrome is the only initial target platform; other platforms require a separate decision.
