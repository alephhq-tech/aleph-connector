import { describe, expect, test } from 'bun:test'
import { BridgeErrorCode, BridgeRpcError, RpcMethod } from '@aleph-connector/cad-protocol'
import { MockBridgeClient } from './MockBridgeClient.js'

describe('MockBridgeClient edit.begin (PR B Slice 02)', () => {
  test('refuses to begin edit on locked layer with LayerProtected (-32012)', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.LayerCreate, { name: 'LOCKED-WALLS', color: { aci: 1 } })
    const { entity } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      layer: 'LOCKED-WALLS',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    await bridge.request(RpcMethod.LayerSetProperties, {
      name: 'LOCKED-WALLS',
      locked: true
    })

    try {
      await bridge.request(RpcMethod.EditBegin, { handles: [entity.handle] })
      expect.unreachable('should have thrown LayerProtected')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.LayerProtected)
      expect(rpcErr.message).toContain('LOCKED-WALLS')
    }
  })

  test('refuses to begin edit on an external reference (xref) with InvalidOperation (-32021)', async () => {
    const bridge = new MockBridgeClient()
    // Inject a mock xref block definition
    const doc = bridge.inspectState()
    doc.blockDefinitions.set('SITE-XREF', {
      name: 'SITE-XREF',
      isAnonymous: false,
      isLayout: false,
      isXref: true,
      explodable: false,
      isDynamic: false
    })

    const { entity: xrefRef } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'SITE-XREF',
      position: { x: 0, y: 0, z: 0 }
    })

    try {
      await bridge.request(RpcMethod.EditBegin, { handles: [xrefRef.handle] })
      expect.unreachable('should have thrown InvalidOperation for xref')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.InvalidOperation)
      expect(rpcErr.message).toContain('external reference')
    }
  })

  test('refuses to begin edit on hatch with EditNotRestorable (-32026) naming the offending handle', async () => {
    const bridge = new MockBridgeClient()
    const { entity: boundaryLine } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const { entity: hatch } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'hatch',
      pattern: 'SOLID',
      boundaryHandles: [boundaryLine.handle]
    })

    try {
      await bridge.request(RpcMethod.EditBegin, { handles: [hatch.handle] })
      expect.unreachable('should have thrown EditNotRestorable')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.EditNotRestorable)
      expect(rpcErr.message).toContain(hatch.handle)
      expect(rpcErr.message).toContain('hatch')
      expect(rpcErr.message).toContain('boundaryHandles')
    }
  })

  test('refuses to begin edit on rotated mtext with EditNotRestorable (-32026)', async () => {
    const bridge = new MockBridgeClient()
    const { entity: mtext } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'mtext',
      text: 'Rotated Label',
      insertion: { x: 0, y: 0, z: 0 }
    })

    // Update geometry in mock to include rotation (simulating read-back rotation from live AutoCAD)
    const doc = bridge.inspectState()
    const rawGeom = doc.entityGeometry.get(mtext.handle) as Record<string, unknown>
    rawGeom.rotation = 0.785398

    try {
      await bridge.request(RpcMethod.EditBegin, { handles: [mtext.handle] })
      expect.unreachable('should have thrown EditNotRestorable for rotated mtext')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.EditNotRestorable)
      expect(rpcErr.message).toContain(mtext.handle)
      expect(rpcErr.message).toContain('rotation')
    }
  })

  test('selection path: selection: "implied" resolves selected entities', async () => {
    const bridge = new MockBridgeClient()
    const { entity: l1 } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })
    const { entity: l2 } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 10, y: 0, z: 0 },
      end: { x: 20, y: 0, z: 0 }
    })

    bridge.setImpliedSelection([l1.handle, l2.handle])

    const res = await bridge.request(RpcMethod.EditBegin, { selection: 'implied' })
    expect(res.editId).toMatch(/^edit_[0-9a-f]{32}$/)
    expect(res.preImages.length).toBe(2)
    expect(res.candidates.length).toBe(2)
    expect(res.preImages.map((p) => p.detail.handle)).toEqual([l1.handle, l2.handle])
  })

  test('candidate handles != source handles and candidates are placed on candidateLayer', async () => {
    const bridge = new MockBridgeClient()
    const { entity: source } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 100, y: 50, z: 0 }
    })

    const res = await bridge.request(RpcMethod.EditBegin, { handles: [source.handle] })
    expect(res.candidates.length).toBe(1)
    const candidate = res.candidates[0]!

    expect(candidate.handle).not.toBe(source.handle)
    expect(candidate.kind).toBe('line')
    expect(candidate.layer).toBe(res.candidateLayer)
    expect(res.candidateLayer).toBe(`CadAI-Candidate-${res.editId}`)

    // Verify candidate exists in drawing on candidateLayer
    const { entity: readCandidate } = await bridge.request(RpcMethod.EntityGet, {
      handle: candidate.handle
    })
    expect(readCandidate.handle).toBe(candidate.handle)
    expect(readCandidate.layer).toBe(res.candidateLayer)

    // Verify source is unchanged
    const { entity: readSource } = await bridge.request(RpcMethod.EntityGet, {
      handle: source.handle
    })
    expect(readSource.handle).toBe(source.handle)
    expect(readSource.layer).toBe(source.layer)
  })

  test('candidate layer is recorded in layer table with preview color', async () => {
    const bridge = new MockBridgeClient()
    const { entity } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'circle',
      center: { x: 10, y: 10, z: 0 },
      radius: 5
    })

    const res = await bridge.request(RpcMethod.EditBegin, { handles: [entity.handle] })
    const { layers } = await bridge.request(RpcMethod.LayerList, {})
    const foundLayer = layers.find((l) => l.name === res.candidateLayer)
    expect(foundLayer).toBeDefined()
    expect(foundLayer!.color).toEqual({ aci: 30 })
    expect(foundLayer!.frozen).toBe(false)
  })

  test('two tabs with the same basename get separate sessions and distinct identities', async () => {
    const bridge = new MockBridgeClient()
    const doc1 = await bridge.request(RpcMethod.DrawingNew, {})
    const doc2 = await bridge.request(RpcMethod.DrawingNew, {})

    const { entity: e1 } = await bridge.request(RpcMethod.EntityCreate, {
      documentName: doc1.name,
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 5, y: 5, z: 0 }
    })

    const { entity: e2 } = await bridge.request(RpcMethod.EntityCreate, {
      documentName: doc2.name,
      kind: 'line',
      start: { x: 10, y: 10, z: 0 },
      end: { x: 15, y: 15, z: 0 }
    })

    const session1 = await bridge.request(RpcMethod.EditBegin, {
      documentName: doc1.name,
      handles: [e1.handle]
    })

    const session2 = await bridge.request(RpcMethod.EditBegin, {
      documentName: doc2.name,
      handles: [e2.handle]
    })

    expect(session1.editId).not.toBe(session2.editId)
    expect(session1.documentIdentity).not.toBe(session2.documentIdentity)
    expect(session1.candidateLayer).not.toBe(session2.candidateLayer)
  })
})

describe('MockBridgeClient edit.apply and edit.preview (PR B Slice 03)', () => {
  test('edit.apply allows mutating candidate handle and returns OperationsApplyResult with staleSince', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })
    const candidate = begin.candidates[0]!

    const applyRes = await bridge.request(RpcMethod.EditApply, {
      editId: begin.editId,
      operations: [
        {
          op: 'transform',
          transform: {
            op: 'move',
            handles: [candidate.handle],
            delta: { x: 0, y: 5, z: 0 }
          }
        }
      ]
    })

    expect(applyRes.status).toBe('committed')
    expect(applyRes.entityRefs.length).toBeGreaterThanOrEqual(1)
    expect(applyRes.staleSince).toMatch(/^tdu:[0-9]+;saves:[0-9]+$/)
  })

  test('edit.apply refuses to mutate source handle with EditConflict (-32031)', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })

    try {
      await bridge.request(RpcMethod.EditApply, {
        editId: begin.editId,
        operations: [
          {
            op: 'transform',
            transform: {
              op: 'move',
              handles: [line.handle], // Source handle!
              delta: { x: 0, y: 5, z: 0 }
            }
          }
        ]
      })
      expect.unreachable('should have failed with EditConflict')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.EditConflict)
      expect(rpcErr.message).toContain(line.handle)
      expect(rpcErr.message).toContain('not a candidate')
    }
  })

  test('edit.apply refuses create targeting a foreign layer with EditConflict (-32031)', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })

    try {
      await bridge.request(RpcMethod.EditApply, {
        editId: begin.editId,
        operations: [
          {
            op: 'create',
            entity: {
              kind: 'circle',
              layer: '0', // Foreign layer!
              center: { x: 5, y: 5, z: 0 },
              radius: 2
            }
          }
        ]
      })
      expect.unreachable('should have failed with EditConflict')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      const rpcErr = err as BridgeRpcError
      expect(rpcErr.code).toBe(BridgeErrorCode.EditConflict)
      expect(rpcErr.message).toContain('candidate layer')
    }
  })

  test('edit.apply resolves batch-local @ref chaining on candidate layer', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })

    const applyRes = await bridge.request(RpcMethod.EditApply, {
      editId: begin.editId,
      operations: [
        {
          op: 'create',
          id: 'step1',
          entity: {
            kind: 'line',
            layer: begin.candidateLayer,
            start: { x: 0, y: 10, z: 0 },
            end: { x: 10, y: 10, z: 0 }
          }
        },
        {
          op: 'transform',
          transform: {
            op: 'move',
            handles: ['@step1'],
            delta: { x: 0, y: 5, z: 0 }
          }
        }
      ]
    })

    expect(applyRes.status).toBe('committed')
  })

  test('edit.preview computes structured diff and returns before/after PNGs', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })
    const candidate = begin.candidates[0]!

    await bridge.request(RpcMethod.EditApply, {
      editId: begin.editId,
      operations: [
        {
          op: 'transform',
          transform: {
            op: 'move',
            handles: [candidate.handle],
            delta: { x: 0, y: 5, z: 0 }
          }
        }
      ]
    })

    const previewRes = await bridge.request(RpcMethod.EditPreview, {
      editId: begin.editId,
      capture: { width: 800, height: 600 }
    })

    expect(previewRes.diff).toBeDefined()
    expect(previewRes.diff.editId).toBe(begin.editId)
    expect(previewRes.diff.entities.length).toBe(1)
    expect(previewRes.diff.entities[0]!.status).toBe('modified')
    expect(previewRes.diff.entities[0]!.candidateHandle).toBe(candidate.handle)
    expect(previewRes.diff.diffDigest).toBeDefined()
    expect(previewRes.beforePng).toBeDefined()
    expect(previewRes.afterPng).toBeDefined()
  })
})

describe('MockBridgeClient edit.discard and edit.accept (PR B Slice 04)', () => {
  test('accept without a token throws EditRequiresHumanApproval (-32032)', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })

    try {
      await bridge.request(RpcMethod.EditAccept, { editId: begin.editId })
      expect.unreachable('should require approvalToken')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.EditRequiresHumanApproval)
    }
  })

  test('source handle erased between preview and accept throws EditStalePreImage (-32030)', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })

    // User or command erases source handle
    await bridge.request(RpcMethod.EntityErase, { handles: [line.handle] })

    try {
      await bridge.request(RpcMethod.EditAccept, {
        editId: begin.editId,
        approvalToken: 'apv_test'
      })
      expect.unreachable('should throw EditStalePreImage')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.EditStalePreImage)
    }
  })

  test('candidate moved after preview throws EditConflict (-32031) when expectedDiffDigest differs', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })
    const preview = await bridge.request(RpcMethod.EditPreview, { editId: begin.editId })

    // Move candidate further after review
    await bridge.request(RpcMethod.EditApply, {
      editId: begin.editId,
      operations: [
        {
          op: 'transform',
          transform: {
            op: 'move',
            handles: [begin.candidates[0]!.handle],
            delta: { x: 5, y: 5, z: 0 }
          }
        }
      ]
    })

    const currentInfo = await bridge.request(RpcMethod.DrawingInfo, {})
    try {
      await bridge.request(RpcMethod.EditAccept, {
        editId: begin.editId,
        approvalToken: 'apv_test',
        expectedRevision: currentInfo.revision,
        expectedDiffDigest: preview.diff.diffDigest
      })
      expect.unreachable('should fail with EditConflict on digest mismatch')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.EditConflict)
    }
  })

  test('discard leaves source byte-identical to pre-image and deletes candidate layer', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.LayerCreate, { name: 'WALLS' })
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      layer: 'WALLS',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })
    const candidate = begin.candidates[0]!

    // Mutate candidate
    await bridge.request(RpcMethod.EditApply, {
      editId: begin.editId,
      operations: [
        {
          op: 'transform',
          transform: {
            op: 'move',
            handles: [candidate.handle],
            delta: { x: 0, y: 20, z: 0 }
          }
        }
      ]
    })

    // Discard session
    const discardRes = await bridge.request(RpcMethod.EditDiscard, { editId: begin.editId })
    expect(discardRes.status).toBe('discarded')
    expect(discardRes.removedCandidates).toEqual([candidate.handle])

    const state = bridge.inspectState()

    // Candidate entity is deleted
    expect(state.entities.has(candidate.handle)).toBe(false)
    // Candidate layer is deleted
    expect(state.layers.has(begin.candidateLayer)).toBe(false)

    // Source entity is untouched and byte-identical to pre-image
    const { entity: readSource } = await bridge.request(RpcMethod.EntityGet, {
      handle: line.handle,
      detail: 'full'
    })
    expect((readSource as { geometry: unknown }).geometry).toEqual(
      (begin.preImages[0]!.detail as { geometry: unknown }).geometry
    )
  })

  test('accept maps handles: source handle gone, candidate handle promoted to source layer', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.LayerCreate, { name: 'WALLS' })
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      layer: 'WALLS',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })
    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })
    const candidate = begin.candidates[0]!

    const acceptRes = await bridge.request(RpcMethod.EditAccept, {
      editId: begin.editId,
      approvalToken: 'apv_test'
    })

    expect(acceptRes.status).toBe('accepted')
    expect(acceptRes.appliedMapping[line.handle]).toBe(candidate.handle)

    const state = bridge.inspectState()

    // Source handle is gone (erased)
    expect(state.entities.has(line.handle)).toBe(false)

    // Candidate handle is kept and re-layered onto source's layer
    const promoted = state.entities.get(candidate.handle)
    expect(promoted).toBeDefined()
    expect(promoted!.layer).toBe('WALLS')
    expect(state.layers.has(begin.candidateLayer)).toBe(false)
  })

  test('retried accept with same idempotencyKey returns same result without double erase', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })

    const r1 = await bridge.request(RpcMethod.EditAccept, {
      editId: begin.editId,
      approvalToken: 'apv_test',
      idempotencyKey: 'idemp_key_accept'
    })

    const r2 = await bridge.request(RpcMethod.EditAccept, {
      editId: begin.editId,
      approvalToken: 'apv_test',
      idempotencyKey: 'idemp_key_accept'
    })

    expect(r1).toEqual(r2)
  })

  test('accept on already accepted session without idempotencyKey throws EditAlreadyApplied (-32033)', async () => {
    const bridge = new MockBridgeClient()
    const { entity: line } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'line',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 }
    })

    const begin = await bridge.request(RpcMethod.EditBegin, { handles: [line.handle] })

    await bridge.request(RpcMethod.EditAccept, {
      editId: begin.editId,
      approvalToken: 'apv_test'
    })

    try {
      await bridge.request(RpcMethod.EditAccept, {
        editId: begin.editId,
        approvalToken: 'apv_test'
      })
      expect.unreachable('should have thrown EditAlreadyApplied')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.EditAlreadyApplied)
    }
  })
})

describe('Block instance-vs-definition gate (PR B Slice 05)', () => {
  test('explode no longer flips Explodable; stored definition untouched after refusal', async () => {
    const bridge = new MockBridgeClient()
    const { entity: ref } = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'SHARED_VALVE',
      position: { x: 0, y: 0, z: 0 }
    })

    // Make definition non-explodable
    await bridge.request(RpcMethod.BlockSetExplodable, {
      blockName: 'SHARED_VALVE',
      explodable: false,
      sharedScope: true
    })

    try {
      await bridge.request(RpcMethod.BlockExplode, { handle: ref.handle })
      expect.unreachable('should fail with SharedDefinitionScopeRequired')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.SharedDefinitionScopeRequired)
    }

    // Stored definition must still be explodable: false (NOT flipped)
    const inspected = await bridge.request(RpcMethod.BlockInspect, { blockName: 'SHARED_VALVE' })
    expect(inspected.explodable).toBe(false)
  })

  test('setExplodable refuses without sharedScope and reports affectedReferenceCount with it', async () => {
    const bridge = new MockBridgeClient()
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'EQUIPMENT_PUMP',
      position: { x: 0, y: 0, z: 0 }
    })

    try {
      await bridge.request(RpcMethod.BlockSetExplodable, {
        blockName: 'EQUIPMENT_PUMP',
        explodable: false
      })
      expect.unreachable('should fail without sharedScope')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.SharedDefinitionScopeRequired)
    }

    const res = await bridge.request(RpcMethod.BlockSetExplodable, {
      blockName: 'EQUIPMENT_PUMP',
      explodable: false,
      sharedScope: true
    })
    expect(res.success).toBe(true)
    expect(res.affectedReferenceCount).toBe(1)
  })

  test('edit-session candidate explode of a shared definition refuses unless candidate was uniquified', async () => {
    const bridge = new MockBridgeClient()
    const ref1 = await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'DOOR_DOUBLE',
      position: { x: 0, y: 0, z: 0 }
    })
    await bridge.request(RpcMethod.EntityCreate, {
      kind: 'blockReference',
      blockName: 'DOOR_DOUBLE',
      position: { x: 10, y: 0, z: 0 }
    })

    // Make definition non-explodable
    await bridge.request(RpcMethod.BlockSetExplodable, {
      blockName: 'DOOR_DOUBLE',
      explodable: false,
      sharedScope: true
    })

    const begin = await bridge.request(RpcMethod.EditBegin, {
      handles: [ref1.entity.handle]
    })
    const candidateHandle = begin.candidates[0]!.handle

    // Exploding candidate before uniquify refuses with SharedDefinitionScopeRequired
    try {
      await bridge.request(RpcMethod.BlockExplode, { handle: candidateHandle })
      expect.unreachable('should refuse to explode shared candidate without uniquify')
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeRpcError)
      expect((err as BridgeRpcError).code).toBe(BridgeErrorCode.SharedDefinitionScopeRequired)
    }

    // Uniquify candidate
    const uniqRes = await bridge.request(RpcMethod.BlockUniquify, { handle: candidateHandle })
    expect(uniqRes.success).toBe(true)
    expect(uniqRes.newDefinitionName).toContain('DOOR_DOUBLE__CadAI_')

    // Now candidate explode succeeds
    const explodeRes = await bridge.request(RpcMethod.BlockExplode, { handle: candidateHandle })
    expect(explodeRes.success).toBe(true)
  })
})
