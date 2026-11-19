# bridge — CadAI.Bridge

The standalone local runtime described in AUTOCAD_MCP_PROJECT.md section 10: a Windows `.NET` process (`CadAI.Bridge.exe`) that sits between the cloud Device Gateway and every running AutoCAD process on this machine.

```
Device Gateway --WSS--> Bridge --Local IPC (named pipe)--> AutoCAD Plugin
```

It has **no AutoCAD dependency** — it never loads `AcMgd`/`AcDbMgd`/`AcCoreMgd`, only speaks WSS to the cloud and JSON-RPC over a named pipe to whatever plugin instances happen to be running. It builds and runs on any machine with the .NET 8 SDK.

## Layout

```
bridge/
  CadAI.Bridge.csproj          net8.0 exe, ProjectReference -> updater
  BridgeConfig.cs               environment-variable configuration
  Program.cs                    entry point: wiring + lifecycle
  Cloud/
    DeviceGatewayClient.cs      WSS client: hello/heartbeat/reconnect/capability.execute
  Device/
    DeviceIdentity.cs           persisted deviceId + token (identity.json)
    AutoCadProcessMonitor.cs    finds acad.exe/acadcore.exe, polls system.status per instance
    CapabilityRegistry.cs       current AutoCadInstance snapshot -> capability.update
  IPC/
    PluginPipeClient.cs         StreamJsonRpc client for one AutoCAD instance's named pipe
    IpcRouter.cs                capability.execute -> pipe call -> capability.result
  Updates/
    UpdateCoordinatorService.cs orchestrates flow_auto_update_version.jpg's Bridge branch
  Diagnostics/
    BridgeLogger.cs             console + rolling-file logging (see "Logging" below)
```

## Configuration (environment variables)

| Variable                         | Required         | Default                                                                                                     | Meaning                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CADAI_GATEWAY_URL`              | **yes**          | —                                                                                                           | Device Gateway WSS endpoint, e.g. `wss://gateway.example.com/device`.                                                                                                                                                                                                   |
| `CADAI_DEVICE_ID`                | no               | persisted                                                                                                   | Development override for the deviceId in `identity.json`; production installs leave it unset — see "Device identity" below.                                                                                                                                             |
| `CADAI_DEVICE_TOKEN`             | no               | persisted                                                                                                   | Development override for the Bridge credential. Production installs leave it unset: a token here outranks `identity.json` and pins one credential to the machine, defeating Desktop's rotation.                                                                         |
| `CADAI_UPDATE_MANIFEST_URL`      | set by installer | — (checks disabled) if unset                                                                                | URL (or `file://` path) of the `ReleaseManifest` JSON the Updater checks. `install.ps1` sets it to the value in `contracts/update-channel.json`; until an operator publishes a signed standalone release the URL 404s and the channel stays dormant.                    |
| `CADAI_BUNDLE_ROOT`              | no               | `%ProgramFiles%\Autodesk\ApplicationPlugins\CadAI.bundle` when populated, else `%APPDATA%\...\CadAI.bundle` | Path to the installed AutoCAD plugin bundle; also where `pending-activation.json` lives (see "Update flow"). AutoCAD only loads it from there once it is in `TRUSTEDPATHS` — see `docs/BRIDGE.md`, "Where the bundle lives".                                            |
| `CADAI_UPDATER_PUBLIC_KEY_PATH`  | set by installer | — (dev key fallback) if unset                                                                               | PEM file with the RSA public key used to verify release signatures. `install.ps1` copies the package's `keys/public.pem` to `%ProgramData%\CadAI\keys\public.pem` and sets this to it. Same variable name updater's own CLI uses — see "Update verification key" below. |
| `CADAI_PROCESS_POLL_INTERVAL_MS` | no               | `2500`                                                                                                      | How often `AutoCadProcessMonitor` re-scans `Process.GetProcessesByName`.                                                                                                                                                                                                |
| `CADAI_HEARTBEAT_INTERVAL_MS`    | no               | `25000`                                                                                                     | How often the Bridge sends `heartbeat`/`ping` to the gateway (gateway default `heartbeatTimeoutMs` is 90s — keep this comfortably under that).                                                                                                                          |
| `CADAI_UPDATE_CHECK_INTERVAL_MS` | no               | `3600000` (1h)                                                                                              | How often `UpdateCoordinatorService` calls `CheckAsync`.                                                                                                                                                                                                                |

## Device identity

The credential this Bridge presents at the WSS upgrade is **minted by Aleph Desktop**, never by the
Bridge itself — only Desktop holds an Aleph Account session that the gateway will accept
(`POST /api/auth/pkce/autocad-bridge-token`):

1. `install.ps1` (run by Desktop's "Cài đặt" button) writes `%LOCALAPPDATA%\CadAI\bridge\identity.json`
   with `deviceId`, `token` and `tokenExpiresAt` (epoch seconds). It sits under the user profile rather
   than `%ProgramData%` because it holds a bearer token.
2. Desktop re-mints that credential on every launch once it is within a day of expiry, and on demand
   from the card's "Gia hạn quyền" button. The Bridge re-reads `identity.json` on every redial, so a
   rotation lands without restarting the daemon (`DeviceGatewayClient.ConnectAsync`).
3. `CADAI_DEVICE_ID`/`CADAI_DEVICE_TOKEN` are the local-development override: they win over the file,
   are folded back into it, and carry no expiry.
4. With no credential from either source the Bridge fails fast at startup — retrying a gateway
   connection can never fix a missing credential, so that is a configuration error, not a
   `DeviceGatewayClient` reconnect-loop concern.

A first run with no `identity.json` and no dev token generates a random `deviceId` and persists it
with a null token, then stops at step 4.

## Update verification key

`UpdateCoordinatorService` constructs `CadAi.Updater.UpdateCoordinator` with an `RSA` public key loaded from `CADAI_UPDATER_PUBLIC_KEY_PATH` if set, or else the checked-in **dev/test-only** key (`updater/Verify/DevPublicKey.cs`) with a loud startup warning — and that fallback only engages when `CADAI_ALLOW_DEV_UPDATER=1` is explicitly set. `install.ps1` sets the variable to the public key shipped inside the signed package, so a production install always verifies against the committed `updater/prodkeys/public.pem`. KMS/HSM-backed custody of the private half and rotation are tracked in #30 — see updater/README.md, "Key custody model for production".

## Update flow (flow_auto_update_version.jpg, "Bridge" branch)

`UpdateCoordinatorService` implements exactly the Bridge-owned half of the diagram (the "AI Desktop" branch is out of scope per AUTOCAD_MCP_PROJECT.md section 27/28):

1. A `PeriodicTimer` (or an out-of-cycle trigger — see below) calls `IUpdateCoordinator.CheckAsync`.
2. If a newer release exists: `DownloadAndVerifyAsync` (hash + signature — throws on any tampering, per updater's README walkthrough), then `StagePluginAsync` **unconditionally**.
3. Branches on `AutoCadProcessMonitor.AnyInstanceRunning`:
   - **No instance running:** `ActivateStagedPluginAsync` immediately ("update plugin" in the diagram).
   - **Instance(s) running:** defer, subscribing once to `AutoCadProcessMonitor.AllInstancesExited` ("AutoCAD closes" -> "update plugin" -> next AutoCAD start loads the new version via Bootstrap's `current.json`).
4. Also calls `StageSelfUpdateAsync` for the Bridge's own binary. If the release package includes one, the Bridge performs a **real** replace-on-restart self-update (not a stub):
   - Writes a small PowerShell helper script to `%TEMP%` that waits for this process's PID to exit, copies the staged build over the current install directory, and relaunches `CadAI.Bridge.exe`.
   - Spawns that helper detached (it outlives this process — Windows child processes aren't tied to their parent's lifetime by default).
   - Raises `SelfUpdateStaged`, which `Program.cs` treats exactly like Ctrl+C: every component shuts down gracefully, then the process exits so the helper's `Get-Process -Id <pid>` wait condition is satisfied.
5. `DeviceGatewayClient.UpdateRequired` (fired when the gateway's `hello.ack` reports `status: "update_required"`) calls `UpdateCoordinatorService.RequestImmediateCheck()` instead of waiting for the next hourly tick.

### Two design decisions not fully pinned by the shared `IUpdateCoordinator` contract

- **Single shared version number.** The interface takes one "current version" at construction and one manifest `latest` field covers both an optional plugin update and an optional Bridge self-update in the same release package (`plugin/` + `bridge/` inside the zip, per updater's README). This service therefore treats Bridge+Plugin as one unified release train and constructs `UpdateCoordinator` with `BridgeConfig.BridgeVersion` — matching `IUpdateCoordinator`'s own XML doc example ("e.g. the Bridge's assembly version").
- **Pending-activation marker.** "Staged but waiting for AutoCAD to exit" is tracked in memory _and_ persisted to `{bundleRoot}/pending-activation.json`. Without the on-disk marker, a Bridge self-update that lands while AutoCAD is still open would lose track of the staged-but-inactive plugin version across its own restart (the self-update literally replaces and relaunches this process). `Start()` resumes from that marker before the first periodic check runs, and every check opportunistically retries activation even when no new manifest version is found.

## Logging

`Diagnostics/BridgeLogger.cs` is a small dependency-free `IBridgeLogger` (not Microsoft.Extensions.Logging's `ILogger<T>`) that mirrors every line to stderr and to a daily-rolling file under `%ProgramData%\CadAI\bridge\logs\`. This was a deliberate choice, not an oversight: the Bridge has no other reason to take the `Microsoft.Extensions.Logging` package dependency, and a two-method interface is enough for a console+file sink. (It also means this project restores and builds with zero network access once `StreamJsonRpc` is cached — verified in this environment, which has no outbound internet.)

## Build

```powershell
dotnet build bridge/CadAI.Bridge.csproj
```

No AutoCAD install or extra MSBuild properties required — unlike `plugin`, this is a plain net8.0-windows app (a headless `WinExe`: no window, no tray). It does require `updater/CadAI.Updater.csproj` to exist (a `ProjectReference`); both build together as part of the same `dotnet build` invocation above.

## Running

```powershell
$env:CADAI_GATEWAY_URL = "wss://gateway.example.com/device"
$env:CADAI_DEVICE_TOKEN = "tok_..."          # development override; production gets identity.json from Desktop's installer
$env:CADAI_UPDATE_MANIFEST_URL = "https://updates.example.com/cadai/manifest.json"
$env:CADAI_UPDATER_PUBLIC_KEY_PATH = "C:\ProgramData\CadAI\keys\public.pem"
.\CadAI.Bridge.exe
```

Smoke-tested in this environment (no AutoCAD, no real cloud) by:

- Running with no environment variables: fails fast with a clear `CADAI_GATEWAY_URL is required` error and exit code 1 (no stack-trace spam, no silent hang).
- Running against an unreachable `ws://127.0.0.1:<closed-port>/device`: generates `identity.json`, logs a connection failure, and retries with exponential backoff (observed `1s -> 2s -> 4s -> 8s`) without crashing.
- Running against a real `device-gateway` instance (`bun run src/bin.ts`) with a matching `deviceId`/token: received `hello.ack` with `status: "compatible"` and a server-issued `sessionId`, proving the System.Text.Json camelCase wire format this project produces is byte-compatible with the independently-implemented TypeScript gateway.

## Known limitations

- There is no self-service enrollment for an unattended machine: the credential is minted by Aleph Desktop from a signed-in Aleph Account (see "Device identity"), and revocation is TTL-based (14 days) plus killing the user's sessions. Update-signing key custody (the dev key fallback above) is likewise out of scope per the task boundaries in AUTOCAD_MCP_PROJECT.md. See `docs/SECURITY.md`.
- `AutoCadProcessMonitor` looks for processes literally named `acad` or `acadcore`; a renamed or non-standard AutoCAD executable would not be discovered.
