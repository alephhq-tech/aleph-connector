/**
 * STDIO proxy for clients that cannot speak Streamable HTTP OAuth yet.
 *
 * Aleph MCP no longer accepts static API / minted ABT tokens as client credentials.
 * Prefer configuring the client with the HTTP URL only and completing the OAuth browser flow:
 *
 *   { "url": "http://127.0.0.1:8080/mcp" }
 *
 * This proxy remains only for transitional stdio hosts that can inject an *OAuth access_token*
 * obtained via authorization_code + PKCE (see scripts/oauth-access-token.ts). Device ABT tokens
 * are rejected by the MCP resource server.
 */
import readline from 'node:readline'

const MCP_URL = process.env.AUTOCAD_MCP_URL || 'http://127.0.0.1:8080/mcp'
const MCP_TOKEN = process.env.AUTOCAD_MCP_TOKEN?.trim()
if (!MCP_TOKEN) {
  console.error(
    'AUTOCAD_MCP_TOKEN must be an OAuth access_token from Aleph Connector (/oauth/authorize + /oauth/token). ' +
      'Static API tokens are not accepted. Prefer HTTP MCP with OAuth discovery instead of this proxy.'
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
          code: -32000,
          message
        }
      }
      process.stdout.write(JSON.stringify(errorResponse) + '\n')
    }
  }
})
