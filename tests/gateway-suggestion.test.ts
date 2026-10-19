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
 *    `nextPrompt: false` — without consulting the manager. Non-default-value
 *    round-trip evidence stays in T1's config cases (config-key checklist
 *    seam 2); the prediction chain itself is T1's covered behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryEntryConfig, harnessAdvisorPlugin } from './support/memory-settings'
import { ownerPeer, provideRemoteAccess } from './support/typert-gateway'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
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
}

/** Compose the real plugin over the given entry config (mirrors gateway-session). */
async function compose(entry: AdvisorConfig = entryConfig()): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  provideRemoteAccess(ctx)
  ctx.provide('sessions', {} as never)
  const resolveModelInfo = vi.fn(async () => ({ provider: 'deepseek', model: 'deepseek-chat' }))
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('llm', { stream: async () => {}, resolveModelInfo } as never)
  const memory = new MemoryEntryConfig(entry)
  await ctx.plugin(harnessAdvisorPlugin(), memory.config)
  await vi.waitFor(() => {
    expect(ctx.reflect.props['advisor']).toEqual({ type: 'service' })
  })
  return { ctx }
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
})
