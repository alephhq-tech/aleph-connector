import { describe, expect, test } from 'bun:test'
import { guardLoopback } from './loopbackGuard.js'

function requestWith(host: string, origin?: string): Request {
  const headers: Record<string, string> = { host }
  if (origin !== undefined) headers.origin = origin
  return new Request('http://127.0.0.1:8080/mcp', { headers })
}

describe('guardLoopback', () => {
  test('allows loopback hosts', () => {
    expect(guardLoopback(requestWith('127.0.0.1:8080'))).toBeNull()
    expect(guardLoopback(requestWith('localhost:8080'))).toBeNull()
    expect(guardLoopback(requestWith('[::1]:8080'))).toBeNull()
    expect(guardLoopback(requestWith('127.0.0.1'))).toBeNull()
  })

  test('rejects a non-loopback Host (DNS rebinding)', () => {
    const blocked = guardLoopback(requestWith('evil.example.com'))
    expect(blocked).not.toBeNull()
    expect(blocked!.status).toBe(403)
  })

  test('rejects a public Host even with a loopback-looking URL line', () => {
    const blocked = guardLoopback(requestWith('alephhq.tech'))
    expect(blocked).not.toBeNull()
    expect(blocked!.status).toBe(403)
  })

  test('rejects a cross-origin Origin header', () => {
    const blocked = guardLoopback(requestWith('127.0.0.1:8080', 'http://evil.example'))
    expect(blocked).not.toBeNull()
    expect(blocked!.status).toBe(403)
  })

  test('allows a loopback Origin and a missing Origin', () => {
    expect(guardLoopback(requestWith('127.0.0.1:8080', 'http://localhost:1420'))).toBeNull()
    expect(guardLoopback(requestWith('127.0.0.1:8080'))).toBeNull()
  })
})
