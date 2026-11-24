# Live AutoCAD E2E lane

`bun run e2e:live` drives the **full stack with no mocks**:

```text
MCP client → local runtime (apps/mcp-server, 127.0.0.1)
           → embedded Device Gateway (WSS /device)
           → installed CadAI connector (Windows service)
           → named pipe → AutoCAD plugin
           → a real AutoCAD document
```

The headless suite (`bun test`) proves the server's logic against `MockBridgeClient`.
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
| repo train == installed train | so the lane tests the code in this checkout |

There is no `.env` requirement: the local runtime mints its own device credential at startup
(`%LOCALAPPDATA%\CadAI\connector\runtime-secret.json`, grants in `device-grants.json`) and writes
the connector's `%LOCALAPPDATA%\CadAI\bridge\identity.json` itself.

## Run it

```powershell
cd apps\mcp-server
bun run e2e:live                 # doctor → runtime → bridge → scratch → harness → teardown
bun run e2e:live --refresh       # also rebuild + deploy connector and plugin from this tree first
bun run e2e:live --launch-autocad  # start AutoCAD if none is running (needs an interactive desktop)
bun run e2e:live --only drawing  # one tool group
bun run e2e:live --doctor-only   # just check the machine
```

The report lands in `apps/mcp-server/e2e-live-report.json` (add `--report-out` to move it).

What the lane automates, in order:

1. **Doctor** — read-only preflight; aborts on any missing prerequisite.
2. **Runtime** — starts `src/index.ts` (loopback only) and waits for `/health`. The runtime mints
   or reuses the Bridge device credential and writes the connector `identity.json`.
3. **Bridge restart** — `schtasks /End` then `/Run` on `CadAI Bridge`, then waits for
   `health.json` to report `pluginLoaded && ipcConnected && bridgeOnline`.
4. **Scratch** — `scripts/prep-scratch.ts` opens/creates the harness's scratch drawing and activates
   it (the harness refuses to run unless the active document is exactly its scratch name).
5. **Harness** — `scripts/e2e-autocad.ts` runs every scenario through `@modelcontextprotocol/client`;
   scratch closed and server stopped afterwards.

## Auth model (local trust)

- **MCP `/mcp`**: no credential. The runtime binds `127.0.0.1` and rejects any request whose
  `Host` is not loopback or whose `Origin` is not a loopback origin (DNS-rebinding guard).
  Socket reachability is not authorization — the Bridge still authenticates on `/device`, and
  every dispatch rechecks the live grant generation.
- **Device `/device`**: ABT credential (HMAC, locally minted) in `identity.json`, grants in
  `%LOCALAPPDATA%\CadAI\connector\device-grants.json`. The lane never mints, replaces, or
  restores the connector credential: the runtime owns it.

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
