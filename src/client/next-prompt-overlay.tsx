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
 * phase (`phase === 'plain'`). Any other state renders nothing.
 *
 * Fill contract: a document-level CAPTURE-phase keydown intercepts ONLY a
 * bare ArrowRight (alt/ctrl/meta/shift all false) whose target is the
 * no-focus surface (document/body/html — nothing focused) or inside the
 * composer card (the composer's own editor lives inside the same
 * `div[data-composer-card]` as the overlay anchor). Any FOCUSED element
 * elsewhere — tree nodes, buttons, menus, editables — keeps native
 * ArrowRight semantics (qc2 F-001). The render gate itself is re-validated
 * INSIDE the handler against the latest render's input snapshot: in the
 * React commit→passive-effect window a non-empty draft (or a moved phase)
 * passes through natively, no preventDefault, no fill — the listener that
 * is still mounted cannot replace user-typed text (qc2 F-002). On
 * intercept: `preventDefault()`, then `inputActions.setDraft(suggestion)`,
 * then the optimistic local clear (suggestion → null) so the ghost
 * disappears the moment the draft fills.
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
 * modifiers) whose target sits in the NO-FOCUS surface or inside the
 * composer card. The card boundary comes from the component's own DOM root —
 * the host renders the overlay anchor inside `div[data-composer-card]`, so a
 * target within THAT card is the composer's own editor surface. Outside the
 * card, the interceptor claims only the surface a browser targets when NO
 * element has focus (document / body / html): every FOCUSED element
 * elsewhere — tree nodes, buttons, menus, editables — keeps its native
 * ArrowRight semantics (qc2 F-001 narrowed the previous draft that hijacked
 * any focused non-editable target).
 */
function isFillTrigger(event: KeyboardEvent, overlayRoot: Element | null): boolean {
  if (event.key !== 'ArrowRight') return false
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  const target = event.target
  if (!(target instanceof Element)) return true // no target element (e.g. dispatched on document) → no-focus surface
  const card = overlayRoot?.closest('[data-composer-card]')
  if (card !== undefined && card !== null && card.contains(target)) return true
  // Outside the card: only the no-focus surface (nothing focused) fills.
  // A focused element is always its own keydown target, so any specific
  // focused element — editable or not — falls through to native behavior.
  return target === document.body || target === document.documentElement
}

/**
 * Render the ghost suggestion in the composer: the muted single-line
 * preview plus the "→" badge (its accessible name is `t('nextPromptBadge')`
 * on the `role="img"` span), or nothing when the render gate does not hold.
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

  // The input snapshot as the latest render read it, re-written on every
  // render (the render itself just consumed the store through useInput).
  // The keydown handler below reads THIS at event time: in the React
  // commit→passive-effect window a draft/phase update is already committed
  // and rendered while the previous listener is still mounted, and the
  // handler's closure can be a render behind — this ref is not (qc2 F-002).
  const inputRef = useRef(input)
  inputRef.current = input

  // Document-level capture-phase fill listener. Mounted while a suggestion
  // waits; the RENDER gate (empty draft, plain phase) is re-validated inside
  // the handler at event time, so the listener surviving the commit→
  // passive-effect teardown window can never fill over user-typed text
  // (qc2 F-002).
  useEffect(() => {
    if (suggestion === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isFillTrigger(event, rootRef.current)) return
      // Re-validate the render gate against the CURRENT input snapshot:
      // skip WITHOUT preventDefault when the draft is no longer empty or
      // the phase left plain — native ArrowRight semantics (caret motion)
      // apply instead of a fill that would replace user-typed text.
      const current = inputRef.current
      if (current.draft !== '' || current.phase !== 'plain') return
      event.preventDefault()
      inputActions.setDraft(suggestion)
      // Optimistic local clear: the ghost disappears the moment the draft
      // fills; the next converging fetch is harmless (contract ④).
      controller.consume()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [controller, inputActions, suggestion])

  if (!showGhost || suggestion === null) return null
  return (
    // role="status" + aria-live="polite" make the suggestion ANNOUNCED
    // (round-2 review): assistive tech hears what the suggestion is when it
    // arrives, without focus — the badge alone only ever named the gesture.
    <div ref={rootRef} className={styles.ghost} role="status" aria-live="polite">
      <span className={styles.ghostText}>{suggestion}</span>
      {/* role="img" gives the aria-label a naming target (a role-less
          generic span delivers no accessible name — I-000027), and the →
          glyph matches the ArrowRight accept gesture and copy (I-000028). */}
      <span className={styles.ghostBadge} role="img" aria-label={t('nextPromptBadge')}>→</span>
    </div>
  )
}
