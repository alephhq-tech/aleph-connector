# AutoCAD Local IPC RPC Protocol (v0.1)

> **Scope note (2026-10-09)**: This file documents the **Local IPC protocol** only — the named-pipe JSON-RPC between `bridge` and `plugin`, 100% unchanged and still entirely local to this directory. The adjacent **WSS Device Protocol** (Device Gateway ↔ Bridge) now has its hand-authored TypeScript mirror in `aleph-cloud/packages/mcp/autocad/device-protocol`, its RPC method/error catalog in `aleph-cloud/packages/mcp/autocad/wire-protocol`, and its canonical JSON Schema (source of truth) at `aleph-cloud/packages/mcp/autocad/wire-protocol/schemas/device-protocol.schema.json`; the hand-kept C# mirror the Bridge itself consumes stays here at `generated/csharp/DeviceProtocol.cs`. The Remote MCP Server and Device Gateway that call the RPC methods documented below now live in `aleph-cloud/apps/mcp-autocad` and `aleph-cloud/packages/mcp/autocad/device-gateway` — see `aleph-cloud/AGENTS.md` §1/§2.

Canonical contract between `bridge` (client, standalone .NET process, routes by `instanceId`) and `plugin` (server, runs inside each AutoCAD process). This file is the single source of truth — the TypeScript types in `aleph-cloud/packages/mcp/autocad/wire-protocol` and the C# DTOs in `plugin/Dto` must both match it. There is no cross-language codegen (yet); changes land here first, then in both implementations, in the same commit.

This is the innermost hop of the 4-tier architecture (see `AUTOCAD_MCP_PROJECT.md`): `AI Desktop -> Remote MCP Server -> Device Gateway -> Bridge -> `**`this pipe`**`-> AutoCAD Plugin -> AutoCAD`. The Remote MCP Server (`aleph-cloud/apps/mcp-autocad`) and Device Gateway (`aleph-cloud/packages/mcp/autocad/device-gateway`) never see these messages directly — see `generated/csharp/DeviceProtocol.cs` (TypeScript mirror: `aleph-cloud/packages/mcp/autocad/device-protocol`) for the WSS contract one hop further out.

## Transport

- **Channel:** one Windows named pipe per AutoCAD process, path `\\.\pipe\cadai-autocad-{processId}`, where `{processId}` is that AutoCAD process's own PID. Not configurable and no environment variable override: `bridge` enumerates running `acad.exe`/`acadcore.exe` processes and dials each instance's pipe by its PID directly.
- **Framing:** `StreamJsonRpc.HeaderDelimitedMessageHandler` (the StreamJsonRpc default) — `Content-Length: <n>\r\n\r\n<utf8-json>`, identical to the `vscode-jsonrpc` / LSP wire format.
- **Field casing:** every payload is camelCase on the wire (`JsonMessageFormatter.JsonSerializer.ContractResolver = CamelCasePropertyNamesContractResolver`, configured in `plugin/PipeServer.cs`), matching `aleph-cloud/packages/mcp/autocad/cad-types`/`aleph-cloud/packages/mcp/autocad/wire-protocol`'s TypeScript field names exactly, even though both ends are C#.
- **Message format:** JSON-RPC 2.0 requests/responses. No batching, no notifications from client→server (every call expects a reply).
- **One pipe server per AutoCAD process**, one client connection per AutoCAD instance from `bridge`. The plugin accepts a single active connection at a time per pipe and rejects every concurrent connect with `-32025 PipeOccupied` — for **every** catalog method, not just the ones a client happens to poll, so a second client never sees a bare `-32601 MethodNotFound`. The slot is claimed once, at accept time, and a secondary connection is never promoted: the only thing a refused client can usefully do is close its connection and re-dial (which `bridge/IPC/PluginPipeClient.cs` now does). Keeping it open is a permanent latch — that was the bug: a second Bridge (typically a reinstall leaving the previous daemon alive) polled the same refused connection forever and looked like a broken plugin.

## Threading contract (why this file exists)

AutoCAD's managed API (`AcMgd`/`AcDbMgd`/`AcCoreMgd`) may only be touched on AutoCAD's main/UI thread. The named-pipe read loop runs on a background `Task`. Every RPC handler therefore:

1. Deserializes params on the pipe thread (cheap, thread-safe).
2. Enqueues the actual AutoCAD work as a closure onto a `ConcurrentQueue<Func<Task>>`. `MainThreadDispatcher` posts a drain to the UI thread's captured `SynchronizationContext` on every enqueue and also drains from `Application.Idle` as a fallback, so a call doesn't sit unrun until AutoCAD's message loop happens to go idle on its own (autocad-mcp#66).
3. Awaits a `TaskCompletionSource` that the queued closure completes.
4. Any exception thrown inside the closure is captured and surfaced as a JSON-RPC error — never crashes the idle loop. Past 64 pending calls, a new one is refused immediately with `-32001 BridgeBusy` instead of queuing indefinitely (autocad-mcp#73).

Geometry mutations run inside `Database.TransactionManager.StartTransaction()` and are explicitly `Commit()`ed only after every object in the call succeeds; any exception triggers implicit `Dispose()` without `Commit()` (transaction rollback), so a failed multi-entity op never leaves a half-written drawing. Every committed mutation also flushes the viewport (`TransactionManager.QueueForGraphicsFlush`/`FlushGraphics`, `Editor.UpdateScreen`) — AutoCAD does not always repaint on its own for changes made outside a running command (autocad-mcp#66).

`operations.apply`/`undo`/`redo`'s native `_.UNDO`/`_.REDO` commands are only valid from document or command context, not the application context every handler otherwise runs in. Targeting the active document, they run inside `Application.DocumentManager.ExecuteInCommandContextAsync` (`Util/CommandContext.cs`), which waits out — bounded at 2 seconds, then `-32001 BridgeBusy` — a command the user has in progress first. Targeting a background document, they stay in application context under `Document.LockDocument()`; undo grouping there is autocad-mcp#68's open decision. See "Operations batching and undo" in `docs/AUTOCAD_PLUGIN.md`.

## Method namespace

Methods are dot-namespaced strings, matching the MCP tool → operation split one level down (`entity.create` handles every `create_*` operation via a `kind` discriminator, mirroring the consolidated-tool pattern used by other production AutoCAD MCP servers).

| RPC method                    | Direction | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system.status`               | call      | own process id, plugin version, AutoCAD version/build, active doc name, pipe uptime                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `drawing.info`                | call      | doc name, path, entity count, layer count, modified flag, current annotation scale, coarse `revision`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `drawing.summary`             | call      | ONE read-only pass over model space: total entity count, every layer (empty included) with its count, extents (`extents`/`extentsEmpty`), `insUnits`/`linearUnits`/`annotationScale`, block-reference count + top-50 distinct names (`blocksHasMore`), attached xrefs with `status`/`overlay`, up to 30 free-standing text/mtext strings with their layer (`textsHasMore`), up to 30 non-empty block-attribute values each tagged with its `block` name (`blockTexts`/`blockTextsHasMore` — where a title block's project name/drawing number/scale/date actually lives; deduplicated per block name), and layout names (`isActive` only knowable for the active tab). The cheap alternative to paging `entity.list` on a large DWG                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `drawing.save`                | call      | `QSAVE`, or `SAVEAS` when `path` given. `path` is validated (`Util/SavePathValidator.cs`, aleph-platform#5): must be an absolute `.dwg` path, never a UNC/device path, and — once the drawing already has a file of its own — must stay inside that file's own directory (`-32023 PathNotAllowed`). Overwriting an existing file other than the document's own current one needs `overwrite: true` (`-32024 FileExists`). A never-saved drawing with no `path` is `-32021 InvalidOperation`, not a silent write to AutoCAD's own temp/template path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `drawing.listOpen`            | call      | every document open in this process (MDI tabs), name/path/isActive/modified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `drawing.setup`               | call      | apply insUnits/linearUnits/linearPrecision/angularUnits/ltScale/celtScale/dimScale/lwDisplay (allowlisted `Database` properties only, never `SetSystemVariable`/a command string) in one transaction; optional `scale` convenience sets `ltScale = scale * 0.5` (ISO) and `dimScale = scale`; optional `annotationScale` (#74) sets `CANNOSCALE`, adding it to the drawing's scale list first if missing, and defaults `entity.create`'s annotative-capable kinds to `annotative: true` from then on; returns every setting read back from the `Database` after commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `drawing.check`               | call      | read-only quality pass — duplicates/overlaps/zeroLength/openOutlines/layerZero/textSize/dimOverride/offExtents, optionally scoped to `handles`/`layer`/`window`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `drawing.cleanup`             | call      | the safe fixes — duplicates/zeroLength (erase), purge (unused layers), audit (not implemented, always fails) — one transaction + one native undo group, `dryRun` defaults `true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `layer.list`                  | call      | all layers with color/linetype/flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `layer.create`                | call      | create layer if absent (idempotent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `layer.setCurrent`            | call      | set `Database.Clayer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `layer.setProperties`         | call      | patch color/linetype/lineweight/frozen/locked/plottable/on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `layer.ensure`                | call      | idempotent bulk upsert of a whole layer set (create or update, ≤200)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `layer.rename`                | call      | rename a layer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `layer.delete`                | call      | delete a layer (refuses `0`/`Defpoints`/current/in-use)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `entity.create`               | call      | discriminated union, see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `entity.list`                 | call      | paged list of entities in model space (optional `layer`/`kind` filter), `limit` capped at 1000 (`-32006 InvalidGeometry` above it), `offset`; `includeBounds: false` (#10) skips computing each entity's bounding box — the most expensive per-entity work on a large drawing — and returns every entity with no `bounds`; filtering and the `total` count only open entities cheaply (never `Entity.Bounds`), and bounds is computed only for entities on the returned page; `window: {min,max}` restricts the whole pass to one world XY rectangle — only entities whose bounds intersect it count and page, so `total` means "matches the filters" (an entity whose bounds AutoCAD can't compute is included, never silently dropped); `detail: "full"` (#25) returns an `EntityDetail` per entity (geometry + properties beyond layer) instead of `EntitySummary` — default/omitted `"summary"`, today's shape                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `entity.get`                  | call      | single entity by handle; `detail: "full"` (#25) returns an `EntityDetail` (geometry + properties beyond layer) instead of `EntitySummary` — default/omitted `"summary"`, today's shape, see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `entity.areaMeasure`          | call      | read-only native area/perimeter of closed polylines, circles, hatches and regions — scope by `handles` (fast path, opens only those) / `selection: "implied"` (the user's current pick, active tab only) / `window`; every number is AutoCAD's own `Curve.Area`/`Hatch.Area`/`Region.Area`/`Circle.Area` (a hatch already nets its holes out), never a bounding-box or shoelace estimate; `outputUnit: "m2"` also reports square metres but only when the drawing declares usable INSUNITS (a unitless drawing returns `insUnits: "unitless"`, `convertedToM2: false`, no `areaM2`); a closed polyline that is a measured hatch's own associative boundary is flagged `boundaryOfHandle` so the overlap is not double-summed; see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                                                    | `entity.areaMeasure` | call | read-only native area/perimeter of closed polylines, circles, hatches and regions — scope by `handles` (fast path, opens only those) / `selection: "implied"` (the user's current pick, active tab only) / `window`; every number is AutoCAD's own `Curve.Area`/`Hatch.Area`/`Region.Area`/`Circle.Area` (a hatch already nets its holes out), never a bounding-box or shoelace estimate; `outputUnit: "m2"` also reports square metres but only when the drawing declares usable INSUNITS (a unitless drawing returns `insUnits: "unitless"`, `convertedToM2: false`, no `areaM2`); a closed polyline that is a measured hatch's own associative boundary is flagged `boundaryOfHandle` so the overlap is not double-summed; see below |
| `entity.traceBoundary`        | call      | read-only closed-boundary trace from ONE interior point — AutoCAD's own `Editor.TraceBoundary` (the engine behind HATCH pick-points), so a region whose strokes are loose lines or nested inside a merged architecture block still yields its real ring; requires the ACTIVE document (boundary detection evaluates the visible view, same restriction as `selection: "implied"` above); returns outer ring first then island rings (`kind`), each with `points`/`area`/`perimeter`/`isClosed`, plus `netArea`; `found: false` + `reason` when nothing closes around the point — geometry is never estimated, and curve types whose vertices are not readable on a transient object are reported in `reason` instead of invented; the traced curves are transient `DBObject`s that are disposed without a transaction, so no entity is created and the drawing revision does not move. **Coordinate frame (E1):** `Editor.TraceBoundary` evaluates its seed in the document's _active_ UCS, so the plugin maps the WCS seed into UCS before the call and every returned ring back to WCS — the result always reports `coordinateSystem: "WCS"` (rings + `netArea` in world coordinates, matching the contract above) and `ucsWithWorld: true` when the active UCS was not World at trace time, an honesty signal rather than a transform the caller must redo |
| `entity.erase`                | call      | erase by handle(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `entity.transform`            | call      | move / rotate / scale / mirror / copy / arrayRect / arrayPolar / arrayPath by handle(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `entity.update`               | call      | in-place edit of one entity's common properties (`layer`/`color`/`linetype`/`lineweight`, any kind) and/or a per-kind `geometry` patch, keeping its handle stable — see below; `geometry.kind` must match the handle's actual current kind (`-32006 InvalidGeometry` otherwise)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `entity.copyTo`               | call      | Copy entities from one open document's model space into another's (`WblockCloneObjects`; optional `delta`); layers/styles/blocks the copies need are created in the target; not journaled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `view.zoomExtents`            | call      | Fit the view to model-space extents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `view.capture`                | call      | Render model space to a base64 PNG off-screen (`width`/`height`/`background`, framed on `window`, `handles`, or the whole drawing); read-only, works on a background tab without activating it; encoded PNG capped at 2 MB — `-32020 CaptureTooLarge` if a request would exceed it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `view.setLive`                | call      | Set this document's live-drafting follow settings (`follow`/`margin`/`minHeight`/`animate`/`progressive`/`paceMs`); merges given fields over the current settings, returns the effective result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `view.getLive`                | call      | Read this document's current live-drafting settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `view.zoom`                   | call      | Explicit "look here" — `window`, or the union of `handles`' extents, or `center`+`height`; always moves the view (no inside-with-margin no-op check)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `operations.apply`            | call      | batch entity ops in one transaction + one native undo group, `progressive: true` repaints partway through instead of only at the end, see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `operations.preview`          | call      | Read-only preview in an always-aborted AutoCAD transaction; returns native union extents for the proposed entities when measurable, including transformed block geometry, so callers can check complete footprints before applying. |
| `operations.undo`             | call      | undo a batch — only if it's the top of this document's MCP journal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `operations.redo`             | call      | redo a batch — only if it's the most recently undone MCP batch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `operations.history`          | call      | read this document's recent batch journal (no undo/redo side effect)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `style.linetypes.list`        | call      | every linetype currently loaded into this drawing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `style.linetypes.load`        | call      | `Database.LoadLineTypeFile` for each name (default file `acadiso.lin`); an already-loaded name is a no-op, not an error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `style.textStyles.list`       | call      | all `TextStyleTableRecord`s with font/height/widthFactor/obliqueAngle and which one is `Database.Textstyle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `style.textStyles.create`     | call      | create or (`update: true`) overwrite a text style; fails on an existing name otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `style.textStyles.setCurrent` | call      | set `Database.Textstyle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `style.dimStyles.list`        | call      | all `DimStyleTableRecord`s (text height/arrow size/extension offset/extension beyond/decimal places/units format/scale) and which one is `Database.Dimstyle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `style.dimStyles.create`      | call      | create or (`update: true`) overwrite a dimension style, optionally cloning `basedOn`; sets the record's own Dimtxt/Dimasz/Dimexo/Dimexe/Dimdec/Dimlunit/Dimscale, not a per-entity override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `style.dimStyles.setCurrent`  | call      | set `Database.Dimstyle` — every dimension entity created afterward reads this ambient style automatically                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `block.inspect`               | call      | read a block definition's properties (`name`, `explodable`, `isDynamic`, `isAnonymous`, `isLayout`, `isXref`, `referenceCount`) by `blockName` or by a `blockReference`'s `handle` (which also reports instance `layer` and `layerLocked`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `block.setExplodable`         | call      | set `BlockTableRecord.Explodable` (`explodable: true                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | false`) for a block definition across the drawing, targeted by `blockName`or`handle`; requires `sharedScope: true`; refuses layout or xref records |
| `block.explode`               | call      | explode a `BlockReference` instance into its constituent entities; refuses with `-32034` if definition is not explodable (never silently mutates the shared definition)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `block.uniquify`              | call      | clone a block definition into a unique `BlockTableRecord` (`<name>__CadAI_<suffix>`) and redirect targeted reference, isolating instance from shared definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `block.list`                  | call      | enumerate block definitions in the drawing, with optional filters for anonymous, layout, or xref records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `block.ensureDefinition`      | call      | build a `BlockTableRecord` directly from an inline entity list when `blockName` does not already exist in this drawing — no source DWG ever opens; idempotent (an existing name is a no-op, its handle is returned as-is). The first `block` _definition authoring_ tool in the taxonomy; built for Slice 06 of `specs/pccc-cad-drawing-truth/` so a workspace with no symbol-library file can still resolve its default PCCC symbols                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cad.scan`                    | call      | the CAD State Engine's inventory pass: a bounded, paginated read-only walk of the selected space (model space by default; optional `layoutName` selects a named paper-space layout and the resolved name is returned; `offset`/`limit`, optional `layer`/`kind` filter) returning compact entity rows plus a manifest (layers/xrefs/layouts, first page only), bracketed by `revisionBefore`/`revisionAfter` so Cloud can prove the page is internally consistent and discard a snapshot that straddled a user edit; never opens the document for write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cad.changes`                 | call      | the incremental-sync feed: everything the `ChangeTracker` recorded since Cloud's `afterSequence` cursor (entity handles appended/modified/erased, coalesced at command boundaries into a monotonic per-document sequence); `earliestSequence > afterSequence + 1` signals dropped events, so Cloud reconciles instead of applying a partial delta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `edit.begin`                  | call      | capture pre-images and clone targeted entities to dedicated candidate layer (`CadAI-Candidate-<editId>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `edit.apply`                  | call      | execute operations confined strictly to candidate layer and candidate handles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `edit.preview`                | call      | compute structured geometric/property diff, SHA-256 diffDigest, and off-screen before/after PNGs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `edit.status`                 | call      | inspect active session status, candidate handles, pre-image count, and applied mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `edit.discard`                | call      | discard session, erase candidate entities, and delete candidate layer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `edit.accept`                 | call      | compare-and-swap commit: re-layer candidates to source, erase sources in 1 transaction + undo group                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Every method above except `drawing.listOpen` (which inherently covers every open document) takes an optional `documentName` param — the `name` a prior `drawing.listOpen` call returned for the target document. Omit it and the call targets `Application.DocumentManager.MdiActiveDocument` (every method's original, unchanged behavior); pass it to read or mutate a document that isn't the active tab. `Document.LockDocument()` works on any open document, not just the active one, so no tab-switch happens as a side effect. Unknown `documentName` → `-32011 DocumentNotFound`.

All params/results are plain JSON objects — see `aleph-cloud/packages/mcp/autocad/cad-types` for the shared shapes (`Point3d`, `EntityRef`, `LayerInfo`, `ColorSpec`, `AutoCadPluginStatus`) and `aleph-cloud/packages/mcp/autocad/wire-protocol` for the per-method request/response interfaces. Every `Point3d` on this wire is always `{ x, y, z }`; the MCP tool layer (`aleph-cloud/packages/mcp/autocad/tools`) additionally accepts the compact tuple `[x, y]`/`[x, y, z]` (`z` defaults to 0) anywhere a `Point3d` is an input, normalized to `{ x, y, z }` before it reaches this contract (#71, #19).

## Error model

JSON-RPC error codes used beyond the standard `-32600..-32700` range:

| Code   | Name                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| -32001 | `BridgeBusy`                    | a user command is in progress on the active document (`operations.*`), the dispatcher's queue is full, or another operation is mutating this document — the connection itself is fine, retry the same call shortly (autocad-mcp#73)                                                                                                                                                                                                                                                                                                             |
| -32002 | `NoActiveDocument`              | no drawing open in AutoCAD                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -32003 | `EntityNotFound`                | handle does not resolve in the current database                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -32004 | `LayerNotFound`                 | referenced layer does not exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -32005 | `TransactionFailed`             | AutoCAD threw inside the transaction; rolled back, message carries `ex.Message`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -32006 | `InvalidGeometry`               | e.g. zero-radius circle, degenerate polyline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -32007 | `BlockNotFound`                 | `entity.create` kind `blockReference` names a block absent from `BlockTable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -32008 | `UndoNotTop`                    | `operations.undo`/`redo` `batchId` is not the top of this document's MCP journal                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -32009 | `UndoStackDiverged`             | a command ran in AutoCAD since the batch committed; undo/redo refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -32010 | `BatchNotFound`                 | `operations.undo`/`redo`/`history` `batchId` unknown to this document's journal                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -32011 | `DocumentNotFound`              | `documentName` (a full name, a bare file name, or a `documentId`) does not match any open document, or a bare name matches several (candidates in `error.data.open`)                                                                                                                                                                                                                                                                                                                                                                            |
| -32012 | `LayerProtected`                | `layer.delete` on `0`, `Defpoints`, or the current layer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -32013 | `LayerInUse`                    | `layer.delete` on a layer with entities on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -32014 | `LayerNameConflict`             | `layer.rename` `to` names a layer that already exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -32016 | `UndoUnsupported`               | `operations.undo`/`redo` on a batch that ran on a background tab (no native undo group), or targeting a tab that isn't active                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -32015 | `CaptureFailed`                 | `view.capture` could not render (empty drawing, or the graphics system failed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -32017 | `StyleNotFound`                 | `style.*.setCurrent`, `style.dimStyles.create`'s `basedOn`, or a name unknown to the referenced symbol table                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -32018 | `StyleNameConflict`             | `style.textStyles.create`/`dimStyles.create` on an existing name without `update: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -32019 | `AuditUnsupported`              | `drawing.cleanup`'s `audit` fix is not implemented — AutoCAD.NET has no general `Database.Audit(fix)` entry point on its public managed API; fails the whole call before any fix runs                                                                                                                                                                                                                                                                                                                                                           |
| -32020 | `CaptureTooLarge`               | `view.capture`'s rendered PNG, base64-encoded, is over the 2 MB per-capture cap — pass smaller `width`/`height` or scope to fewer `handles`/a tighter `window`                                                                                                                                                                                                                                                                                                                                                                                  |
| -32021 | `InvalidOperation`              | an operation the current state can't perform: `operations.apply`'s batch-local `id`/`@ref` is invalid — duplicate `id`, unknown/forward `@ref`, or an `@ref` that resolved to more than one entity where one handle is required (raised by `server` before any request reaches the bridge); `drawing.open` with no path or `drawing.save` on an unnamed drawing without a path; `entity.areaMeasure` `selection: "implied"` aimed at a background tab (a background tab has no selection set)                                                   |
| -32022 | `ViewFailed`                    | `view.zoom`/`view.zoomExtents` (or a live-follow camera move) was rejected by AutoCAD's view API — the message carries the underlying `ErrorStatus`. Never a raw `-32000` any more; drawing data is untouched either way                                                                                                                                                                                                                                                                                                                        |
| -32023 | `PathNotAllowed`                | `drawing.save`'s `path` failed validation (aleph-platform#5): not an absolute `.dwg` path, a UNC/device path, or — once the drawing has a file of its own — outside that file's own directory. Nothing is written                                                                                                                                                                                                                                                                                                                               |
| -32024 | `FileExists`                    | `drawing.save`'s `path` names a file that already exists and isn't the document's own current file, without `overwrite: true`. Nothing is written                                                                                                                                                                                                                                                                                                                                                                                               |
| -32025 | `PipeOccupied`                  | this connection is not the plugin's one primary connection: another client already holds it and a secondary connection is never promoted. Retrying over the same connection can never work — close it and re-dial. Raised by `plugin/RpcHandlers/BusyHandlers.cs` for every catalog method; the reverse half of the contract is `bridge/IPC/PluginPipeClient.cs`, which drops the connection on exactly this code and on nothing else. Distinct from `-32001 BridgeBusy`, which means the connection is healthy and AutoCAD is temporarily busy |
| -32026 | `EditNotRestorable`             | an entity targeted for editing cannot be rebuilt by `entity.create`/`entity.update` (e.g. `hatch`, kind `other`, rotated `mtext`, variable-width `polyline`, ordinate with a text override). Refuses before cloning                                                                                                                                                                                                                                                                                                                             |
| -32027 | `EditStorageFailed`             | failed to persist the edit session file locally before transaction commit; transaction aborted, no candidate layer or entity created                                                                                                                                                                                                                                                                                                                                                                                                            |
| -32028 | `EditNotFound`                  | `editId` does not match any known active, revalidating, or stored session                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -32029 | `EditDocumentMismatch`          | operation targeted a document different from the one the pre-image was captured in                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -32030 | `EditStalePreImage`             | document revision has advanced or a source entity has changed/erased since the pre-image was captured                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -32031 | `EditConflict`                  | `edit.apply` targeted an entity outside candidate set or candidate modified externally                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -32032 | `EditRequiresHumanApproval`     | `edit.accept` requires human approval via Desktop approval token (Slice 04/06)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -32033 | `EditAlreadyApplied`            | edit session has already been accepted and committed; cannot be accepted a second time                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -32034 | `SharedDefinitionScopeRequired` | mutation would modify a shared block definition (`BlockTableRecord`) affecting multiple references; requires explicit `sharedScope: true`                                                                                                                                                                                                                                                                                                                                                                                                       |
| -32035 | `BlockUniquifyUnsupported`      | block uniquify cannot safely clone the requested block definition (e.g. anonymous/dynamic block, xref, nested block, or missing capability)                                                                                                                                                                                                                                                                                                                                                                                                     |
| -32036 | `RevertConflict`                | dependency conflict prevents selective revert: entity modified since target change set was recorded                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -32037 | `IdempotencyKeyConflict`        | one `idempotencyKey` presented with a different payload: the key already stands for one operation, so the stored result is refused rather than returned for work that was never done, and the new payload is not executed under the old identity (issue #388 §C). The caller retries the original arguments unchanged, or sends the new work under a fresh key. Nothing was sent to AutoCAD                                                                                                                                                     |
| -32038 | `ProtectedEntity`               | an erasure targeted pre-existing user geometry: the plugin refuses to delete entities whose `CADAI` XData ownership stamp is absent, so the caller's own created entities remain erasable while the user's original drawings survive; the human-approved `edit.begin`/`edit.accept` flow or the user's own hand in AutoCAD are the sanctioned routes. `drawing.cleanup` sweeps skip (not refuse) non-CadAI entities and report `skippedProtected`                                                                                               |
| -32039 | `RevisionConflict`              | `operations.apply`'s optional `expectedRevision` did not match `tdu:{Database.Tduupdate.Ticks};saves:{Database.NumberOfSaves}` at the start of execution (#413 phase A, replacing the retired Design Guard's revision probe with a native, caller-optional precondition). Checked before the first phase's transaction opens and only on that phase — zero side effects on a mismatch, `status: "requires_revalidation"`. The caller re-reads the document and retries with the fresh revision                                                  |
| -32040 | `InvalidScope`                  | `view.capture` request specified non-finite window coordinates, degenerate bounds, or handles that could not be resolved to drawable entities. Check entity handles with `entity.list` or verify coordinate window.                                                                                                                                                                                                                                                                                                                             |

## Per-entity write-set precondition (#413 phase B)

`operations.apply` accepts an optional `expectedState: { handle: stateDigest }` map guarding each
handle it is about to mutate (`erase`/`transform`/`update`). The digest is `entity.get` with
`detail: "full"`'s result-level `stateDigest` field: the `PreImageCanonical` digest (canonical
JSON, sorted keys, 1e-6 rounding, FNV-1a-64 → 16 hex) of that entity's **bounds-free** detail —
the same hashing the pre-image journal and the `RevertConflict` check already use. Bounds are
excluded from the digest because view-dependent extents drift without any real edit.

Inside the batch's already-open transaction — atomic with the mutation it guards — each mapped
handle's live digest is recomputed. A mismatch **skips only that handle** (zero mutation, no
pre-image, no journal entry for it) and appends `{ handle, expected, actual, reason:
"state_conflict" }` to the result's `conflicts` array; every other handle in the batch proceeds
and the overall `status` stays `"committed"`. A handle with no entry, and the map being absent
entirely, is never checked — the same opt-out semantics as phase A's `expectedRevision`.
Unresolvable handles (erased since the caller's read) pass through unreported: "the entity is
gone" is not a stale-fingerprint signal, and those handles already skipped silently before.

Deliberately a **result field, not an error code**: a conflict-aware partial skip is a truthful
success, and inventing a fatal `EntityStateConflict` code would re-implement phase A's
all-or-nothing granularity at entity scope, which is exactly what #413 phase B replaces. Use
`expectedState` instead of `expectedRevision` when unrelated concurrent edits elsewhere in the
drawing must not veto this batch; the two are independent and may both be sent (phase A's
whole-document gate still fails the whole batch first if the document-level revision moved).

## Idempotency keys (#9, hardened by #388 §C)

Every mutating method accepts `idempotencyKey`; `plugin/Util/Idempotency.cs` wraps each mutating handler in `Journal/IdempotencyCache.cs` (per-document, bounded LRU, 200 entries — mirrored by the server's `MockBridgeClient.ts` for tests). A hit returns the stored result without starting the transaction, so a client retry after a timeout never duplicates the mutation.

A key is an **identity**, not a label: the entry records the canonical digest (`Edits/PreImageCanonical.HashRequest`) of the payload that first claimed it, and the same key arriving with different parameters throws `-32037` instead of answering with the stored result or re-executing under the old identity. The canonicalizer drops the volatile envelope fields (`idempotencyKey`, `view`, `result`, `dryRun`, `progressive`, `ensureLayer`, `timeoutMs`), so a genuine retry — same work, different view — still matches while one changed coordinate does not.

Aleph Cloud does not let the model author these keys for its own retries: `McpCapabilityProvider` stamps the coordinator's server-minted `operationId` out-of-band in the MCP request's `_meta` under `aleph.io/operation`, and the AutoCAD MCP server uses it as the idempotency identity (falling back to a model-supplied `idempotencyKey`, then to the JSON-RPC request id, for clients that stamp nothing). The `operationId` is deliberately NOT suffixed with the request id: a whole-turn retry carries the same `operationId` on a fresh JSON-RPC id, and that is exactly what makes the retry dedupe at the source instead of applying the write twice.

## `drawing.listOpen` payload

```ts
type DrawingListOpenParams = Record<string, never>;
interface DrawingListOpenResult {
  documents: {
    name: string;
    path: string | null;
    isActive: boolean;
    modified: boolean | null;
  }[];
}
```

Enumerates `Application.DocumentManager` — every document open in this AutoCAD process (MDI tabs), not just `drawing.info`/`system.status`'s single `activeDocument`. Read-only, no document lock. `modified` is `null` for every non-active document: AutoCAD's `DBMOD` system variable only reflects the currently active document's context, and this listing must not switch tabs (a side effect) just to read a background document's dirty state — so `null` means "not knowable from here," never a false "unmodified" claim. `drawing.info`'s own `modified` field has the identical nullability when called with a non-active `documentName`. Every other RPC method's `documentName` param (see "Method namespace" above) is how a caller acts on one of the documents this method lists.

## `drawing.setup` payload (#62, `annotationScale` #74)

```ts
interface DrawingSetupParams {
  insUnits?: "unitless" | "mm" | "cm" | "m" | "in" | "ft"; // Database.Insunits
  linearUnits?: "decimal" | "architectural" | "engineering"; // Database.Lunits
  linearPrecision?: number; // 0-8, Database.Luprec
  angularUnits?: "decimalDegrees" | "radians"; // Database.Aunits; display only, API stays radians
  ltScale?: number; // > 0, Database.Ltscale
  celtScale?: number; // > 0, Database.Celtscale
  dimScale?: number; // > 0, Database.Dimscale
  lwDisplay?: boolean; // Database.LineWeightDisplay
  scale?: number; // > 0, convenience: sets ltScale = scale * 0.5 (ISO) and dimScale = scale
  annotationScale?: string; // "paper:drawing", e.g. "1:100" — sets CANNOSCALE (Database.Cannoscale)
  documentName?: string;
}
interface DrawingSetupResult {
  insUnits: "unitless" | "mm" | "cm" | "m" | "in" | "ft";
  linearUnits: "decimal" | "architectural" | "engineering";
  linearPrecision: number;
  angularUnits: "decimalDegrees" | "radians";
  ltScale: number;
  celtScale: number;
  dimScale: number;
  lwDisplay: boolean;
  annotationScale: string; // current CANNOSCALE name, e.g. "1:1" on a drawing that never set it
}
```

Write counterpart to `drawing.info` (#29): sets the handful of drawing-scope settings the `UN`/ `LTSCALE`/`LW` commands change, via the typed `Database` properties above inside one transaction — never `Application.SetSystemVariable` with an arbitrary name, and never a command string (an AGENTS.md invariant against raw system-variable/command injection). Every field is optional and independently applied; an omitted field is left untouched. `scale` is a convenience only: it also sets `ltScale`/`dimScale` unless those are given explicitly in the same call, in which case the explicit value wins. `linearPrecision` outside 0-8, an unknown enum value, or any key outside this allowlist is rejected by the MCP `drawing` tool's zod input schema (`contracts/mcp-tools` `drawingSetupParams`).

`annotationScale` (#74) sets `Database.Cannoscale` to the named "paper:drawing" scale (`AnnotationScale.PaperUnits`/`DrawingUnits`), adding it to the drawing's scale list first if it isn't already there (`Database.ObjectContextManager.GetContextCollection("ACDB_ANNOTATIONSCALES")`, an `ObjectContextCollection`). From that call on — for this document only — `entity.create`'s `mtext`/`text.singleLine`/`dimension.linear`/`dimension.aligned`/`dimension.ordinate`/`hatch` kinds default their own `annotative` field to `true` (see "Annotative text/dimensions/hatch" below); this default is plugin-memory state (`Util/Annotation.cs`, a per-document dictionary mirroring `Util/LiveView.cs`'s own posture), not persisted across a plugin reload/AutoCAD restart. A malformed `annotationScale` (not `"number:number"` with both parts > 0) fails with `-32006 InvalidGeometry`.

## `drawing.check` / `drawing.cleanup` payload

```ts
type DrawingCheckKind =
  | "duplicates"
  | "overlaps"
  | "zeroLength"
  | "openOutlines"
  | "layerZero"
  | "textSize"
  | "dimOverride"
  | "offExtents";

interface DrawingCheckParams {
  scope?: { handles?: string[] } | { layer?: string } | { window?: { min: Point3d; max: Point3d } };
  checks?: DrawingCheckKind[]; // default: all eight
  documentName?: string;
}
interface DrawingCheckResult {
  findings: {
    check: DrawingCheckKind;
    severity: "info" | "warning" | "error";
    handles: string[];
    message: string;
    fix?: "duplicates" | "zeroLength" | "purge" | "audit"; // present only when drawing.cleanup can act on this finding
  }[];
}

interface DrawingCleanupParams {
  fixes: ("duplicates" | "zeroLength" | "purge" | "audit")[];
  dryRun?: boolean; // default true
  documentName?: string;
}
interface DrawingCleanupResult {
  dryRun: boolean;
  applied: { fix: string; count: number; handles?: string[] }[]; // handles omitted for purge (acts on layers, not entities)
}
```

`check` is read-only (never opens an entity `ForWrite`); scope resolution is first-match-wins (`handles`, else `layer`, else `window`, else the whole drawing), but the tolerance — `1e-6 × the whole drawing's extents diagonal` — is always computed over every entity regardless of scope, matching `aleph-cloud/apps/mcp-autocad/src/bridge/MockBridgeClient.ts`'s mock exactly. `textSize` is a documented simplification until annotative text (a separate feature) exists: it flags a text/mtext entity whose height matches no height used by ≥2 _other_ text entities on the same layer, not the true paper-height × annotation-scale rule. `overlaps` (collinear line segments) has no cleanup fix — only a human can decide whether to trim, extend, or leave them. `cleanup`'s `duplicates`/`zeroLength` re-run the matching `check` internally and erase what it finds (`duplicates` keeps the first entity in each group); `purge` removes any layer with no referencing entity, never `0`/`Defpoints`/the current layer; `audit` has no real implementation — `Database`'s public managed API exposes no general "audit and fix this document" entry point (only `AuditXData`, which audits one object's custom xdata) — so any call naming `audit` in `fixes` fails whole-batch with `-32019 AuditUnsupported` before any other fix runs, rather than silently no-op or fake success. A non-dry-run cleanup on the active document runs inside one `_.UNDO _Group`/`_End` pair, same as `operations.apply`.

## `entity.create` payload (`kind` discriminator)

```ts
type CreateEntityParams =
  | { kind: "line"; layer?: string; start: Point3d; end: Point3d }
  | { kind: "circle"; layer?: string; center: Point3d; radius: number }
  | {
      kind: "arc";
      layer?: string;
      center: Point3d;
      radius: number;
      startAngle: number;
      endAngle: number;
    }
  | {
      kind: "polyline";
      layer?: string;
      points: Point3d[];
      closed?: boolean;
      bulges?: number[];
      constantWidth?: number;
    }
  | { kind: "rectangle"; layer?: string; corner1: Point3d; corner2: Point3d }
  | {
      kind: "mtext";
      layer?: string;
      insertion: Point3d;
      text: string;
      height?: number;
      width?: number;
      paperHeight?: number; // mm on paper (#74) — overrides height with paperHeight * current CANNOSCALE's drawing-units-per-paper-unit factor
      annotative?: boolean; // defaults to this document's annotative-default (drawing.setup annotationScale) when omitted
    }
  | {
      kind: "text.singleLine";
      layer?: string;
      insertion: Point3d;
      text: string;
      height?: number;
      rotation?: number;
      paperHeight?: number; // same rule as mtext's paperHeight
      annotative?: boolean;
    }
  | {
      kind: "blockReference";
      layer?: string;
      blockName: string;
      position: Point3d;
      scale?: Point3d;
      rotation?: number;
      attributes?: Record<string, string>;
    }
  | {
      kind: "dimension.linear";
      layer?: string;
      extLine1: Point3d;
      extLine2: Point3d;
      dimLinePoint: Point3d;
      dimText?: string;
      rotation?: number; // dimension line angle, radians: 0 horizontal (default), PI/2 vertical
      annotative?: boolean; // assigns the on-demand CadAI-Annotative dim style instead of Database.Dimstyle
    }
  | {
      kind: "dimension.aligned";
      layer?: string;
      extLine1: Point3d;
      extLine2: Point3d;
      dimLinePoint: Point3d;
      dimText?: string;
      annotative?: boolean;
    }
  | {
      kind: "dimension.ordinate";
      layer?: string;
      origin: Point3d; // ordinate datum (UCS origin the X/Y values are measured from)
      featurePoint: Point3d; // point on the geometry being called out
      leaderEndPoint: Point3d;
      axis: "x" | "y";
      annotative?: boolean;
    }
  | {
      kind: "hatch";
      layer?: string;
      // Exactly one of boundaryHandles or loops is present.
      boundaryHandles?: string[]; // legacy: all handles joined into one loop
      loops?: Array<
        | { handles: string[] } // reuse existing closed-curve entities
        | { points: Point3d[]; bulges?: number[] } // polyline loop, no boundary entity created
        | { circle: { center: Point3d; radius: number } } // circular loop, no boundary entity created
      >; // loops[0] = outer (Outermost), rest = islands (Default)
      pattern?: string;
      patternScale?: number;
      patternAngle?: number;
      style?: "normal" | "outer" | "ignore";
      associative?: boolean; // only meaningful for handles-loops
      annotative?: boolean;
    };
```

Angles are radians (matches `Autodesk.AutoCAD.Geometry`), points are `{ x, y, z }` in drawing units (model space, WCS).

`blockReference` places a reference to a block **already present** in the drawing's `BlockTable` — there is no `entity.create` support for authoring new block _definitions_ (a separate, future feature). `attributes` maps `AttributeDefinition.Tag` → value for the block's attribute definitions; unrecognized tags are ignored, unsupplied tags keep the block's default text.

`polyline`'s `bulges`/`constantWidth` are wire-only — no MCP tool exposes raw bulge input. The MCP server's shape-preset expansion (`aleph-cloud/apps/mcp-autocad/src/tools/normalize.ts`, `aleph-cloud/apps/mcp-autocad/src/construct/shapes.ts`) sets them for a rounded (`fillet`) `rectangle` and for `donut`, resolving every other preset (`polygon`, `polygon.edge`, rotated/chamfered `rectangle`, `arc.threePoint`, `arc.startEndRadius`, `circle.twoPoint`, `circle.threePoint`) to the plain kinds above before this call ever reaches the plugin.

`dimension.chain` is an `entity.create`/`operations.apply` **kind that never reaches this wire**: `aleph-cloud/apps/mcp-autocad/src/tools/normalize.ts`'s `expandEntity` expands it, server-side, into N plain `dimension.linear` steps (`{ points, mode: "continue" | "baseline", direction: "horizontal" | "vertical" | { rotation }, offset, spacing? }` → `continue`: consecutive point pairs, one dim line each; `baseline`: every point measured from `points[0]`, stacked at `offset + i * spacing`). `spacing` defaults to a fixed 3.75x the tool's default text height (9.375) — real AutoCAD's DIMBASELINE spacing (`DIMDLI`) is a live per-document system variable this expansion has no document to read, so pass `spacing` explicitly to match a real drawing. `< 2` points, `offset === 0`, or duplicate consecutive points all reject with `-32006 InvalidGeometry` before anything is sent. A standalone `entity.create` with this kind is sent as a one-step `operations.apply` batch under the hood so the whole chain is still one transaction/undo step.

`hatch`'s legacy `boundaryHandles` must reference existing closed-curve entities already created via `entity.create` (e.g. a closed `polyline` or a `circle`), all joined into one loop (unchanged, #58). The `loops` form (mutually exclusive with `boundaryHandles`) hatches a slab-with-a-hole, a wall section with a window, or a ring in one call: `loops[0]` is the outer boundary (`HatchLoopTypes.Outermost`), every later entry an island (`HatchLoopTypes.Default`); `{ handles }` reuses existing closed-curve entities the same way `boundaryHandles` does; `{ points, bulges? }` and `{ circle }` both build a polyline-style loop (`Hatch.AppendLoop(HatchLoopTypes, Point2dCollection, DoubleCollection)` — a circle is the standard two-vertex bulge-`1.0` trick, since the SDK exposes no `BulgeVertexCollection` or plain-curve `AppendLoop` overload) with **no boundary entity created in the drawing**. `associative` only matters for `handles`-loops (a point/circle loop has no boundary curve to associate with). `style` maps to `HatchStyle` (`normal`/`outer`/`ignore`). `pattern` is validated only by `Hatch.SetHatchPattern` itself — the AutoCAD .NET SDK has no enumerable "list every predefined pattern" surface to pre-check against, so an unknown name throws inside the plugin and is mapped to `InvalidGeometry`, same as an open or self-intersecting loop caught out of `AppendLoop`/`EvaluateHatch`.

`arrayRect { handles, rows, columns, rowSpacing, columnSpacing, angle? }` copies the sources to every row/column position except their own (row-major; one copy per source per position; spacings along +X/+Y before `angle`, negative values build the other way). `arrayPolar { handles, center, count, fillAngle? = 2π, rotateItems? = true }` places `count` items including the source; with `rotateItems: false` each copy is moved so its extents centre follows the circle. `arrayPath { handles, path: { handle } | { points }, count?, spacing?, align? }` places items at equal arc-length spacing along an existing curve entity's handle (line/arc/polyline — the plugin accepts any `Curve`-derived entity; the wire/mock support line/arc/polyline) or an explicit straight-segment `points` path — exactly one of `count`/`spacing` is required: `count` divides the whole path into `count - 1` equal gaps including both endpoints (AutoCAD ARRAYPATH's "Divide" method); `spacing` places items every `spacing` from the path's start, with no item past the end (its "Measure" method). `align` (default `true`, matching `arrayPolar`'s `rotateItems` default) rotates each copy about its own extents centre to the path's local tangent-angle change since the start; `false` only translates. All three are non-associative (`Clone()` + `TransformBy`, no AutoCAD `ARRAY` object) and return the new refs; the MCP server rejects arrays over 5,000 copies before calling the plugin — except `arrayPath` `spacing` mode with a `path.handle` (its length is only known once resolved), where the same cap is enforced after resolving the path, inside `MockBridgeClient`/`EntityHandlers.ApplyArrayPath` instead.

`entity.transform` `copy`/`mirror`/arrays on a `blockReference` clones the reference and its geometry but does not deep-clone attribute values (a known limitation — `DBObject.Clone()` does not cascade to owned `AttributeReference` children); use `move`/`rotate`/`scale` for attributed blocks.

## `entity.update` payload (#26)

```ts
interface EntityUpdateParams {
  handle: string;
  documentName?: string;
  view?: ViewOverride;
  // Common properties — apply to any kind via the entity's base Entity/DBObject properties.
  layer?: string;
  color?: ColorSpec;
  linetype?: string;
  lineweight?: number;
  geometry?: EntityUpdateGeometry;
}

type EntityUpdateGeometry =
  | { kind: "line"; start?: Point3d; end?: Point3d }
  | { kind: "circle"; center?: Point3d; radius?: number }
  | { kind: "arc"; center?: Point3d; radius?: number; startAngle?: number; endAngle?: number }
  | { kind: "polyline"; closed?: boolean }
  | { kind: "mtext"; insertion?: Point3d; text?: string; height?: number; width?: number }
  | {
      kind: "text.singleLine";
      insertion?: Point3d;
      text?: string;
      height?: number;
      rotation?: number;
    }
  | {
      kind: "blockReference";
      position?: Point3d;
      scale?: Point3d;
      rotation?: number;
      attributes?: Record<string, string>;
    }
  | {
      kind: "dimension.linear";
      extLine1?: Point3d;
      extLine2?: Point3d;
      dimLinePoint?: Point3d;
      dimText?: string;
      rotation?: number;
    }
  | {
      kind: "dimension.aligned";
      extLine1?: Point3d;
      extLine2?: Point3d;
      dimLinePoint?: Point3d;
      dimText?: string;
    }
  | {
      kind: "dimension.ordinate";
      origin?: Point3d;
      featurePoint?: Point3d;
      leaderEndPoint?: Point3d;
    }
  | { kind: "hatch"; pattern?: string; patternScale?: number; patternAngle?: number };

interface EntityUpdateResult {
  entity: EntitySummary; // same shape entity.create/transform/get already return
}
```

`entity.update` is the in-place alternative to erase+recreate for everything short of changing an entity's kind: its handle never changes, so references to it (hatches that reuse it as a boundary, the caller's own notes) stay valid. Every field, common and `geometry`'s, is optional — only the fields actually given change; everything else keeps its exact current value. `EntityHandlers.Update` opens the handle `ForWrite` inside a transaction, applies common properties first (`Layer`/`Color`/`Linetype`/`LineWeight`, the same validation `layer.setProperties` already does — unknown layer is `-32004 LayerNotFound`, unloaded linetype is `-32006 InvalidGeometry`), then — if `geometry` is given — reads the entity's **actual** current kind (`EntityKindResolver.KindOf`, never trusted from the caller) and checks it against `geometry.kind` before touching anything; a mismatch throws `-32006 InvalidGeometry` and the whole call (including any common properties already staged in the same transaction) rolls back untouched. Commit/`ScreenRefresh`/`view.setLive` follow happen exactly as every other mutating `entity.*` call.

**Non-goals** (still erase+recreate territory): changing an entity's `kind` (a circle can't become a line), and changing a `polyline`'s vertex count — `geometry`'s `polyline` case only has `closed`, not `points`. There is no `rectangle` case in `EntityUpdateGeometry` at all: AutoCAD has no native Rectangle entity, so a `rectangle` created via `entity.create` is already reported back by `entity.get`/`list`/`create` itself as kind `"polyline"` (see `EntityKindResolver`'s own doc comment) — no stored entity's actual kind is ever `"rectangle"` to patch.

`blockReference`'s `attributes` sets `AttributeReference.TextString` on each of the block reference's **existing** attribute references whose `Tag` is a key in the map (same lookup `ApplyBlockAttributes` does at create time) — a tag absent from the map, or naming an attribute the block reference doesn't have, is left/ignored; this never creates or removes an attribute reference (block definitions aren't mutated by `entity.update`).

## Annotative text/dimensions/hatch (#74)

`annotative?: boolean` on `mtext`, `text.singleLine`, `dimension.linear`/`aligned`/`ordinate`, and `hatch`: when the resolved value (the field itself, or — when omitted — this document's annotative-default set by `drawing.setup`'s `annotationScale`) is `true`, `EntityHandlers.CreateOne` calls `Util/Annotation.cs`'s `Mark(db, entity)` on the newly appended entity: sets `Entity.Annotative = AnnotativeStates.True` and, if the document has a current `CANNOSCALE` context, adds it to the entity's supported-scale list (`DBObject.AddContext`) — the standard "make this object annotative and pick it up at the scale it was drawn" sequence. `false`/omitted-with-no-document-default behaves exactly as every pre-#74 call: `Entity.Annotative` is left at its default (`AnnotativeStates.NotApplicable`/unset).

`mtext`/`text.singleLine` additionally get an annotative-capable text style, and `dimension.linear`/`aligned`/`ordinate` an annotative-capable dimension style: both on-demand, named `CadAI-Annotative`, created the first time any document needs one (`TextStyleTableRecord`/`DimStyleTableRecord.Annotative = AnnotativeStates.True`) via `StyleHandlers.GetOrCreateTextStyle`/`GetOrCreateDimStyle` — the exact same "find, or add a new blank record" plumbing `style.textStyles.create`/`style.dimStyles.create` use, not a second copy of it. An annotative dimension is assigned this style's `ObjectId` instead of the ambient `Database.Dimstyle`; a non-annotative one is unaffected (still `Database.Dimstyle`, unchanged).

`mtext`/`text.singleLine`'s `paperHeight` (millimetres on paper) computes the actual model-space `TextHeight`/`Height` as `paperHeight * Util/Annotation.cs's CurrentScaleFactor(db)` (`AnnotationScale.DrawingUnits / PaperUnits` of the document's current `CANNOSCALE` — e.g. 100 for "1:100"), so the caller never does that multiplication by hand; it takes priority over `height` when both are given, and applies regardless of the entity's own `annotative` value (so a fixed one-time paper-to-model conversion is still available even for a non-annotative entity). Omitting `paperHeight` behaves exactly as before: `height` (default 2.5) is used verbatim.

**Verified**: the `paperHeight` → model-height math (`bun test` against the pure computation and against `MockBridgeClient`'s recorded `height`/`paperHeight`/`annotative` debug fields on the created entity — not wire/`EntitySummary` fields, same convention as hatch's own `loops`/`pattern` debug fields, #58), `bun run smoke`, `dotnet build` (every `AnnotativeStates`/`ObjectContextManager`/`AnnotationScale`/`DBObject.AddContext`/`.Annotative` call compiles against the real `AutoCAD.NET.Model` assembly). **Not verified against real AutoCAD** (no install in this environment): whether an annotative MText actually renders at the paper-scaled size on screen, and whether switching `CANNOSCALE` to a second scale already on the drawing's scale list re-renders it at that scale live — both are AutoCAD's own annotation-scale display machinery, inherent to `Entity.Annotative`/`ObjectContextManager` and not something this plugin computes or can observe without a real AutoCAD session.

## `entity.get`/`entity.list` `detail: "full"` payload (`EntityDetail`, #25)

`detail?: "summary" | "full"` on `entity.get`'s params and `entity.list`'s params; default/omitted `"summary"` returns exactly today's `EntitySummary` (`{handle,kind,layer,bounds?}`), byte-for-byte — every existing caller is unaffected. `detail: "full"` returns an `EntityDetail` per entity instead: `EntitySummary`'s fields plus `properties` (common fields beyond `layer`) and a `geometry` object whose shape depends on `kind` — a discriminated union mirroring `CreateEntityParams`'s own shape.

```ts
interface EntityCommonProperties {
  color: ColorSpec; // ByLayer = { aci: 256 }, ByBlock = { aci: 0 }, same convention as LayerInfo.color
  linetype: string; // "ByLayer" / "ByBlock" / a real linetype name
  linetypeScale: number;
  lineweight: number; // raw LineWeight enum value (ByLayer -1, ByBlock -2, e.g. 25 = 0.25mm)
  transparency?: number; // 0 (fully transparent) – 100 (opaque); omitted when ByLayer/ByBlock (no per-entity override)
  visible: boolean;
}

interface PolylineVertex {
  point: Point3d;
  bulge?: number; // omitted when 0 (straight segment)
  startWidth?: number; // omitted when 0
  endWidth?: number; // omitted when 0
}

type EntityDetail = EntityRef & {
  bounds?: { min: Point3d; max: Point3d };
  properties: EntityCommonProperties;
} & (
    | { kind: "line"; geometry: { start: Point3d; end: Point3d; length: number } }
    | { kind: "circle"; geometry: { center: Point3d; radius: number } }
    | {
        kind: "arc";
        geometry: { center: Point3d; radius: number; startAngle: number; endAngle: number };
      }
    | {
        kind: "polyline";
        geometry: { vertices: PolylineVertex[]; closed: boolean; length: number; area?: number };
      } // a created "rectangle" always reads back as kind "polyline" — no separate EntityDetail variant
    | {
        kind: "mtext";
        geometry: {
          insertion: Point3d;
          text: string;
          height: number;
          rotation: number;
          width?: number;
          style: string;
        };
      }
    | {
        kind: "text.singleLine";
        geometry: {
          insertion: Point3d;
          text: string;
          height: number;
          rotation: number;
          style: string;
          widthFactor?: number; // omitted when 1 (AutoCAD's default)
        };
      }
    | {
        kind: "blockReference";
        geometry: {
          blockName: string;
          position: Point3d;
          scale: Point3d;
          rotation: number;
          attributes?: Record<string, string>; // every non-constant AttributeReference actually on the block, omitted when there are none
        };
      }
    | {
        kind: "dimension.linear";
        geometry: {
          extLine1: Point3d;
          extLine2: Point3d;
          dimLinePoint: Point3d;
          rotation: number;
          measurement: number; // the real Dimension.Measurement, not an echo of extLine1/extLine2
          text: string; // Dimension.DimensionText — the actual displayed text, honoring the dim style's formatting
        };
      }
    | {
        kind: "dimension.aligned";
        geometry: {
          extLine1: Point3d;
          extLine2: Point3d;
          dimLinePoint: Point3d;
          measurement: number;
          text: string;
        };
      }
    | {
        kind: "dimension.ordinate";
        geometry: {
          origin: Point3d;
          featurePoint: Point3d;
          leaderEndPoint: Point3d;
          axis: "x" | "y";
          measurement: number;
          text: string;
        };
      }
    | {
        kind: "hatch";
        geometry: {
          pattern: string;
          patternScale: number;
          patternAngle: number;
          associative: boolean;
          loopCount: number;
          loopTypes: string[]; // Hatch.LoopTypeAt(i).ToString() per loop, index-aligned — loop count/types only, never a full vertex dump
          area?: number;
        };
      }
    | { kind: "other"; geometry: { dxfName: string } } // any CLR entity type EntityKindResolver.cs doesn't otherwise name
  );
```

`EntityKindResolver.KindOf`'s catch-all returns `"other"` (a real `EntityKind` member) for every CLR entity type this server can't create (`Spline`, `Ellipse`, `DBPoint`, `Leader`, `MLeader`, `Table`, `Solid3d`, `Region`, `Xline`, `Ray`, `Polyline2d`/`Polyline3d`, `RadialDimension`, `DiametricDimension`, an angular/arc-length dimension, `AttributeDefinition`, `Wipeout`, `RasterImage`, `Face`, …) — never the old "unknown" string, which wasn't even part of the TS `EntityKind` union. `entity.list`'s `kind` filter accepts `"other"` too.

Plugin-side, `EntityHandlers.ToDetail`/`ToProperties`/`BuildGeometry` read every field straight off the live entity (`Circle.Center`/`Radius`, `Line.StartPoint`/`EndPoint`/`Length`, `Polyline.GetBulgeAt`/`GetStartWidthAt`/`GetEndWidthAt`/`Area`, the three `Dimension` subclasses' `Measurement`/`DimensionText`, `Hatch.PatternName`/`NumberOfLoops`, …) — never a second copy of what `entity.create` originally received. `MockBridgeClient` builds the same shape from its existing `entityGeometry` map (the full `CreateEntityParams` it already records per handle for `drawing.check`), with mock-only `properties` (every mock entity is ByLayer/visible — `entity.create` has no per-entity color/linetype override today).

## Pre-image restorability contract (#282 PR B slice 01 — **types defined, no method uses them yet**)

Slice 01 fixes the vocabulary the edit flow will carry; it adds **no** pipe method. `entity.preimage` and `edit.begin` (slice 02) are where `Restorability` first crosses this pipe, so nothing below is emitted by any shipped handler today. The shapes live in `aleph-cloud/packages/mcp/autocad/wire-protocol/local-ipc/methods.ts` (`RestoreVerdict`, `Restorability`, `PreImageDocumentIdentity`, `EntityPreImage`) and in `plugin/Edits/Restorability.cs` / `plugin/Edits/EntityPreImage.cs`.

```ts
// camelCase strings on the wire, never an ordinal, so inserting a member cannot renumber stored verdicts.
type RestoreVerdict = "supported" | "notSupported" | "unknownKind";

interface Restorability {
  verdict: RestoreVerdict;
  kind: string; // NOT EntityKind: unknownKind verdicts carry kind names outside that union
  reason: string | null; // populated whenever verdict is not 'supported'
  unsupportedFeatures: string[]; // fields that will not round-trip even when verdict IS 'supported'
}

interface PreImageDocumentIdentity {
  documentId: string;
  fingerprintGuid: string | null; // Database.FingerprintGuid hex (no braces); null on an unsaved new drawing
  path: string | null;
}

interface EntityPreImage {
  detail: EntityDetail; // exactly the `detail: "full"` payload documented above — no parallel geometry model
  revisionAtCapture: string | null; // Database.Tduupdate.Ticks + NumberOfSaves at capture
  document: PreImageDocumentIdentity;
  capturedAtUtc: string; // ISO-8601; EXCLUDED from the digest, which covers `detail` alone
}
```

The per-kind verdict table (`line`/`circle`/`arc`/`mtext` unrotated/`polyline` with uniform widths/`text.singleLine`/`blockReference`/the three dimensions -> `supported`; `hatch`, `other`, rotated MText, variable-width polyline, ordinate with a text override -> `notSupported` with a reason naming the field; anything else -> `unknownKind`) and the serialized field names above are pinned by `contracts/preimage-contract-vectors.json` — generated by `bun run gen:preimage-vectors` from `aleph-cloud/`, asserted by the C# `plugin.Tests/Edits/RestorabilityTests.cs` and the TS `apps/mcp-autocad/src/tools/edit.test.ts` against the same file. The pre-image digest is the design guard's canonical fingerprint (`aleph-cloud/packages/engineering/src/spatial/fingerprint.ts`) over `detail` alone, ported to C# in `plugin/Edits/PreImageCanonical.cs`; both halves are checked against that fixture's `vectors` table.

## `entity.areaMeasure` payload (native area/perimeter)

```ts
type EntityAreaMeasureParams = {
  handles?: string[]; // fast path: opens exactly these entities, never scans model space
  selection?: "implied"; // the user's current pick (Editor.SelectImplied); active tab only
  window?: { min: Point3d; max: Point3d }; // world XY rectangle over model space
  outputUnit?: "m2"; // also report square metres, only when INSUNITS are usable
  documentName?: string;
};

type AreaMeasureMethod = "polyline-area" | "hatch-area" | "region-area" | "circle-area";

type AreaMeasureStatus =
  | "measured" // areaDrawingUnits2 (and areaM2 when converted) present
  | "open_boundary" // an area-bearing curve with Closed=false — no enclosed region
  | "ambiguous_region" // a line/arc a window/implied scope matched — which region was meant is ambiguous
  | "unsupported_geometry"; // AutoCAD refused Area (self-intersecting/unevaluable) or returned non-finite

type AreaMeasureRegion = {
  handle: string;
  kind: string; // EntityKindResolver.KindOf — polyline/circle/hatch/region/…
  layer: string;
  status: AreaMeasureStatus;
  method?: AreaMeasureMethod; // which native property produced the number, present iff measured
  areaDrawingUnits2?: number; // square drawing units, straight from AutoCAD
  areaM2?: number; // only when INSUNITS usable AND outputUnit "m2"
  perimeterDrawingUnits?: number; // closed polyline Length / Region.Perimeter / Circle.Circumference
  loopCount?: number; // hatch only
  holeLoopCount?: number; // hatch only — loops without the Outermost flag, already netted out of area
  boundaryOfHandle?: string; // this closed polyline IS a measured hatch's own associative boundary
  message?: string; // why a non-measured status was returned, or the do-not-double-sum note
};

type EntityAreaMeasureResult = {
  documentId: string;
  documentName: string;
  revision: string; // same tdu:…;saves:… string drawing.info reports
  insUnits: InsUnits; // the INSUNITS the conversion (or refusal) was based on
  convertedToM2: boolean; // true iff areaM2 values are present
  regions: AreaMeasureRegion[];
  skippedNonAreaCount: number; // scope-matched entities with no area at all (text/dimension/block/…), counted not guessed
};
```

Scope is first-match-wins: `handles`, else `selection: "implied"`, else `window`; none of the three is `-32006 InvalidGeometry`. A `handles` entry that doesn't resolve is `-32003 EntityNotFound`, never silently skipped. `selection: "implied"` on a background tab is `-32021 InvalidOperation` (a background tab has no selection set).

Every number comes from AutoCAD's own geometry engine — `Polyline.Area`/`Curve.Area` for closed curves, `Circle.Area`/`Circumference`, `Hatch.Area` (already the net of every loop, outer minus holes), `Region.Area`/`Perimeter`. The tool never substitutes a bounding-box or shoelace estimate: an open curve is `open_boundary`, a line/arc matched by a region query is `ambiguous_region`, and a refused `Area` (the `Autodesk.AutoCAD.Runtime.Exception` AutoCAD throws, or a non-finite return) is `unsupported_geometry` with the underlying message. The m² conversion goes through one table (`Util/UnitFormat.cs`'s `SquareMetersPerUnitSquared`: mm 1e-6, cm 1e-4, m 1, in 0.00064516, ft 0.09290304); INSUNITS `Undefined` or a unit outside the wire vocabulary yields `convertedToM2: false` and no `areaM2` at all — the drawing-units-squared figure is still returned.

The one double-count the plugin can prove is flagged rather than silently dropped: when a measured hatch and a measured closed polyline are the same region (the polyline is the hatch's associative boundary, via `Hatch.GetAssociatedObjectIds()`), the polyline carries `boundaryOfHandle` + a do-not-add message. Overlapping hatches or crossing polylines are not detected — the plugin has no cheap, reliable test for them and refuses to guess.

`MockBridgeClient` implements the same scope/status/conversion/refusal wiring from its existing `entityGeometry` map (shoelace for a closed polyline/rectangle, πr² for a circle, outer-loop-minus-islands for a hatch) — enough to exercise the tool surface in `bun test`/`smoke`, never a claim that its number equals `Polyline.Area` for bulged curves. The real numbers need a live AutoCAD; see IMPLEMENTATION_STATUS.md for the reproducible QA steps.

## `operations.apply`/`preview`/`revert`/`undo`/`redo`/`history` payloads

```ts
type EntityOperation =
  | { op: "create"; entity: CreateEntityParams; id?: string }
  | { op: "erase"; handles: string[]; id?: string }
  | { op: "transform"; transform: EntityTransformParams; id?: string }
  | {
      op: "update";
      update: Omit<EntityUpdateParams, "documentName" | "idempotencyKey" | "view">;
      id?: string;
    };

// operations.apply
type OperationsApplyParams = {
  operations: EntityOperation[];
  taskId?: string; // logical agent task identifier
  defaults?: { layer?: string }; // merged under each create step's own explicit fields
  view?: ViewOverride; // per-call override of this document's view.setLive follow setting
  progressive?: boolean; // repaint partway through the batch instead of only at the end; default false
  paceMs?: number; // 0..100, extra delay between progressive repaints, hard-capped to 3s total per batch
};
type OperationsApplyResult = {
  batchId?: string; // absent when status is "aborted"
  taskId?: string;
  sequence?: number;
  status:
    | "committed"
    | "aborted"
    | "partial"
    | "cancelled"
    | "failed"
    | "busy"
    | "requires_revalidation"
    | "outcome_unknown";
  entityRefs: EntityRef[];
  error?: { code: number; message: string; failedStep?: number | null; causeCode?: number | null };
  undo?:
    | { supported: true; mode: "native-lifo"; state: "top" }
    | { supported: false; mode: "unsupported-background"; state: "none" };
  partial?: boolean;
  committedBatchIds?: string[];
  completedPhases?: number;
  totalPhases?: number;
};

// operations.preview
// `extents` is the union of native entity extents; the preview transaction is aborted and never persists changes.
type OperationsPreviewParams = {
  operations: EntityOperation[];
  documentName?: string;
  taskId?: string;
};
type OperationsPreviewResult = {
  valid: boolean;
  operationCount: number;
  entityRefs: EntityRef[];
  extents?: { min: Point3d; max: Point3d };
  error?: { code: number; message: string; failedStep?: number | null; causeCode?: number | null };
};

// operations.revert
type OperationsRevertParams = {
  batchId?: string;
  taskId?: string;
  documentName?: string;
};
type OperationsRevertResult = {
  status: "reverted";
  batchId?: string;
  taskId?: string;
  revertedChangeSetsCount: number;
  erasedHandles: string[];
  recreatedHandles: string[];
  restoredHandles: string[];
};

// operations.undo / operations.redo
type OperationsUndoParams = { batchId: string };
type OperationsUndoResult = { batchId: string; status: "undone" | "redone" };

// operations.history
type OperationsHistoryParams = { limit?: number };
type OperationsHistoryResult = { batches: BatchJournalEntrySummary[] };
```

### Batch-local `id`/`@ref` and `defaults` (#19)

Any step may carry a batch-local `id` (e.g. `"wall1"`); a later step references its resulting entity/entities as `"@wall1"` anywhere a real handle would go: `erase.handles`, `transform`'s `handles` (every op) and `arrayPath`'s `path.handle`, and `entity.create` kind `hatch`'s `boundaryHandles`/`loops[].handles`. This lets one call build a closed outline, hatch it, and copy it — `[{ op: "create", id: "outline", entity: {...} }, { op: "create", entity: { kind: "hatch", boundaryHandles: ["@outline"] } }, { op: "transform", transform: { op: "copy", handles: ["@outline"], delta: [...] } }]` — instead of three round trips with hand-tracked handles.

In-place `update` accepts the same optional common-property and geometry patch as `entity.update` and preserves the existing entity handle. `update.handle` can refer to a unique batch-local `@id`, too; each update returns exactly one original entity ref and records a before/after pre-image in the task ledger for guarded `operations.revert`. `operations.preview` can dry-run such updates in an aborted native transaction. Unsupported restoration shapes (e.g., hatch boundary data) refuse the batch; the user must explicitly request the separate candidate approval workflow for risky edits. Design Guard counts handle-only `update` and `transform` payloads as mutations, never a free pass. The default drafting policy operates at the selected DWG’s original coordinates, without an automatic side-by-side copy.

`id`/`@ref` is resolved **entirely in `server`, before the wire** — `EntityOperation.id` and any `"@ref"` string never reach the plugin; `OperationsHandlers.cs` has no code for this feature and sees only real hex handles, exactly as before. A real handle for a step only exists once that step has actually run, so a step that references an id produced earlier **in the same call** forces everything up to and including the producing step to be sent first: one `operations.apply` tool call becomes as many `RpcMethod.OperationsApply` bridge requests as the refs in it require (one, same as today, when there are none — the common case). Each request is still one AutoCAD transaction/native undo group; a call chaining a reference across requests is no longer a single transaction, and `undo`/`redo` only ever address the **last** one. `status`, `entityRefs` (concatenated in original step order) and `error.failedStep` (mapped back to the original array index) on the tool's result still describe the whole chain as one outcome.

Rejected with `-32021 InvalidOperation`, before any request reaches the bridge, for: a duplicate `id`; an `@ref` naming an `id` no step defines; an `@ref` naming a step that hasn't run yet (including a true forward reference to a later step); and an `@ref` that resolved to more than one entity where exactly one handle is required (`arrayPath.path.handle`).

`defaults.layer` is merged into every `create` step that omits its own `layer`, before expansion (so a `dimension.chain` step's N expanded entities see it too) — a step's own explicit `layer` always wins. No other field is defaulted yet.

`operations.apply` executes on the native cooperative CAD scheduler. With progressive drafting enabled, it can commit **multiple short transaction phases** per bridge request; otherwise a request may be one transaction. Each committed phase has its own `batchId`/undo boundary. `status` and `committedBatchIds` describe exactly which phases landed; cancelling midway never claims a full rollback. Chained batch-local `@ref` waves can also result in multiple requests. If any step throws, that request's transaction is aborted (disposed without `Commit()`; 0 entities change **for that request** — any earlier request in the same tool call already committed and is not rolled back). Layer/drawing/view operations are **not** valid batch steps in this version — entity mutations only.

`operations.undo`/`operations.redo` are LIFO-only against the native undo stack, not a general-purpose non-LIFO undo. Task-scoped change sets for `operations.revert` are persisted locally and separate from native LIFO undo:

- `undo(batchId)` succeeds only if `batchId` is the most recent still-committed batch (`-32008 UndoNotTop` otherwise) **and** no AutoCAD command has run since it committed (`-32009 UndoStackDiverged` otherwise — best-effort, tracked via a per-document command-generation counter that does not catch non-command edits like grip edits or property-palette changes).
- `redo(batchId)` succeeds only if `batchId` is the most recently undone batch in this document (`-32008 UndoNotTop` otherwise); applying a new batch clears the redo stack, matching ordinary editor undo/redo semantics.
- Non-LIFO compensating revert (`operations.revert`) reverts an older `batchId` or entire `taskId` without destroying intermediate human drafting edits, failing closed with `-32036 RevertConflict` if any touched entity was subsequently modified.

## `style.*` payloads (#34)

```ts
type StyleLinetypesListResult = { linetypes: { name: string; description: string }[] };

type StyleLinetypesLoadParams = { names: string[]; file?: string }; // file defaults to "acadiso.lin"
type StyleLinetypesLoadResult = { loaded: string[]; alreadyLoaded: string[] };

type TextStyleInfo = {
  name: string;
  font: string;
  height: number; // 0 = variable height
  widthFactor: number;
  obliqueAngle: number; // radians
  isCurrent: boolean;
};
type StyleTextStylesListResult = { textStyles: TextStyleInfo[] };
type StyleTextStylesCreateParams = {
  name: string;
  font: string;
  height: number; // default 0
  widthFactor: number; // default 1
  obliqueAngle: number; // default 0
  update?: boolean;
};
type StyleTextStylesCreateResult = { textStyle: TextStyleInfo; created: boolean };
type StyleTextStylesSetCurrentParams = { name: string };

type DimStyleInfo = {
  name: string;
  textHeight: number;
  arrowSize: number;
  extensionOffset: number;
  extensionBeyond: number;
  decimalPlaces: number; // 0..8
  unitsFormat: "decimal" | "architectural" | "engineering";
  scale: number;
  isCurrent: boolean;
};
type StyleDimStylesListResult = { dimStyles: DimStyleInfo[] };
type StyleDimStylesCreateParams = Omit<DimStyleInfo, "isCurrent"> & {
  basedOn?: string;
  update?: boolean;
};
type StyleDimStylesCreateResult = { dimStyle: DimStyleInfo; created: boolean };
type StyleDimStylesSetCurrentParams = { name: string };
```

`style.linetypes.load` calls `Database.LoadLineTypeFile(name, file)` per name inside its own read-check (`LinetypeTable.Has`) so the result can report `loaded` versus `alreadyLoaded` accurately; `LoadLineTypeFile` is itself a no-op for a name already in the table. `layer.setProperties`'s `linetype` field still requires the name to already be loaded (`-32006 InvalidGeometry` otherwise) — `style.linetypes.load` is the only way to load `DASHED`/`CENTER`/`HIDDEN`/etc.

`style.textStyles.create`/`style.dimStyles.create` map directly onto `TextStyleTableRecord`/`DimStyleTableRecord` fields (`FileName`/`TextSize`/`XScale`/`ObliquingAngle` and `Dimtxt`/`Dimasz`/`Dimexo`/`Dimexe`/`Dimdec`/`Dimlunit`/`Dimscale` respectively) — `unitsFormat` maps to `Dimlunit` (`decimal` → 2, `architectural` → 4, `engineering` → 3). Both fail with `-32018 StyleNameConflict` on an existing name unless `update: true`; `dimStyles.create`'s optional `basedOn` clones that existing style's other DIMxxx variables before applying the request's fields, and a missing `basedOn` fails with `-32017 StyleNotFound`.

`style.textStyles.setCurrent`/`style.dimStyles.setCurrent` set `Database.Textstyle`/`Database.Dimstyle` — the ambient style AutoCAD's own entity constructors read when no per-entity style is given. `entity.create`'s `dimension.linear`/`dimension.aligned` kinds never set a dimension style themselves, so a dimension created after `dimStyles.setCurrent` picks up that style automatically; an unknown name fails with `-32017 StyleNotFound`.

Every brand-new mock/real document seeds AutoCAD's own defaults: linetype `Continuous` always loaded, text style `Standard` and dimension style `Standard` always present and current.

Symbol table names (linetypes, text styles, dimension styles — same rule `layer.create`/`rename` already enforce) may not contain `<` `>` `/` `\` `"` `:` `;` `?` `*` `|` `,` `=` or a backtick.

## Live drafting mode (`view.setLive`/`getLive`/`zoom`, per-call `view`, `operations.apply` `progressive`)

```ts
type ViewOverride = { follow?: "off" | "fit" | "pan" };

interface LiveViewSettings {
  follow: "off" | "fit" | "pan"; // default "off" — today's behavior, view never moves
  margin: number; // fraction of the affected extents added around it when fitting; default 0.25
  minHeight: number | null; // never zoom closer than this view height (drawing units)
  animate: boolean; // interpolate over ~8 frames (<=200ms) instead of jumping; default true
  progressive: boolean; // operations.apply repaints partway through instead of only at the end; default false
  paceMs: number; // 0..100, extra delay between progressive repaints; default 0
}
// view.setLive(fields) merges the given fields over the current (or default) settings, returns the effective result
type ViewSetLiveParams = Partial<Omit<LiveViewSettings, never>> & { documentName?: string };
type ViewSetLiveResult = LiveViewSettings;
// view.getLive() reads the current settings without changing them
type ViewGetLiveParams = { documentName?: string };
type ViewGetLiveResult = LiveViewSettings;

// view.zoom: explicit "look here", first match wins
interface ViewZoomParams {
  window?: { min: Point3d; max: Point3d };
  handles?: string[];
  center?: Point3d;
  height?: number;
  documentName?: string;
}
interface ViewZoomResult {
  center: Point3d; // world-space center of the framed box
  height: number; // the view's resulting height (drawing units)
}
```

Settings are stored in plugin memory per document (`Util/LiveView.cs`, keyed by stable document identity `DocumentContext.IdOf(doc)` surviving SAVEAS and tab renames). After every mutating call — `entity.create`/`transform`/`erase`, `operations.apply` — when the document's `follow` isn't `"off"`, the plugin unions the `GeometricExtents` of the entities that call affected (skipping erased ones) and, if that box isn't already fully inside the current view with `margin` applied, pans or fits the view toward it (`fit` never zooms in past the current height if panning alone would have covered the box; `minHeight` clamps how close it can zoom regardless). Camera adjustments are non-blocking and never issue `Thread.Sleep` on the UI thread.

`operations.apply` settings precedence is strictly: **Explicit per-call override > Persisted per-document setting > System defaults**. When progressive execution is enabled (either per-call `progressive: true` or persisted via `view.setLive`), the native `CadOperationScheduler` partitions drawing tasks into bounded micro-batches (10–50 operations each), committing each completed phase, requesting viewport screen refreshes, and cooperatively releasing the execution context to allow pending human commands between commits. Multi-wave and micro-batch results truthfully report overall execution status, `partial: true`, `committedBatchIds`, completed/total phases, and original failed step indices upon error or cancellation.

`view.zoom` is the explicit "look here" primitive — unlike the post-mutation `follow` logic, it always moves the view (no inside-with-margin no-op check) and resolves `window`, else the union of `handles`' `GeometricExtents`, else `center`+`height`; an unresolvable handle is rejected.

**E2E Verification notice**: In-process wiring, bounded micro-batch partitioning, settings precedence, and partial result contracts are verified by automated tests (`bun test`, `dotnet test`). Full real-time AutoCAD viewport repaint and human interleaved input require a live Windows AutoCAD 2022/2025 host process.
