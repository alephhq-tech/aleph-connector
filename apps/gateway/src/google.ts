import { createHash, randomBytes } from 'node:crypto'
import type { GatewayConfig } from './config.js'
import { signInWithGoogle } from './auth.js'

const pendingStates = new Map<string, number>()

function pruneStates(): void {
  const now = Date.now()
  for (const [k, exp] of pendingStates) {
    if (exp <= now) pendingStates.delete(k)
  }
}

export function googleConfigured(config: GatewayConfig): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret)
}

export function startGoogleAuth(config: GatewayConfig): Response {
  if (!googleConfigured(config)) {
    return Response.json({ error: 'Google sign-in is not configured' }, { status: 503 })
  }
  pruneStates()
  const state = randomBytes(16).toString('base64url')
  pendingStates.set(state, Date.now() + 10 * 60 * 1000)
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', config.googleClientId!)
  url.searchParams.set('redirect_uri', config.googleRedirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('access_type', 'online')
  url.searchParams.set('prompt', 'select_account')
  url.searchParams.set('state', state)
  return Response.redirect(url.toString(), 302)
}

export async function handleGoogleCallback(
  config: GatewayConfig,
  requestUrl: URL
): Promise<Response> {
  if (!googleConfigured(config)) {
    return Response.json({ error: 'Google sign-in is not configured' }, { status: 503 })
  }
  const code = requestUrl.searchParams.get('code') ?? ''
  const state = requestUrl.searchParams.get('state') ?? ''
  const err = requestUrl.searchParams.get('error')
  if (err) {
    return Response.json({ error: err }, { status: 400 })
  }
  pruneStates()
  if (!code || !state || !pendingStates.has(state)) {
    return Response.json({ error: 'Invalid Google OAuth state' }, { status: 400 })
  }
  pendingStates.delete(state)

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId!,
      client_secret: config.googleClientSecret!,
      redirect_uri: config.googleRedirectUri,
      grant_type: 'authorization_code'
    })
  })
  if (!tokenRes.ok) {
    const text = await tokenRes.text()
    return Response.json({ error: `Google token exchange failed: ${text}` }, { status: 502 })
  }
  const tokens = (await tokenRes.json()) as { access_token?: string; id_token?: string }
  const accessToken = tokens.access_token
  if (!accessToken) {
    return Response.json({ error: 'Google did not return an access_token' }, { status: 502 })
  }

  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!profileRes.ok) {
    return Response.json({ error: 'Failed to load Google profile' }, { status: 502 })
  }
  const profile = (await profileRes.json()) as { email?: string; email_verified?: boolean }
  if (!profile.email || profile.email_verified === false) {
    return Response.json({ error: 'Google email is missing or unverified' }, { status: 400 })
  }

  const session = await signInWithGoogle(config, profile.email)
  const deep = new URL(config.connectorAppCallbackUri)
  deep.searchParams.set('session_token', session.sessionToken)
  // Include a short fingerprint so the app can log without storing PII in the URL beyond token.
  deep.searchParams.set(
    'email_hash',
    createHash('sha256').update(profile.email.toLowerCase()).digest('hex').slice(0, 12)
  )
  return connectSuccessPage(deep.toString(), profile.email)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Browser landing after Google OAuth — mirrors Antigravity-style “connected” UX. */
function connectSuccessPage(deepLink: string, email: string): Response {
  const href = escapeHtml(deepLink)
  const safeEmail = escapeHtml(email)
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Connected · Aleph</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0c0d10;
      --panel: #14161c;
      --text: #f2f0ea;
      --muted: #9a958a;
      --accent: #c4a574;
      --line: rgba(255,255,255,0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(1200px 600px at 50% -10%, rgba(196,165,116,0.14), transparent 55%),
        radial-gradient(800px 400px at 80% 100%, rgba(80,100,140,0.12), transparent 50%),
        var(--bg);
      color: var(--text);
    }
    .card {
      width: min(440px, calc(100vw - 2rem));
      padding: 2.25rem 2rem 2rem;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent 40%), var(--panel);
      text-align: center;
    }
    .mark {
      width: 56px;
      height: 56px;
      margin: 0 auto 1.25rem;
      border-radius: 14px;
      display: grid;
      place-items: center;
      background: rgba(196,165,116,0.16);
      color: var(--accent);
      font-size: 1.6rem;
      font-weight: 700;
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.45rem;
      font-weight: 650;
      letter-spacing: -0.02em;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
      font-size: 0.95rem;
    }
    .email {
      margin-top: 0.85rem;
      color: var(--text);
      font-weight: 500;
    }
    a.btn {
      display: inline-block;
      margin-top: 1.5rem;
      padding: 0.75rem 1.25rem;
      border-radius: 10px;
      background: var(--accent);
      color: #1a140c;
      text-decoration: none;
      font-weight: 650;
      font-size: 0.95rem;
    }
    a.btn:hover { filter: brightness(1.05); }
    .hint {
      margin-top: 1.1rem;
      font-size: 0.8rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">✓</div>
    <h1 id="title">You're connected</h1>
    <p id="body">Google sign-in succeeded. Opening <strong>Aleph Connector</strong> once to finish setup.</p>
    <p class="email">${safeEmail}</p>
    <a class="btn" href="${href}" id="open">Open Aleph Connector</a>
    <p class="hint" id="hint">You can close this tab after Connector shows you signed in.</p>
  </main>
  <script>
    (function () {
      var href = ${JSON.stringify(deepLink)};
      var opened = false;
      function markOpened() {
        opened = true;
        var t = document.getElementById('title');
        var b = document.getElementById('body');
        var h = document.getElementById('hint');
        if (t) t.textContent = 'Connected — return to Connector';
        if (b) b.innerHTML = 'Aleph Connector should already be signed in. You can close this browser tab.';
        if (h) h.textContent = 'Only click the button if Connector is still on the sign-in screen.';
      }
      function openApp() {
        if (opened) return;
        markOpened();
        try { window.location.href = href; } catch (_) {}
      }
      // Single auto-open — no meta-refresh / retries (those re-pop the browser dialog).
      openApp();
      document.getElementById('open')?.addEventListener('click', function (e) {
        e.preventDefault();
        opened = false;
        openApp();
      });
    })();
  </script>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  })
}
