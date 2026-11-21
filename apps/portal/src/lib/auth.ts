import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual
} from 'node:crypto'
import { cookies } from 'next/headers'
import { getSql } from './db'

const SESSION_COOKIE = 'aleph_portal_session'
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

export interface PortalUser {
  id: string
  email: string
}

export interface PortalSession {
  user: PortalUser
  workspaceId: string
  workspaceName: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export async function createUserWithWorkspace(email: string, password: string): Promise<PortalSession> {
  const sql = getSql()
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
        INSERT INTO users (id, email, password_hash, created_at)
        VALUES (${userId}, ${normalized}, ${passwordHash}, ${now})
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

  return createSession({ id: userId, email: normalized }, workspaceId, workspaceName)
}

export async function signIn(email: string, password: string): Promise<PortalSession> {
  const sql = getSql()
  const normalized = email.trim().toLowerCase()
  const rows = await sql<
    { id: string; email: string; password_hash: string }[]
  >`SELECT id, email, password_hash FROM users WHERE email = ${normalized} LIMIT 1`
  const row = rows[0]
  if (!row) throw new Error('Invalid email or password')
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
    { id: row.id, email: row.email },
    membership.workspace_id,
    membership.name
  )
}

async function createSession(
  user: PortalUser,
  workspaceId: string,
  workspaceName: string
): Promise<PortalSession> {
  const sql = getSql()
  const raw = randomBytes(32).toString('base64url')
  const id = `sess_${randomUUID().replace(/-/g, '')}`
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  await sql`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (${id}, ${user.id}, ${hashToken(raw)}, ${expiresAt}, ${now})
  `
  const jar = await cookies()
  jar.set(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt)
  })
  return { user, workspaceId, workspaceName }
}

export async function destroySession(): Promise<void> {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value
  if (raw) {
    const sql = getSql()
    await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(raw)}`
  }
  jar.delete(SESSION_COOKIE)
}

export async function getSession(): Promise<PortalSession | null> {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value
  if (!raw) return null
  const sql = getSql()
  const now = Date.now()
  const rows = await sql<
    { user_id: string; email: string; workspace_id: string; workspace_name: string }[]
  >`
    SELECT s.user_id, u.email, wm.workspace_id, w.name AS workspace_name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN workspace_members wm ON wm.user_id = u.id
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE s.token_hash = ${hashToken(raw)} AND s.expires_at > ${now}
    ORDER BY w.created_at ASC
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    user: { id: row.user_id, email: row.email },
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name
  }
}

export async function requireSession(): Promise<PortalSession> {
  const session = await getSession()
  if (!session) throw new Error('Authentication required')
  return session
}
