# installer/autocad-bundle

Packages the AutoCAD plugin's build output into the versioned bundle layout AutoCAD's Autoloader understands, and installs it for per-user autoload.

## Layout

```
CadAI.bundle/
  PackageContents.xml     <- Autodesk bundle manifest; one ComponentEntry per AutoCAD
                             managed-runtime generation, each pointing at that
                             generation's own Bootstrap/{generation}/*.dll
  current.json            <- {"current": "0.3.0"} — which Versions/{version}/ subfolder
                             is active, shared across every generation
  Bootstrap/
    net48/
      CadAI.AutoCAD.Bootstrap.dll         <- AutoCAD 2021-2024 (.NET Framework 4.8)
    net8.0-windows/
      CadAI.AutoCAD.Bootstrap.dll         <- AutoCAD 2025-2026 (.NET 8)
    net10.0-windows/
      CadAI.AutoCAD.Bootstrap.dll         <- AutoCAD 2027+ (.NET 10)
  Versions/
    0.3.0/
      net48/CadAI.AutoCAD.dll             <- NOT independently registered with AutoCAD
      net8.0-windows/CadAI.AutoCAD.dll
      net10.0-windows/CadAI.AutoCAD.dll
    0.2.0/
      net48/CadAI.AutoCAD.dll             <- a superseded version, kept for rollback
      net8.0-windows/CadAI.AutoCAD.dll
      net10.0-windows/CadAI.AutoCAD.dll
```

A given AutoCAD process only ever loads one generation's Bootstrap (whichever `ComponentEntry`'s `RuntimeRequirements` its series matches) — see `plugin/CadAI.AutoCAD.csproj`'s header comment for the full AutoCAD-series-to-generation mapping. That Bootstrap reads `current.json` next to the bundle root, `Assembly.LoadFrom`s (net48) or loads into a collectible `AssemblyLoadContext` (net8.0-windows/net10.0-windows) `Versions/{current}/{own generation}/CadAI.AutoCAD.dll`, and calls into it through a small shared entry-point contract (see `plugin/README.md` for exactly how Bootstrap and the versioned plugin share that contract — that choice belongs to the plugin implementation, not this installer). Because the versioned DLL is loaded by reflection rather than registered as its own bundle component, its `[CommandMethod]`s do not auto-discover — the versioned plugin registers its commands dynamically via `Application.AddCommand`.

This indirection is what makes updates possible without ever touching a DLL that AutoCAD currently has loaded: `CadAI.Updater` (updater) stages a new version into a fresh `Versions/{newVersion}/` folder (every generation that's part of the release) and only flips `current.json` once AutoCAD isn't running — see AUTOCAD_MCP_PROJECT.md section 18 and updater/README.md.

## build-bundle.ps1

The plugin projects need either the AutoCAD.NET NuGet packages (net8.0-windows/net10.0-windows) or a local AutoCAD 2021-2024 install/ObjectARX SDK (net48, via `-p:AutoCadNetFxRefDir`; see SETUP.md), which isn't available in every environment, so this script takes already-built output directories as parameters — one pair per generation you actually have, all optional (pass at least one pair):

```powershell
dotnet build plugin/Bootstrap/CadAI.AutoCAD.Bootstrap.csproj -f net8.0-windows
dotnet build plugin/CadAI.AutoCAD.csproj -f net8.0-windows

.\installer\autocad-bundle\build-bundle.ps1 `
    -BootstrapOutputDirNet8 plugin\Bootstrap\bin\Debug\net8.0-windows `
    -PluginOutputDirNet8 plugin\bin\Debug\net8.0-windows `
    -Version 0.1.3
```

This copies `PackageContents.xml` + every given generation's build output into `%APPDATA%\Autodesk\ApplicationPlugins\CadAI.bundle` (under its own `Bootstrap/{generation}/` and `Versions/{version}/{generation}/` subfolder), then writes `current.json` to activate the given version. `%APPDATA%\Autodesk\ApplicationPlugins\` is Autodesk's documented **per-user** bundle discovery path — AutoCAD scans it at every startup and loads any `*.bundle\PackageContents.xml` it finds, with no manual APPLOAD/NETLOAD step and no admin rights needed (unlike the all-users path under `%ProgramData%\Autodesk\ApplicationPlugins\`, which this script deliberately does not use, matching "the user should install the AutoCAD integration only once" from AUTOCAD_MCP_PROJECT.md section 17).

Smoke-tested with placeholder build output (this sandbox has no AutoCAD SDK, so no real plugin DLL exists yet): running the script against net48+net8.0-windows stand-in `CadAI.AutoCAD.Bootstrap.dll`/`CadAI.AutoCAD.dll` pairs correctly produced the exact dual-generation tree above under a scratch `-InstallTarget`, including a correctly-written `current.json`. Also caught and fixed a real Windows PowerShell 5.1 bug while writing this script's own help text: an em dash inside an actual (non-comment) double-quoted string literal, in a BOM-less `.ps1` file, gets misread under the system's default ANSI code page and breaks string parsing — `.ps1` files in this repo stay plain-ASCII in code (not just comments) for exactly this reason.

**`SECURELOAD`/`TRUSTEDPATHS` caveat:** this per-user path is not one of AutoCAD's implicitly-trusted locations — only `%PROGRAMFILES%\Autodesk\ApplicationPlugins` is trusted unconditionally; everything else, including this path, "must be trusted... and should be digitally signed" per Autodesk's own Autoloader docs. With AutoCAD's default `SECURELOAD=1` and an _unsigned_ build, a machine may refuse the bundle without any error or prompt (reproduced here on AutoCAD 2022; the same shape loaded on this machine's AutoCAD 2025, so it is version-dependent). No longer a manual step: `bridge/Device/AutoCadTrustedPaths.cs` registers `<bundle>\...` in the user's `TRUSTEDPATHS` when the Bridge starts, so the first AutoCAD launch after an install works. Proven causally on real AutoCAD 2022 (`SECURELOAD=1`, `TRUSTEDPATHS` empty): refused for the whole 180s observation window (35 polls, no pipe, no module), then loaded on the first poll after the single registry entry — and again with the shipped Bridge binary registering it itself. See `docs/BRIDGE.md`, "Where the bundle lives".

## PackageContents.xml

`Author`/`CompanyDetails` are Aleph Technologies' real identity, matching `src-tauri/tauri.conf.json` (`publisher`, `homepage`), so Windows and AutoCAD's own plugin manager show who shipped this. `Name`, `Description`, `AppVersion`, and both GUIDs (`ProductCode`/`UpgradeCode`) are still scaffold defaults to revise if the product identity changes — do NOT regenerate the GUIDs for a routine release: `ProductCode` is what the Autoloader treats as "the same package" and `UpgradeCode` as "the same product line", so changing either leaves the previous bundle orphaned on every client machine. `PluginVersionTests` pins `AppVersion` and `current.json`'s `current` to `PluginState.PluginVersion`, so bump all three together. `RuntimeRequirements` lives _inside_ each `ComponentEntry` (a sibling under `Components` is silently ignored by AutoCAD 2025's Autoloader — see `docs/IMPLEMENTATION_STATUS.md`). Three `ComponentEntry` blocks, one per AutoCAD managed-runtime generation (`SeriesMin`/`Max` per Autodesk's "About Managed .NET Compatibility" table — see `plugin/CadAI.AutoCAD.csproj`'s header comment): `R24.0`-`R24.3` → net48, `R25.0`-`R25.1` → net8.0-windows, `R26.0`-`R26.9` → net10.0-windows. Only the `R25.0` (AutoCAD 2025) entry has been verified against a real install; the other two are implemented but unverified — see `docs/IMPLEMENTATION_STATUS.md`. Known gap: Autodesk has also shipped `net10.0`-targeting patch updates for the `25.0`/`25.1` NuGet packages themselves (not reflected in their own compatibility table), so an AutoCAD 2025/2026 install that received one of those updates needs the net10.0-windows entry instead — `SeriesMin`/`Max` can't express that distinction, so this isn't automatically correct for every installation.
