/**
 * STDIO <-> HTTP Proxy for Claude Desktop and other stdio-only MCP clients.
 *
 * Claude Desktop spawns this script via stdio (`bun run stdio-proxy.ts`), and this proxy forwards
 * JSON-RPC messages to the local AutoCAD MCP HTTP server (default http://127.0.0.1:8080/mcp) with
 * the required Authorization bearer header. Provide AUTOCAD_MCP_TOKEN from a
 * signed, authorized Aleph credential; no default/static token is accepted.
 */
import readline from 'node:readline'

const MCP_URL = process.env.AUTOCAD_MCP_URL || 'http://127.0.0.1:8080/mcp'
const MCP_TOKEN = process.env.AUTOCAD_MCP_TOKEN?.trim()
if (!MCP_TOKEN) {
  console.error(
    'AUTOCAD_MCP_TOKEN must be a signed Aleph credential. Sign in through Aleph Desktop and provide a valid token.'
  )
  process.exit(1)
}

let sessionId: string | null = null

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
})

rl.on('line', async (line: string) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Malformed JSON on stdin
    return
  }

  let msgId: unknown = undefined
  if (parsed && typeof parsed === 'object' && 'id' in parsed) {
    msgId = parsed.id
  }
  const isNotification = msgId === undefined || msgId === null

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${MCP_TOKEN}`
    }
    if (sessionId) {
      headers['mcp-session-id'] = sessionId
    }

    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: trimmed
    })

    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid

    if (isNotification || res.status === 204 || res.headers.get('content-length') === '0') {
      return
    }

    const text = await res.text()
    // Parse SSE payload: "event: message\ndata: {json}\n\n"
    const sseBlocks = text.split('\n\n')
    for (const block of sseBlocks) {
      const dataLines: string[] = []
      for (const rawLine of block.split('\n')) {
        if (rawLine.startsWith('data: ')) {
          dataLines.push(rawLine.slice(6))
        } else if (rawLine.startsWith('data:')) {
          dataLines.push(rawLine.slice(5))
        }
      }
      if (dataLines.length > 0) {
        const fullData = dataLines.join('\n').trim()
        if (fullData) {
          process.stdout.write(fullData + '\n')
        }
      } else {
        // Plain JSON response
        const candidate = block.trim()
        if (candidate.startsWith('{') && candidate.endsWith('}')) {
          process.stdout.write(candidate + '\n')
        }
      }
    }
  } catch (err: unknown) {
    if (!isNotification) {
      const message = err instanceof Error ? err.message : String(err)
      const errorResponse = {
        jsonrpc: '2.0',
        id: msgId,
        error: {
          code: -32603,
          message: `AutoCAD MCP Proxy Error: ${message}. Is 'bun run autocad:dev' running at ${MCP_URL}?`
        }
      }
      process.stdout.write(JSON.stringify(errorResponse) + '\n')
    }
  }
})
