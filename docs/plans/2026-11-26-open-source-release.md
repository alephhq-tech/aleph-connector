# Open-Source Release Implementation Plan

> **For agentic workers:** Implement in place with focused validation; do not publish, tag, or push without explicit user authorization.

**Goal:** Complete Phase 4 of the local-first conversion: license the project under Apache 2.0, audit secrets and git history, harden CI testing, document user and developer onboarding, and prepare the v0.1.0 release workflow.

**Spec:** `docs/specs/2026-11-26-open-source-release-design.md`

## Tasks

### 1. Licensing and package metadata
- [x] Replace `LICENSE` with Apache License 2.0.
- [x] Update `license` field in root `package.json`, `windows/connector-app/package.json`, `windows/connector-app/src-tauri/Cargo.toml`, and `.csproj` files.
- [x] Add `NOTICE` and standard copyright header notices.

### 2. Secrets and sensitive data audit
- [x] Scan full git history and working tree for leaked credentials, private keys, API tokens, `.env` files, or internal endpoints.
- [x] Verify that test fixtures use only mock/ephemeral keys and no production secrets.
- [x] Ensure `.gitignore` cleanly covers local dev state, build outputs, and credentials.

### 3. CI and Phase 3 review follow-ups
- [x] Add `cargo test` execution to `.github/workflows/test-connector-package.yml`.
- [x] Include `PluginState.cs` version parity check in `windows/scripts/build-github-release.ps1`.
- [x] Narrow `supervisor_state` mutex lock in `windows/connector-app/src-tauri/src/runtime.rs` so health polling does not hold the lock.
- [x] Verify full test suite (`cargo test`, `bun test`, `dotnet test`) passes cleanly.

### 4. Documentation and community guides
- [x] Rewrite `README.md` for open-source users: 3-step setup, supported agents, architecture diagram, security model.
- [x] Add `CONTRIBUTING.md` with build prerequisites and local test workflow.
- [x] Document release instructions and prerequisites (`docs/windows-distribution.md`).

### 5. Final verification and PR
- [x] Run all automated tests across Rust, Bun, and .NET.
- [x] Validate packaging scripts and installer builds.
- [x] Submit PR to `main` for Phase 4.
