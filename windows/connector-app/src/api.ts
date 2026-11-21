export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthSession {
  sessionToken: string;
  expiresAt: number;
  user: AuthUser;
  workspaceId: string;
  workspaceName: string;
}

export interface DetectedAgent {
  kind: string;
  displayName: string;
  configPath: string;
  present: boolean;
  selected: boolean;
}

interface GatewayAuthResponse {
  sessionToken: string;
  expiresAt: number | string;
  user: { id: string; email: string };
  workspaceId: string;
  workspaceName: string;
}

/** Gateway/Postgres may serialize bigint timestamps as strings. */
export function asEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(`Invalid expiresAt: ${String(value)}`);
}

function mapSession(raw: GatewayAuthResponse): AuthSession {
  return {
    sessionToken: raw.sessionToken,
    expiresAt: asEpochMs(raw.expiresAt),
    user: raw.user,
    workspaceId: raw.workspaceId,
    workspaceName: raw.workspaceName,
  };
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export async function signUp(
  gatewayUrl: string,
  email: string,
  password: string,
): Promise<AuthSession> {
  const raw = await postJson<GatewayAuthResponse>(`${gatewayUrl}/auth/signup`, {
    email,
    password,
  });
  return mapSession(raw);
}

export async function signIn(
  gatewayUrl: string,
  email: string,
  password: string,
): Promise<AuthSession> {
  const raw = await postJson<GatewayAuthResponse>(`${gatewayUrl}/auth/signin`, {
    email,
    password,
  });
  return mapSession(raw);
}

export async function pairDevice(
  gatewayUrl: string,
  sessionToken: string,
  deviceId: string,
): Promise<{ token: string; expiresAt: number; deviceId: string }> {
  return postJson(`${gatewayUrl}/devices/pair`, { deviceId }, sessionToken);
}

export async function approveOAuth(
  gatewayUrl: string,
  sessionToken: string,
  params: Record<string, string>,
): Promise<{ redirect_to: string }> {
  return postJson(`${gatewayUrl}/oauth/session/approve`, params, sessionToken);
}

export function googleStartUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/$/, "")}/auth/google/start`;
}
