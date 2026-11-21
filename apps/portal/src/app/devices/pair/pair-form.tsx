'use client'

import { useState, useTransition } from 'react'

export function PairForm() {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<{
    token?: string
    expiresAt?: number
    deviceId?: string
    error?: string
  } | null>(null)

  return (
    <div className="stack">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          const deviceId = new FormData(form).get('deviceId')
          startTransition(async () => {
            const res = await fetch('/api/devices/pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceId })
            })
            const body = (await res.json()) as {
              token?: string
              expiresAt?: number
              deviceId?: string
              error?: string
            }
            if (!res.ok) {
              setResult({ error: body.error || `Pairing failed (${res.status})` })
              return
            }
            setResult(body)
          })
        }}
      >
        <label htmlFor="deviceId">Device ID</label>
        <input
          id="deviceId"
          name="deviceId"
          placeholder="from %LOCALAPPDATA%/CadAI/bridge/identity.json"
          required
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Pairing…' : 'Pair and mint credential'}
        </button>
      </form>
      {result?.error ? <p className="error">{result.error}</p> : null}
      {result?.token ? (
        <div className="stack">
          <p>
            Paired <strong>{result.deviceId}</strong>. Paste this token into the Connector{' '}
            <code>identity.json</code> (<code>token</code> + <code>tokenExpiresAt</code>).
          </p>
          <code className="token">{result.token}</code>
          {result.expiresAt ? (
            <p className="muted">Expires {new Date(result.expiresAt * 1000).toISOString()}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
