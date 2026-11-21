import { OPERATION_META_KEY } from '@aleph-connector/operation-protocol'

/** The shape `McpServer`'s v2 handler context carries for the request being handled. Only `id`
 * and `_meta` are read here; the SDK types them loosely and every other field is irrelevant. */
export interface McpRequestContext {
  mcpReq: { id: string | number; _meta?: Record<string, unknown> }
}

/**
 * The idempotency identity for one mutating dispatch (issue #388 §C, bullet 2).
 *
 * Cloud stamps its server-minted `operationId` out-of-band in the request's `_meta`
 * (`McpCapabilityProvider`), exactly like the outcome attestation travels in the RESULT's `_meta`.
 * Out-of-band is the point: a key that arrived in tool arguments could be authored by the model,
 * and §C forbids letting the model's own text decide whether a write is a retry.
 *
 * The operationId — and nothing else — is the key, because the coordinator deliberately keeps one
 * operationId for every attempt at the same call (`identityFor` reuses it across retries while the
 * JSON-RPC id changes). Suffixing it with the request id would defeat the whole mechanism: a
 * whole-turn retry would present a different key and the write would apply twice, which is exactly
 * the duplicate the design is here to prevent.
 *
 * Fallback chain, in order of trust:
 * 1. the request's `_meta` operation id — server-minted, stable across whole-turn retries;
 * 2. the model-supplied `idempotencyKey`, when it set one;
 * 3. this request's JSON-RPC id — per-request, so it only ever dedupes an SDK-level retransmission
 *    of the same request.
 *
 * `id` is a string in practice, but a raw wire `id` can be numeric; the bridge keys on strings.
 */
export function operationKey(ctx: McpRequestContext, modelKey?: string): string {
  const minted = ctx.mcpReq._meta?.[OPERATION_META_KEY]
  if (typeof minted === 'string' && minted.length > 0) return minted
  return modelKey ?? String(ctx.mcpReq.id)
}
