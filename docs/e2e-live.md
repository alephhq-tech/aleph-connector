# Live AutoCAD E2E lane

`bun run e2e:live` drives the **full stack with no mocks**:

```text
MCP client → Remote MCP Server (apps/mcp-server)
           → embedded Device Gateway (WSS /device)
           → installed CadAI connector (Windows service)
           → named pipe → AutoCAD plugin
           → a real AutoCAD document
```

The headless suite (`bun test`, 842 tests) proves the server's logic against `MockBridgeClient`.
This lane proves the same tool calls against the real plugin — the part a mock can never show:
actual AutoCAD geometry behaviour, the WSS transport, the connector's named-pipe framing, the
document lock/transaction/undo machinery, and real error codes on real drawings.

## Prerequisites

Checked by `windows/scripts/e2e-live-doctor.ps1` (the lane runs it first and aborts if anything is
missing):

| Requirement | Why |
|---|---|
| AutoCAD 2021–2026 installed | the live target |
| `AcMgd.dll`/`AcDbMgd.dll` from an AutoCAD 2021–2024 dir | builds the net48 plugin generation (2025+ needs none) |
| CadAI connector installed (`%ProgramData%\CadAI\Bridge`, `CadAI Bridge` scheduled task) | the WSS dialer / pipe host |
| Plugin bundle installed (`%APPDATA%\Autodesk\ApplicationPlugins\CadAI.bundle`) | what AutoCAD loads |
| `CADAI_GATEWAY_URL` → `ws://127.0.0.1:8080/device` | connector must dial **this** server |
| `JWT_SECRET` (16+ chars) in `apps/mcp-server/.env` | signs and verifies the dev credential |
| repo train == installed train | so the lane tests the code in this checkout |

## Run it

```powershell
cd apps\mcp-server
bun run e2e:live                 # doctor → server → credential → bridge → scratch → harness → teardown
bun run e2e:live --refresh       # also rebuild + deploy connector and plugin from this tree first
bun run e2e:live --launch-autocad  # start AutoCAD if none is running (needs an interactive desktop)
bun run e2e:live --only drawing  # one tool group
bun run e2e:live --doctor-only   # just check the machine
```

Run **from `apps/mcp-server`**: Bun loads `.env` relative to the process CWD, so that is where
`JWT_SECRET` comes from. The report lands in `apps/mcp-server/e2e-live-report.json` (add
`--report-out` to move it).

What the lane automates, in order:

1. **Doctor** — read-only preflight; aborts on any missing prerequisite.
2. **Server** — starts `src/index.ts` with `ALEPH_DEV_IDENTITY=1` and waits for `/health`.
3. **Device credential** — `scripts/mint-dev-credential.ts` first-claims a grant for the connector's
   `deviceId` and writes it to `%LOCALAPPDATA%\CadAI\bridge\identity.json` (WSS `/device` only).
4. **MCP OAuth** — `scripts/oauth-access-token.ts` completes authorization_code + PKCE against the
   local AS and returns an access_token for `/mcp` (device ABTs are rejected on MCP).
5. **Bridge restart** — `schtasks /End` then `/Run` on `CadAI Bridge`, then waits for
   `health.json` to report `pluginLoaded && ipcConnected && bridgeOnline`.
6. **Scratch** — `scripts/prep-scratch.ts` opens/creates the harness's scratch drawing and activates
   it (the harness refuses to run unless the active document is exactly its scratch name).
7. **Harness** — `scripts/e2e-autocad.ts` runs every scenario through `@modelcontextprotocol/client`;
   scratch closed and server stopped afterwards.

## Auth model (OAuth MCP + device ABT)

- **MCP `/mcp`**: OAuth 2.1 authorization_code + PKCE (S256). Interactive login goes through
  Aleph Portal (`ALEPH_PORTAL_URL`, production `https://portal.alephhq.tech`) — consent at
  `/oauth/consent`, then portal calls mcp-server `POST /oauth/portal/approve` with shared
  `PORTAL_APPROVE_SECRET`. Same path locally and in production. No static API token and no env
  fake users.
- **Device `/device`**: separate ABT credential in `identity.json` (HMAC
  `${JWT_SECRET}:autocad-bridge-token`). Production / portal pairing writes Postgres
  `device_grants` (see `apps/portal`). The live e2e lane opts into `ALEPH_DEV_IDENTITY=1` and
  file-backed grants in `apps/mcp-server/.aleph-dev/device-grants.json`. MCP access tokens cannot
  dial `/device`; device ABTs cannot call `/mcp`.

`bun run mint:dev-credential` mints the **device** credential only (dev lane).
`bun run oauth:access-token` obtains an MCP OAuth access_token for the live lane (PKCE via
`/oauth/dev/code`, only when `ALEPH_DEV_IDENTITY=1`). For the interactive portal path, run
`apps/portal` with matching `JWT_SECRET` / `PORTAL_APPROVE_SECRET` / `DATABASE_URL`.

## Safety properties kept from the harness

- **Never touches an operator's drawing.** `assertScratchDocument` aborts the run if the active
  AutoCAD document is not the lane's scratch file; the scratch is created under a fresh temp folder
  and closed with `save:false` at teardown.
- **Refuses rather than guesses.** No `blockReference` coverage unless the block exists in the scratch
  drawing (`--block-name`), and `operations:undo-stack-diverged` stays skipped — it needs a human
  AutoCAD command between apply and undo.
- **net48 cannot hot-swap.** With AutoCAD open, `refresh-dev-client.ps1` reports "built but NOT
  deployed"; close and reopen AutoCAD (never force-kill `acad.exe` on an unsaved drawing).
- **The bridge's repair source matters.** `refresh-dev-client.ps1` deploys to both the installed
  bundle and `%ProgramData%\CadAI\Bridge\CadAI.bundle`, because `PluginRecoveryService` copies the
  source bundle over the installed one whenever their manifests differ — skipping it silently reverts
  the deployed train.

## CI

Not wired: a GitHub-hosted runner has neither AutoCAD nor a desktop session, and a modal AutoCAD
dialog (license, Drawing Recovery Manager) can hold the main thread indefinitely. This lane is a
self-hosted Windows runner / on-demand operator lane. What CI *can* run today is the contract parity
already in the repo: `pluginInvariants.test.ts`, `preimage-fingerprint-parity.test.ts`,
`windows/generated/csharp.Tests`, and the protocol fixture validator.
