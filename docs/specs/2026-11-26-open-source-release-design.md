# Open-Source Release — Design

Date: 2026-11-26. Implements Phase 4 of `2026-11-25-local-first-connector-design.md` and the open-source proposal.

## Outcome and Goals

Transform the Aleph Connector repository into a public, open-source, local-first AutoCAD MCP distribution:
1. **Open Source Licensing:** Replace proprietary license with Apache License 2.0 (standard permissive license with explicit patent grants and trademark protection), update package metadata across Rust, Node, and C#.
2. **Security & Secrets Hygiene:** Scan git history and working tree to verify no private keys, passwords, bearer tokens, AWS/MinIO/database credentials, or confidential CAD drawings are exposed.
3. **CI Pipeline Hardening & Test Completeness:**
   - Add `cargo test` to `.github/workflows/test-connector-package.yml` so pull requests run Rust security/contract tests in CI.
   - Address minor review items from Phase 3 (release version check parity across `PluginState.cs`, mutex scope during runtime health polling, redirect handling).
4. **Community Documentation:**
   - Public-facing `README.md` with clear value proposition: Free, Local-first, No Cloud Account, Bring Your Own AI.
   - Step-by-step user onboarding guide (Download EXE/MSI -> Open AutoCAD -> Select Agent -> Connect).
   - Agent setup guide for Claude Desktop, Codex, Antigravity, Cursor, and VS Code.
   - `CONTRIBUTING.md` and security policy guidelines.
5. **Release Preparedness:**
   - Establish formal release checklist for `v0.1.0`.
   - Provide clear instructions for publishing the first release via `release-connector.yml`.

## Non-goals

- No rewriting of AutoCAD plugin or Bridge C# layer.
- No remote/cloud execution support (remains strictly loopback local-first).
- No deployment of cloud infrastructure or accounts.
