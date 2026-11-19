import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { EntityDetail, EntityKind } from '@arcdio/cad-types'
import { RESTORE_VERDICT_VALUES, type RpcMethodName } from '@arcdio/cad-protocol'
import type { EntityPreImage, Restorability } from '@arcdio/cad-protocol'
import { registerEditTools } from './edit.js'
import { db, hashApprovalToken } from '@arcdio/data'
import type { BridgeClient } from '../bridge/BridgeClient.js'
import {
  createEntityParams,
  editBeginParams,
  editApplyParams,
  editPreviewParams,
  editDiscardParams,
  editAcceptParams
} from '@arcdio/cad-tools'

/**
 * The TypeScript half of the PR B slice 01 restorability contract.
 *
 * A pre-image is only restorable if the payload captured from `entity.get detail:"full"` can be fed
 * back through `entity.create`. That completeness question has two independent implementations: the
 * plugin's C# `Restorability.IsRoundTripPayload` (mirroring EntityHandlers' `Require()` set) and
 * this zod `createEntityParams` schema, which is what the MCP tool actually accepts. Both are
 * asserted against ONE shared table (windows/contracts/preimage-contract-vectors.json →
 * `createVectors`), so neither can loosen while the other holds —
 * a create rule added on one side without a vector here fails, and changing a rule on one side
 * flips that side's assertion.
 *
 * The second half is the mirror itself: `Restorability` and `EntityPreImage` in
 * packages/mcp/autocad/wire-protocol/local-ipc/methods.ts. They are typed here with `satisfies`, so
 * renaming or dropping a field on the interface is a compile error, and the runtime assertions
 * compare the same key sets against the fixture the C# tests pin to the plugin types — one table,
 * three owners.
 *
 * The fixture is read as plain JSON data across the product boundary (same licence as
 * pluginInvariants.test.ts reading plugin .cs): a data contract shared with the plugin C# tests.
 */
interface RebuildVector {
  name: string
  note: string
  rebuild: unknown
  accepted: boolean
}

const FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      '../../../../windows/contracts/preimage-contract-vectors.json',
      import.meta.url
    ),
    'utf8'
  )
) as {
  createVectors: RebuildVector[]
  restorabilityVectors: { name: string; verdict: string }[]
  restorabilityWireShape: Record<string, unknown>
  entityPreImageWireShape: Record<string, unknown>
  vectors: { name: string; value: unknown }[]
}

// What the plugin emits, typed against the TS mirror. `reason` is nullable and `kind` is a plain
// string (unknownKind verdicts carry kind names outside the EntityKind union), which is exactly the
// shape that would silently break if the mirror drifted toward the C# enum/union.
const tsRestorability = {
  verdict: 'notSupported',
  kind: 'hatch',
  reason: 'entity.get reads a hatch boundary as loop count/types only',
  unsupportedFeatures: ['properties.transparency']
} satisfies Restorability

const tsPreImage = {
  detail: {
    handle: '2a4',
    kind: 'line',
    layer: 'WALLS',
    geometry: { start: { x: 0, y: 0, z: 0 }, end: { x: 100.5, y: 0.3, z: 0 }, length: 100.5004 },
    properties: {
      color: { aci: 256 },
      linetype: 'ByLayer',
      linetypeScale: 1,
      lineweight: -1,
      visible: true
    }
  } satisfies EntityDetail,
  revisionAtCapture: null,
  document: {
    documentId: 'doc-7f3a',
    fingerprintGuid: 'a91b7c2d4e5f60718293a4b5c6d7e8f9',
    path: 'C:/drawings/r1.dwg'
  },
  capturedAtUtc: '2026-10-24T09:15:30.000Z'
} satisfies EntityPreImage

describe('pre-image rebuild payloads match the shared create table (PR B slice 01)', () => {
  test('zod createEntityParams agrees with the shared table on every vector', () => {
    for (const v of FIXTURE.createVectors) {
      const parsed = createEntityParams.safeParse(v.rebuild)
      expect(parsed.success, `${v.name} (${v.note})`).toBe(v.accepted)
    }
  })

  test('the table covers every create-able wire kind', () => {
    // "other" is a read-back-only kind (the plugin's create switch rejects it), so it must appear as
    // a rejected vector rather than an accepted one. Every other EntityKind member needs at least
    // one accepted vector: a new kind added to the union with no row here would go unchecked on
    // whichever side forgot to grow.
    const kinds = new Set(FIXTURE.createVectors.map((v) => (v.rebuild as { kind: string }).kind))
    const expected: EntityKind[] = [
      'line',
      'circle',
      'arc',
      'polyline',
      'rectangle',
      'mtext',
      'text.singleLine',
      'blockReference',
      'dimension.linear',
      'dimension.aligned',
      'dimension.ordinate',
      'hatch',
      'other'
    ]
    for (const kind of expected) expect(kinds.has(kind), `no rebuild vector for ${kind}`).toBe(true)

    for (const kind of expected.filter((k) => k !== 'other')) {
      const anyAccepted = FIXTURE.createVectors.some(
        (v) => (v.rebuild as { kind: string }).kind === kind && v.accepted
      )
      expect(anyAccepted, `${kind} must have at least one accepted rebuild form`).toBe(true)
    }
  })

  test('the shared table rejects the same structural rules the plugin enforces', () => {
    const rejected = new Map(
      FIXTURE.createVectors
        .filter((v) => !v.accepted)
        .map((v) => [(v.rebuild as { kind: string }).kind, v.note] as const)
    )
    // Each of these is an independent check in EntityHandlers.BuildEntity/its builders; the zod
    // schema encodes the same rule, and both sides read the verdict from here.
    for (const kind of [
      'line',
      'circle',
      'polyline',
      'blockReference',
      'dimension.ordinate',
      'hatch',
      'other'
    ]) {
      expect(rejected.has(kind), `missing rejected vector for ${kind}`).toBe(true)
    }
  })
})

describe('the TS wire mirror matches the shared contract table (PR B slice 01)', () => {
  test('every fixture verdict name is a RestoreVerdict the mirror declares', () => {
    // The C# side parses the same strings into its enum (RestorabilityTests), so the union here is
    // the third owner of the spelling: rename a member in either language and this list stops
    // covering the table.
    for (const v of FIXTURE.restorabilityVectors) {
      expect(RESTORE_VERDICT_VALUES as readonly string[], `${v.name} verdict`).toContain(v.verdict)
    }
    expect(RESTORE_VERDICT_VALUES.length).toBe(3)
  })

  test("Restorability's declared fields are exactly the fixture's wire fields", () => {
    // `satisfies` above proves the TS literal has these fields; comparing its key set to the
    // fixture proves the fixture documents the same ones the C# record serializes
    // (RestorabilityTests.RestorabilityWireFieldNames_MatchTheSharedContractTable).
    expect(keys(tsRestorability)).toEqual(keys(FIXTURE.restorabilityWireShape))
  })

  test("EntityPreImage's stored shape is the fixture's, with no persisted verdict", () => {
    expect(keys(tsPreImage)).toEqual(keys(FIXTURE.entityPreImageWireShape))
    // The plugin computes the verdict on read (EntityPreImage.Restorability()); storing it would
    // let a verdict drift from the geometry it describes.
    expect(FIXTURE.entityPreImageWireShape).not.toHaveProperty('restorability')
    expect(tsPreImage).not.toHaveProperty('restorability')
  })

  test('the mirror accepts a kind outside EntityKind, which is what unknownKind means', () => {
    // A proxyObject-style name must be representable in Restorability.kind: the union is only
    // EntityKind on the read path's happy cases, so typing Restorability.kind as EntityKind would
    // erase the very verdict the table exists to report.
    const stray: Restorability = {
      verdict: 'unknownKind',
      kind: 'proxyObject',
      reason: 'no row',
      unsupportedFeatures: []
    }
    expect(stray.kind).toBe('proxyObject')
    const knownKinds = new Set(
      FIXTURE.createVectors.map((v) => (v.rebuild as { kind: string }).kind)
    )
    expect(knownKinds.has(stray.kind)).toBe(false)
  })
})

describe('safe editing MCP tool schemas (PR B Slice 03)', () => {
  test('editBeginParams validates handles and selection: "implied"', () => {
    expect(editBeginParams.safeParse({ handles: ['1A', '2B'] }).success).toBe(true)
    expect(editBeginParams.safeParse({ selection: 'implied' }).success).toBe(true)
    expect(editBeginParams.safeParse({}).success).toBe(true)
  })

  test('editApplyParams validates operations and required editId', () => {
    const valid = editApplyParams.safeParse({
      editId: 'edit_123',
      operations: [
        {
          op: 'create',
          id: 'step1',
          entity: {
            kind: 'line',
            start: { x: 0, y: 0, z: 0 },
            end: { x: 10, y: 0, z: 0 }
          }
        }
      ]
    })
    expect(valid.success).toBe(true)
    expect(editApplyParams.safeParse({ editId: 'edit_123', operations: [] }).success).toBe(false)
    expect(
      editApplyParams.safeParse({ operations: [{ op: 'erase', handles: ['1'] }] }).success
    ).toBe(false)
  })

  test('editPreviewParams validates editId and capture bounds', () => {
    expect(editPreviewParams.safeParse({ editId: 'edit_123' }).success).toBe(true)
    expect(
      editPreviewParams.safeParse({
        editId: 'edit_123',
        capture: { width: 1024, height: 768 }
      }).success
    ).toBe(true)
    expect(editPreviewParams.safeParse({}).success).toBe(false)
  })
})

describe('safe editing MCP tool schemas (PR B Slice 04)', () => {
  test('editDiscardParams validates editId and optional approvalToken', () => {
    expect(editDiscardParams.safeParse({ editId: 'edit_123' }).success).toBe(true)
    expect(
      editDiscardParams.safeParse({ editId: 'edit_123', approvalToken: 'apv_123' }).success
    ).toBe(true)
    expect(editDiscardParams.safeParse({}).success).toBe(false)
  })

  test('editAcceptParams validates editId and approvalToken and expected diff/revision', () => {
    expect(
      editAcceptParams.safeParse({
        editId: 'edit_123',
        approvalToken: 'apv_123',
        expectedDiffDigest: 'abcdef0123456789',
        expectedRevision: 'tdu:100;saves:1'
      }).success
    ).toBe(true)
    expect(editAcceptParams.safeParse({}).success).toBe(false)
  })
})

type EditToolHandler = (
  input: unknown,
  ctx: { mcpReq: { id: number; signal?: AbortSignal } }
) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>

function createEditTool(bridge: BridgeClient): EditToolHandler {
  let handler!: EditToolHandler
  const serverDouble = {
    registerTool: (_name: string, _defs: unknown, cb: EditToolHandler): void => {
      handler = cb
    }
  } as unknown as Parameters<typeof registerEditTools>[0]
  registerEditTools(serverDouble, bridge)
  return handler
}

class SpyBridge implements BridgeClient {
  calls: { method: string; params: unknown }[] = []
  async request<M extends RpcMethodName>(method: M, params: unknown): Promise<any> {
    this.calls.push({ method, params })
    return { status: 'accepted', appliedMapping: {} }
  }
  async close(): Promise<void> {}
}

describe('safe editing MCP tool human approval verification (PR B Slice 06)', () => {
  test('edit.accept with no token throws refusal and bridge is never dialed', async () => {
    const spy = new SpyBridge()
    const handler = createEditTool(spy)

    const res = await handler(
      {
        operation: 'accept',
        editId: 'edit_no_token',
        approvalToken: '',
        validationId: 'val_test'
      },
      { mcpReq: { id: 1 } }
    )

    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('human approval')
    expect(spy.calls.length).toBe(0)
  })

  test('edit.accept with token bound to different diffDigest refuses and bridge is never dialed', async () => {
    const spy = new SpyBridge()
    const handler = createEditTool(spy)

    const rawToken = 'apv_digest_mismatch_token'
    const tokenHash = hashApprovalToken(rawToken)

    await db.editApprovals.createPending({
      runId: 'run-digest-1',
      workspaceId: 'ws-1',
      editId: 'edit_digest_1',
      diffDigest: 'expected_digest_aaa',
      expiresAt: Date.now() + 60_000
    })
    await db.editApprovals.resolve('run-digest-1', {
      approved: true,
      tokenHash,
      expiresAt: Date.now() + 60_000
    })

    const res = await handler(
      {
        operation: 'accept',
        editId: 'edit_digest_1',
        approvalToken: rawToken,
        expectedDiffDigest: 'different_digest_bbb',
        validationId: 'val_test'
      },
      { mcpReq: { id: 2 } }
    )

    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('diff digest')
    expect(spy.calls.length).toBe(0)
  })

  test('edit.accept with expired token refuses and bridge is never dialed', async () => {
    const spy = new SpyBridge()
    const handler = createEditTool(spy)

    const rawToken = 'apv_expired_token'
    const tokenHash = hashApprovalToken(rawToken)

    await db.editApprovals.createPending({
      runId: 'run-expired-1',
      workspaceId: 'ws-1',
      editId: 'edit_exp_1',
      diffDigest: 'digest_exp',
      expiresAt: Date.now() - 1000
    })
    await db.editApprovals.resolve('run-expired-1', {
      approved: true,
      tokenHash,
      expiresAt: Date.now() - 1000
    })

    const res = await handler(
      {
        operation: 'accept',
        editId: 'edit_exp_1',
        approvalToken: rawToken,
        expectedDiffDigest: 'digest_exp',
        validationId: 'val_test'
      },
      { mcpReq: { id: 3 } }
    )

    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain('expired')
    expect(spy.calls.length).toBe(0)
  })

  test('edit.accept with valid token dials bridge exactly once and consumed token replay refuses', async () => {
    const spy = new SpyBridge()
    const handler = createEditTool(spy)

    const rawToken = 'apv_valid_token_123'
    const tokenHash = hashApprovalToken(rawToken)

    await db.editApprovals.createPending({
      runId: 'run-valid-1',
      workspaceId: 'ws-1',
      editId: 'edit_valid_1',
      diffDigest: 'digest_valid_1',
      expiresAt: Date.now() + 60_000
    })
    await db.editApprovals.resolve('run-valid-1', {
      approved: true,
      tokenHash,
      expiresAt: Date.now() + 60_000
    })

    const res1 = await handler(
      {
        operation: 'accept',
        editId: 'edit_valid_1',
        approvalToken: rawToken,
        expectedDiffDigest: 'digest_valid_1',
        validationId: 'val_test'
      },
      { mcpReq: { id: 4 } }
    )

    expect(res1.isError).toBeFalsy()
    expect(spy.calls.length).toBe(1)
    expect(spy.calls[0]!.method).toBe('edit.accept')

    const res2 = await handler(
      {
        operation: 'accept',
        editId: 'edit_valid_1',
        approvalToken: rawToken,
        expectedDiffDigest: 'digest_valid_1',
        validationId: 'val_test'
      },
      { mcpReq: { id: 5 } }
    )

    expect(res2.isError).toBe(true)
    expect(res2.content[0]!.text).toContain('already been consumed')
    expect(spy.calls.length).toBe(1)
  })
})

const keys = (o: object) => Object.keys(o).sort()
