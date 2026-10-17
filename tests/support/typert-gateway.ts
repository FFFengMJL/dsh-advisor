/**
 * 0.2.1 `TypertGatewayService` test fixtures. Two contract changes force
 * them: `invoke` now names the calling PeerScope explicitly, and the service
 * injects `remoteAccess` (the decider host profiles mount as
 * `api-remote-access`), so a harness without it never applies the service.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

/**
 * The Peer an in-process test invocation speaks for: the local owner. The
 * Gateway admits an owner Peer without consulting `remoteAccess`, and reads
 * only `principal` plus the liveness `signal` from the scope.
 */
export function ownerPeer(ctx: Context): PeerScope {
  return {
    // `PeerScope.id` is a compile-time brand; nothing on the owner path reads it.
    id: 'owner-peer' as PeerScope['id'],
    ctx,
    principal: { kind: 'owner' },
    signal: new AbortController().signal,
    interactions: 'answer',
    dispose: async () => {},
  }
}

/**
 * Mount the access decider the Gateway injects. The owner Peer bypasses it,
 * so this owner-only fixture stays unreached and fails closed if it is not.
 */
export function provideRemoteAccess(ctx: Context): void {
  ctx.provide('remoteAccess', {
    decide: () => {
      throw new Error('owner-only fixture: unexpected non-owner access decision')
    },
  })
}
