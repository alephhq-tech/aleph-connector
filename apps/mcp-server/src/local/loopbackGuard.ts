/**
 * Loopback transport guard for the local-first runtime.
 *
 * The MCP runtime binds 127.0.0.1, but binding alone does not stop a browser on this
 * machine from POSTing to http://127.0.0.1:PORT with a public DNS name pointed at
 * 127.0.0.1 (DNS rebinding), or from firing cross-origin requests while a loopback name
 * resolves. Every HTTP request must pass this guard before reaching /mcp, /device, or
 * /health. It is transport protection only — the Bridge still authenticates on /device,
 * and product-level approval lives in the desktop app.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** Strips brackets and the :port from a Host header value. */
function hostName(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  // A bare IPv6 host without brackets has multiple colons; a v4/hostname host has one port colon.
  if (colon !== -1 && trimmed.indexOf(':') === colon) return trimmed.slice(0, colon)
  return trimmed
}

function blocked(reason: string): Response {
  return Response.json({ error: 'loopback_only', reason }, { status: 403 })
}

/** Returns null when the request may proceed, or the 403 response to return instead. */
export function guardLoopback(request: Request): Response | null {
  const host = request.headers.get('host')
  if (!host || !LOOPBACK_HOSTS.has(hostName(host))) {
    return blocked('Host must be a loopback address (127.0.0.1, localhost, or ::1).')
  }

  const origin = request.headers.get('origin')
  if (origin) {
    let originHost: string
    try {
      originHost = new URL(origin).hostname
    } catch {
      return blocked('Origin header is not a valid URL.')
    }
    if (!LOOPBACK_HOSTS.has(originHost)) {
      return blocked('Origin must be a loopback address.')
    }
  }

  return null
}
