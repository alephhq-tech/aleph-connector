/**
 * @deprecated OAuth AS lives on apps/gateway. Kept only so older imports fail loudly.
 */
export function createMcpOAuth(): never {
  throw new Error(
    'createMcpOAuth was removed from mcp-server. Run apps/gateway for the OAuth AS (ALEPH_GATEWAY_URL).'
  )
}
