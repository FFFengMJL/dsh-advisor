// @vitest-environment jsdom
/**
 * Next-prompt ghost suggestion overlay (plan dsh-advisor-next-prompt-n12,
 * task 3) — component behavior over a scripted wire face, mirroring the
 * advisor-session-action spec (preloaded stores + @testing-library/react;
 * the dev-time `bindSnapshotSelector` stand-in reads the current snapshot per
 * render, so assertions after a store mutation re-render explicitly).
 *
 * The occupant registers into the shell-declared `conversation.input.overlay`
 * list slot, which the resident composer renders inside its card
 * (`div[data-composer-card]`, the overlay anchor's parent) — that marker is
 * the fill-target boundary: a keydown whose target sits inside the SAME
 * composer card is the composer's own editor (the fill target); an
 * input/textarea/contenteditable elsewhere keeps native semantics.
 *
 * Contract under test (brief behavior contract, one case per bullet):
 * ① render gate: ghost renders ONLY when suggestion !== null && draft === ''
 *    && phase === 'plain'; otherwise nothing renders and the keydown
 *    listener is unmounted (a fill attempt intercepts nothing).
 * ② ghost presentation: the suggestion text renders, plus the "⇥" badge
 *    carrying `aria-label={t('nextPromptBadge')}`.
 * ③ ArrowRight fill: a document-level capture-phase keydown intercepts ONLY
 *    a bare ArrowRight (no modifiers) while the gate holds and the target is
 *    not an editable outside the composer card; on intercept:
 *    preventDefault + inputActions.setDraft(suggestion).
 * ④ fill clears local state optimistically (suggestion → null) so the ghost
 *    disappears the moment the draft fills.
 * ⑤ fetch points: mount; every consumed refresh-signal epoch bump; and the
 *    30 s idle poll that runs ONLY while idle (fake-timer case proves the
 *    timer is cleared when a suggestion arrives).
 * ⑥ failure: transport/business failure → status 'unavailable', renders
 *    nothing, no retry storm — the next signal (or scheduled poll) is the
 *    next attempt.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc, RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { NextPromptOverlay } from '../src/client/next-prompt-overlay'
import type { NextPromptOverlayProps } from '../src/client/next-prompt-overlay'
import { AdvisorSuggestionController, NEXT_PROMPT_IDLE_POLL_MS } from '../src/client/next-prompt-store'
import { en } from '../src/client/locales'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * Dev-time stand-in for the renderer's hooks binding (see the session-action
 * spec header note): a selector hook reading the current snapshot per render.
 */
function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> {
  return (sel) => sel(w.getSnapshot())
}

/** The synthesized `t` seat: the en dictionary plus `{name}` substitution. */
const t = ((key: string, params?: Record<string, unknown>): string => {
  let text: string = en[key as keyof typeof en] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}) as NextPromptOverlayProps['t']

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

/**
 * One scripted RPC for the `/api/advisor/suggestion` channel. `auto` mode
 * resolves every call with the current `reply` immediately (the fake-timer
 * poll case); the default parks each call until `settle` (the component
 * cases), mirroring the session-action spec's ScriptedRpc.
 */
class SuggestionRpc {
  calls: Array<{ channel: string; method: string; args: unknown }> = []
  reply: RpcResult<unknown> = ok({ suggestion: null })
  auto = false
  private resolvers: Array<(result: RpcResult<unknown>) => void> = []

  call(channel: string, method: string, payload: { args: unknown }): Promise<RpcResult<unknown>> {
    this.calls.push({ channel, method, args: payload.args })
    if (this.auto) return Promise.resolve(this.reply)
    return new Promise((resolve) => { this.resolvers.push(resolve) })
  }

  settle(result: RpcResult<unknown>): void {
    this.resolvers.shift()!(result)
  }

  last(): { channel: string; method: string; args: unknown } {
    return this.calls[this.calls.length - 1]!
  }
}

/** The per-session input state the composer's SessionStandardProps publish. */
interface TestInputState {
  draft: string
  phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

interface Harness {
  rpc: SuggestionRpc
  epoch: ReturnType<typeof createSnapshotStore<{ epoch: number }>>
  input: ReturnType<typeof createSnapshotStore<TestInputState>>
  controller: AdvisorSuggestionController
  setDraft: ReturnType<typeof vi.fn>
  props: NextPromptOverlayProps
}

function harness(): Harness {
  const rpc = new SuggestionRpc()
  const controller = new AdvisorSuggestionController('sess-1', rpc as unknown as ClientConnectionRpc)
  const epoch = createSnapshotStore<{ epoch: number }>({ epoch: 0 })
  const input = createSnapshotStore<TestInputState>({ draft: '', phase: 'plain' })
  const setDraft = vi.fn()
  const props = {
    sessionId: 'sess-1',
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    useRefreshSignal: bindSnapshotSelector(epoch),
    useInput: bindSnapshotSelector(input),
    // The composer's public input actions; only setDraft is read.
    inputActions: { setDraft } as never,
    // The conversation/global standard seats are never read — never-called
    // stubs (the session-action spec stub pattern).
    useConversation: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    t,
  } as NextPromptOverlayProps
  return { rpc, epoch, input, controller, setDraft, props }
}

/** The composer-card wrapper the host renders the overlay anchor inside. */
function ComposerCard(props: { children: React.ReactNode }): React.ReactNode {
  return <div data-composer-card="true">{props.children}</div>
}

const SUGGESTION = 'Try the /advisor command'

/** Render + settle one suggestion so the ghost is on screen (cases ①–④). */
async function mountWithSuggestion(h: Harness): Promise<ReturnType<typeof render>> {
  const view = render(
    <ComposerCard>
      <NextPromptOverlay {...h.props} />
    </ComposerCard>,
  )
  await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
  h.rpc.settle(ok({ suggestion: SUGGESTION }))
  await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('ready'))
  view.rerender(
    <ComposerCard>
      <NextPromptOverlay {...h.props} />
    </ComposerCard>,
  )
  return view
}

describe('next-prompt ghost overlay (plan dsh-advisor-next-prompt-n12, task 3)', () => {
  it('fetches the suggestion on mount through /api/advisor/suggestion', async () => {
    const h = harness()
    render(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    expect(h.rpc.last()).toEqual({
      channel: '/api',
      method: 'advisor/suggestion',
      args: { sessionId: 'sess-1' },
    })
  })

  it('renders the ghost text and the ⇥ badge label when a suggestion waits on an empty plain draft', async () => {
    const h = harness()
    await mountWithSuggestion(h)
    expect(screen.getByText(SUGGESTION)).toBeTruthy()
    const badge = screen.getByLabelText(en.nextPromptBadge)
    expect(badge.textContent).toContain('⇥')
  })

  it('renders nothing while the draft is non-empty or the phase is not plain, and intercepts nothing', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)

    // A non-empty draft: no ghost, and the keydown listener is unmounted —
    // a bare ArrowRight keeps its native semantics (nothing prevented).
    h.input.update((s) => { s.draft = 'partial' })
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    expect(screen.queryByText(SUGGESTION)).toBeNull()
    expect(fireEvent.keyDown(document, { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()

    // Back to an empty draft but a claimed phase: still no ghost.
    h.input.update((s) => { s.draft = ''; s.phase = 'claimed' })
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    expect(screen.queryByText(SUGGESTION)).toBeNull()
    expect(fireEvent.keyDown(document, { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()
  })

  it('fills the draft on a bare ArrowRight and clears the suggestion optimistically', async () => {
    const h = harness()
    const view = await mountWithSuggestion(h)

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(h.setDraft).toHaveBeenCalledTimes(1)
    expect(h.setDraft).toHaveBeenCalledWith(SUGGESTION)
    expect(event.defaultPrevented).toBe(true)
    // The optimistic clear: the store suggestion is null immediately, so the
    // ghost disappears the moment the draft fills (no ghost on the next render).
    await waitFor(() => expect(h.controller.store.getSnapshot().suggestion).toBeNull())
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    expect(screen.queryByText(SUGGESTION)).toBeNull()
  })

  it('keeps native semantics for modifier keys, other keys, and editables outside the composer card', async () => {
    const h = harness()
    await mountWithSuggestion(h)

    // Any modifier keeps the native browser behavior (no prevent, no fill).
    for (const mods of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true, ...mods })
      document.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    // Other keys are never intercepted.
    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    document.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
    expect(h.setDraft).not.toHaveBeenCalled()

    // A focused editable OUTSIDE the composer card keeps native semantics:
    // pressing ArrowRight there fills nothing.
    render(<div contentEditable data-testid="elsewhere" />)
    expect(fireEvent.keyDown(screen.getByTestId('elsewhere'), { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()
  })

  it('treats the composer card editor as the fill target (a keydown inside the card intercepts)', async () => {
    const h = harness()
    // The editor element sits INSIDE the same composer card as the overlay
    // anchor — exactly where the host mounts the composer's own editor.
    const view = render(
      <ComposerCard>
        <div contentEditable data-testid="editor" />
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok({ suggestion: SUGGESTION }))
    await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('ready'))
    view.rerender(
      <ComposerCard>
        <div contentEditable data-testid="editor" />
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    expect(fireEvent.keyDown(screen.getByTestId('editor'), { key: 'ArrowRight' })).toBe(false)
    expect(h.setDraft).toHaveBeenCalledTimes(1)
    expect(h.setDraft).toHaveBeenCalledWith(SUGGESTION)
  })

  it('refetches on every consumed refresh-signal epoch bump, idempotently per epoch', async () => {
    const h = harness()
    const view = render(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok({ suggestion: null }))
    await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('ready'))

    // Rerenders without a bump never refetch (the epoch is consumed once).
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    expect(h.rpc.calls).toHaveLength(1)

    // The bump (connection reset / window focus ride the shared plane) →
    // exactly one new fetch for the new epoch.
    h.epoch.update((s) => { s.epoch += 1 })
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
    expect(h.rpc.last().method).toBe('advisor/suggestion')
  })

  it('polls at the idle interval only while idle and stops once a suggestion arrives', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.rpc.auto = true
    const view = render(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    // Mount fetch flushed (advanceTimersByTimeAsync awaits the settled
    // microtasks — testing-library's waitFor never runs under fake timers).
    await vi.advanceTimersByTimeAsync(0)
    expect(h.controller.store.getSnapshot().status).toBe('ready')
    expect(h.rpc.calls).toHaveLength(1)

    // Idle (suggestion null + empty draft + plain phase): the 30 s poll runs.
    await vi.advanceTimersByTimeAsync(NEXT_PROMPT_IDLE_POLL_MS)
    expect(h.rpc.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(NEXT_PROMPT_IDLE_POLL_MS)
    expect(h.rpc.calls).toHaveLength(3)

    // The next poll's reply carries a suggestion: the ghost appears and the
    // poll timer is CLEARED — no further ticks while the suggestion waits.
    h.rpc.reply = ok({ suggestion: SUGGESTION })
    await vi.advanceTimersByTimeAsync(NEXT_PROMPT_IDLE_POLL_MS)
    expect(h.controller.store.getSnapshot().suggestion).toBe(SUGGESTION)
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    expect(h.rpc.calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(NEXT_PROMPT_IDLE_POLL_MS * 2)
    expect(h.rpc.calls).toHaveLength(4)
  })

  it('maps a failure to unavailable: renders nothing with no retry storm until the next signal', async () => {
    const h = harness()
    const view = render(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(1))
    h.rpc.settle(ok({ error: { tag: 'advisor/unavailable', message: 'no suggestion face on this host' } }))
    await waitFor(() => expect(h.controller.store.getSnapshot().status).toBe('unavailable'))
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    // Nothing renders for an unavailable surface.
    expect(view.container.textContent).toBe('')
    // The keydown listener is unmounted too: a bare ArrowRight is native.
    expect(fireEvent.keyDown(document, { key: 'ArrowRight' })).toBe(true)
    expect(h.setDraft).not.toHaveBeenCalled()

    // No retry storm: rerenders (and the settled failure itself) never
    // trigger a new fetch — only the next consumed signal does.
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    expect(h.rpc.calls).toHaveLength(1)
    h.epoch.update((s) => { s.epoch += 1 })
    view.rerender(
      <ComposerCard>
        <NextPromptOverlay {...h.props} />
      </ComposerCard>,
    )
    await waitFor(() => expect(h.rpc.calls).toHaveLength(2))
  })
})
