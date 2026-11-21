import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} from 'node:crypto'
import type { GatewayConfig } from './config.js'
import { getSql } from './db.js'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SCRYPT_PREFIX = 'scrypt$'

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url')
  const hash = scryptSync(password, salt, 32).toString('base64url')
  return `${SCRYPT_PREFIX}${salt}$${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  if (!stored.startsWith(SCRYPT_PREFIX)) return false
  const parts = stored.slice(SCRYPT_PREFIX.length).split('$')
  if (parts.length !== 2) return false
  const [salt, expected] = parts as [string, string]
  const actual = scryptSync(password, salt, 32).toString('base64url')
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface GatewayUser {
  id: string
  email: string
}

export interface GatewaySession {
  user: GatewayUser
  workspaceId: string
  workspaceName: string
  /** Opaque session bearer for the Connector desktop app. */
  sessionToken: string
  expiresAt: number
}

export async function createUserWithWorkspace(
  config: GatewayConfig,
  email: string,
  password: string
): Promise<GatewaySession> {
  const sql = getSql(config)
  const normalized = email.trim().toLowerCase()
  if (!normalized.includes('@')) throw new Error('Valid email is required')
  if (password.length < 8) throw new Error('Password must be at least 8 characters')

  const passwordHash = hashPassword(password)
  const userId = `user_${randomUUID().replace(/-/g, '')}`
  const workspaceId = `ws_${randomUUID().replace(/-/g, '')}`
  const now = Date.now()
  const workspaceName = `${normalized.split('@')[0]}'s workspace`

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO users (id, email, password_hash, auth_provider, created_at)
        VALUES (${userId}, ${normalized}, ${passwordHash}, ${'password'}, ${now})
      `
      await tx`
        INSERT INTO workspaces (id, name, created_at)
        VALUES (${workspaceId}, ${workspaceName}, ${now})
      `
      await tx`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${workspaceId}, ${userId}, 'owner')
      `
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/unique|duplicate/i.test(message)) {
      throw new Error('An account with that email already exists')
    }
    throw err
  }

  return createSession(config, { id: userId, email: normalized }, workspaceId, workspaceName)
}

export async function signIn(
  config: GatewayConfig,
  email: string,
  password: string
): Promise<GatewaySession> {
  const sql = getSql(config)
  const normalized = email.trim().toLowerCase()
  const rows = await sql<{ id: string; email: string; password_hash: string | null }[]>`
    SELECT id, email, password_hash FROM users WHERE email = ${normalized} LIMIT 1
  `
  const row = rows[0]
  if (!row?.password_hash) throw new Error('Invalid email or password')
  if (!verifyPassword(password, row.password_hash)) {
    throw new Error('Invalid email or password')
  }

  const memberships = await sql<{ workspace_id: string; name: string }[]>`
    SELECT wm.workspace_id, w.name
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = ${row.id}
    ORDER BY w.created_at ASC
    LIMIT 1
  `
  const membership = memberships[0]
  if (!membership) throw new Error('Account has no workspace')

  return createSession(
    config,
    { id: row.id, email: row.email },
    membership.workspace_id,
    membership.name
  )
}

/** Upsert a Google-authenticated user and return a Connector session. */
export async function signInWithGoogle(
  config: GatewayConfig,
  email: string
): Promise<GatewaySession> {
  const sql = getSql(config)
  const normalized = email.trim().toLowerCase()
  if (!normalized.includes('@')) throw new Error('Google account email is required')

  const existing = await sql<{ id: string; email: string }[]>`
    SELECT id, email FROM users WHERE email = ${normalized} LIMIT 1
  `
  if (existing[0]) {
    const memberships = await sql<{ workspace_id: string; name: string }[]>`
      SELECT wm.workspace_id, w.name
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ${existing[0].id}
      ORDER BY w.created_at ASC
      LIMIT 1
    `
    const membership = memberships[0]
    if (!membership) throw new Error('Account has no workspace')
    return createSession(
      config,
      { id: existing[0].id, email: existing[0].email },
      membership.workspace_id,
      membership.name
    )
  }

  const userId = `user_${randomUUID().replace(/-/g, '')}`
  const workspaceId = `ws_${randomUUID().replace(/-/g, '')}`
  const now = Date.now()
  const workspaceName = `${normalized.split('@')[0]}'s workspace`
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (id, email, password_hash, auth_provider, created_at)
      VALUES (${userId}, ${normalized}, ${null}, ${'google'}, ${now})
    `
    await tx`
      INSERT INTO workspaces (id, name, created_at)
      VALUES (${workspaceId}, ${workspaceName}, ${now})
    `
    await tx`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')
    `
  })
  return createSession(config, { id: userId, email: normalized }, workspaceId, workspaceName)
}

async function createSession(
  config: GatewayConfig,
  user: GatewayUser,
  workspaceId: string,
  workspaceName: string
): Promise<GatewaySession> {
  const sql = getSql(config)
  const raw = randomBytes(32).toString('base64url')
  const id = `sess_${randomUUID().replace(/-/g, '')}`
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  await sql`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (${id}, ${user.id}, ${hashToken(raw)}, ${expiresAt}, ${now})
  `
  return { user, workspaceId, workspaceName, sessionToken: raw, expiresAt }
}

export async function destroySession(config: GatewayConfig, sessionToken: string): Promise<void> {
  if (!sessionToken) return
  const sql = getSql(config)
  await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(sessionToken)}`
}

export async function getSession(
  config: GatewayConfig,
  sessionToken: string | null
): Promise<Omit<GatewaySession, 'sessionToken'> | null> {
  if (!sessionToken) return null
  const sql = getSql(config)
  const now = Date.now()
  const rows = await sql<
    { user_id: string; email: string; workspace_id: string; workspace_name: string; expires_at: number }[]
  >`
    SELECT s.user_id, u.email, wm.workspace_id, w.name AS workspace_name, s.expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN workspace_members wm ON wm.user_id = u.id
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE s.token_hash = ${hashToken(sessionToken)} AND s.expires_at > ${now}
    ORDER BY w.created_at ASC
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    user: { id: row.user_id, email: row.email },
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    // postgres.js may return bigint columns as string
    expiresAt: Number(row.expires_at)
  }
}

export function sessionTokenFromRequest(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? ''
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim()
    return token || null
  }
  return null
}
