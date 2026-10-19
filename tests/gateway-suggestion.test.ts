/**
 * T2 (plan dsh-advisor-next-prompt-n12) — the read-only next-prompt
 * suggestion endpoint: `/api/advisor/suggestion`.
 *
 * Contract under test:
 * ① Unit (scripted face): `getSuggestion` relays to the elected owner's
 *    suggestion face (the stored single-line text rides the wire unchanged);
 *    a malformed request answers `advisor/rejected` WITHOUT touching the
 *    face; a gateway without an owner answers `advisor/unavailable` in data.
 * ② Composed (real `apply` wiring): the explicit typert registration claims
 *    the aliased endpoint (`method: 'suggestion'` → implementation member
 *    `getSuggestion`); the wire result is exactly the one-field
 *    `{ suggestion: string | null }` shape; the wiring short-circuits to
 *    `{ suggestion: null }` in data (never an error) when the freshly
 *    resolved config closes the gate (S4 blocked) or reads
 *    `nextPrompt: false` — without consulting the manager. That
 *    short-circuit is also DISCRIMINATINGLY covered (qc1 W-1): one composed
 *    case seeds a real stored suggestion through the full wiring (completed
 *    turn arm → delta fire → shaped fake-llm reply) and proves the open
 *    gate serves it while the SAME seeded state answers null the moment the
 *    config flips `nextPrompt` off — deleting the guard turns that case
 *    red. Non-default-value round-trip evidence stays in T1's config cases
 *    (config-key checklist seam 2); the prediction chain itself is T1's
 *    covered behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryEntryConfig, harnessAdvisorPlugin } from './support/memory-settings'
import { ownerPeer, provideRemoteAccess } from './support/typert-gateway'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { installAdvisorSettings } from '../src/settings'
import { AdvisorConfigGateway } from '../src/gateway'
import type { AdvisorSuggestionFace, AdvisorSuggestionRpcResult } from '../src/gateway'
import type { AdvisorConfig } from '../src/config'

// n4 QC F-6: the single-reviewer guard is process-global; the composed tests
// mount the real plugin, so the flag must reset between cases.
beforeEach(() => {
  delete (globalThis as Record<string, unknown>)['__dshAdvisorReviewer__']
})

/** Full entry (plugin-row) config shape, merged over the schema defaults. */
function entryConfig(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    systemPrompt: '',
    immuneTurns: 3,
    maxDeltaMessages: 60,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ① unit: gateway behavior over a scripted face
// ---------------------------------------------------------------------------

describe('advisor suggestion endpoint (unit, scripted face)', () => {
  function scripted(face: AdvisorSuggestionFace): { gateway: AdvisorConfigGateway } {
    const ctx = new Context()
    const gateway = new AdvisorConfigGateway(
      ctx,
      installAdvisorSettings(ctx, entryConfig()),
      () => undefined,
      undefined,
      undefined,
      () => face,
    )
    return { gateway }
  }

  it('getSuggestion relays the stored suggestion to the elected owner face', () => {
    const getSuggestion = vi.fn((): AdvisorSuggestionRpcResult => ({ suggestion: 'run pnpm test -- --filter gateway' }))
    const { gateway } = scripted({ getSuggestion })
    expect(gateway.getSuggestion('sess-1')).toEqual({ suggestion: 'run pnpm test -- --filter gateway' })
    expect(getSuggestion).toHaveBeenCalledTimes(1)
    expect(getSuggestion).toHaveBeenCalledWith('sess-1')
  })

  it('rejects an empty or non-string sessionId as advisor/rejected WITHOUT touching the face', () => {
    const getSuggestion = vi.fn((): AdvisorSuggestionRpcResult => ({ suggestion: null }))
    const { gateway } = scripted({ getSuggestion })
    for (const bad of [undefined, 42, '']) {
      expect(gateway.getSuggestion(bad as never)).toEqual({
        error: { tag: 'advisor/rejected', message: expect.any(String) },
      })
    }
    expect(getSuggestion).not.toHaveBeenCalled()
  })

  it('answers advisor/unavailable in data when no elected owner exists on this fiber', () => {
    const ctx = new Context()
    const gateway = new AdvisorConfigGateway(ctx, installAdvisorSettings(ctx, entryConfig()))
    expect(gateway.getSuggestion('sess-1')).toEqual({
      error: { tag: 'advisor/unavailable', message: expect.stringContaining('no elected owner') },
    })
  })
})

// ---------------------------------------------------------------------------
// ② composed: real apply wiring through the typertGateway
// ---------------------------------------------------------------------------

interface Harness {
  ctx: Context
  /** The entry-config handle the Loader stand-in commits volatile patches through. */
  memory: MemoryEntryConfig
}

/** Default composed llm: no usable stream (predictions drop, reviews fail silently). */
function inertLlm(): unknown {
  return { stream: async () => {}, resolveModelInfo: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
}

/**
 * Compose the real plugin over the given entry config (mirrors
 * gateway-session). `llm` swaps the composed llm seam — the seeded case
 * hands in a stream that yields one text-delta reply so the REAL
 * NextPromptManager wiring can store a prediction.
 */
async function compose(entry: AdvisorConfig = entryConfig(), llm: unknown = inertLlm()): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  provideRemoteAccess(ctx)
  ctx.provide('sessions', {} as never)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('llm', llm as never)
  const memory = new MemoryEntryConfig(entry)
  await ctx.plugin(harnessAdvisorPlugin(), memory.config)
  await vi.waitFor(() => {
    expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
  })
  return { ctx, memory }
}

describe('composed suggestion endpoint (apply wiring)', () => {
  it('claims /api/advisor/suggestion and answers exactly the one-field wire shape', async () => {
    const { ctx } = await compose(entryConfig({ provider: 'deepseek', model: 'deepseek-chat' }))
    const result = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'suggestion', args: { sessionId: 'sess-1' }, peer: ownerPeer(ctx),
    })
    // Wire-shape fixture: exactly one field, no error arm, nothing extra —
    // the value round-trip evidence lives in T1's config cases.
    expect(Object.keys(result as object)).toEqual(['suggestion'])
    expect(result).toEqual({ suggestion: null })
  })

  it('answers the empty suggestion in data while the S4 gate blocks (disabled), never an error', async () => {
    const { ctx } = await compose() // pairless entry → gate-blocked (disabled with reason)
    const result = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'suggestion', args: { sessionId: 'sess-1' }, peer: ownerPeer(ctx),
    })
    expect(result).toEqual({ suggestion: null })
  })

  it('answers the empty suggestion in data when the config reads nextPrompt: false', async () => {
    const { ctx } = await compose(entryConfig({ provider: 'deepseek', model: 'deepseek-chat', nextPrompt: false }))
    const result = await ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'suggestion', args: { sessionId: 'sess-1' }, peer: ownerPeer(ctx),
    })
    expect(result).toEqual({ suggestion: null })
  })

  it('serves a seeded stored suggestion while the gate is open, and masks the SAME value once nextPrompt flips off', async () => {
    // The qc1 W-1 regression: every other composed case asserts null over an
    // EMPTY manager, so deleting the gate short-circuit kept the suite green.
    // Here the manager holds a REAL stored suggestion (driven through the
    // full wiring), which makes the guard the only thing standing between
    // the wire answer and the stored text once the config flips.
    const seeded = 'run pnpm vitest run tests/gateway-suggestion.test.ts'
    const seededLlm = {
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: seeded }
      })(),
      resolveModelInfo: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    }
    const { ctx, memory } = await compose(entryConfig({ provider: 'deepseek', model: 'deepseek-chat', nextPrompt: true }), seededLlm)

    // Seed through the real wiring (integration-suite event shape): one
    // completed primary turn arms the slot, the turn's rendered delta is the
    // prediction context, and the fake llm reply is shaped and stored by the
    // NextPromptManager the gateway face reads.
    const log = [
      { type: 'user/message', seq: 0, time: 0, data: { id: 'u0', role: 'user', content: [], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 1, time: 0, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'wrote a test' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } } }, surfaceOp: 'append' },
      { type: 'step/start', seq: 2, time: 0, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const session = { id: 'sess-1', snapshotEvents: () => log } as unknown as Session
    ctx.emit('session/event', session, log[3]!)
    const invoke = (): Promise<unknown> => ctx.typertGateway.invoke({
      namespace: 'advisor', method: 'suggestion', args: { sessionId: 'sess-1' }, peer: ownerPeer(ctx),
    })

    // (a) Gate open (`nextPrompt: true`): the endpoint serves the seeded text.
    await vi.waitFor(async () => {
      expect(await invoke()).toEqual({ suggestion: seeded })
    })

    // (b) The SAME seeded state after a live config flip (`nextPrompt:
    //     false`): the short-circuit answers the empty suggestion WITHOUT
    //     consulting the manager — which still holds the text, so deleting
    //     the guard turns exactly this case red.
    memory.commit(ctx, { nextPrompt: false })
    await Promise.resolve() // let the Loader stand-in's volatile-update re-apply settle
    expect(await invoke()).toEqual({ suggestion: null })
  })
})
