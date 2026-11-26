# Windows Distribution Implementation Plan

> **For agentic workers:** Implement in place with focused tests; do not commit, publish, sign or deploy without explicit user authorization.

**Goal:** Ship a complete offline local-first Windows EXE/MSI distribution with secure GitHub Releases updates and recoverable runtime process ownership.

**Architecture:** Retain Tauri NSIS/WiX and existing CAD packaging, stage all app and CAD resources before bundling, authenticate GitHub release packages using the existing pinned RSA key, and supervise only the runtime child owned by Connector. The signed installer updates the complete application rather than an unconsumed pending executable.

**Tech Stack:** Tauri v2, Rust, React, Bun, PowerShell 5.1, .NET 8/10, GitHub Actions.

**Spec:** `docs/specs/2026-11-26-windows-distribution-design.md`

## Global constraints

- Keep runtime on 127.0.0.1 and `/device` credentials; never overwrite the real Bridge identity in tests.
- Package `net48`, `net8.0-windows`, `net10.0-windows` for releases; builds fail closed on missing SDK/Autodesk references.
- Use the existing production public key and signature format; private signing keys remain external.
- No external publishing, actual installation, process interference or production key generation.

## Review focus

- Forged manifest with matching attacker hash and invalid signature must fail before execution.
- Valid old signed artifact relabelled as newer must fail version-marker matching.
- ZIP entry traversal must fail before writing outside staging.
- Sidecar exit or port contention must not cause duplicate runtimes or claim a foreign service.
- Explicit stop/exit must prevent automatic restarts and leave no owned child.

## Tasks

### 1. Packaging and real paths

**Files:** `windows/scripts/package-client.ps1`, `windows/scripts/Test-PackagedBundle.ps1`, new preparation script, `windows/connector-app/src-tauri/tauri.conf.json`, Rust resource resolvers, `windows/connector-app/src/App.tsx`.

- [x] Build both sidecars and stage CAD payload and agent pack before Tauri packaging; eliminate recursive package/build coupling.
- [x] Configure NSIS and MSI resources; resolve executable, client and agent-pack paths in installed and dev layouts.
- [x] Validate required files, generations and version markers; fail incomplete release builds.
- [x] Exercise packaged-path resolution in isolated temp directories and validate staged layout.

### 2. Secure GitHub Release updates

**Review:** per-task — untrusted download and code execution

**Files:** `windows/connector-app/src-tauri/src/updates.rs`, release workflow, updater tests/docs.

- [x] Write tests using a test-only key: correct signature succeeds, tampered payload or signer fails, wrong marker and downgrade fail before invoking installer.
- [x] Authenticate release payload with pinned production key, compare signed version marker, enforce HTTPS/expected release assets and safe extraction.
- [x] Launch the authenticated installer for the full application and remove dead pending-exe logic; preserve explicit approval.
- [x] Publish versioned installer, signed package and manifest as a GitHub Release only from an explicit release workflow, with no release secret embedded in code. *(Workflow implemented and validated; not dispatched to publish yet.)*

### 3. Runtime supervision

**Review:** per-task — child process lifecycle and concurrency

**Files:** `windows/connector-app/src-tauri/src/runtime.rs`, `lib.rs`, `windows/connector-app/src/App.tsx`.

- [x] Add isolated process tests for unexpected exit/restart, explicit stop, shutdown and port collision.
- [x] Supervise desired runtime state with bounded backoff, clean shutdown, and no duplicate child.
- [x] Start runtime during onboarding and report errors/state accurately; use real packaged stdio path.

### 4. Verify distribution

**Files:** README and Windows release documentation, CI package workflow.

- [x] Run targeted Rust tests and distribution smoke tests using temporary identity/state paths.
- [x] Build NSIS and MSI where Windows, WiX/NSIS and Autodesk reference prerequisites permit; inspect installer contents without installing.
- [x] Run relevant typecheck/build and document exact release prerequisites, signing, outputs, and remaining live-install limitations.
- [ ] Run clean-machine EXE/MSI installation, live signed GitHub Release upgrade, and live AutoCAD drawing verification *(blocked on production `UPDATE_SIGNING_PRIVATE_KEY`, Authenticode signing, and manual clean-machine/AutoCAD environment).*
