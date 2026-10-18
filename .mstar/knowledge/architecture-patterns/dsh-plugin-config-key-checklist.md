# dsh plugin config-key addition checklist — every read seam, not just the write path

**Source**: plan dsh-advisor-issue102-output-resilience (issue #102; added `maxTokens` + `proseFallback`)
**Status**: active

## The lesson

Adding a key to a dsh plugin's config schema is a **write-path one-liner but a read-seam checklist**. The write path (schema default + `settings.update`) is the easy half; every surface that *reads* the composed config must learn the key independently, and none of them fails loudly when it doesn't — the key silently reads as "absent" and each surface invents its own wrong default. In issue-102's plan, four tasks each owned one seam and **no brief owned the read seams between them**: the gateway `readConfig` serialized only the old five keys (QC W-1, blocking — the web card showed stale defaults, a saved value snapped back on display, and re-typing the displayed value clobbered a stored non-default), the `/advisor config` readback wiring missed the keys (fixer-disclosed R-1), and a resolver-shape test fixture pinned the old key set red (R-2). Three occurrences of one class.

## The checklist (all seams, in order)

1. **Schema + resolver** (`src/config.ts`): field + default + bounds, `CONFIG_KEYS`, interfaces, `unwrap` — the SSOT for validation.
2. **Gateway wire** (`readConfig`/`set`): `/api/<ns>/get` must serialize the new key and `set` must round-trip it — pin both with a non-default-value get/set round-trip test (a default-value pin cannot distinguish "carries the key" from "omits the key").
3. **Command readback** (`/advisor config`): its compose source (`getConfig()`) supplies the key; renderer renders it.
4. **Web client**: store draft + clamp + the apply-path `always` list; **and the store's wire-shape comment/test fixtures** — fixtures that echo a full config hide the seam (make one fixture wire-shaped, i.e. exactly what the endpoint returns).
5. **TUI section**: field entry (mind the structural-mirror kind union for boolean/select kinds).
6. **Derived-state signature**: construction-time consumers join the runtime-rebuild signature (normalized `??` reads so absent-vs-explicit-default is not a teardown); per-turn consumers join the in-place latch path.
7. **Docs + frozen spec**: user docs and spec annotations (additive supersession style), including any contract test that pins the key set.

## Failure signature

"A config key exists and saves fine, but one surface never shows it" → audit seams 2–6 before blaming the client. **A get/set round-trip test with a NON-default value is the single cheapest detector** — it fails on every omitted read seam at once.

## Removal is the same checklist, mirrored (2026-10-18, `maxTokens` removal)

Removing a key touches the same seams in reverse, plus one removal-only seam: **stored-profile tolerance**. A stored profile still carrying the removed key must load cleanly, not reject the plugin row — add the key to the resolver's `LEGACY_KEYS` (tolerated, destructured out of every snapshot before the rest-spread, never read, never re-persisted; same mechanism as the 2026-09-26 `enabled` removal). Pin it with (a) a dual-legacy fixture (both removed keys + all live keys resolve and strip) and (b) near-miss strictness tests (`maxtoken`, `max_token` still throw unknown-key) so the tolerance cannot widen into case-insensitive matching. The gateway `set` echo test must also prove a legacy key in a patch never reaches the wire.
