# Aleph Connector local-first — design

Date: 2026-11-25. Status: design for the approved direction (user proposal).

## Intent

Turn Aleph Connector from a cloud-managed MCP (OAuth gateway + account + WSS to cloud) into a
local-first, no-account MCP for AutoCAD: one Windows app, one local runtime, the user's own AI
agent (Claude, Codex, Antigravity, Cursor, VS Code) connects over loopback. A non-programmer
installs an EXE, opens AutoCAD, presses Connect, and draws. Aleph Connector ships no model.

## Goals

- No Aleph account, no OAuth, no gateway, no PostgreSQL, no internet required for CAD work.
- One Bun process on 127.0.0.1 serves /mcp (Streamable HTTP), /device (Bridge WSS), /health.
- Keep the Windows Bridge (C#) and AutoCAD plugin unchanged in protocol; only their dial target
  and credential provisioning change.
- Desktop app launches/manages the local runtime, detects AutoCAD + agents, writes agent MCP
  configs safely (backup, merge, never clobber a broken file), installs plugin, ships skills.
- Revision-bound local CAD State on SQLite (bun:sqlite): snapshot index feeding
  inspect_floorplan / PCCC overlays; stale revision never served as current.
- Codex gets a real [mcp_servers."aleph-connector"] TOML entry; Claude Desktop gets a bundled
  stdio exe, not npx mcp-remote.

## Non-goals (this design)

- No installer/MSI pipeline changes, no updater channel changes (Phase 3 plan).
- No relicensing/public release work (Phase 4 plan; LICENSE stays proprietary until then).
- No remote/cloud agents; only agents executing MCP on the same Windows machine.
- No rewrite of Bridge or plugin; no removal of the loopback WSS leg yet.

## Constraints

- Preserve: typed allowlisted ops, idempotencyKey/expectedRevision, document-scoped
  serialization, commit-vs-verify truth, 14 semantic tools, DocumentPin per session.
- "Socket reachability is never authorization": the Bridge still presents an ABT device
  credential on /device; the local runtime is its issuer.
- Loopback only: bind 127.0.0.1, validate Host (loopback names only) and Origin
  (absent or loopback) to blunt DNS rebinding and drive-by browser POSTs.

## Architecture (target)

```
Agent (Claude/Codex/Antigravity/Cursor/VS Code)
   |  MCP Streamable HTTP (no auth) or bundled stdio exe
   v
Local runtime (Bun, 127.0.0.1:PORT)         <- launched/managed by Tauri app
   /mcp     MCP tools (same 14 tools)
   /device  Bridge WSS, ABT device credential (locally minted, identity.json)
   /health  runtime status
   |
Windows Bridge (C#, unchanged protocol) -> named pipe -> AutoCAD plugin -> DWG
```

### Identity (local trust, replaces OAuth)

- packages/identity keeps ABT/device/grants; mcp-oauth/* and scopes.ts are deleted with
  apps/gateway.
- The runtime owns a local secret + grant file + stable deviceId under
  %LOCALAPPDATA%\CadAI\connector\ (dev fallback: repo .local/state). On startup it
  first-claims a grant for the deviceId and writes bridge\identity.json (the file the Bridge
  already reads). This is the dev tier (configureDevIdentity) promoted to the default; the
  Postgres tier and ALEPH_DEV_IDENTITY flag are removed.
- MCP requests carry a fixed local caller (workspaceId='local', userId='local') and the
  deviceId from local custody. No bearer gate on /mcp; the loopback + Host/Origin guard is
  the transport protection, the app-level approval (read-only default, edit toggle) is the
  product protection (Phase 2 UI).

### CAD State (SQLite)

- packages/data: LocalDataStore implements AlephConnectorDataStore on bun:sqlite
  (documents, snapshots, snapshot_entities, edit_approvals, symbol_catalog).
- packages/cad-state: LocalCadStateService implements CadStateService — a snapshot answers
  only when its revision equals the live revision.
- The MCP server builds snapshots itself on demand: createCadStateSource.snapshotFor misses
  trigger a paged cad.scan (2000/page, bounded total) written as a snapshot for that exact
  revision. No run-engine.

### Desktop app

- Tauri launches the compiled sidecar (bun build --compile -> aleph-mcp.exe, bundled as a
  Tauri resource; dev mode may spawn bun run src/index.ts), exposes start/stop/status,
  health-polls /health.
- Install Bridge passes -GatewayUrl ws://127.0.0.1:PORT/device (install.ps1 already accepts
  it; Bridge reads CADAI_GATEWAY_URL/config.json — no C# change).
- mcp_config.rs: Codex writes a real TOML block (backup first, replace own block only);
  Claude Desktop writes {command: <install-dir>\aleph-mcp-stdio.exe} (compiled stdio-proxy,
  token requirement removed); JSON writers keep merge semantics and refuse to overwrite a file
  that fails to parse.
- Frontend: login/session/deep-link OAuth flow deleted; screens = Runtime, AutoCAD, Agents, Logs.

## Decisions (my calls)

- Keep default port 8080 (MCP_AUTOCAD_PORT); the app may override when spawning the sidecar.
- Keep loopback WSS (/device) in v1; named-pipe consolidation is a later step.
- Device credential TTL long (400 days) locally; rotation = re-mint, grant generation bump
  invalidates the old token (existing semantics).
- Symbol catalog stays empty locally; PCCC tools already fall back to drawing blocks.
- Phases 3 (installer) and 4 (open-source) get separate plans; this design's plan covers
  Phase 1 (local runtime + CAD State) and Phase 2 (desktop integration).

## Verification

- bun test green; new tests: loopback guard (Host/Origin reject), local identity mint->Bridge
  auth->execute, LocalDataStore/CadStateService revision invalidation, snapshot builder over
  MockBridgeClient, Codex TOML writer (backup, replace-own, refuse-broken).
- bun run smoke still passes (no auth path touched).
- Live lane (e2e:live) drops the OAuth step and proves: no internet, no account, real AutoCAD
  read/write through the local runtime.
