import type { McpOAuthAuthorizationServer } from '@aleph-connector/identity'
import type { GatewayConfig } from './config.js'
import {
  createUserWithWorkspace,
  destroySession,
  getSession,
  sessionTokenFromRequest,
  signIn
} from './auth.js'
import { listDevices, pairDevice, revokeDevice } from './devices.js'
import { googleConfigured, handleGoogleCallback, startGoogleAuth } from './google.js'

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  return new Response(response.body, { status: response.status, headers })
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return (await request.json()) as Record<string, unknown>
}

export function createGatewayApp(config: GatewayConfig, oauth: McpOAuthAuthorizationServer) {
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method === 'OPTIONS') {
        return cors(new Response(null, { status: 204 }))
      }

      const url = new URL(request.url)

      if (request.method === 'GET' && url.pathname === '/health') {
        return cors(
          json({
            status: 'ok',
            service: 'aleph-gateway',
            issuer: config.publicUrl,
            resource: config.mcpResourceUrl,
            google: googleConfigured(config)
          })
        )
      }

      if (request.method === 'GET' && url.pathname === '/auth/google/start') {
        return cors(startGoogleAuth(config))
      }
      if (request.method === 'GET' && url.pathname === '/auth/google/callback') {
        return cors(await handleGoogleCallback(config, url))
      }

      const oauthResponse = await oauth.handleRequest(request)
      if (oauthResponse) return cors(oauthResponse)

      if (url.pathname === '/auth/signup' && request.method === 'POST') {
        try {
          const body = await readJson(request)
          const session = await createUserWithWorkspace(
            config,
            String(body.email ?? ''),
            String(body.password ?? '')
          )
          return cors(
            json({
              sessionToken: session.sessionToken,
              expiresAt: session.expiresAt,
              user: session.user,
              workspaceId: session.workspaceId,
              workspaceName: session.workspaceName
            })
          )
        } catch (err) {
          return cors(json({ error: err instanceof Error ? err.message : String(err) }, 400))
        }
      }

      if (url.pathname === '/auth/signin' && request.method === 'POST') {
        try {
          const body = await readJson(request)
          const session = await signIn(
            config,
            String(body.email ?? ''),
            String(body.password ?? '')
          )
          return cors(
            json({
              sessionToken: session.sessionToken,
              expiresAt: session.expiresAt,
              user: session.user,
              workspaceId: session.workspaceId,
              workspaceName: session.workspaceName
            })
          )
        } catch (err) {
          return cors(json({ error: err instanceof Error ? err.message : String(err) }, 401))
        }
      }

      if (url.pathname === '/auth/signout' && request.method === 'POST') {
        await destroySession(config, sessionTokenFromRequest(request) ?? '')
        return cors(json({ ok: true }))
      }

      if (url.pathname === '/auth/me' && request.method === 'GET') {
        const session = await getSession(config, sessionTokenFromRequest(request))
        if (!session) return cors(json({ error: 'Authentication required' }, 401))
        return cors(
          json({
            user: session.user,
            workspaceId: session.workspaceId,
            workspaceName: session.workspaceName,
            expiresAt: session.expiresAt
          })
        )
      }

      if (url.pathname === '/devices' && request.method === 'GET') {
        const session = await getSession(config, sessionTokenFromRequest(request))
        if (!session) return cors(json({ error: 'Authentication required' }, 401))
        const devices = await listDevices(config, session.workspaceId, session.user.id)
        return cors(json({ devices }))
      }

      if (url.pathname === '/devices/pair' && request.method === 'POST') {
        const session = await getSession(config, sessionTokenFromRequest(request))
        if (!session) return cors(json({ error: 'Authentication required' }, 401))
        try {
          const body = await readJson(request)
          const minted = await pairDevice(config, {
            deviceId: String(body.deviceId ?? ''),
            workspaceId: session.workspaceId,
            userId: session.user.id
          })
          return cors(
            json({
              token: minted.token,
              expiresAt: minted.expiresAt,
              deviceId: minted.deviceId,
              grantGeneration: minted.grantGeneration
            })
          )
        } catch (err) {
          return cors(json({ error: err instanceof Error ? err.message : String(err) }, 400))
        }
      }

      if (url.pathname === '/devices/revoke' && request.method === 'POST') {
        const session = await getSession(config, sessionTokenFromRequest(request))
        if (!session) return cors(json({ error: 'Authentication required' }, 401))
        try {
          const body = await readJson(request)
          const ok = await revokeDevice(
            config,
            String(body.deviceId ?? ''),
            session.workspaceId,
            session.user.id
          )
          return cors(json({ ok }))
        } catch (err) {
          return cors(json({ error: err instanceof Error ? err.message : String(err) }, 400))
        }
      }

      // Session-authenticated OAuth approve (Connector already signed in — preferred path).
      if (url.pathname === '/oauth/session/approve' && request.method === 'POST') {
        const session = await getSession(config, sessionTokenFromRequest(request))
        if (!session) return cors(json({ error: 'Authentication required' }, 401))
        try {
          const body = await readJson(request)
          const approved = oauth.approveAuthorization({
            clientId: String(body.client_id ?? ''),
            redirectUri: String(body.redirect_uri ?? ''),
            codeChallenge: String(body.code_challenge ?? ''),
            ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
            ...(typeof body.resource === 'string' ? { resource: body.resource } : {}),
            ...(typeof body.state === 'string' ? { state: body.state } : {}),
            userId: session.user.id,
            workspaceId: session.workspaceId
          })
          return cors(
            json({ code: approved.code, redirect_to: approved.redirectTo, iss: config.publicUrl })
          )
        } catch (err) {
          return cors(json({ error: err instanceof Error ? err.message : String(err) }, 400))
        }
      }

      return cors(new Response('Not Found', { status: 404 }))
    }
  }
}
