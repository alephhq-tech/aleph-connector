# Portal

Owns Aleph account onboarding, OAuth consent, device pairing and grants. It does not execute CAD operations.

Production host: **portal.alephhq.tech** (landing stays on alephhq.tech). Local default: `http://127.0.0.1:3000`.

## Setup

```bash
# from repo root
bun install
cp apps/portal/.env.example apps/portal/.env
# set DATABASE_URL, JWT_SECRET, PORTAL_APPROVE_SECRET (same values as mcp-server)

cd apps/portal
bun run db:migrate
bun run dev
```

mcp-server must have matching secrets and:

```env
ALEPH_PORTAL_URL=http://127.0.0.1:3000
PORTAL_APPROVE_SECRET=...
JWT_SECRET=...
DATABASE_URL=postgres://...
```

Without `ALEPH_DEV_IDENTITY=1`, mcp-server uses Postgres `device_grants` (same table portal writes).

## Routes

| Path | Purpose |
|------|---------|
| `/signup`, `/signin` | Email/password account |
| `/` | Workspace home |
| `/oauth/consent` | MCP client consent (redirect target from mcp `/oauth/login`) |
| `/devices`, `/devices/pair` | List/revoke/pair Connector; mint ABT into `identity.json` |

## OAuth flow

1. MCP client → mcp-server `/oauth/authorize`
2. → `/oauth/login` → portal `/oauth/consent?return_to=...`
3. User signs in and Approves
4. Portal `POST {MCP_PUBLIC_URL}/oauth/portal/approve` with `Authorization: Bearer $PORTAL_APPROVE_SECRET`
5. Portal redirects the browser to the client `redirect_uri` with `code`
6. Client exchanges code at `/oauth/token`
