# Aleph Connector Local-First Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cloud OAuth/Postgres identity of `apps/mcp-server` with a local-first runtime (loopback guard + locally minted ABT device credential + SQLite CAD State), and cut the Tauri app over from login/pairing to managing that local runtime.

**Architecture:** One Bun process on 127.0.0.1 keeps serving `/mcp` + `/device` + `/health` (unchanged protocol). Identity custody moves from Aleph Gateway to a local secret/grant/identity file the runtime owns. CAD State moves from "not configured" to bun:sqlite with revision-bound snapshots built on demand from `cad.scan`. The Tauri app spawns/monitors the runtime sidecar and writes agent configs pointing at loopback.

**Tech Stack:** Bun 1.4 (bun:sqlite), TypeScript, @modelcontextprotocol/server, Tauri v2 (Rust), React.

**Spec:** `docs/specs/2026-11-25-local-first-connector-design.md`

## Global Constraints

- Bind 127.0.0.1 only; every HTTP request must pass the loopback Host/Origin guard.
- The Bridge still authenticates on `/device` with an ABT device credential ("socket reachability is never authorization").
- The 14 semantic tools, `operations` batch semantics, `idempotencyKey`/`expectedRevision`, DocumentPin: untouched.
- No changes to `windows/connector` (C# Bridge) or `windows/autocad-plugin`.
- `bun test` and `bun run typecheck` green after every task; `cargo test` green after Rust tasks.
- Commit per task with `commit.draft()` (never `git add -A`).

## Review Focus

- A non-loopback `Host:` (DNS rebinding) or cross-origin browser `Origin:` must get 403, never reach MCP or `/device`.
- A stale snapshot (revision changed) must never answer `resolveAccess` with `mayUseForCurrentFacts:true`.
- Rewriting an agent config that is malformed JSON/TOML must not clobber the user's file; own-entry rewrites must be idempotent.
- The runtime must survive restart: same deviceId, fresh token, old token rejected after re-mint (grant generation bump).
- `/mcp` with no Authorization header must work; a leftover `Authorization: Bearer <garbage>` header must be ignored, not rejected.

---

### Task 1: Local runtime identity + loopback guard

**Review:** per-task — authentication/security

**Files:**
- Create: `apps/mcp-server/src/local/runtimeIdentity.ts`, `apps/mcp-server/src/local/bridgeToken.ts`, `apps/mcp-server/src/local/loopbackGuard.ts`
- Test: `apps/mcp-server/src/local/loopbackGuard.test.ts`, `apps/mcp-server/src/local/runtimeIdentity.test.ts`
- Modify: `apps/mcp-server/src/app.ts`, `apps/mcp-server/src/config.ts`, `apps/mcp-server/src/index.ts`

**Interfaces:**
- Consumes: `configureIdentity`, `AbtTokenService`, `MutableDeviceGrantStore` from `@aleph-connector/identity` (unchanged).
- Produces:
  - `configureLocalRuntime(env: NodeJS.ProcessEnv, log: Logger): LocalRuntimeContext` where `LocalRuntimeContext = { deviceId: string; caller: { workspaceId: string; userId: string } }` — installs the ABT credential service + JSON grant store, first-claims the grant, mints a 400-day token, writes `identity.json` for the Bridge.
  - `guardLoopback(request: Request): Response | null` — 403 JSON `{ error: 'loopback_only', reason }` when Host or Origin is not loopback.
  - `createApp(config: McpServerConfig, ctx: LocalRuntimeContext): McpServerApp` (signature change from `createApp(config)`).
  - `McpServerConfig` loses `jwtSecret`, `gatewayIssuerUrl`, `resourceUrl`; keeps `port`, `mcpPath`, `publicUrl`, `gateway`.

- [ ] **Step 1: Failing test — loopback guard.** In `loopbackGuard.test.ts`: `guardLoopback` returns null for Host `127.0.0.1:8080`, `localhost:8080`, `[::1]:8080`, and for missing Origin; returns a 403 Response for Host `evil.example.com`, for Origin `http://evil.example`, and for Host `alephhq.tech`. Build Requests with explicit `Host` headers via `new Request('http://127.0.0.1:8080/mcp', { headers: { host: ... } })`.
- [ ] **Step 2: Run — expect FAIL (module missing).** `bun test apps/mcp-server/src/local/loopbackGuard.test.ts`
- [ ] **Step 3: Implement `loopbackGuard.ts`.** Loopback hostnames: `127.0.0.1`, `localhost`, `::1` (strip port, strip brackets). Origin checked via `new URL(origin).hostname`. Export `guardLoopback`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Failing test — runtime identity.** In `runtimeIdentity.test.ts` with `ALEPH_LOCAL_STATE_DIR` pointed at a temp dir: first `configureLocalRuntime` creates `runtime-secret.json`, `device-grants.json`, and `identity.json` (path `ALEPH_LOCAL_IDENTITY_PATH` override) with `{deviceId, token, tokenExpiresAt}`; second call reuses the same `deviceId`; `deviceCredentialService.verify(token)` returns ok with `payload.deviceId === ctx.deviceId`; `validateDeviceGrant(ctx.deviceId, 'local', 'local')` is true; `ctx.caller` is `{ workspaceId: 'local', userId: 'local' }`. On Windows default paths: when `LOCALAPPDATA` is unset and no override env, fall back to `<repo>/.local/state/` (derive from module URL like `defaultDevGrantFile` does).
- [ ] **Step 6: Run — expect FAIL.**
- [ ] **Step 7: Implement.** Move `JsonFileGrantStore` + `DevBridgeTokenService` from `src/dev/bridgeToken.ts` into `src/local/bridgeToken.ts` (rename service to `LocalBridgeTokenService`, keep semantics). `runtimeIdentity.ts`: resolve `stateDir` = `ALEPH_LOCAL_STATE_DIR` ?? `%LOCALAPPDATA%/CadAI/connector` ?? module-derived `.local/state`; secret = `JWT_SECRET` env override else read/create `runtime-secret.json` (32-byte hex, `mkdirSync` parent); deviceId = existing `identity.json` deviceId else `device_<uuid-nodash>`; grants = `JsonFileGrantStore(stateDir/device-grants.json)`; `configureIdentity({ credentialService: new LocalBridgeTokenService(secret, grants), grantStore: grants })`; mint with ttl `400*86400`; write `identity.json` (path = `ALEPH_LOCAL_IDENTITY_PATH` ?? `%LOCALAPPDATA%/CadAI/bridge/identity.json` ?? `.local/state/identity.json`).
- [ ] **Step 8: Run — expect PASS.**
- [ ] **Step 9: Cut over `app.ts`/`config.ts`/`index.ts`.** Remove `requireBearerAuth`, `McpAccessTokenVerifier`, `MCP_SCOPES`, `/.well-known/*` handlers, `authGate`. `fetch` starts with `const blocked = guardLoopback(request); if (blocked) return blocked`. `/mcp` branch: `return mcpHandler.fetch(request, {})`. `createApp(config, ctx)` builds `DeviceGatewayBridgeClient(gateway, ctx.deviceId, ctx.caller)` and `createServer(bridge, gateway, ctx.deviceId, ctx.caller.workspaceId)`. `/health` returns `auth: 'local'` and `deviceId`. `config.ts`: drop `jwtSecret`/`gatewayIssuerUrl`/`resourceUrl` fields and their env parsing. `index.ts`: `const ctx = configureLocalRuntime(process.env, log)` before `createApp(config, ctx)`.
- [ ] **Step 10: `bun run typecheck`** — expect errors only in files deleted by Task 2 (`src/auth/*`, `src/dev/*`, `src/db/sql.ts`); delete those three directories now as part of this task's cutover (they have no remaining importers after Step 9), then typecheck clean. Update `apps/mcp-server/package.json` scripts: remove `oauth:access-token`, `db:migrate`, `mint:dev-credential`, `gen:jwt-secret`.
- [ ] **Step 11: `bun test` full + `bun run smoke`** — expect PASS (smoke never used the auth path).
- [ ] **Step 12: Commit** `feat(mcp-server): local runtime identity and loopback guard replace OAuth gate`.

### Task 2: Delete cloud identity (gateway, OAuth, Postgres)

**Files:**
- Delete: `apps/gateway/` (whole app), `packages/identity/src/mcp-oauth/` (jwt.ts, server.ts, store.ts + tests), `packages/identity/src/scopes.ts`, `apps/mcp-server/src/db/sql.ts`, `apps/mcp-server/src/dev/` (bridgeToken.test.ts, configureDevIdentity.ts), `apps/mcp-server/scripts/oauth-access-token.ts`, `apps/mcp-server/scripts/migrate.ts`, `apps/mcp-server/scripts/gen-jwt-secret.ts`, `apps/mcp-server/scripts/mint-dev-credential.ts`
- Modify: `packages/identity/src/index.ts` (drop mcp-oauth + scopes exports), `packages/identity/src/grants.ts` (drop `PostgresDeviceGrantStore` + `SqlExecutor`), `packages/identity/package.json`, `apps/mcp-server/package.json` (drop `postgres` dep), `apps/mcp-server/.env.example`, `tsconfig.json` (drop gateway ref), `docs/architecture.md`, `README.md`, `docs/extraction-map.md` (append a "local-first cutover" note)

**Interfaces:**
- Consumes: Task 1 removed all importers of the deleted modules.
- Produces: `@aleph-connector/identity` exports only device/ABT/grants (Memory + file stores).

- [ ] **Step 1: `grep -rn "mcp-oauth\|MCP_SCOPES\|PostgresDeviceGrantStore\|apps/gateway" apps packages --include="*.ts"`** — confirm zero importers outside the delete list; fix any stragglers first.
- [ ] **Step 2: Delete the files above; prune identity/index.ts and grants.ts.**
- [ ] **Step 3: Rewrite `apps/mcp-server/.env.example`** to local shape: `MCP_AUTOCAD_PORT`, `MCP_PATH`, `ALEPH_LOCAL_STATE_DIR`, `ALEPH_LOCAL_IDENTITY_PATH`, `DEVICE_GATEWAY_*`, `LOG_LEVEL`.
- [ ] **Step 4: `bun run typecheck && bun test`** — PASS.
- [ ] **Step 5: Update `docs/architecture.md`** runtime-boundary mermaid + Identity model section to the local-first shape (no OAuth AS, local ABT custody, loopback guard invariant).
- [ ] **Step 6: Commit** `feat: remove cloud gateway, OAuth, and Postgres identity tiers`.

### Task 3: SQLite CAD State + on-demand snapshot builder

**Review:** per-task — persisted format

**Files:**
- Create: `packages/data/src/local.ts`, `packages/cad-state/src/local.ts`, `apps/mcp-server/src/local/snapshotBuilder.ts`, tests `packages/data/src/local.test.ts`, `packages/cad-state/src/local.test.ts`, `apps/mcp-server/src/local/snapshotBuilder.test.ts`
- Modify: `packages/data/src/index.ts` (export local), `packages/cad-state/src/index.ts` (export local), `apps/mcp-server/src/tools/drawing.ts` (`createCadStateSource` gains optional `snapshotFor` builder hook), `apps/mcp-server/src/index.ts` (wire stores at startup)

**Interfaces:**
- Consumes: `AlephConnectorDataStore`, `CadStateService`, `configureDataStore`, `configureCadStateService` (existing seams); `RpcMethod.CadScan` via `BridgeClient`.
- Produces:
  - `openLocalStore(dbPath: string): { data: LocalDataStore; cadState: LocalCadStateService; close(): void }` in `packages/data/src/local.ts` (single bun:sqlite `Database`, WAL, schema created on open: tables `cad_documents`, `cad_snapshots`, `cad_snapshot_entities`, `edit_approvals`, `cad_symbol_catalog`).
  - `LocalDataStore implements AlephConnectorDataStore` plus `insertSnapshotEntities(snapshotId: string, rows: CadSnapshotEntity[]): void` and `snapshotEntityCount(snapshotId: string): number`.
  - `LocalCadStateService implements CadStateService` plus `recordSnapshot(workspaceId: string, drawingId: string, revision: string): string` (returns `snap_<uuid>`, replaces prior snapshot for the same drawing) and `snapshotForRevision(workspaceId, drawingId, revision): string | null`.
  - `buildSnapshot(bridge: BridgeClient, store: { cadState: LocalCadStateService; data: LocalDataStore }, workspaceId: string, identity: { documentId?: string; documentName?: string; fingerprintGuid?: string; revision: string }): Promise<string | null>` in `apps/mcp-server/src/local/snapshotBuilder.ts` — pages `cad.scan` (`detail:'full'`, 2000/page, cap 10 000 rows), requires `revisionBefore === revisionAfter === identity.revision`, registers the document row, writes entities, returns snapshotId; null when identity lacks revision or the scan revision moved.
  - `createCadStateSource(workspaceId, bridge, buildOnMiss?: (identity) => Promise<string | null>)` — `snapshotFor` falls back to `buildOnMiss` then re-queries `resolveAccess`.
- [ ] **Step 1: Failing test `packages/data/src/local.test.ts`** — temp file db: `insertSnapshotEntities` + `cadSnapshotEntities.query(snapshotId, {window: null, limit})` round-trips handle/kind/layer/blockName/geometry; `cadSymbolCatalog.insert/findByKey` returns only `status:'approved'`; `editApprovals` consume-token state machine matches `InMemoryDataStore` semantics (reuse the same assertions as the in-memory parity comment).
- [ ] **Step 2: Run — FAIL. Step 3: Implement `local.ts`** (bun:sqlite, prepared statements; geometry stored as JSON text; `window` currently unused by query — accept and ignore like the in-memory tier).
- [ ] **Step 4: Failing test `packages/cad-state/src/local.test.ts`** — `recordSnapshot(ws,d,rev1)` then `resolveAccess(ws,d,rev1)` → `{snapshot:{id}, mayUseForCurrentFacts:true}`; `resolveAccess(ws,d,rev2)` → null; a second `recordSnapshot` for the same drawing replaces the old snapshot (old id no longer resolves).
- [ ] **Step 5: Run — FAIL. Step 6: Implement `LocalCadStateService`** (shares the `cad_snapshots` table from `openLocalStore`).
- [ ] **Step 7: Failing test `snapshotBuilder.test.ts`** against `MockBridgeClient`: build returns a snapshotId; `cadState.resolveAccess` at the mock's live revision answers fresh; after a mock write bumps the revision, `resolveAccess` at the old revision returns null; `data.cadSnapshotEntities.query` returns the scanned entities.
- [ ] **Step 8: Run — FAIL. Step 9: Implement `snapshotBuilder.ts`** (page loop mirroring `createCadStateSource.scanLayout`: offset stepping by page size, stop at `total` or cap; abort → null when `revisionBefore !== revisionAfter`).
- [ ] **Step 10: Wire:** `apps/mcp-server/src/index.ts` calls `openLocalStore(stateDir/cad-state.db)`, `configureDataStore(data)`, `configureCadStateService(cadState)`; `server.ts`/`tools/index.ts` pass `buildOnMiss = (identity) => identity.revision ? buildSnapshot(bridge, store, workspaceId, identity) : null` into `createCadStateSource`. `drawing.ts` `snapshotFor`: on `!access` or missing snapshot, call `buildOnMiss`, then re-run the `resolveAccess` lookup once.
- [ ] **Step 11: `bun test` full + `bun run smoke`** — PASS.
- [ ] **Step 12: Commit** `feat: revision-bound SQLite CAD State with on-demand snapshot builder`.

### Task 4: Tauri runtime sidecar management

**Files:**
- Create: `windows/connector-app/src-tauri/src/runtime.rs`
- Modify: `windows/connector-app/src-tauri/src/lib.rs` (register commands, drop session commands), `windows/connector-app/src-tauri/src/identity.rs` (delete `AuthSession`/`AuthUser`/session fns; keep `read_identity_file`), `windows/connector-app/src-tauri/tauri.conf.json` (resources), `windows/connector-app/src-tauri/capabilities/default.json` (no new perms needed — spawn via std::process, not shell plugin)
- Test: `cargo test` unit tests inside `runtime.rs` (sidecar path resolution, URL building)

**Interfaces:**
- Produces Tauri commands: `start_runtime(port: Option<u16>) -> Result<RuntimeStatus, String>`, `stop_runtime() -> Result<RuntimeStatus, String>`, `runtime_status() -> RuntimeStatus` where `RuntimeStatus { running: bool, port: u16, mcp_url: String, device_wss_url: String, healthy: bool }` (healthy = GET `http://127.0.0.1:{port}/health` ok, via ureq, 1 s timeout).
- Sidecar resolution order: env `ALEPH_MCP_SIDECAR` → `<resource_dir>/aleph-mcp.exe` → walk-up (pattern from `install.rs:9-27`) for `apps/mcp-server/src/index.ts` (dev: spawn `bun run src/index.ts` with cwd there).
- `default_urls()` in `lib.rs` returns `(gateway_url removed) mcp_url` only: `http://127.0.0.1:{port}/mcp` from the live `RuntimeStatus`.
- Consumes: `install_autocad` keeps its signature; the frontend now passes `device_wss_url` from `RuntimeStatus`.

- [ ] **Step 1: Failing unit test** in `runtime.rs`: `resolve_sidecar()` with `ALEPH_MCP_SIDECAR` set returns that path; `device_wss_url(port)` == `ws://127.0.0.1:{port}/device`; `mcp_url(port)` == `http://127.0.0.1:{port}/mcp`. `cargo test` in `src-tauri` — FAIL (module missing).
- [ ] **Step 2: Implement `runtime.rs`**: `static RUNTIME: OnceLock<Mutex<Option<Child>>>`; `start_runtime` spawns sidecar with env `MCP_AUTOCAD_PORT`, `ALEPH_LOCAL_STATE_DIR` (default `%LOCALAPPDATA%/CadAI/connector`), CREATE_NO_WINDOW; `stop_runtime` `child.kill()`; `runtime_status` checks `try_wait()`.
- [ ] **Step 3: `cargo test` PASS.**
- [ ] **Step 4: lib.rs:** add `mod runtime;`, register the 3 commands; delete `save_session`/`load_session`/`clear_session`/`ensure_device_id`/`write_identity` commands (runtime owns identity.json now); `default_urls` returns only the mcp url. Delete `AuthSession` code from `identity.rs`.
- [ ] **Step 5: `cargo check` + `cargo test` PASS.**
- [ ] **Step 6: Root `package.json`:** add `"build:runtime": "bun build --compile apps/mcp-server/src/index.ts --outfile windows/connector-app/src-tauri/binaries/aleph-mcp.exe"`; `tauri.conf.json` bundle gets `"resources": ["binaries/aleph-mcp.exe"]`. Run `bun run build:runtime` once to prove it compiles (bun:sqlite bundles fine).
- [ ] **Step 7: Commit** `feat(connector-app): manage the local MCP runtime sidecar`.

### Task 5: Agent config writer — real Codex TOML, bundled stdio, backup safety

**Review:** per-task — destructive file writes

**Files:**
- Modify: `windows/connector-app/src-tauri/src/mcp_config.rs`, `windows/connector-app/src-tauri/src/lib.rs` (`write_mcp_config` gains `stdio_exe: Option<String>` arg)
- Test: `#[cfg(test)]` module in `mcp_config.rs` (tempdir-based)

**Interfaces:**
- Produces: `write_mcp_config(kind, config_path, mcp_url, stdio_exe: Option<&str>)`.
  - `codexCli` → real TOML: removes any existing `[mcp_servers."aleph-connector"]` block (header line through the next `[` header or EOF), appends `[mcp_servers."aleph-connector"]\nurl = "{mcp_url}"\n`; refuses (Err) if the file contains an `[mcp_servers.` header it cannot delimit (unclosed quoted key) — never writes on parse doubt.
  - `claudeDesktop` → `mcpServers.aleph-connector = { "command": stdio_exe.expect(...) }` (Err when `stdio_exe` is None); no `npx`.
  - All JSON writers: `read_object` returns Err when the file exists, is non-empty, and fails to parse (currently silently clobbers).
  - Every writer: before first write, copy existing file to `<path>.bak` (overwrite allowed on re-run).
- [ ] **Step 1: Failing tests** (tempdir): codex writer on a fresh file appends the block; on a file with an existing own block (plus a foreign `[mcp_servers.other]`) replaces only the own block and keeps the foreign one; re-run is idempotent (one block); `.bak` created with the original bytes; claudeDesktop writes `command` = given exe and errors without one; a malformed JSON config file returns Err and leaves the file byte-identical.
- [ ] **Step 2: `cargo test` FAIL. Step 3: Implement** (line-based TOML edit; header regex `^\s*\[\s*mcp_servers\s*\.\s*"aleph-connector"\s*\]\s*$`).
- [ ] **Step 4: `cargo test` PASS.**
- [ ] **Step 5: `stdio-proxy.ts`:** drop the `AUTOCAD_MCP_TOKEN` requirement (local server has no bearer gate); keep `AUTOCAD_MCP_URL`. Add root script `build:stdio": "bun build --compile apps/mcp-server/src/stdio-proxy.ts --outfile windows/connector-app/src-tauri/binaries/aleph-mcp-stdio.exe"` and add it to `tauri.conf.json` resources.
- [ ] **Step 6: Commit** `fix(connector-app): real Codex TOML entries, bundled stdio exe, config backup safety`.

### Task 6: Frontend cutover — no login, runtime-first screens

**Files:**
- Modify: `windows/connector-app/src/App.tsx`, `windows/connector-app/src/api.ts`, `windows/connector-app/src/styles.css`
- Delete: OAuth deep-link handling, session state, Google/email sign-in UI

**Interfaces:** Consumes Task 4 commands (`start_runtime`, `stop_runtime`, `runtime_status`) and Task 5's `write_mcp_config(kind, configPath, mcpUrl, stdioExe)`.

- [ ] **Step 1: Delete** `api.ts` `signUp`/`signIn`/`pairDevice`/`approveOAuth`/`googleStartUrl`; delete session gate, `completePair`, `handleDeepLink`, `onAuth`/`onGoogle`/`onSignOut`, Account screen's Gateway/MCP URL inputs.
- [ ] **Step 2: New nav** `"runtime" | "autocad" | "agents" | "logs"`. Runtime screen: status badges (Local MCP running/stopped, port, `/health`), Start/Stop/Restart buttons, MCP URL display. AutoCAD screen: keep install/repair/update/uninstall; `install_autocad` receives `device_wss_url` from `runtime_status`. Agents screen: unchanged list; `onInstallPlugin` passes `stdioExe` = `<package_root>/aleph-mcp-stdio.exe` for `claudeDesktop` and `mcpUrl` = `http://127.0.0.1:{port}/mcp` from runtime status. Boot effect: `runtime_status` + `refreshAgents` + `refreshIntegration`.
- [ ] **Step 3: `bun run build` in `windows/connector-app`** (vite build) — PASS; `cargo check` PASS.
- [ ] **Step 4: Commit** `feat(connector-app): local-first UI — runtime control replaces sign-in`.

### Task 7: Live lane without OAuth + docs

**Files:**
- Modify: `apps/mcp-server/scripts/e2e-live.ts`, `apps/mcp-server/scripts/e2e-autocad.ts`, `windows/scripts/e2e-live-doctor.ps1`, `README.md`, `docs/CLIENTS.md`

- [ ] **Step 1: e2e-live.ts:** drop step 4/7 (OAuth token) and the `JWT_SECRET` precondition; the runtime mints its own credential at startup, so drop the mint step too — instead read `deviceId`/token from `identity.json` after server start for the Bridge task restart; `CADAI_E2E_TOKEN` no longer passed to `e2e-autocad.ts`.
- [ ] **Step 2: e2e-autocad.ts:** real mode no longer requires `--token`/`CADAI_E2E_TOKEN`; `connectReal` sends no Authorization header.
- [ ] **Step 3: doctor ps1:** drop JWT_SECRET/gateway checks; assert the sidecar or `bun run src/index.ts` path exists.
- [ ] **Step 4: `bun test` + `bun run smoke` + `bun run typecheck`** — PASS. Run `bun run e2e:live -- --doctor-only` and report its output (full live lane runs only with AutoCAD open; do not launch AutoCAD unasked).
- [ ] **Step 5: Docs:** README product boundary (local-first, no account), CLIENTS.md config examples (loopback URL, bundled stdio exe).
- [ ] **Step 6: Commit** `feat(e2e): live lane runs the local runtime without OAuth`.

---

## Out of scope (next plans)

- Phase 3: EXE/MSI packaging of sidecar + Bridge + plugin bundle, process recovery, updater from GitHub Releases.
- Phase 4: relicensing (Apache-2.0), git-history secret audit, public CI, GitHub Releases.
- Read-only default + edit-approval UI (needs a policy seam in tools; separate design).
