# Aleph Connector

Private, cloud-managed CAD tooling for user-owned AI agents.

Aleph Connector exposes authenticated MCP tools to Claude, Codex, Antigravity, and other MCP clients. It does not host or operate an AI model. Cloud services own authorization, CAD semantics, validation, geometry, and engineering rules. The Windows Connector and AutoCAD plugin execute typed operations against the user's live DWG.

## Product boundary

- **Agent:** understands intent, reasons, and selects tools.
- **Aleph Connector Cloud:** authenticates clients and devices; inspects, plans, validates, dispatches, and verifies CAD work.
- **Windows Connector:** maintains the outbound device connection and routes typed requests over local IPC.
- **AutoCAD plugin:** uses the Autodesk .NET API with document identity, main-thread execution, locks, transactions, rollback, and receipts.

MCP clients authenticate with **OAuth 2.1 + PKCE** (no static API tokens). Device Connectors use a separate paired credential on `/device`. Aleph Connector never accepts arbitrary AutoCAD commands, AutoLISP, C# scripts, shell commands, or simulated mouse/keyboard input.

## Repository layout

```text
apps/
  mcp-server/       Remote MCP HTTP service and WSS device gateway
  portal/           Account, pairing, devices, grants, and downloads
packages/
  cad-core/         Transport-independent command and execution contracts
  cad-protocol/     Canonical TypeScript ↔ C# wire contracts
  cad-tools/        MCP schemas and semantic tool implementations
  cad-state/        Revision-bound CAD context and cache
  engineering/      Private geometry and engineering algorithms
  identity/         MCP OAuth, pairing, device credentials, and grants
windows/
  connector/        Compiled Windows device runtime
  autocad-plugin/   Compiled in-process AutoCAD integration
  updater/          Signed update client
  installer/        Installer and AutoCAD bundle packaging
docs/
  architecture.md
  extraction-map.md
```

## Invariants

1. Every CAD read/write is bound to an authorized user, device, AutoCAD instance, document reference, and revision.
2. Writes use typed allowlisted operations, idempotency keys, explicit revision preconditions, and document-scoped serialization.
3. A timeout after dispatch is an unknown outcome; reconcile the execution receipt before retrying.
4. Preview is pure. Apply reports commit truth independently from visual verification.
5. MCP client credentials and Windows device credentials are distinct and independently revocable.
6. Drawing content and captures are not logged by default.

## Status

Repository foundation only. Extraction follows `docs/extraction-map.md`; no production service or installer is claimed complete.
