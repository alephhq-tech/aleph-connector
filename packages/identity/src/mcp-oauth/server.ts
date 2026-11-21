import { createHash, timingSafeEqual } from 'node:crypto'
import { DEFAULT_MCP_SCOPES, MCP_SCOPES, parseScopeString, scopeString } from '../scopes.js'
import { McpJwtService, randomToken } from './jwt.js'
import {
  MemoryMcpOAuthStore,
  newClientId,
  type AuthorizationCodeRecord,
  type McpOAuthStore,
  type RegisteredClient
} from './store.js'

export interface McpOAuthServerConfig {
  issuer: string
  resource: string
  jwtSecret: string
  accessTokenTtlSeconds?: number
  refreshTokenTtlSeconds?: number
  authorizationCodeTtlSeconds?: number
  store?: McpOAuthStore
  /**
   * Deep-link (or HTTPS) URI that receives OAuth consent. Default
   * `aleph-connector://oauth/consent` opens the Windows Connector app.
   * @deprecated Prefer `connectorConsentUri`.
   */
  portalUrl?: string
  /** Deep-link base for interactive consent (e.g. `aleph-connector://oauth/consent`). */
  connectorConsentUri?: string
  /**
   * Shared secret for `POST /oauth/connector/approve` (Connector → AS). Also accepted on the
   * legacy `/oauth/portal/approve` path.
   */
  connectorApproveSecret?: string
  /** @deprecated Use `connectorApproveSecret`. */
  portalApproveSecret?: string
  allowDevCodeIssuance?: boolean
}

export interface OAuthMetadataDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
  jwks_uri?: string
  response_types_supported: string[]
  grant_types_supported: string[]
  token_endpoint_auth_methods_supported: string[]
  code_challenge_methods_supported: string[]
  scopes_supported: string[]
  resource_indicator_parameter_supported: boolean
  authorization_response_iss_parameter_supported: boolean
}

const AUTH_CODE_TTL = 10 * 60
const ACCESS_TTL = 60 * 60
const REFRESH_TTL = 30 * 24 * 60 * 60

function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status)
}

function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export class McpOAuthAuthorizationServer {
  readonly issuer: string
  readonly resource: string
  private readonly jwt: McpJwtService
  private readonly store: McpOAuthStore
  private readonly accessTtl: number
  private readonly refreshTtl: number
  private readonly codeTtl: number
  private readonly connectorConsentUri: string
  private readonly connectorApproveSecret: string | undefined
  private readonly allowDevCodeIssuance: boolean

  constructor(config: McpOAuthServerConfig) {
    this.issuer = config.issuer.replace(/\/$/, '')
    this.resource = config.resource
    this.jwt = new McpJwtService(config.jwtSecret)
    this.store = config.store ?? new MemoryMcpOAuthStore()
    this.accessTtl = config.accessTokenTtlSeconds ?? ACCESS_TTL
    this.refreshTtl = config.refreshTokenTtlSeconds ?? REFRESH_TTL
    this.codeTtl = config.authorizationCodeTtlSeconds ?? AUTH_CODE_TTL
    const consent =
      config.connectorConsentUri?.trim() ||
      (config.portalUrl?.trim()
        ? `${config.portalUrl.replace(/\/$/, '')}/oauth/consent`
        : 'aleph-connector://oauth/consent')
    this.connectorConsentUri = consent.replace(/\/$/, '')
    this.connectorApproveSecret =
      config.connectorApproveSecret?.trim() || config.portalApproveSecret?.trim() || undefined
    this.allowDevCodeIssuance = config.allowDevCodeIssuance === true
  }

  metadata(): OAuthMetadataDocument {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...MCP_SCOPES],
      resource_indicator_parameter_supported: true,
      authorization_response_iss_parameter_supported: true
    }
  }

  async handleRequest(request: Request): Promise<Response | null> {
    const url = new URL(request.url)
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(this.metadata())
    }
    if (url.pathname === '/oauth/register' && request.method === 'POST') {
      return this.handleRegister(request)
    }
    if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
      return this.handleAuthorize(url)
    }
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      return this.handleToken(request)
    }
    if (url.pathname === '/oauth/login' && request.method === 'GET') {
      return this.loginPage(url)
    }
    if (
      (url.pathname === '/oauth/connector/approve' || url.pathname === '/oauth/portal/approve') &&
      request.method === 'POST'
    ) {
      return this.handleConnectorApprove(request)
    }
    if (
      this.allowDevCodeIssuance &&
      url.pathname === '/oauth/dev/code' &&
      request.method === 'POST'
    ) {
      return this.handleDevCode(request)
    }
    return null
  }

  private async handleConnectorApprove(request: Request): Promise<Response> {
    if (!this.connectorApproveSecret) {
      return oauthError(
        'server_error',
        'Connector approve is not configured (set CONNECTOR_APPROVE_SECRET).',
        503
      )
    }
    const auth = request.headers.get('authorization') ?? ''
    const expected = `Bearer ${this.connectorApproveSecret}`
    const a = Buffer.from(auth)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return oauthError('invalid_client', 'Connector approve authentication failed', 401)
    }
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return oauthError('invalid_request', 'JSON body required')
    }
    try {
      const approved = this.approveAuthorization({
        clientId: String(body.client_id ?? ''),
        redirectUri: String(body.redirect_uri ?? ''),
        codeChallenge: String(body.code_challenge ?? ''),
        ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
        ...(typeof body.resource === 'string' ? { resource: body.resource } : {}),
        userId: String(body.user_id ?? ''),
        workspaceId: String(body.workspace_id ?? ''),
        ...(typeof body.state === 'string' ? { state: body.state } : {})
      })
      return json({ code: approved.code, redirect_to: approved.redirectTo, iss: this.issuer })
    } catch (err) {
      return oauthError(
        'invalid_request',
        err instanceof Error ? err.message : 'connector_approve_failed'
      )
    }
  }

  private async handleDevCode(request: Request): Promise<Response> {
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return oauthError('invalid_request', 'JSON body required')
    }
    try {
      const approved = this.approveAuthorization({
        clientId: String(body.client_id ?? ''),
        redirectUri: String(body.redirect_uri ?? ''),
        codeChallenge: String(body.code_challenge ?? ''),
        ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
        ...(typeof body.resource === 'string' ? { resource: body.resource } : {}),
        userId: String(body.user_id ?? ''),
        workspaceId: String(body.workspace_id ?? ''),
        ...(typeof body.state === 'string' ? { state: body.state } : {})
      })
      return json({ code: approved.code, redirect_to: approved.redirectTo, iss: this.issuer })
    } catch (err) {
      return oauthError('invalid_request', err instanceof Error ? err.message : 'dev_code_failed')
    }
  }

  private async handleRegister(request: Request): Promise<Response> {
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return oauthError('invalid_client_metadata', 'Body must be JSON')
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : []
    if (redirectUris.length === 0) {
      return oauthError('invalid_client_metadata', 'redirect_uris required')
    }
    const authMethod =
      body.token_endpoint_auth_method === 'client_secret_post' ||
      body.token_endpoint_auth_method === 'client_secret_basic'
        ? body.token_endpoint_auth_method
        : 'none'
    const clientId = newClientId()
    const clientSecret = authMethod === 'none' ? undefined : randomToken(24)
    const client: RegisteredClient = {
      clientId,
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      redirectUris,
      tokenEndpointAuthMethod: authMethod,
      ...(typeof body.client_name === 'string' ? { clientName: body.client_name } : {}),
      createdAt: Date.now()
    }
    this.store.putClient(client)
    return json(
      {
        client_id: client.clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(client.createdAt / 1000)
      },
      201
    )
  }

  private loginPage(url: URL): Response {
    const authorizePath = url.searchParams.get('authorize') ?? '/oauth/authorize'
    const returnTo = new URL(authorizePath, this.issuer).toString()
    let deepLink: URL
    try {
      deepLink = new URL(this.connectorConsentUri)
    } catch {
      return oauthError('server_error', 'Invalid connectorConsentUri', 500)
    }
    deepLink.searchParams.set('return_to', returnTo)
    // Custom schemes: redirect + HTML fallback that auto-opens the Connector app.
    if (deepLink.protocol !== 'http:' && deepLink.protocol !== 'https:') {
      const href = deepLink.toString()
      const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Open Aleph Connector</title>
<meta http-equiv="refresh" content="0;url=${escapeHtml(href)}"/>
</head><body style="font-family:system-ui;padding:2rem">
<p>Opening <strong>Aleph Connector</strong> to approve this sign-in…</p>
<p><a href="${escapeHtml(href)}">Open Aleph Connector</a> if nothing happens.</p>
<p style="color:#666;font-size:0.9rem">Install Connector from alephhq.tech/download if you do not have it yet.</p>
<script>location.href=${JSON.stringify(href)}</script>
</body></html>`
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
    return Response.redirect(deepLink.toString(), 302)
  }

  private handleAuthorize(url: URL): Response {
    const params = url.searchParams
    const clientId = params.get('client_id') ?? ''
    const redirectUri = params.get('redirect_uri') ?? ''
    const responseType = params.get('response_type') ?? ''
    const codeChallenge = params.get('code_challenge') ?? ''
    const codeChallengeMethod = params.get('code_challenge_method') ?? ''
    const resource = params.get('resource') ?? this.resource
    try {
      parseScopeString(params.get('scope'))
    } catch (err) {
      return oauthError('invalid_scope', err instanceof Error ? err.message : 'invalid_scope')
    }

    if (responseType !== 'code') {
      return oauthError('unsupported_response_type', 'Only response_type=code is supported')
    }
    const client = this.store.getClient(clientId)
    if (!client) return oauthError('invalid_client', 'Unknown client_id', 401)
    if (!client.redirectUris.includes(redirectUri)) {
      return oauthError('invalid_request', 'redirect_uri is not registered for this client')
    }
    if (codeChallengeMethod !== 'S256' || !codeChallenge) {
      return oauthError('invalid_request', 'PKCE S256 code_challenge is required')
    }
    if (resource !== this.resource) {
      return oauthError('invalid_target', `resource must be ${this.resource}`)
    }

    const authorize = new URL(`${this.issuer}/oauth/authorize`)
    for (const [k, v] of params.entries()) authorize.searchParams.append(k, v)
    const login = new URL(`${this.issuer}/oauth/login`)
    login.searchParams.set('authorize', `${authorize.pathname}${authorize.search}`)
    return Response.redirect(login.toString(), 302)
  }

  approveAuthorization(input: {
    clientId: string
    redirectUri: string
    codeChallenge: string
    scope?: string
    resource?: string
    userId: string
    workspaceId: string
    state?: string
  }): { code: string; redirectTo: string } {
    const client = this.store.getClient(input.clientId)
    if (!client) throw new Error('invalid_client')
    if (!client.redirectUris.includes(input.redirectUri)) throw new Error('invalid_redirect_uri')
    const scope = scopeString(parseScopeString(input.scope))
    const resource = input.resource ?? this.resource
    if (resource !== this.resource) throw new Error('invalid_target')
    const code = randomToken(24)
    const record: AuthorizationCodeRecord = {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: 'S256',
      scope,
      resource,
      userId: input.userId,
      workspaceId: input.workspaceId,
      expiresAt: Math.floor(Date.now() / 1000) + this.codeTtl
    }
    this.store.putCode(record)
    const redirect = new URL(input.redirectUri)
    redirect.searchParams.set('code', code)
    if (input.state) redirect.searchParams.set('state', input.state)
    redirect.searchParams.set('iss', this.issuer)
    return { code, redirectTo: redirect.toString() }
  }

  private async handleToken(request: Request): Promise<Response> {
    const params = await formParams(request)
    const grantType = params.get('grant_type') ?? ''
    if (grantType === 'authorization_code') return this.tokenFromCode(request, params)
    if (grantType === 'refresh_token') return this.tokenFromRefresh(request, params)
    return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token')
  }

  private authenticateClient(
    request: Request,
    params: URLSearchParams
  ): RegisteredClient | Response {
    let clientId = params.get('client_id') ?? ''
    let clientSecret = params.get('client_secret')
    const basic = request.headers.get('authorization')
    if (basic?.toLowerCase().startsWith('basic ')) {
      try {
        const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8')
        const idx = decoded.indexOf(':')
        if (idx >= 0) {
          clientId = decoded.slice(0, idx)
          clientSecret = decoded.slice(idx + 1)
        }
      } catch {
        return oauthError('invalid_client', 'Malformed Authorization header', 401)
      }
    }
    const client = this.store.getClient(clientId)
    if (!client) return oauthError('invalid_client', 'Unknown client_id', 401)
    if (client.tokenEndpointAuthMethod === 'none') {
      if (clientSecret) return oauthError('invalid_client', 'Public client must not send a secret', 401)
      return client
    }
    if (!client.clientSecret || !clientSecret || !safeEqual(client.clientSecret, clientSecret)) {
      return oauthError('invalid_client', 'Client authentication failed', 401)
    }
    return client
  }

  private tokenFromCode(request: Request, params: URLSearchParams): Response {
    const clientOrErr = this.authenticateClient(request, params)
    if (clientOrErr instanceof Response) return clientOrErr
    const client = clientOrErr
    const code = params.get('code') ?? ''
    const redirectUri = params.get('redirect_uri') ?? ''
    const verifier = params.get('code_verifier') ?? ''
    const record = this.store.takeCode(code)
    if (!record || record.expiresAt <= Math.floor(Date.now() / 1000)) {
      return oauthError('invalid_grant', 'Authorization code is invalid or expired')
    }
    if (record.clientId !== client.clientId) {
      return oauthError('invalid_grant', 'Authorization code was issued to another client')
    }
    if (record.redirectUri !== redirectUri) {
      return oauthError('invalid_grant', 'redirect_uri mismatch')
    }
    if (!verifier || pkceS256(verifier) !== record.codeChallenge) {
      return oauthError('invalid_grant', 'PKCE verification failed')
    }
    return this.issueTokens({
      clientId: client.clientId,
      userId: record.userId,
      workspaceId: record.workspaceId,
      scope: record.scope,
      resource: record.resource
    })
  }

  private tokenFromRefresh(request: Request, params: URLSearchParams): Response {
    const clientOrErr = this.authenticateClient(request, params)
    if (clientOrErr instanceof Response) return clientOrErr
    const client = clientOrErr
    const refreshToken = params.get('refresh_token') ?? ''
    const record = this.store.getRefresh(refreshToken)
    if (!record || record.revoked || record.expiresAt <= Math.floor(Date.now() / 1000)) {
      return oauthError('invalid_grant', 'Refresh token is invalid or expired')
    }
    if (record.clientId !== client.clientId) {
      return oauthError('invalid_grant', 'Refresh token was issued to another client')
    }
    this.store.revokeRefresh(refreshToken)
    return this.issueTokens({
      clientId: client.clientId,
      userId: record.userId,
      workspaceId: record.workspaceId,
      scope: record.scope,
      resource: record.resource
    })
  }

  private issueTokens(input: {
    clientId: string
    userId: string
    workspaceId: string
    scope: string
    resource: string
  }): Response {
    const access = this.jwt.sign({
      iss: this.issuer,
      aud: input.resource,
      sub: input.userId,
      client_id: input.clientId,
      workspace_id: input.workspaceId,
      scope: input.scope || scopeString(DEFAULT_MCP_SCOPES),
      ttlSeconds: this.accessTtl
    })
    const refresh = randomToken(32)
    this.store.putRefresh({
      token: refresh,
      clientId: input.clientId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      scope: input.scope,
      resource: input.resource,
      expiresAt: Math.floor(Date.now() / 1000) + this.refreshTtl,
      revoked: false
    })
    return json({
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: this.accessTtl,
      refresh_token: refresh,
      scope: input.scope,
      resource: input.resource
    })
  }

  verifyAccessToken(token: string): {
    userId: string
    workspaceId: string
    clientId: string
    scopes: string[]
    expiresAt: number
  } | null {
    const claims = this.jwt.verify(token, { issuer: this.issuer, audience: this.resource })
    if (!claims) return null
    return {
      userId: claims.sub,
      workspaceId: claims.workspace_id,
      clientId: claims.client_id,
      scopes: claims.scope.split(/\s+/).filter(Boolean),
      expiresAt: claims.exp
    }
  }

  registerPublicClient(input: {
    clientId?: string
    redirectUris: string[]
    clientName?: string
  }): RegisteredClient {
    const client: RegisteredClient = {
      clientId: input.clientId ?? newClientId(),
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod: 'none',
      ...(input.clientName ? { clientName: input.clientName } : {}),
      createdAt: Date.now()
    }
    this.store.putClient(client)
    return client
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function formParams(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(await request.text())
  }
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === 'string') params.set(k, v)
    }
    return params
  }
  // POST authorize with multipart/form or urlencoded without header
  try {
    const text = await request.text()
    return new URLSearchParams(text)
  } catch {
    return new URLSearchParams()
  }
}
