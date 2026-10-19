/**
 * Next-prompt ghost suggestion overlay (plan dsh-advisor-next-prompt-n12,
 * task 3): the occupant registered into the shell-declared
 * `conversation.input.overlay` list slot. The resident composer renders that
 * slot inside its card (`div[data-composer-card]`, the overlay anchor's
 * parent), so the ghost previews the reviewer's stored next-prompt
 * suggestion directly in the empty composer — and pressing ArrowRight fills
 * the draft with it.
 *
 * Render gate: the ghost renders ONLY while a suggestion waits
 * (`suggestion !== null`) on an EMPTY draft (`draft === ''`) in the plain
 * phase (`phase === 'plain'`). Any other state renders nothing and unmounts
 * the document-level keydown listener (it exists only while the ghost does),
 * so a bare ArrowRight keeps its native semantics everywhere else.
 *
 * Fill contract: a document-level CAPTURE-phase keydown intercepts ONLY a
 * bare ArrowRight (alt/ctrl/meta/shift all false) while the gate holds and
 * the event target is not an editable outside the composer card — the
 * composer's own editor lives inside the same `div[data-composer-card]` as
 * the overlay anchor, so a target within that card is the expected fill
 * target, while a focused input/textarea/contenteditable elsewhere keeps
 * native behavior. On intercept: `preventDefault()`, then
 * `inputActions.setDraft(suggestion)`, then the optimistic local clear
 * (suggestion → null) so the ghost disappears the moment the draft fills.
 *
 * Fetch discipline: fetch on mount, on every consumed refresh-signal epoch
 * bump (connection/reset + window focus ride the plugin's shared debounced
 * plane), and through an idle poll (`NEXT_PROMPT_IDLE_POLL_MS`) that runs
 * ONLY while the surface is idle (no suggestion, empty draft, plain phase)
 * and stops otherwise. Every response settles through the controller's
 * request fence; a failure latches `unavailable` (renders nothing, no
 * retry storm — the next signal or scheduled poll is the next attempt).
 */

import { useEffect, useRef, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { NEXT_PROMPT_IDLE_POLL_MS } from './next-prompt-store.ts'
import type { AdvisorSuggestionController, AdvisorSuggestionState } from './next-prompt-store.ts'
import styles from './next-prompt.module.css'

/**
 * Injected dependencies of {@link NextPromptOverlay} (slot `inject`, built
 * per session binding by the registration's inject factory). The `hooks`
 * compartment carries the bare snapshot sources; the renderer binds each as
 * a `use<Name>` selector hook the component consumes.
 */
export interface NextPromptOverlayInjected {
  /** The session this occurrence is bound to (framework-resolved). */
  readonly sessionId: string
  /** The per-session suggestion controller (one per binding). */
  readonly controller: AdvisorSuggestionController
  /** Bare snapshot sources the renderer binds as selector hooks. */
  readonly hooks: {
    /** The per-session suggestion snapshot. */
    readonly snapshot: SnapshotStore<AdvisorSuggestionState>
    /** Refresh-signal epoch (bumped on connection reset / window focus). */
    readonly refreshSignal: SnapshotStore<{ epoch: number }>
  }
}

/**
 * Props the renderer binds for the overlay: the session-scoped runtime share
 * (whose SessionStandardProps supply the input machine's draft/phase state
 * and the public `inputActions.setDraft` fill verb), the
 * framework-synthesized `t` seat for the declared `settings.advisor`
 * namespace, and the registrant's per-binding business face.
 */
export type NextPromptOverlayProps =
  PropsRuntime<'conversation.input.overlay'>
  & PropsLocale<'settings.advisor'>
  & InjectFace<NextPromptOverlayInjected>
  & SessionStandardProps

/**
 * Whether one keydown event is the fill trigger: a bare ArrowRight (no
 * modifiers) whose target is not an editable element outside the composer
 * card. The card boundary comes from the component's own DOM root — the
 * host renders the overlay anchor inside `div[data-composer-card]`, so a
 * target within THAT card is the composer's own editor surface; any
 * input/textarea/contenteditable elsewhere keeps native semantics.
 */
function isFillTrigger(event: KeyboardEvent, overlayRoot: Element | null): boolean {
  if (event.key !== 'ArrowRight') return false
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  const target = event.target
  if (!(target instanceof Element)) return true // no target element (e.g. dispatched on document) → composer surface
  const card = overlayRoot?.closest('[data-composer-card]')
  if (card !== undefined && card !== null && card.contains(target)) return true
  // Outside the composer card: an editable target keeps native behavior.
  // (Attribute-based check, not HTMLElement.isContentEditable — jsdom does
  // not implement that property.)
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return false
  if (target.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') !== null) return false
  return true
}

/**
 * Render the ghost suggestion in the composer: the muted single-line
 * preview plus the "⇥" badge (its label is `t('nextPromptBadge')`), or
 * nothing when the render gate does not hold.
 * @param props - slot-delivered injected dependencies and the synthesized seats.
 * @returns the overlay occupant.
 */
export function NextPromptOverlay(props: NextPromptOverlayProps): ReactNode {
  const { controller, useSnapshot, useRefreshSignal, useInput, inputActions, t } = props
  const state = useSnapshot((s) => s)
  const epoch = useRefreshSignal((s) => s.epoch)
  const input = useInput((s) => s)
  const suggestion = state.suggestion
  const draft = input.draft
  const phase = input.phase
  // The render gate: a suggestion waits on an empty draft in the plain phase.
  const showGhost = suggestion !== null && draft === '' && phase === 'plain'
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Fetch on mount and on every consumed refresh-signal epoch bump
  // (connection/reset + window focus ride the plugin's shared debounced
  // plane). takeSignal is idempotent per epoch, so a re-render never
  // double-fetches; the mount run IS the first fetch (no epoch consumed yet).
  useEffect(() => {
    if (controller.takeSignal(epoch)) void controller.fetch()
  }, [controller, epoch])

  // Idle poll: armed ONLY while idle (no suggestion, empty draft, plain
  // phase); any other state clears the timer (contract ⑤ — the fake-timer
  // spec proves the timer is gone once a suggestion arrives).
  const idle = suggestion === null && draft === '' && phase === 'plain'
  useEffect(() => {
    if (!idle) return
    const timer = window.setInterval(() => { void controller.fetch() }, NEXT_PROMPT_IDLE_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [controller, idle])

  // Document-level capture-phase fill listener — mounted ONLY while the
  // ghost renders (the gate unmounts it, restoring native ArrowRight
  // semantics everywhere else).
  useEffect(() => {
    if (!showGhost || suggestion === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isFillTrigger(event, rootRef.current)) return
      event.preventDefault()
      inputActions.setDraft(suggestion)
      // Optimistic local clear: the ghost disappears the moment the draft
      // fills; the next converging fetch is harmless (contract ④).
      controller.consume()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [controller, inputActions, showGhost, suggestion])

  if (!showGhost || suggestion === null) return null
  return (
    <div ref={rootRef} className={styles.ghost}>
      <span className={styles.ghostText}>{suggestion}</span>
      <span className={styles.ghostBadge} aria-label={t('nextPromptBadge')}>⇥</span>
    </div>
  )
}
