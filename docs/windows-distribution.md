# Local-first Windows distribution

## Build installers

A Windows builder needs Bun, Rust, the Tauri Windows prerequisites, .NET 8/10 SDKs, and the AutoCAD 2021–2024 managed references (`AUTOCAD_NETFX_REF_DIR`). Install dependencies, stage the client package, then build both installers:

```powershell
bun install --frozen-lockfile
cd windows/connector-app; bun install --frozen-lockfile; cd ../..
powershell -NoProfile -ExecutionPolicy Bypass -File windows/scripts/prepare-connector-package.ps1 -RequireAllGenerations
cd windows/connector-app; bun run tauri:build
```

The script compiles the local runtime and stdio proxy and stages Bridge, installer scripts, agent pack, guide skills, and the `net48`, `net8.0-windows`, `net10.0-windows` AutoCAD plugin builds. Bridge includes the .NET Desktop runtime; both Tauri installers include the offline WebView2 installer. `src-tauri/target/release/bundle/` contains the NSIS EXE and MSI. These artifacts are not Authenticode-signed unless a signing certificate is separately configured; Windows may warn users. Building does not install or start the Bridge.

## GitHub Releases and updates

`.github/workflows/release-connector.yml` runs only on explicit workflow dispatch. The selected tag version must match the checked-in Tauri, Cargo, frontend, Bridge and plugin versions. The Windows runner needs Bun, Rust, OpenSSL, the Autodesk references and `UPDATE_SIGNING_PRIVATE_KEY` matching `windows/updater/prodkeys/public.pem`; the builder also compares the key to the Rust updater's embedded DER key. It publishes the NSIS installer, MSI, a signed update ZIP, and `manifest.json` to GitHub Releases. Never store private keys in the repository. No production release has been published by the build.

Connector checks the latest GitHub release. After the user confirms twice, it downloads the version-specific update ZIP, checks SHA-256 and the pinned RSA-SHA256 signature, verifies the signed version is strictly newer, and only then launches the installer. The interactive NSIS installer prompts the user to close Connector before replacing the app. After installing an app update, close AutoCAD and use **Repair / reinstall** in Connector to upgrade the separately installed Bridge and plugin; this remains an explicit action to protect open drawings. The updater launches the EXE installer even when Connector was originally installed with MSI; compatibility with an existing MSI installation has not yet been verified.

The Connector requests runtime startup on launch. A supervised child is restarted after unexpected exit with bounded backoff; explicit Stop or normal application exit stops supervision. Claude Desktop is configured to launch the bundled `aleph-mcp-stdio.exe` with `AUTOCAD_MCP_URL` pointing to the active local runtime URL. Signing and release download require network access; normal CAD use and installation from the built EXE/MSI do not require an Aleph account or network connection.

## Verification limitations

The build and isolated runtime tests do not modify the real Bridge identity, install the MSI/EXE, or exercise a live AutoCAD drawing. Before production, test clean-machine installation, an actual signed upgrade from each installer type, recovery after interruption, and a live AutoCAD session. Current AutoCAD plugin builds also emit NuGet security advisories for `MessagePack 2.5.192`; resolve or assess them before distributing.

Independent review also noted four minor follow-ups not yet implemented: `runtime.rs` holds its supervisor mutex across the 5-second health check and mutates process-wide environment variables in unit tests; `updates.rs` validates only the final redirect URL rather than intermediate hops; `build-github-release.ps1` does not yet cross-check `PluginState.PluginVersion`; and `test-connector-package.yml` does not yet run `cargo test`.
