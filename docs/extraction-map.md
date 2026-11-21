# Aleph Platform → Aleph Connector extraction map

Source checkout: `~/Documents/aleph-platform`. Copy only owned CAD modules; do not copy AgentEngine, Model Gateway, Run Engine, Aleph Desktop UI, or general Aleph account infrastructure.

## Move together

| Aleph Connector target | Aleph source | Treatment |
|---|---|---|
| `apps/mcp-server` | `aleph-cloud/apps/mcp-autocad` | Extract tool/server implementation; replace auth, database, config, observability, and session pinning |
| `packages/cad-protocol` | `aleph-cloud/packages/mcp/autocad/wire-protocol` and `cad-types` | Preserve canonical TS contracts and C# generation |
| `packages/cad-tools` | `aleph-cloud/packages/mcp/autocad/tools` | Preserve validated schemas; normalize public names after extraction |
| device contracts/router | `aleph-cloud/packages/mcp/autocad/device-contracts`, `device-protocol`, `device-gateway` | Preserve routing and result correlation; replace Aleph grants |
| `packages/engineering` | selected `aleph-cloud/packages/engineering` | Re-vendor PCCC, spatial, standards, and verification code used by CAD tools only |
| `packages/cad-state` | selected `aleph-cloud/services/cad-state` | Replace workspace/database assumptions with revision-bound Aleph Connector context storage |
| `windows/connector` | `aleph-desktop/integrations/autocad/bridge` | Rename product surfaces; replace Desktop token mint/onboarding |
| `windows/autocad-plugin` | `aleph-desktop/integrations/autocad/plugin` and tests | Preserve typed RPC, main-thread execution, locks, transactions, and rollback |
| `windows/updater` | `aleph-desktop/integrations/autocad/updater` and tests | Preserve signed update verification |
| `windows/installer` | `aleph-desktop/integrations/autocad/installer` | Produce Aleph Connector-branded bundle and install flow |
| update contracts | `aleph-desktop/integrations/autocad/contracts` | Preserve bundle rules, update channel, and preimage vectors |
| generated C# | `aleph-desktop/integrations/autocad/generated/csharp` | Regenerate from canonical protocol; never hand-maintain a duplicate schema |

## Aleph dependencies to sever

The current MCP app has 92 TypeScript source files and 160 `@aleph/*` import sites. Most imports point to the CAD packages above and move with the product. Sever these platform dependencies:

| Dependency | Import sites | Replacement |
|---|---:|---|
| `@aleph/identity` | 1 | Aleph OAuth verifier, pairing, device credentials, and grant generation |
| `@aleph/database` | 4 | Aleph Connector PostgreSQL repositories |
| `@aleph/service-cad-state` | 3 | revision-bound Aleph Connector CAD context store |
| `@aleph/protocol` | 6 | minimal Aleph Connector operation identity, evidence, capture, and error contracts |
| `@aleph/engineering` | 8 | selected private algorithms re-vendored under `packages/engineering` |
| `@aleph/config` | 1 | Aleph Connector environment schema |
| `@aleph/observability` | 2 | Aleph Connector structured logging/tracing with CAD payload redaction |

## Preserve; do not redesign

- Existing 14 semantic tools: `block`, `cad`, `construct`, `context`, `drawing`, `edit`, `entity`, `layer`, `operations`, `style`, `system`, `view`, `pccc_overlay`, `pccc_fire_alarm_overlay`.
- `operations` batch semantics, one-undo behavior, same-call handle references, and commit-boundary reporting.
- `idempotencyKey` and `expectedRevision` preconditions.
- `_meta` operation identity outranking model-supplied keys.
- Existing C# RPC handlers and the absence of arbitrary AutoCAD command/AutoLISP/script execution.

Public tool names may change only after the extracted behavior and contract tests are green. Avoid a simultaneous move, rename, and semantic rewrite.

## Required P0 corrections

1. Replace session-scoped `DocumentPin` with opaque, expiring `documentRef` handles. Do not carry over `stdio-proxy.ts`'s legacy `Mcp-Session-Id` behavior.
2. Split the current shared Bridge/MCP credential. Keep per-request live grant-generation rechecks, but use independent MCP OAuth and device issuers/audiences.
3. Make execution receipts durable before public write access. A reconnect after dispatch must reconcile by `executionId` rather than retry blindly.
4. Keep the in-process PCCC region cache only while the cloud is explicitly single-instance. Move `planId` and region state to shared storage before horizontal scaling.
5. Treat capture as optional verification evidence. `tools/capture.ts` currently supplies helpers to other tools; a standalone public capture tool must be intentionally added and tested.

## P0 slices and acceptance criteria

### Slice A — Contract and Windows runtime extraction

- Canonical protocol builds TypeScript and generated C# consumers.
- Connector, plugin, updater, and their focused tests build independently from Aleph Desktop.
- No Aleph Connector runtime imports or paths reference Aleph Desktop/Cloud identity.
- No raw command, AutoLISP, C# script, shell, mouse, or keyboard execution path exists.

### Slice B — Cloud CAD runtime extraction

- MCP server, CAD packages, selected engineering modules, and in-memory test backend typecheck and test outside Aleph Cloud.
- All seven platform dependencies above are removed or re-vendored.
- Existing idempotency, revision-precondition, pinning, batch, and PCCC contract tests remain behaviorally equivalent.

### Slice C — Standalone identity and pairing

- MCP client and device credentials have distinct issuers/audiences and cannot substitute for each other.
- Pairing requires explicit owner confirmation and issues an independently revocable device credential.
- Dispatch rechecks caller-to-device grants; client-supplied device IDs never establish authorization.
- Revocation blocks the next request/dispatch, not only the next login.

### Slice D — Packaging and live proof

- Signed installer installs Connector, plugin bundle, and updater once.
- External MCP client can authenticate, call context, perform a typed batch, verify revision/handles, reconcile a simulated lost response, and undo on real AutoCAD.
- Verification includes multiple tabs/processes, stale revision, reconnect, capture failure, and unknown-outcome recovery.
