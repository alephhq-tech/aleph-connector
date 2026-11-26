#!/usr/bin/env bun
/**
 * Real-AutoCAD end-to-end verification harness (#6): drives every MCP tool through the _full_ stack
 * (MCP client -> Remote MCP Server -> Device Gateway -> WSS -> Bridge -> named pipe -> the AutoCAD
 * plugin -> a real AutoCAD) as a real `@modelcontextprotocol/client`, and asserts on the resulting
 * drawing state instead of just on the wire response. Written by an agent, run by a human on a
 * Windows machine with AutoCAD — see RUN.md's "Verifying against real AutoCAD".
 *
 * `--mock` swaps in this repo's own `MockBridgeClient`, using the exact same in-memory
 * `createServer` + `InMemoryTransport` construction `src/smoke.ts` already uses, so an agent
 * without AutoCAD can still prove this script compiles and runs correctly end to end against the
 * mock stack (`bun run e2e:autocad -- --mock`). That is a wiring proof only — it cannot exercise
 * the WSS Device Gateway transport or the real Bridge/plugin, which is the whole reason this script
 * exists: the first real run against actual AutoCAD is owed to the maintainer.
 *
 * Every RPC-mutating call below passes `documentName` explicitly and the harness refuses to run at
 * all unless that document is already the _active_ tab (see `assertScratchDocument`), so it never
 * touches whatever drawing a human has open — see the "Idempotent and safe" note below.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { win32 as winPath } from 'node:path'
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { BridgeErrorCode } from '@aleph-connector/cad-protocol'
import type { CreateEntityParams, EntityTransformParams } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from '../src/bridge/MockBridgeClient.js'
import { MockDeviceGateway } from '../src/bridge/MockDeviceGateway.js'
import { createServer } from '../src/server.js'

// Small utilities

/** A thrown tool result (`isError: true`) — `code`/`errorName` mirror `toolError.ts`'s shape. */
class ToolCallError extends Error {
  constructor(
    public readonly code: number | undefined,
    public readonly errorName: string,
    message: string
  ) {
    super(message)
    this.name = 'ToolCallError'
  }
}

/** Thrown by a scenario to report itself as skipped (not failed) with a reason. */
class SkipScenario extends Error {}

/** Thrown before any scenario runs when the target document isn't this harness's own scratch. */
class RefusalError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * `fs.mkdirSync(dir, { recursive: true })` throws `EEXIST` for `dir === "."` on Bun (unlike Node),
 * which every relative `--report-out` (the default) hits since `path.dirname` of a bare/relative
 * file name is `"."`. `"."` always exists, so skip the call entirely for it.
 */
function ensureDir(dir: string): void {
  if (dir === '.') return
  fs.mkdirSync(dir, { recursive: true })
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertSetEqual(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  const a = [...actual].sort()
  const e = [...expected].sort()
  const same = a.length === e.length && a.every((v, i) => v === e[i])
  if (!same) throw new Error(`${label}: expected {${e.join(', ')}}, got {${a.join(', ')}}`)
}

/**
 * Calls one MCP tool and returns its parsed JSON payload, or throws a `ToolCallError` carrying the
 * structured `{code, name, message}` `toolError.ts` puts in every `isError: true` result — the same
 * shape `smoke.ts`'s `textOf` unwraps, plus the error-code extraction scenarios need to assert on
 * specific `BridgeErrorCode`s (e.g. the deliberate `UndoNotTop` case).
 */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const block = result.content[0]
  assert(block && block.type === 'text', `${name}: tool result had no text block`)
  if (result.isError) {
    // Not every isError result is this server's own JSON envelope (toolError.ts) — an MCP-SDK-
    // level schema validation failure (e.g. a missing required field) returns plain text instead.
    let error: { code?: number; name?: string; message?: string } = {}
    try {
      // toolError.ts always wraps a structured error this shape; named const, not an inline
      // cast-then-access, per this repo's cast-hygiene convention.
      const envelope = JSON.parse(block.text) as { error?: typeof error }
      error = envelope.error ?? {}
    } catch {
      // fall through with the raw text as the message
    }
    throw new ToolCallError(error.code, error.name ?? 'Error', error.message ?? block.text)
  }
  return JSON.parse(block.text) as Record<string, unknown>
}

// Stack construction — real (StreamableHTTP against a running mcp-server) or mock (MockBridgeClient)

interface ConnectedStack {
  client: Client
  close: () => Promise<void>
}

/**
 * The real target: a running `bun run --cwd apps/mcp-server start` (RUN.md Option B) reached over
 * Streamable HTTP, exactly like an AI Desktop client would. This is the harness's actual purpose —
 * everything past this point exercises the Bridge and the AutoCAD plugin for real.
 */
async function connectReal(mcpUrl: string): Promise<ConnectedStack> {
  // The local runtime needs no credential: it binds 127.0.0.1 and guards Host/Origin.
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
  const client = new Client({ name: 'e2e-autocad-harness', version: '0.1.0' })
  await client.connect(transport)
  return { client, close: async () => client.close() }
}

/**
 * The offline proof: the exact same `createServer` + `InMemoryTransport.createLinkedPair` +
 * `MockBridgeClient`/`MockDeviceGateway` construction `apps/mcp-server/src/smoke.ts` already uses —
 * reused verbatim rather than inventing a second wiring path. Proves this script's tool-call
 * sequences and assertions are correct; it does not (and cannot) prove anything about the WSS
 * Device Gateway transport, the real Bridge, or the AutoCAD plugin.
 */
async function connectMock(): Promise<ConnectedStack> {
  const deviceId = 'device_pc_01'
  const bridge = new MockBridgeClient()
  const deviceGateway = new MockDeviceGateway(deviceId, {
    instanceId: 'acad_18244',
    processId: 18244,
    status: 'online',
    autocadVersion: '2024-mock',
    pluginVersion: '0.1.0-mock',
    protocol: 1,
    activeDocument: 'Drawing1.dwg'
  })
  const server = createServer(bridge, deviceGateway, deviceId)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'e2e-autocad-harness', version: '0.1.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

// Idempotent and safe: refuse to run against anything but this harness's own scratch document.
// This harness never opens a drawing itself - scripts/prep-scratch.ts (run by the live lane, or by
// hand) creates/saves/opens the scratch tab, and the operator can do the same by hand. Every call
// below then targets the scratch by name, so a mid-run tab switch on the human's side can never
// redirect a mutation elsewhere.

async function assertScratchDocument(client: Client, scratchName: string): Promise<void> {
  const listed = await callTool(client, 'drawing', { operation: 'list_open' })
  const documents = listed.documents as { name: string; isActive: boolean }[]
  const active = documents.find((d) => d.isActive)
  // `Document.Name` is the full path for a saved drawing (see docs/AUTOCAD_PLUGIN.md's "Document
  // targeting"), so compare basenames case-insensitively — the same fallback
  // `DocumentContext.Resolve` already applies to every `documentName` this harness passes below.
  const activeBaseName = active ? path.basename(active.name).toLowerCase() : undefined
  const expectedBaseName = path.basename(scratchName).toLowerCase()
  if (!active || activeBaseName !== expectedBaseName) {
    throw new RefusalError(
      `Refusing to run: the active AutoCAD document is "${active?.name ?? '(none open)'}", not the ` +
        `expected scratch document "${scratchName}". Open AutoCAD, create or activate a drawing ` +
        `saved under exactly that name (see RUN.md's "Verifying against real AutoCAD"), or pass ` +
        `--scratch-name to match whichever scratch drawing you already have active. Nothing was ` +
        `read or written.`
    )
  }
}

// Scenario bookkeeping

interface ScenarioOutcome {
  id: string
  group: string
  status: 'pass' | 'fail' | 'skip'
  durationMs: number
  detail?: string
  error?: string
}

interface ScenarioSpec {
  id: string
  group: string
  run: () => Promise<string>
}

async function runScenario(spec: ScenarioSpec): Promise<ScenarioOutcome> {
  const start = performance.now()
  try {
    const detail = await spec.run()
    return {
      id: spec.id,
      group: spec.group,
      status: 'pass',
      durationMs: performance.now() - start,
      detail
    }
  } catch (err) {
    if (err instanceof SkipScenario) {
      return {
        id: spec.id,
        group: spec.group,
        status: 'skip',
        durationMs: performance.now() - start,
        detail: err.message
      }
    }
    return {
      id: spec.id,
      group: spec.group,
      status: 'fail',
      durationMs: performance.now() - start,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// entity.* — one scenario per `entity.create` kind: create -> get/list read-back -> assert fields
// -> transform -> erase. The kind list and transform-op list are re-derived from the protocol's
// own wire types (not hand-copied), and a compile-time check below fails `bun run typecheck` the
// day either union gains or loses a member this list doesn't account for.

type EntityCreateKind = CreateEntityParams['kind']
type TransformOp = EntityTransformParams['op']

/** Every `entity.transform` op, in the fixed order used to round-robin one onto each entity kind. */
const TRANSFORM_OP_ORDER = [
  'move',
  'rotate',
  'scale',
  'mirror',
  'copy',
  'arrayRect',
  'arrayPolar',
  'arrayPath'
] as const

const SCRATCH_LAYER = 'CADAI-E2E'
const ENTITY_BASE_X = 500_000
const ENTITY_KIND_SPACING = 5_000

interface EntityKindSpec {
  kind: EntityCreateKind
  /**
   * Kind `entity.get`/`entity.list` report back, if different from `kind` — AutoCAD has no native
   * rectangle entity (`entity.create(kind: "rectangle")` creates a closed `Polyline`; see
   * docs/AUTOCAD_PLUGIN.md's "Known limitations"), so read-back reports `"polyline"`. Defaults to
   * `kind`.
   */
  readBackKind?: string
  /** Fields for `entity.create`'s `entity` object, minus `kind`/`layer`/`documentName`. */
  create: (x: number, blockName: string) => Record<string, unknown>
  transformOp: (typeof TRANSFORM_OP_ORDER)[number]
  /** Fields for `entity.transform`'s `transform` object, minus `op`/`handles`/`documentName`. */
  transformParams: (x: number) => Record<string, unknown>
}

const ENTITY_KIND_SPECS: readonly EntityKindSpec[] = [
  {
    kind: 'line',
    create: (x) => ({ start: [x, 0], end: [x + 800, 0] }),
    transformOp: 'move',
    transformParams: () => ({ delta: [0, 50] })
  },
  {
    kind: 'circle',
    create: (x) => ({ center: [x, 0], radius: 150 }),
    transformOp: 'rotate',
    transformParams: (x) => ({ center: [x, 0], angle: Math.PI / 4 })
  },
  {
    kind: 'arc',
    create: (x) => ({ center: [x, 0], radius: 150, startAngle: 0, endAngle: Math.PI / 2 }),
    transformOp: 'scale',
    transformParams: (x) => ({ center: [x, 0], factor: 1.5 })
  },
  {
    kind: 'polyline',
    create: (x) => ({
      points: [
        [x, 0],
        [x + 400, 0],
        [x + 400, 400]
      ],
      closed: false
    }),
    transformOp: 'mirror',
    transformParams: (x) => ({ axisStart: [x, -100], axisEnd: [x, 500] })
  },
  {
    kind: 'rectangle',
    readBackKind: 'polyline',
    create: (x) => ({ corner1: [x, 0], corner2: [x + 400, 300] }),
    transformOp: 'copy',
    transformParams: () => ({ delta: [0, 600] })
  },
  {
    kind: 'mtext',
    create: (x) => ({ insertion: [x, 0], text: 'E2E', height: 50 }),
    transformOp: 'arrayRect',
    transformParams: () => ({ rows: 2, columns: 2, rowSpacing: 80, columnSpacing: 250 })
  },
  {
    kind: 'text.singleLine',
    create: (x) => ({ insertion: [x, 0], text: 'E2E', height: 50 }),
    transformOp: 'arrayPolar',
    transformParams: (x) => ({ center: [x, -300], count: 4 })
  },
  {
    kind: 'blockReference',
    create: (x, blockName) => ({ blockName, position: [x, 0] }),
    transformOp: 'arrayPath',
    transformParams: (x) => ({
      path: {
        points: [
          [x, -200],
          [x, 200]
        ]
      },
      count: 3
    })
  },
  {
    kind: 'dimension.linear',
    create: (x) => ({ extLine1: [x, 0], extLine2: [x + 800, 0], dimLinePoint: [x + 400, -300] }),
    transformOp: 'move',
    transformParams: () => ({ delta: [0, 50] })
  },
  {
    kind: 'dimension.aligned',
    create: (x) => ({ extLine1: [x, 0], extLine2: [x + 600, 600], dimLinePoint: [x + 300, -200] }),
    transformOp: 'rotate',
    transformParams: (x) => ({ center: [x + 300, -200], angle: Math.PI / 6 })
  },
  {
    kind: 'dimension.ordinate',
    create: (x) => ({
      origin: [x, 0],
      featurePoint: [x + 200, 100],
      leaderEndPoint: [x + 200, 400],
      axis: 'x'
    }),
    transformOp: 'scale',
    transformParams: (x) => ({ center: [x + 200, 100], factor: 1.2 })
  },
  {
    kind: 'hatch',
    create: (x) => ({ loops: [{ circle: { center: [x, 0], radius: 150 } }] }),
    transformOp: 'mirror',
    transformParams: (x) => ({ axisStart: [x, -500], axisEnd: [x, 900] })
  }
] as const

/**
 * Fails to compile if `CreateEntityParams["kind"]` gains/loses a member `ENTITY_KIND_SPECS` doesn't
 * cover.
 */
type AssertCovers<Whole, Listed extends Whole> = [Whole] extends [Listed] ? true : never
const _entityKindsCovered: AssertCovers<
  EntityCreateKind,
  (typeof ENTITY_KIND_SPECS)[number]['kind']
> = true
const _transformOpsCovered: AssertCovers<TransformOp, (typeof TRANSFORM_OP_ORDER)[number]> = true
void _entityKindsCovered
void _transformOpsCovered

async function runEntityKindScenario(
  client: Client,
  doc: string,
  blockName: string,
  spec: EntityKindSpec,
  index: number
): Promise<string> {
  const x = ENTITY_BASE_X + index * ENTITY_KIND_SPACING
  let created: Record<string, unknown>
  try {
    created = await callTool(client, 'entity', {
      operation: 'create',
      entity: { kind: spec.kind, layer: SCRATCH_LAYER, ...spec.create(x, blockName) },
      documentName: doc
    })
  } catch (err) {
    if (
      spec.kind === 'blockReference' &&
      err instanceof ToolCallError &&
      err.code === BridgeErrorCode.BlockNotFound
    ) {
      throw new SkipScenario(
        `no block named "${blockName}" is defined in "${doc}" — this harness has no way to author a ` +
          `block definition (there is no drawing/block-define RPC, see docs/IMPLEMENTATION_STATUS.md's ` +
          `"Not yet implemented" table). Define one by hand in AutoCAD (the BLOCK command, name ` +
          `"${blockName}") or pass --block-name to match one that already exists, then rerun.`
      )
    }
    throw err
  }
  const entity = created.entity as { handle: string; kind: string; layer: string }
  const handle = entity.handle
  assertEqual(entity.kind, spec.kind, `entity.create(${spec.kind}) result kind`)
  assertEqual(entity.layer, SCRATCH_LAYER, `entity.create(${spec.kind}) result layer`)

  const got = await callTool(client, 'entity', { operation: 'get', handle, documentName: doc })
  const gotEntity = got.entity as { handle: string; kind: string }
  assertEqual(gotEntity.handle, handle, `entity.get(${spec.kind}) handle`)
  assertEqual(gotEntity.kind, spec.readBackKind ?? spec.kind, `entity.get(${spec.kind}) kind`)

  const listed = await callTool(client, 'entity', {
    operation: 'list',
    layer: SCRATCH_LAYER,
    documentName: doc
  })
  const entities = listed.entities as { handle: string }[]
  assert(
    entities.some((e) => e.handle === handle),
    `entity.list(layer=${SCRATCH_LAYER}) should include ${handle}`
  )

  const transformed = await callTool(client, 'entity', {
    operation: 'transform',
    transform: { op: spec.transformOp, handles: [handle], ...spec.transformParams(x) },
    documentName: doc
  })
  const affected = transformed.affected as { handle: string }[]
  assert(
    affected.length > 0,
    `entity.transform(${spec.transformOp}) should affect at least one entity`
  )
  const cleanupHandles = [...new Set([handle, ...affected.map((a) => a.handle)])]

  const erased = await callTool(client, 'entity', {
    operation: 'erase',
    handles: cleanupHandles,
    documentName: doc
  })
  assertSetEqual(erased.erased as string[], cleanupHandles, `entity.erase(${spec.kind}) result`)

  return (
    `created ${handle}, get/list read-back ok, transform ${spec.transformOp} -> ` +
    `${affected.length} affected, erased ${cleanupHandles.length} handle(s)`
  )
}

// layer.* — list, create, set_current, set_properties, ensure, rename, delete, all in one pass so
// the scenario leaves the drawing exactly as it found it (no stray test layers on a re-run).

async function runLayerScenario(client: Client, doc: string): Promise<string> {
  const A = 'CADAI-E2E-LAYERTEST-A'
  const B = 'CADAI-E2E-LAYERTEST-B'
  const bRenamed = 'CADAI-E2E-LAYERTEST-B2'

  await callTool(client, 'layer', {
    operation: 'create',
    name: A,
    color: { aci: 1 },
    documentName: doc
  })
  let list = await callTool(client, 'layer', { operation: 'list', documentName: doc })
  let layers = list.layers as { name: string; isCurrent: boolean; locked: boolean }[]
  assert(
    layers.some((l) => l.name === A),
    'layer.create should make the layer visible to layer.list'
  )

  await callTool(client, 'layer', { operation: 'set_current', name: A, documentName: doc })
  list = await callTool(client, 'layer', { operation: 'list', documentName: doc })
  layers = list.layers as { name: string; isCurrent: boolean; locked: boolean }[]
  assert(
    layers.find((l) => l.name === A)?.isCurrent === true,
    'layer.set_current should mark the layer current'
  )

  await callTool(client, 'layer', {
    operation: 'set_properties',
    name: A,
    color: { aci: 3 },
    locked: true,
    documentName: doc
  })
  list = await callTool(client, 'layer', { operation: 'list', documentName: doc })
  layers = list.layers as { name: string; isCurrent: boolean; locked: boolean }[]
  assert(
    layers.find((l) => l.name === A)?.locked === true,
    'layer.set_properties should lock the layer'
  )

  const ensured = await callTool(client, 'layer', {
    operation: 'ensure',
    layers: [{ name: A, color: { aci: 3 } }, { name: B }],
    documentName: doc
  })
  const ensuredLayers = ensured.layers as { name: string; action: string }[]
  assertEqual(
    ensuredLayers.find((l) => l.name === B)?.action,
    'created',
    'layer.ensure should create B'
  )
  assert(
    ['updated', 'unchanged'].includes(ensuredLayers.find((l) => l.name === A)?.action ?? ''),
    'layer.ensure should report A as already present'
  )

  await callTool(client, 'layer', {
    operation: 'rename',
    from: B,
    to: bRenamed,
    documentName: doc
  })
  list = await callTool(client, 'layer', { operation: 'list', documentName: doc })
  layers = list.layers as { name: string; isCurrent: boolean; locked: boolean }[]
  assert(
    layers.some((l) => l.name === bRenamed),
    'layer.rename should produce the new name'
  )
  assert(!layers.some((l) => l.name === B), 'layer.rename should remove the old name')

  // Release A as current (delete refuses the current layer) and unlock it before deleting both.
  await callTool(client, 'layer', { operation: 'set_current', name: '0', documentName: doc })
  await callTool(client, 'layer', {
    operation: 'set_properties',
    name: A,
    locked: false,
    documentName: doc
  })
  await callTool(client, 'layer', { operation: 'delete', name: A, documentName: doc })
  await callTool(client, 'layer', { operation: 'delete', name: bRenamed, documentName: doc })

  list = await callTool(client, 'layer', { operation: 'list', documentName: doc })
  layers = list.layers as { name: string; isCurrent: boolean; locked: boolean }[]
  assert(
    !layers.some((l) => l.name === A || l.name === bRenamed),
    'cleanup should remove both test layers'
  )

  return 'list/create/set_current/set_properties/ensure/rename/delete all verified; no layers left behind'
}

// drawing.info / drawing.save (save to a fresh temp path only — never overwrites a real file)

async function runDrawingInfoScenario(client: Client, doc: string): Promise<string> {
  const info = await callTool(client, 'drawing', { operation: 'info', documentName: doc })
  // `info.name` is the full path for a saved drawing (see docs/AUTOCAD_PLUGIN.md's "Document
  // targeting"); compare basenames, same as `assertScratchDocument` above.
  assertEqual(
    path.basename(String(info.name)).toLowerCase(),
    path.basename(doc).toLowerCase(),
    'drawing.info name'
  )
  assert(typeof info.entityCount === 'number', 'drawing.info entityCount should be numeric')
  assert(typeof info.layerCount === 'number', 'drawing.info layerCount should be numeric')
  return `name=${info.name} entityCount=${info.entityCount} layerCount=${info.layerCount}`
}

async function runDrawingSaveScenario(client: Client, doc: string): Promise<string> {
  // aleph-platform#5: once a drawing has a file of its own, `drawing.save` only accepts a path
  // inside that SAME directory — `os.tmpdir()` (the pre-fix target) is exactly the kind of
  // unrelated path the fix exists to reject for an already-saved drawing. A never-saved drawing
  // (`info.path` null — true for the mock harness's "Drawing1.dwg" the first time this runs) has
  // no folder to match yet, so `os.tmpdir()` is still accepted there. Either way, pick a fresh,
  // never-existing name so this never overwrites a real file. Built with `path.win32`, not the
  // bare `path` import, because the AutoCAD stack is Windows-only regardless of which OS this
  // harness itself runs on (`--mock` runs fine on Linux/macOS) — the Bridge/plugin always compare
  // against a Windows-style path.
  const info = await callTool(client, 'drawing', { operation: 'info', documentName: doc })
  // No real filesystem is touched in `--mock` mode, so a never-saved document (there is no real
  // "never saved" case against a real, pre-existing scratch fixture) just needs any well-formed
  // absolute Windows path — `os.tmpdir()` on the harness's own OS would be a POSIX path on
  // Linux/macOS, which `path.win32` would reject as not rooted.
  const ownDir = info.path ? winPath.dirname(String(info.path)) : 'C:\\Windows\\Temp'
  const tempPath = winPath.join(ownDir, `cadai-e2e-save-${Date.now()}.dwg`)

  const saved = await callTool(client, 'drawing', {
    operation: 'save',
    path: tempPath,
    documentName: doc
  })
  assertEqual(saved.savedPath, tempPath, 'drawing.save savedPath')
  return `saved to fresh path ${saved.savedPath} inside the drawing's own folder (never an existing file)`
}

// view.zoom_extents

async function runViewZoomExtentsScenario(client: Client, doc: string): Promise<string> {
  const result = await callTool(client, 'view', { operation: 'zoom_extents', documentName: doc })
  assert(
    typeof result === 'object' && result !== null,
    'view.zoom_extents should return an object result'
  )
  return 'zoom_extents committed with no error'
}

// operations.apply -> history -> undo -> assert gone -> redo -> assert back, plus a deliberate
// UndoNotTop case. UndoStackDiverged needs a real AutoCAD command to run between apply and undo —
// see the always-skipped "operations:undo-stack-diverged" scenario below for the manual steps.

const OPERATIONS_BASE_X = ENTITY_BASE_X + ENTITY_KIND_SPECS.length * ENTITY_KIND_SPACING + 10_000

/**
 * `MockBridgeClient`'s `operations.undo`/`redo` are LIFO/UndoNotTop bookkeeping only — like
 * `smoke.ts`'s own equivalent test, they never actually remove/restore entities in the mock's
 * document map (only the real plugin's native AutoCAD undo group does that). So the "assert gone ->
 * redo -> assert back" half of this scenario, the actual point of #6, only runs for real; in
 * `--mock` it's skipped with a note instead of asserting something the mock can't make true.
 */
async function runOperationsScenario(client: Client, doc: string, mock: boolean): Promise<string> {
  const x = OPERATIONS_BASE_X
  const batchA = await callTool(client, 'operations', {
    operation: 'apply',
    operations: [
      {
        op: 'create',
        entity: { kind: 'circle', layer: SCRATCH_LAYER, center: [x, 0], radius: 50 }
      },
      {
        op: 'create',
        entity: { kind: 'circle', layer: SCRATCH_LAYER, center: [x + 200, 0], radius: 50 }
      }
    ],
    documentName: doc
  })
  // Dump the whole result, not just the status: a live "partial" carries phases[] and
  // error.causeCode that say which wave failed and why, which the bare status never shows.
  if (batchA.status !== 'committed') {
    throw new Error(`batchA status: expected "committed", got ${JSON.stringify(batchA)}`)
  }
  const batchAId = batchA.batchId as string
  const batchARefs = batchA.entityRefs as { handle: string }[]
  assertEqual(batchARefs.length, 2, 'batchA entity count')

  const batchB = await callTool(client, 'operations', {
    operation: 'apply',
    operations: [
      {
        op: 'create',
        entity: { kind: 'circle', layer: SCRATCH_LAYER, center: [x + 400, 0], radius: 50 }
      }
    ],
    documentName: doc
  })
  assertEqual(batchB.status, 'committed', 'batchB status')
  const batchBId = batchB.batchId as string
  const batchBHandles = (batchB.entityRefs as { handle: string }[]).map((r) => r.handle)

  const history = await callTool(client, 'operations', { operation: 'history', documentName: doc })
  const batches = history.batches as { batchId: string }[]
  assert(
    batches.some((b) => b.batchId === batchAId),
    'operations.history should include batchA'
  )
  assert(
    batches.some((b) => b.batchId === batchBId),
    'operations.history should include batchB'
  )
  assertEqual(
    batches[0]?.batchId,
    batchBId,
    'operations.history should list the most recent batch first'
  )

  // Deliberate UndoNotTop: batchA is no longer the top of the LIFO journal — batchB is.
  let sawUndoNotTop = false
  try {
    await callTool(client, 'operations', {
      operation: 'undo',
      batchId: batchAId,
      documentName: doc
    })
  } catch (err) {
    if (err instanceof ToolCallError && err.code === BridgeErrorCode.UndoNotTop)
      sawUndoNotTop = true
    else throw err
  }
  assert(sawUndoNotTop, 'undoing a non-top batch should fail with -32008 UndoNotTop')

  const scratchHandles = async (): Promise<string[]> => {
    const listed = await callTool(client, 'entity', {
      operation: 'list',
      layer: SCRATCH_LAYER,
      documentName: doc
    })
    return ((listed.entities as { handle: string }[]) ?? []).map((e) => e.handle)
  }
  const beforeUndo = await scratchHandles()

  if (mock) {
    const undone = await callTool(client, 'operations', {
      operation: 'undo',
      batchId: batchBId,
      documentName: doc
    })
    assertEqual(undone.status, 'undone', 'operations.undo status')
    const redone = await callTool(client, 'operations', {
      operation: 'redo',
      batchId: batchBId,
      documentName: doc
    })
    assertEqual(redone.status, 'redone', 'operations.redo status')
  } else {
    // LIVE: undo then redo with NOTHING in between. Autodesk's REDO doc says it "must immediately
    // follow the U or UNDO command", and every entity/history read starts a transaction — which the
    // Autodesk developer blog names as the thing that drops the redo buffer right after an undo.
    // The previous ordering (a read between the two) measured "redone" restoring nothing, so the
    // reads move after the pair. Redo restoring batchB's entities is itself the proof undo removed
    // them; the same-handle assertion covers native redo's ObjectId stability.
    const undone = await callTool(client, 'operations', {
      operation: 'undo',
      batchId: batchBId,
      documentName: doc
    })
    assertEqual(undone.status, 'undone', 'operations.undo status')
    const redone = await callTool(client, 'operations', {
      operation: 'redo',
      batchId: batchBId,
      documentName: doc
    })
    assertEqual(redone.status, 'redone', 'operations.redo status')

    const afterPair = await scratchHandles()
    const missing = batchBHandles.filter((h) => !afterPair.includes(h))
    if (missing.length > 0) {
      throw new Error(
        `undo/redo pair left batchB entities missing: missing=[${missing}] ` +
          `expected=[${batchBHandles}] layerNow=[${afterPair}] beforeUndo=[${beforeUndo}] ` +
          `(redo reported "redone" but did not restore the level native undo removed)`
      )
    }
  }

  await callTool(client, 'entity', {
    operation: 'erase',
    handles: [...batchARefs.map((r) => r.handle), ...batchBHandles],
    documentName: doc
  })

  return mock
    ? `batchA=${batchAId} (2 entities) batchB=${batchBId} (1 entity): UndoNotTop confirmed on ` +
        `batchA while batchB was top; undo/redo status round-tripped; entity-removed-after-undo ` +
        `NOT checked (MockBridgeClient's undo/redo is LIFO bookkeeping only, see real-mode notes ` +
        `above the function) — every entity erased`
    : `batchA=${batchAId} (2 entities) batchB=${batchBId} (1 entity): UndoNotTop confirmed on ` +
        `batchA while batchB was top; undo->gone->redo->back all verified on batchB; every entity erased`
}

const UNDO_STACK_DIVERGED_NOTE =
  'Not scriptable from here: UndoStackDiverged (-32009) fires when an AutoCAD command runs ' +
  '(CommandEnded/CommandCancelled/CommandFailed) on the active document between operations.apply ' +
  "committing a batch and operations.undo targeting it — this harness has no way to drive AutoCAD's " +
  'own command line. Manual steps for the operator: 1) run this harness (or one operations.apply ' +
  "call) against the scratch drawing to commit a batch and note its batchId; 2) in AutoCAD's command " +
  'line on that same scratch drawing, run any command that ends cleanly (e.g. REGEN); 3) call ' +
  'operations.undo with that batchId and confirm the result is isError:true with code -32009 ' +
  "UndoStackDiverged; 4) record that result by hand in the PR's Evidence section — this script " +
  'cannot verify it unattended.'

// CLI

interface CliOptions {
  mock: boolean
  mcpUrl: string
  scratchName?: string
  blockName: string
  reportOut: string
  only?: string
  help: boolean
}

const USAGE = `Usage: bun run scripts/e2e-autocad.ts [options]

Drives every MCP tool through the full stack and asserts on the resulting drawing state.

Options:
  --mock                  Use the in-memory MockBridgeClient stack instead of a running
                           mcp-server (this is the only mode an agent without AutoCAD can run).
  --mcp-url <url>         Streamable HTTP endpoint of a running mcp-server (real mode only).
                           Default: $CADAI_E2E_MCP_URL or http://127.0.0.1:8080/mcp
  --scratch-name <name>   Expected name of the harness's own scratch document. The harness
                           refuses to run if the active document doesn't match.
                           Default: Drawing1.dwg (--mock) / CADAI-E2E-SCRATCH.dwg (real)
  --block-name <name>     Block name entity.create(blockReference) inserts; must already be
                           defined in the scratch drawing for real-mode coverage (see RUN.md).
                           Default: CADAI-E2E-BLOCK
  --report-out <path>     Where to write the machine-readable JSON report.
                           Default: a cadai-e2e-report.json under the OS temp directory
  --only <group>          Run only one tool group: entity | layer | drawing | view | operations
                           (or entity:<kind> for a single entity.create kind, e.g. entity:hatch)
  -h, --help              Show this help and exit.
`

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined) throw new Error(`${flag} requires a value`)
  return value
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    mock: false,
    mcpUrl: process.env.CADAI_E2E_MCP_URL ?? 'http://127.0.0.1:8080/mcp',
    blockName: 'CADAI-E2E-BLOCK',
    reportOut: path.join(os.tmpdir(), 'cadai-e2e-report.json'),
    help: false
  }
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    switch (arg) {
      case '--mock':
        opts.mock = true
        i += 1
        break
      case '--mcp-url':
        opts.mcpUrl = requireValue(argv, i + 1, arg)
        i += 2
        break
      case '--scratch-name':
        opts.scratchName = requireValue(argv, i + 1, arg)
        i += 2
        break
      case '--block-name':
        opts.blockName = requireValue(argv, i + 1, arg)
        i += 2
        break
      case '--report-out':
        opts.reportOut = requireValue(argv, i + 1, arg)
        i += 2
        break
      case '--only':
        opts.only = requireValue(argv, i + 1, arg)
        i += 2
        break
      case '-h':
      case '--help':
        opts.help = true
        i += 1
        break
      default:
        throw new Error(`Unknown argument: ${arg} (see --help)`)
    }
  }
  return opts
}

function printTable(results: readonly ScenarioOutcome[]): void {
  const header = ['scenario', 'group', 'status', 'time', 'detail']
  const rows = results.map((r) => [
    r.id,
    r.group,
    r.status.toUpperCase(),
    `${r.durationMs.toFixed(0)}ms`,
    r.error ?? r.detail ?? ''
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)))
  const line = (cols: readonly string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  console.log(line(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows) console.log(line(row))
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    return
  }
  if (!opts.mock && !process.env.CADAI_E2E_MCP_URL && opts.mcpUrl === 'http://127.0.0.1:8080/mcp') {
    console.log(`No --mock and no --mcp-url override: assuming a local stack at ${opts.mcpUrl}.`)
  }
  const scratchName = opts.scratchName ?? (opts.mock ? 'Drawing1.dwg' : 'CADAI-E2E-SCRATCH.dwg')

  const stack = opts.mock ? await connectMock() : await connectReal(opts.mcpUrl)
  const startedAt = new Date().toISOString()
  try {
    await assertScratchDocument(stack.client, scratchName)
  } catch (err) {
    if (err instanceof RefusalError) {
      console.error(err.message)
      const report = {
        mode: opts.mock ? 'mock' : 'real',
        scratchDocument: scratchName,
        startedAt,
        finishedAt: new Date().toISOString(),
        refused: true,
        reason: err.message
      }
      ensureDir(path.dirname(opts.reportOut))
      fs.writeFileSync(opts.reportOut, JSON.stringify(report, null, 2))
      console.error(`Report: ${opts.reportOut}`)
      await stack.close()
      process.exitCode = 1
      return
    }
    throw err
  }

  const specs: ScenarioSpec[] = [
    ...ENTITY_KIND_SPECS.map((spec, index): ScenarioSpec => ({
      id: `entity:${spec.kind}`,
      group: 'entity',
      run: () => runEntityKindScenario(stack.client, scratchName, opts.blockName, spec, index)
    })),
    { id: 'layer:crud', group: 'layer', run: () => runLayerScenario(stack.client, scratchName) },
    {
      id: 'drawing:info',
      group: 'drawing',
      run: () => runDrawingInfoScenario(stack.client, scratchName)
    },
    {
      id: 'drawing:save',
      group: 'drawing',
      run: () => runDrawingSaveScenario(stack.client, scratchName)
    },
    {
      id: 'view:zoomExtents',
      group: 'view',
      run: () => runViewZoomExtentsScenario(stack.client, scratchName)
    },
    {
      id: 'operations:batch-undo-redo',
      group: 'operations',
      run: () => runOperationsScenario(stack.client, scratchName, opts.mock)
    },
    {
      id: 'operations:undo-stack-diverged',
      group: 'operations',
      run: () => {
        throw new SkipScenario(UNDO_STACK_DIVERGED_NOTE)
      }
    }
  ]

  const selected = specs.filter((s) => !opts.only || s.group === opts.only || s.id === opts.only)
  if (selected.length === 0) {
    console.error(
      `--only ${opts.only} matched no scenario. Groups: entity, layer, drawing, view, operations.`
    )
    await stack.close()
    process.exitCode = 1
    return
  }

  const needsScratchLayer = selected.some((s) => s.group === 'entity' || s.group === 'operations')
  if (needsScratchLayer) {
    await callTool(stack.client, 'layer', {
      operation: 'create',
      name: SCRATCH_LAYER,
      documentName: scratchName
    })
  }

  const results: ScenarioOutcome[] = []
  for (const spec of selected) {
    results.push(await runScenario(spec))
  }

  if (needsScratchLayer) {
    try {
      await callTool(stack.client, 'layer', {
        operation: 'delete',
        name: SCRATCH_LAYER,
        documentName: scratchName
      })
    } catch (err) {
      console.error(
        `Warning: could not delete scratch layer "${SCRATCH_LAYER}" after the run (` +
          `${err instanceof Error ? err.message : String(err)}) — a failed scenario likely left ` +
          `an entity on it; check the table above.`
      )
    }
  }

  await stack.close()

  console.log('')
  printTable(results)
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length
  }
  console.log('')
  console.log(
    `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.total} total)`
  )

  const finishedAt = new Date().toISOString()
  const report = {
    mode: opts.mock ? 'mock' : 'real',
    mcpUrl: opts.mock ? undefined : opts.mcpUrl,
    scratchDocument: scratchName,
    startedAt,
    finishedAt,
    results,
    summary
  }
  ensureDir(path.dirname(opts.reportOut))
  fs.writeFileSync(opts.reportOut, JSON.stringify(report, null, 2))
  console.log(`\nReport: ${opts.reportOut}`)

  process.exitCode = summary.failed > 0 ? 1 : 0
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
