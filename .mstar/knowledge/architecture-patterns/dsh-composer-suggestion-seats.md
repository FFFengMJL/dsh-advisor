---
module: dsh web composer plugin surface (conversation.input.overlay + inputActions + typert alias)
date: 2026-10-19
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
title: Predicted-prompt composer suggestions from a dsh plugin — overlay ghost-text seat, public draft write channel, ArrowRight capture gate, and the typert method alias
description: Verified recipe for a plugin-provided "suggested prompt" affordance in the dsh web composer — the sanctioned `conversation.input.overlay` seat renders ghost text at the placeholder position (the real placeholder attribute is unreachable from plugins), `SessionStandardProps.inputActions.setDraft` is the public draft-write channel for the → key accept gesture behind a document-level capture-phase gate, and the backing read endpoint registers through a typert `method`/`implementation` alias. Includes the rejected takeover paths and the intercept-scope lessons from QC.
last_updated: 2026-10-19
tags:
  - dsh
  - plugin
  - client-half
  - composer
  - overlay
  - keyboard
  - typert
applies_when:
  - A dsh plugin needs to surface a suggestion or hint inside the web composer without replacing host UI
  - A plugin needs to programmatically fill the composer draft from a slot occupant
  - A plugin gateway endpoint needs a wire name that differs from its implementation member name
  - Debugging why a composer-area plugin seat renders at the wrong position or a key gesture is hijacked
---

# dsh composer suggestion surface (overlay + setDraft + ArrowRight + typert alias)

## Context

The dsh web composer (`@deepseek-ai/dsh-client-ui-conversation`) picks its placeholder text internally (`placeholder.default/hero/plan/...` locale keys, chosen per composer state); the `placeholder` prop on `ComposerBarOwnerProps` arrives only from the host shell, so **a plugin cannot set the real placeholder attribute**. The host instead renders a plugin seat INSIDE the composer card: `<div class="overlayAnchor" data-composer-overlay>` with CSS `height:0; position:absolute; inset:0 0 auto` — occupants can absolutely position content over the editor area (the overlayAnchor covers the card top), which is the sanctioned way to show ghost text at the placeholder position. Verified against dsh 0.2.1-rc.2.

The public draft-write channel is `SessionStandardProps.inputActions` (any session-scope slot occupant receives it): `setDraft(text)` replaces the whole draft, `insertText(text, span)` is revision-guarded, and `useInput` exposes `draft` / `phase` (`'plain' | 'adjudicating' | 'claimed' | 'submitting'`) for gating. Host ArrowRight is only a Lexical caret command — there is no suggestion-accept gesture to reuse, so a plugin adds its own document-level capture-phase keydown listener.

## Guidance

### Seat: `conversation.input.overlay` (list, session scope)

- Register with the B2 generator+yield shape (`ctx.slots.inject('conversation.input.overlay', function* () { yield ctx.slots.register({ name: 'conversation.input.overlay', id: <plugin-id>, locale: NS, inject: (sessionId) => ({ sessionId, ... }) }, Component) })`).
- Ghost-text presentation that reads as a placeholder: absolutely position at the overlay anchor start (the shipped editor geometry is `inset:4px 8px auto 14px` inside the card), `pointer-events: none` so clicks reach the editor, single-line ellipsis, `--dsw-alias-*` tokens only.
- **Rejected paths** (do not take): occupying `conversation.composer.bar` (single slot) replaces the whole composer — upgrade-fragile; locale-override tricks to change `placeholder.*` keys are app-global and cannot be per-session.

### Fill gesture: document-level capture keydown, gated hard

- Mount the `keydown` listener with `capture: true` on `document` while (and only while) the suggestion exists; the overlay occupant element itself is a SIBLING of the editor, so its capture listener never sees the editor's keydown — the document level is required.
- Gate at event time, re-reading a render-fresh input snapshot: `e.key === 'ArrowRight'` && no modifiers && the CURRENT `draft === ''` && `phase === 'plain'` && suggestion present && the target is either focus-less (document/body) or inside the host card (`closest('[data-composer-card]')` — the host ships this marker). Narrow arms to these surfaces: a bare `return true` fallback hijacks ArrowRight on tree nodes, buttons, and menus elsewhere on the page (breaks native keyboard navigation). Then `preventDefault()` + `inputActions.setDraft(suggestion)`; optimistic-clear the local suggestion so the ghost disappears immediately.
- jsdom caveats: `isContentEditable` is unimplemented — use an attribute-based `closest('[contenteditable], input, textarea')` proxy for the "another editable owns this key" check, and fake timers beat `waitFor` for poll assertions.

### Lifecycle hygiene (QC-hardened)

- Re-validate the gate INSIDE the handler from a render-fresh ref: in the commit→passive-effect window the draft may already be non-empty while the listener is not yet torn down; without the re-check the fill silently overwrites user-typed text.
- The server side should invalidate the suggestion on the next user turn (generation fence); a client-local clear lets the next converging fetch resurrect an accepted suggestion — treat server invalidation as the source of truth and the local clear as cosmetic.
- Truncate suggestion text by code points (`Array.from`), not UTF-16 units, and strip C0 control chars — a `slice(0, N)` splits surrogate pairs into U+FFFD.

### Wire: typert method alias for read endpoints

`ctx.typert.register` contributions accept `method: '<wire-name>'` with `implementation: '<member-name>'` on the InvocationDescriptor: dispatch resolves `descriptor.implementation ?? descriptor.method` then `Reflect.get` (dsh-api-gateway lib), and the claim path is `ctx.typert.local.get('<ns>/<wire-name>')`. Use it to expose e.g. `/api/advisor/suggestion` backed by a `getSuggestion` member — the composed test proves it end-to-end through `ctx.typertGateway.invoke({ method: '<wire-name>' })`.

## Why This Matters

Every wrong seat for this feature looked plausible: the real placeholder is host-internal, the composer bar takeover shadows shipped UI, and a naive global keydown hijacks unrelated widgets. The overlay seat + `setDraft` + document-capture-with-narrow-arms combination achieves the placeholder look and the shell-style "→ accepts" gesture entirely through sanctioned extension points, surviving host upgrades.

## When to Apply

Any dsh plugin that adds composer-adjacent affordances (predicted prompts, quick replies, template hints) or needs to write the composer draft from a slot occupant. Reference implementation: dsh-advisor `src/client/next-prompt-overlay.tsx` + `src/next-prompt.ts` + `/api/advisor/suggestion` (this repository).

## Examples

- dsh-advisor next-prompt feature (plan dsh-advisor-next-prompt-n12): overlay ghost text + ⇥ badge, 30 s idle poll only while the composer is empty and idle, request-fenced fetch over the refresh-signal epoch, ArrowRight fill with the full gate matrix, server generation fence invalidating on the next user turn.
- Known open residue: one-render ref lag in the store→render gap (fails safe — fills into an empty draft at worst), and the S4-blocked gate arm's coverage is manager-empty only (see plan-linked issues I-000022/I-000023).
