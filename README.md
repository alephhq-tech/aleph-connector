# Aleph Connector

Local-first CAD tooling for user-owned AI agents. Free to run, no account, no cloud server.

Aleph Connector exposes MCP tools to Claude, Codex, Antigravity, Cursor, and other MCP clients
over loopback on the user's own Windows machine. It does not host or operate an AI model. The
local runtime owns CAD semantics, validation, geometry, and engineering rules; the Windows
Connector and AutoCAD plugin execute typed operations against the user's live DWG.

## Product boundary

- **Agent:** understands intent, reasons, and selects tools (its own account/model — Aleph
  Connector ships no model).
- **Local runtime (Bun, 127.0.0.1):** serves `/mcp` (Streamable HTTP), `/device` (Connector WSS),
  and `/health`; inspects, plans, validates, dispatches, and verifies CAD work.
- **Windows Connector:** maintains the loopback device connection and routes typed requests over
  local IPC.
- **AutoCAD plugin:** uses the Autodesk .NET API with document identity, main-thread execution,
  locks, transactions, rollback, and receipts.

MCP clients connect with no credentials — the runtime binds loopback and rejects non-loopback
`Host`/cross-origin `Origin` requests. Windows Connectors use a locally minted device credential
on `/device`; socket reachability is never authorization. Aleph Connector never accepts arbitrary
AutoCAD commands, AutoLISP, C# scripts, shell commands, or simulated mouse/keyboard input.

## Repository layout

```text
apps/
  mcp-server/       Local MCP runtime (HTTP + WSS device gateway, one process)
packages/
  cad-core/         Transport-independent command and execution contracts
  cad-protocol/     Canonical TypeScript <-> C# wire contracts
  cad-tools/        MCP schemas and semantic tool implementations
  cad-state/        Revision-bound CAD context and cache (SQLite)
  engineering/      Geometry and engineering algorithms
  identity/         ABT device credentials and grants (local custody)
windows/
  connector/        Compiled Windows device runtime (Bridge)
  connector-app/    Aleph Connector desktop UI (Tauri v2 + Bun)
  autocad-plugin/   Compiled in-process AutoCAD integration
  updater/          Signed update client
  installer/        AutoCAD bundle packaging
docs/
  architecture.md
  extraction-map.md
```

## Invariants

1. Every CAD read/write is bound to the local device, AutoCAD instance, document reference, and
   revision.
2. Writes use typed allowlisted operations, idempotency keys, explicit revision preconditions, and
   document-scoped serialization.
3. A timeout after dispatch is an unknown outcome; reconcile the execution receipt before retrying.
4. Preview is pure. Apply reports commit truth independently from visual verification.
5. The runtime binds 127.0.0.1; non-loopback `Host` or cross-origin `Origin` requests are rejected.
   The Connector's device credential and grant-generation recheck stay independent of MCP access.
6. Drawing content and captures are not logged by default.

## Status

Local-first runtime and desktop integration are implemented. Windows NSIS/MSI builds and the
signed GitHub release/update pipeline are documented in `docs/windows-distribution.md`; a clean
installation and live AutoCAD upgrade still need verification before release. Open-source release
work (relicensing, secret audit, public CI) remains separate.
