# Local-first Windows distribution — design

Date: 2026-11-26. Implements Phase 3 of `2026-11-25-local-first-connector-design.md`.

## Outcome and constraints

Produce a Windows NSIS EXE and MSI containing the Connector UI, compiled local MCP runtime and stdio proxy, guide skills, agent pack, Bridge, installer scripts and AutoCAD plugin generations. The installer must not require Bun, an Aleph account, cloud gateway or database on the customer machine. AutoCAD integration installation remains an explicit user action, using the existing transactional install script and locally issued Bridge credential. No publishing, production signing, secrets, or changes to a customer's installed Bridge are authorized by this implementation task.

Runtime remains bound to loopback; no token is exposed in MCP configuration. Preserve the existing signed Bridge update path and compatibility with AutoCAD's open-document activation policy. Release builds must refuse incomplete AutoCAD generations and mismatched version trains.

## Packaging

Use Tauri v2's existing NSIS and WiX bundle mechanisms rather than a second custom installer. A preparation command first builds both Bun-compiled sidecars, stages their skill directories, and builds the existing Bridge/plugin package without recursively building Connector. Tauri resources map that package into `binaries/client/`, the sidecars into `binaries/`, and agent pack into `binaries/agent-pack/`. Runtime resolution and Claude Desktop configuration use the actual packaged resource paths. Development continues to support the existing source-tree/package overrides.

The release workflow builds on Windows and publishes artifacts to GitHub Releases only when explicitly dispatched. It fails closed if release prerequisites are unavailable; no dev signing key is accepted for releases. The PR packaging workflow includes the changed local runtime and Connector files.

## Update trust and installation

Do not execute a ZIP merely because its unauthenticated manifest contains the ZIP's SHA-256: the Connector currently ignores the RSA signature. Use the existing release verification key and RSA-SHA256 PKCS#1 v1.5 contract; a valid signature over the actual ZIP digest and matching signed version markers must be checked before extracting or running any release payload. Reject malformed versions, mismatched digest/signature, path traversal and an equal or older release. A signed release is an immutable ZIP attached to GitHub Releases; its companion manifest points at that exact asset. Do not trust a public key supplied by the downloaded ZIP. The application update must actually replace the complete installed application through the signed installer, not leave an orphaned `.pending` file. After the verified installer updates the Connector and its bundled CAD payload, the user closes AutoCAD and explicitly selects Repair / reinstall to update the installed Bridge and plugin. No live drawing is modified by the updater.

## Runtime lifecycle

On Connector launch, start the owned sidecar and periodically detect an unexpected exit; restart with bounded backoff while desired, but never restart after an explicit Stop or while shutting down. Reject port collisions rather than claiming another service as this runtime. The UI must show startup failure or unhealthy status accurately, and closing the application stops its child.

## Verification

Exercise signed good and tampered update fixtures offline, including altered hash/signature and stale/mismatched versions; no installer execution in tests. Test sidecar exit, deliberate stop and port collision without using the user's real identity. Validate staged resources and build both Windows installer formats when toolchain and Autodesk reference assemblies are available. Report any unavailable release signing or actual end-user installer/live AutoCAD checks explicitly.
