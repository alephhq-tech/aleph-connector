# autocad-plugin

The in-AutoCAD half of the 4-tier architecture (see `AUTOCAD_MCP_PROJECT.md`):

```text
AI Desktop --MCP/HTTPS--> Remote MCP Server --(in-process)--> Device Gateway
    --WSS--> Bridge (bridge, standalone .NET process)
    --Local IPC named pipe--> AutoCAD Plugin (this app, in-AutoCAD-process, .NET)
    --AutoCAD .NET API--> AutoCAD --> DWG
```

This directory contains two separate assemblies, split per `AUTOCAD_MCP_PROJECT.md` §18 "Plugin Update Strategy":

```text
CadAI.bundle/
├── PackageContents.xml                        AutoCAD's bundle loader entry point (one
│                                               ComponentEntry per generation below)
├── current.json                               { "current": "0.3.0" }
├── Bootstrap/
│   ├── net48/CadAI.AutoCAD.Bootstrap.dll           <- AutoCAD 2021-2024
│   ├── net8.0-windows/CadAI.AutoCAD.Bootstrap.dll  <- AutoCAD 2025-2026
│   └── net10.0-windows/CadAI.AutoCAD.Bootstrap.dll <- AutoCAD 2027+
└── Versions/
    └── 0.3.0/
        ├── net48/CadAI.AutoCAD.dll
        ├── net8.0-windows/CadAI.AutoCAD.dll
        └── net10.0-windows/CadAI.AutoCAD.dll
```

(`installer/autocad-bundle/` — owned by `updater`'s installer packaging — assembles this exact tree from each generation's build output.)

## Bootstrap vs versioned plugin

An AutoCAD plugin DLL may already be loaded and pinned inside a running `acad.exe`. The updater (`updater`, `IUpdateCoordinator`) therefore never tries to overwrite a loaded DLL — it stages a new version alongside the old one under `Versions/{version}/` and only flips `current.json` once AutoCAD isn't running (`bridge` enforces that ordering; see its README).

For that to work, something has to sit between AutoCAD's plugin loader and the versioned code, and that something has to be small and effectively never change (a bundle whose own entry point changes every release reopens the "already loaded" problem it's trying to solve). That's **Bootstrap**:

- `Bootstrap/CadAI.AutoCAD.Bootstrap.csproj` — the _only_ assembly AutoCAD registers directly, via `PackageContents.xml` (one `ComponentEntry` per AutoCAD managed-runtime generation — see this project's root `CadAI.AutoCAD.csproj` header comment for the series mapping). It carries `[assembly: ExtensionApplication]` / `[assembly: CommandClass]`. On `Initialize()` it reads `current.json` (one level above its own assembly directory), resolves `Versions/{current}/{own generation}/CadAI.AutoCAD.dll`, and loads it — on net8.0-windows/net10.0-windows via a collectible `AssemblyLoadContext`, on net48 via a plain `Assembly.LoadFrom` (no `AssemblyLoadContext` in .NET Framework; see "Hot reload" below). It handles a missing/malformed `current.json` or a missing versioned DLL by logging to the AutoCAD command line and returning — it never lets a bad bundle state crash AutoCAD startup.
- `CadAI.AutoCAD.csproj` (this directory's root) — the versioned plugin: `RpcHandlers/`, `Dto/`, `Util/`, `PipeServer.cs`, `MainThreadDispatcher.cs`, `PluginState.cs`, `PluginErrors.cs`, `PluginEntryPoint.cs`. This is what actually talks to AutoCAD's managed API and answers the local IPC pipe. **It is never registered with AutoCAD as its own `ExtensionApplication`** — only Bootstrap is — so it has no `[assembly: ExtensionApplication]` at all; Bootstrap drives its lifecycle instead (see below). Being loaded via `Assembly.LoadFrom` rather than AutoCAD's own assembly scan also means its `[CommandMethod]` attributes (if it had any — it currently doesn't; see "Commands" below) would never auto-register.

### Entry-point wiring

`Bootstrap/IPluginEntryPoint.cs` defines the contract Bootstrap drives the versioned plugin through:

```csharp
public interface IPluginEntryPoint
{
    void Initialize();
    void Terminate();
    string DescribeStatus();
}
```

This lives in the Bootstrap assembly (not a third shared-contracts assembly), and the versioned plugin's `.csproj` takes a `ProjectReference` on `Bootstrap/CadAI.AutoCAD.Bootstrap.csproj` with `Private=false` (so Bootstrap's DLL isn't duplicated into `Versions/{version}/` — it's already loaded in the AutoCAD process by the time the versioned plugin loads, and the CLR resolves the reference to that already-loaded instance by assembly identity). `PluginEntryPoint` (in this project) implements the interface. Bootstrap locates the implementing type in the loaded assembly with one `Assembly.GetTypes().FirstOrDefault(...)` reflection call, then calls `Initialize()`/`Terminate()`/`DescribeStatus()` on it directly and typed — reflection is used only to _find_ the type, not to invoke its members. This was chosen over duplicating the interface textually in both assemblies with fully dynamic/reflection-based invocation: it's one extra tiny, stable `ProjectReference` in exchange for compile-time-checked calls on both ends.

`DescribeStatus()` is one method beyond the minimal `Initialize`/`Terminate` sketch in the top-level project brief — it exists so Bootstrap's `[CommandMethod("CADAISTATUS")]` (the only AutoCAD-registered command in either assembly) can forward to whatever versioned plugin is actually loaded, without AutoCAD needing to know two different command implementations exist.

### Commands

Only `Bootstrap/BootstrapExtensionApplication.cs` registers AutoCAD commands (`CADAISTATUS` and `CADAIRELOAD`, via the normal `[CommandMethod]` attribute — its assembly _is_ AutoCAD-scanned). The versioned plugin currently has no commands of its own; if a future RPC handler needs one, it must use `Autodesk.AutoCAD.ApplicationServices.Application.AddCommand(...)` from `PluginEntryPoint.Initialize()` instead of `[CommandMethod]`, because `[CommandMethod]` attributes are only discovered on assemblies AutoCAD scans directly, and this one is loaded via reflection.

## Hot reload

On net8.0-windows/net10.0-windows (AutoCAD 2025+), `CadAI.AutoCAD.dll` is loaded through a collectible `AssemblyLoadContext` (`Bootstrap/PluginLoadContext.cs`), not `Assembly.LoadFrom` directly into the default context — that's what makes it possible to unload it and load a freshly-rebuilt copy from disk without restarting AutoCAD. **On net48 (AutoCAD 2021-2024) there is no `AssemblyLoadContext` in .NET Framework** — loading is a plain `Assembly.LoadFrom`, `CADAIRELOAD` just prints that hot-reload isn't available on this AutoCAD version, and updating the plugin there requires restarting AutoCAD.

Workflow on net8.0-windows/net10.0-windows, after the first `NETLOAD`/bundle autoload of `Bootstrap.dll` in an AutoCAD session:

1. Close nothing — AutoCAD stays open. Edit `plugin` code.
2. In AutoCAD's command line, type `CADAIRELOAD` and press Enter first (this releases the plugin DLL's file handle by unloading its `PluginLoadContext` before you rebuild — see below).
3. `dotnet build plugin/CadAI.AutoCAD.csproj -c Release -p:TargetFrameworks=net8.0-windows -o <same Versions/{version}/net8.0-windows folder the bundle is loaded from>` (or re-run `.\scripts\package-client.ps1`, which does this and re-copies into `dist/client/CadAI.bundle/Versions/{version}/net8.0-windows/`).
4. Type `CADAIRELOAD` again to load the freshly-built DLL.

`CADAIRELOAD` (`BootstrapExtensionApplication.Reload`) does exactly what a restart would do, without the restart: calls `PluginEntryPoint.Terminate()` on the currently-loaded plugin (stops the pipe server, unhooks `Application.Idle`), calls `Unload()` on its `PluginLoadContext`, forces a bounded number of `GC.Collect()`/`GC.WaitForPendingFinalizers()` cycles to give the CLR a chance to actually release the DLL's file handle, then re-reads `current.json` and loads whatever version it names — fresh from disk — into a brand-new `PluginLoadContext`. `CADAISTATUS` immediately after shows the new `pipeUptimeSeconds` reset to ~0, confirming the reload actually re-initialized the plugin.

Only `CadAI.AutoCAD.Bootstrap` itself is exempt from reload — `PluginLoadContext.Load` explicitly returns `null` for it so it always resolves to the single instance AutoCAD already loaded into the default context (this is what keeps `IPluginEntryPoint`'s type identity consistent across every reload; loading a second copy of Bootstrap would make the interface cast fail). Bootstrap changes are rare enough (it's a thin, stable loader shim) that they still require closing and reopening AutoCAD plus one more `NETLOAD`.

Reload is best-effort: if something outside `PluginEntryPoint` (a lingering event subscription, a delegate captured by AutoCAD itself, etc.) still holds a reference into the old assembly, the collectible context won't actually unload — `CADAIRELOAD` logs a warning in that case and loads the new version anyway, but the old version's memory isn't reclaimed until AutoCAD restarts. This has never been observed in practice given `PluginEntryPoint.Terminate()`'s current cleanup (pipe disposal + `Application.Idle -=`), but the check exists so a future change that leaks a reference fails loudly instead of silently serving stale code.

## Pipe naming (multi-instance)

Each AutoCAD process opens its own named pipe:

```text
\\.\pipe\cadai-autocad-{processId}
```

where `{processId}` is that AutoCAD process's own PID (`Process.GetCurrentProcess().Id`, read inside `PluginEntryPoint.Initialize()` — see `PipeServer`'s constructor call site). There is no configurable pipe name and no environment variable override anymore (the previous single fixed `AUTOCAD_MCP_PIPE_NAME` pipe is gone): `bridge` enumerates running `acad.exe`/`acadcore.exe` processes, reads each one's PID, and dials `cadai-autocad-{pid}` directly — one pipe server per AutoCAD process, one Bridge process talking to all of them.

## Local IPC contract

JSON-RPC 2.0 over `StreamJsonRpc`, header-delimited framing (`Content-Length: <n>\r\n\r\n<json>`, `HeaderDelimitedMessageHandler` + `JsonMessageFormatter` — StreamJsonRpc's default, chosen so the framing matches `vscode-jsonrpc`/LSP). Method catalog: `contracts/protocol/local-ipc/methods.ts`; error codes: `contracts/protocol/local-ipc/errors.ts`; shared payload shapes: `contracts/cad-types`. `docs/PROTOCOL.md` is the prose version of the same contract.

`system.status`'s result (`SystemStatusResult` in `Dto/DrawingDto.cs`) is the `AutoCadPluginStatus` shape: `processId` (this AutoCAD process's own PID — lets `bridge` build the `acad_{processId}` `instanceId` without a second round trip), `pluginVersion` (`PluginState.PluginVersion`), `autocadVersion`, `activeDocument`, `pipeUptimeSeconds`.

**Wire casing:** `PipeServer` configures `JsonMessageFormatter.JsonSerializer.ContractResolver = CamelCasePropertyNamesContractResolver` so every result serializes with camelCase field names (`processId`, not `ProcessId`) — matching `contracts/cad-types`/`contracts/protocol/local-ipc`'s TypeScript-authored field names exactly, even though both ends of this particular pipe are C# now. Without this, Newtonsoft's default emits the literal PascalCase CLR property names, which is what the pre-rewrite `apps/autocad-bridge` did (a latent inconsistency this rewrite fixes).

## Design notes (unchanged from the pre-rewrite implementation)

- **One process gets the real handlers.** `PipeServer` accepts every connection but only the first gets `RpcHandlers/*`; any concurrent connection gets `BusyHandlers`, which answers every catalog method with `-32025 PipeOccupied` instead of hanging or silently dropping. That code means "close and dial again" — the slot is never handed to a waiting secondary connection — and `bridge/IPC/PluginPipeClient.cs` hangs up on exactly it.
- **Every AutoCAD call runs on the main thread.** The pipe read loop is a background `Task`; `MainThreadDispatcher` queues the actual database work and drains it from `Application.Idle`. See `docs/PROTOCOL.md`, "Threading contract" — skipping this marshaling is the most common way to crash AutoCAD from a plugin.
- **Every mutation is transactional.** Each handler wraps its work in `using var tr = db.TransactionManager.StartTransaction()` and only calls `tr.Commit()` after every object in the call succeeds. An exception mid-way disposes the transaction without committing — AutoCAD rolls it back, so a failed multi-entity `entity.create`/`entity.transform` never leaves a half-written drawing.

## Build

Both projects multi-target `net48;net8.0-windows;net10.0-windows` — one per AutoCAD managed-runtime generation (see `CadAI.AutoCAD.csproj`'s header comment for the full series mapping, and `SETUP.md`'s "Supported AutoCAD versions" table). Build one generation at a time with `-p:TargetFrameworks=<tfm>` — **not** `-f <tfm>`: the SDK validates every entry in `<TargetFrameworks>` before `-f` narrows which one compiles, so `-f net48` alone still fails with `NETSDK1045` without the .NET 10 SDK installed, even though you're not building `net10.0-windows`. `-p:TargetFrameworks=<tfm>` overrides the property outright instead:

```powershell
# AutoCAD 2025-2026: NuGet-only (AutoCAD.NET.Model/Core), no local AutoCAD install needed
dotnet build plugin/Bootstrap/CadAI.AutoCAD.Bootstrap.csproj -c Release -p:TargetFrameworks=net8.0-windows
dotnet build plugin/CadAI.AutoCAD.csproj -c Release -p:TargetFrameworks=net8.0-windows

# AutoCAD 2027+: same NuGet-only story, needs the .NET 10 SDK
dotnet build plugin/Bootstrap/CadAI.AutoCAD.Bootstrap.csproj -c Release -p:TargetFrameworks=net10.0-windows
dotnet build plugin/CadAI.AutoCAD.csproj -c Release -p:TargetFrameworks=net10.0-windows

# AutoCAD 2021-2024: needs AcMgd.dll/AcDbMgd.dll/AcCoreMgd.dll from a real install or the
# ObjectARX SDK — see SETUP.md, "Building the net48 (AutoCAD 2021-2024) target". Verified
# clean (0 warnings, 0 errors) against a real AutoCAD 2022 install.
dotnet build plugin/Bootstrap/CadAI.AutoCAD.Bootstrap.csproj -c Release -p:TargetFrameworks=net48 -p:AutoCadNetFxRefDir="C:\Program Files\Autodesk\AutoCAD 2021"
dotnet build plugin/CadAI.AutoCAD.csproj -c Release -p:TargetFrameworks=net48 -p:AutoCadNetFxRefDir="C:\Program Files\Autodesk\AutoCAD 2021"
```

Output DLLs are generated at `plugin/Bootstrap/bin/Release/{tfm}/CadAI.AutoCAD.Bootstrap.dll` and `plugin/bin/Release/{tfm}/CadAI.AutoCAD.dll`.

Or run `.\scripts\package-client.ps1` from the repo root to automatically compile and assemble the complete `./dist/client/CadAI.bundle` ready for distribution — pass `-AutoCadNetFxRefDir`/`-IncludeNet10` to also build the net48/net10.0-windows generations (net8.0-windows always builds).

## Known limitations (v0.1, carried over unchanged)

- `block`, `annotation` (dimensions/leaders), and `pid` symbol-library tools from the protocol's tool taxonomy are not implemented yet — only `system`, `drawing`, `layer`, `entity`, and `view` are wired end to end.
- `layer.setProperties` requires the target linetype to already be loaded in the drawing; it does not load `.lin` definitions on demand.
- AutoCAD has no native rectangle entity: `entity.create` with `kind: "rectangle"` creates a closed `Polyline`, so `entity.list`/ `entity.get` report it back as `kind: "polyline"` afterward.
