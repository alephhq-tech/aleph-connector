import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canonicalize, hashCanonical } from '../src/spatial/fingerprint'

/**
 * Regenerates windows/contracts/preimage-contract-vectors.json.
 *   cd aleph-cloud && bun run gen:preimage-vectors
 * The digests MUST come from this package's fingerprint.ts: it is the algorithm the Design Guard
 * already uses to bind a validation record to a payload, and the plugin's C# port
 * (plugin/Edits/PreImageCanonical.cs) must reproduce it byte for byte. Committing hand-computed
 * digests would let all four consumers agree on a wrong number.
 * `createVectors` is the shared entity.create completeness table; adding an entity kind or a new
 * required field on one side without a vector here is what the coverage tests in
 * plugin.Tests/Edits/RestorabilityTests.cs and apps/mcp-autocad/src/tools/edit.test.ts catch.
 */
const P = (x: number, y: number, z = 0) => ({ x, y, z })
const props = (over: Record<string, unknown> = {}) => ({
  color: { aci: 256 },
  linetype: 'ByLayer',
  linetypeScale: 1,
  lineweight: -1,
  visible: true,
  ...over
})

const vectors: { name: string; note: string; value: unknown }[] = [
  {
    name: 'line',
    note: 'baseline: a simple line on a named layer',
    value: {
      handle: '2a4',
      kind: 'line',
      layer: 'WALLS',
      geometry: { start: P(0, 0), end: P(100.5, 0.3), length: 100.5004 },
      properties: props()
    }
  },
  {
    name: 'line-float-wobble-equals-line',
    note: '0.1+0.2 vs 0.3 must digest equal once rounded at the 1e-6 floor',
    value: {
      handle: '2a4',
      kind: 'line',
      layer: 'WALLS',
      geometry: { start: P(0, 0), end: P(100.5, 0.1 + 0.2), length: 100.5004 },
      properties: props()
    }
  },
  {
    name: 'line-moved-differs-from-line',
    note: '1e-5 is far above the 1e-6 floor: one wall moved must change the digest',
    value: {
      handle: '2a4',
      kind: 'line',
      layer: 'WALLS',
      geometry: { start: P(0, 0), end: P(100.50001, 0.3), length: 100.5004 },
      properties: props()
    }
  },
  {
    name: 'line-negative-half',
    note: 'Math.round sends a negative half toward +infinity (-0.5000005 -> -0.500000); AwayFromZero would split C# from TS here',
    value: {
      handle: '2a4',
      kind: 'line',
      layer: 'WALLS',
      geometry: { start: P(-0.5000005, -0.0000005), end: P(0, 0), length: 0.5 },
      properties: props()
    }
  },
  {
    name: 'circle-volatile-dropped',
    note: 'idempotencyKey/view are volatile for BOTH canonicalizers; bounds stays null and renders null',
    value: {
      handle: 'b7',
      kind: 'circle',
      layer: 'FIXTURES',
      bounds: null,
      idempotencyKey: 'retry-must-not-change-identity',
      view: { follow: 'off' },
      geometry: { center: P(-12.5, 8), radius: 4.25 },
      properties: props({
        color: { rgb: { r: 255, g: 0, b: 0 } },
        linetype: 'DASHED',
        lineweight: 25
      })
    }
  },
  {
    name: 'circle-volatile-free-equals-volatile-dropped',
    note: 'same circle with the volatile keys absent must digest equal',
    value: {
      handle: 'b7',
      kind: 'circle',
      layer: 'FIXTURES',
      bounds: null,
      geometry: { center: P(-12.5, 8), radius: 4.25 },
      properties: props({
        color: { rgb: { r: 255, g: 0, b: 0 } },
        linetype: 'DASHED',
        lineweight: 25
      })
    }
  },
  {
    name: 'circle-bounds-null-vs-absent-differs',
    note: 'an explicit null and a missing key are NOT the same canonical form — pins the keep-null rule',
    value: {
      handle: 'b7',
      kind: 'circle',
      layer: 'FIXTURES',
      geometry: { center: P(-12.5, 8), radius: 4.25 },
      properties: props({
        color: { rgb: { r: 255, g: 0, b: 0 } },
        linetype: 'DASHED',
        lineweight: 25
      })
    }
  },
  {
    name: 'polyline-order-is-semantic',
    note: 'arrays are order-preserving: reversing vertices is a different shape, not the same drawing',
    value: {
      handle: 'f11',
      kind: 'polyline',
      layer: 'ROUTES',
      geometry: {
        vertices: [{ point: P(0, 0) }, { point: P(10, 0), bulge: 0.5 }, { point: P(10, 10) }],
        closed: false,
        length: 25.7,
        area: null
      },
      properties: props()
    }
  },
  {
    name: 'text-unicode-and-quotes',
    note: 'non-ASCII plus escaped quotes must survive both escape paths identically',
    value: {
      handle: 'c2',
      kind: 'mtext',
      layer: 'ANNOTATIONS',
      geometry: {
        insertion: P(5, 5),
        text: 'Cột "PCCC-1"\ndài\t2m — 层级',
        height: 2.5,
        rotation: 0,
        width: 40,
        style: 'Standard'
      },
      properties: props()
    }
  }
]
// What Restorability.Of() must answer for a captured detail. `verdict`/`reason`/
// `unsupportedFeatures` are the EXACT wire field names slice 04 reads, so the C# serializer test
// (RestorabilityTests) pins them against this table and the TS mirror interface in
// wire-protocol/local-ipc/methods.ts is checked against the same keys by edit.test.ts.
const restorabilityVectors: {
  name: string
  note: string
  detail: unknown
  verdict: 'supported' | 'notSupported' | 'unknownKind'
  reasonIncludes: string | null
  unsupportedFeatures: string[]
}[] = [
  {
    name: 'line-plain',
    note: 'a defaulted line on a layer restores exactly',
    verdict: 'supported',
    reasonIncludes: null,
    unsupportedFeatures: [],
    detail: {
      handle: '2a4',
      kind: 'line',
      layer: 'WALLS',
      properties: props(),
      geometry: { start: P(0, 0), end: P(100.5, 0.3), length: 100.5004 }
    }
  },
  {
    name: 'line-read-only-properties',
    note: 'transparency/linetypeScale/visible have no write path: supported, but each loss is named',
    verdict: 'supported',
    reasonIncludes: null,
    unsupportedFeatures: [
      'properties.transparency',
      'properties.linetypeScale',
      'properties.visible'
    ],
    detail: {
      handle: '2a4',
      kind: 'line',
      layer: 'WALLS',
      properties: props({ transparency: 40, linetypeScale: 2, visible: false }),
      geometry: { start: P(0, 0), end: P(1, 1) }
    }
  },
  {
    name: 'polyline-variable-widths',
    note: 'entity.create sets one constant width per polyline',
    verdict: 'notSupported',
    reasonIncludes: 'constant width',
    unsupportedFeatures: [],
    detail: {
      handle: 'f11',
      kind: 'polyline',
      layer: 'ROUTES',
      properties: props(),
      geometry: {
        vertices: [
          { point: P(0, 0), startWidth: 1, endWidth: 1 },
          { point: P(10, 0), startWidth: 2, endWidth: 2 }
        ],
        closed: false,
        length: 10
      }
    }
  },
  {
    name: 'mtext-rotated',
    note: 'ToDetail reads MText.Rotation; neither BuildMText nor entity.update ever writes it',
    verdict: 'notSupported',
    reasonIncludes: 'rotation',
    unsupportedFeatures: [],
    detail: {
      handle: 'c2',
      kind: 'mtext',
      layer: 'ANNOTATIONS',
      properties: props(),
      geometry: {
        insertion: P(5, 5),
        text: 'note',
        height: 2.5,
        rotation: 0.785,
        style: 'Standard'
      }
    }
  },
  {
    name: 'dimension-ordinate-text-override',
    note: 'BuildOrdinateDimension passes literal null text (EntityHandlers.cs:1057)',
    verdict: 'notSupported',
    reasonIncludes: 'text override',
    unsupportedFeatures: [],
    detail: {
      handle: 'd9',
      kind: 'dimension.ordinate',
      layer: 'DIM',
      properties: props(),
      geometry: {
        origin: P(0, 0),
        featurePoint: P(10, 5),
        leaderEndPoint: P(12, 6),
        axis: 'x',
        measurement: 10,
        text: '2\'-4"'
      }
    }
  },
  {
    name: 'block-reference-instance',
    note: 'the instance rebuilds; the shared block definition and attribute geometry never do',
    verdict: 'supported',
    reasonIncludes: null,
    unsupportedFeatures: ['blockReference.definition', 'blockReference.attributeGeometry'],
    detail: {
      handle: 'a1',
      kind: 'blockReference',
      layer: 'DOORS',
      properties: props(),
      geometry: {
        blockName: 'DOOR',
        position: P(3, 4),
        scale: P(1, 1),
        rotation: 0,
        attributes: { TAG: 'D1' }
      }
    }
  },
  {
    name: 'hatch-boundary-lost',
    note: 'read-back is loop count/types only; create needs boundaryHandles or loops',
    verdict: 'notSupported',
    reasonIncludes: 'boundaryHandles',
    unsupportedFeatures: [],
    detail: {
      handle: 'h3',
      kind: 'hatch',
      layer: 'FLOOR',
      properties: props(),
      geometry: {
        pattern: 'ANSI31',
        patternScale: 1,
        patternAngle: 0,
        associative: true,
        loopCount: 2,
        loopTypes: ['Outermost', 'Default'],
        area: 12.5
      }
    }
  },
  {
    name: 'other-dxf-name-only',
    note: 'a DXF class name is not a rebuildable payload',
    verdict: 'notSupported',
    reasonIncludes: 'geometry.dxfName',
    unsupportedFeatures: [],
    detail: {
      handle: 's5',
      kind: 'other',
      layer: '0',
      properties: props(),
      geometry: { dxfName: 'SPLINE' }
    }
  },
  {
    name: 'unknown-kind',
    note: 'a kind string with no table row must be refused, never guessed at',
    verdict: 'unknownKind',
    reasonIncludes: 'proxyObject',
    unsupportedFeatures: [],
    detail: {
      handle: 'p1',
      kind: 'proxyObject',
      layer: '0',
      properties: props(),
      geometry: { dxfName: 'ACDB_PROXY_OBJECT' }
    }
  }
]

// The entity.create call that would restore a captured entity. `accepted` is what the plugin's
// Require() set (EntityHandlers.cs:895-909 + builders) answers, and what the zod
// createEntityParams schema must agree with.
const createVectors: { name: string; note: string; rebuild: unknown; accepted: boolean }[] = [
  {
    name: 'line-complete',
    note: 'start + end',
    accepted: true,
    rebuild: { kind: 'line', layer: 'WALLS', start: P(0, 0), end: P(100.5, 0.3) }
  },
  {
    name: 'line-missing-end',
    note: 'end absent',
    accepted: false,
    rebuild: { kind: 'line', layer: 'WALLS', start: P(0, 0) }
  },
  {
    name: 'circle-complete',
    note: 'center + positive radius',
    accepted: true,
    rebuild: { kind: 'circle', center: P(-12.5, 8), radius: 4.25 }
  },
  {
    name: 'circle-zero-radius',
    note: 'radius 0 is rejected on both sides',
    accepted: false,
    rebuild: { kind: 'circle', center: P(0, 0), radius: 0 }
  },
  {
    name: 'arc-complete',
    note: 'center, radius and both angles',
    accepted: true,
    rebuild: { kind: 'arc', center: P(0, 0), radius: 5, startAngle: 0, endAngle: 1.5 }
  },
  {
    name: 'polyline-complete',
    note: 'two points minimum',
    accepted: true,
    rebuild: { kind: 'polyline', points: [P(0, 0), P(10, 0), P(10, 10)], closed: false }
  },
  {
    name: 'polyline-one-point',
    note: 'below the 2-vertex floor',
    accepted: false,
    rebuild: { kind: 'polyline', points: [P(0, 0)] }
  },
  {
    name: 'rectangle-complete',
    note: 'create-only kind (reads back as polyline)',
    accepted: true,
    rebuild: { kind: 'rectangle', corner1: P(0, 0), corner2: P(10, 4) }
  },
  {
    name: 'mtext-complete',
    note: 'insertion + text',
    accepted: true,
    rebuild: { kind: 'mtext', insertion: P(5, 5), text: 'Cột "PCCC-1"', height: 2.5 }
  },
  {
    name: 'text-complete',
    note: 'insertion + text',
    accepted: true,
    rebuild: {
      kind: 'text.singleLine',
      insertion: P(5, 5),
      text: 'W=400',
      height: 2.5,
      rotation: 1.571
    }
  },
  {
    name: 'block-complete',
    note: 'blockName + position',
    accepted: true,
    rebuild: { kind: 'blockReference', blockName: 'DOOR', position: P(3, 4), rotation: 0.5 }
  },
  {
    name: 'block-missing-name',
    note: 'no block to insert',
    accepted: false,
    rebuild: { kind: 'blockReference', position: P(3, 4) }
  },
  {
    name: 'dim-linear-complete',
    note: 'three dimension points',
    accepted: true,
    rebuild: {
      kind: 'dimension.linear',
      extLine1: P(0, 0),
      extLine2: P(10, 0),
      dimLinePoint: P(5, 2)
    }
  },
  {
    name: 'dim-aligned-complete',
    note: 'three dimension points',
    accepted: true,
    rebuild: {
      kind: 'dimension.aligned',
      extLine1: P(0, 0),
      extLine2: P(8, 6),
      dimLinePoint: P(4, 4)
    }
  },
  {
    name: 'dim-ordinate-complete',
    note: 'axis must be x or y',
    accepted: true,
    rebuild: {
      kind: 'dimension.ordinate',
      origin: P(0, 0),
      featurePoint: P(10, 5),
      leaderEndPoint: P(12, 6),
      axis: 'x'
    }
  },
  {
    name: 'dim-ordinate-bad-axis',
    note: 'axis z is invalid on both sides',
    accepted: false,
    rebuild: {
      kind: 'dimension.ordinate',
      origin: P(0, 0),
      featurePoint: P(10, 5),
      leaderEndPoint: P(12, 6),
      axis: 'z'
    }
  },
  {
    name: 'hatch-loops',
    note: 'loops form satisfies create (read-back never produces one)',
    accepted: true,
    rebuild: {
      kind: 'hatch',
      loops: [{ points: [P(0, 0), P(10, 0), P(10, 10), P(0, 10)] }],
      pattern: 'ANSI31'
    }
  },
  {
    name: 'hatch-neither-boundary',
    note: 'needs exactly one of boundaryHandles/loops',
    accepted: false,
    rebuild: { kind: 'hatch', pattern: 'SOLID' }
  },
  {
    name: 'hatch-both-boundaries',
    note: 'ambiguous boundary is rejected',
    accepted: false,
    rebuild: {
      kind: 'hatch',
      boundaryHandles: ['1'],
      loops: [{ points: [P(0, 0), P(1, 0), P(1, 1)] }]
    }
  },
  {
    name: 'other-not-creatable',
    note: 'kind other is never a create input',
    accepted: false,
    rebuild: { kind: 'other', dxfName: 'SPLINE' }
  }
]

// The exact wire shape a Restorability must serialize to: these four camelCase keys and these
// verdict strings are what slice 02/04 read. The C# test serializes a Restorability and compares
// against this; the TypeScript mirror interface is checked against it too, so a renamed or added
// field fails on both sides of the boundary.
const restorabilityWireShape = {
  verdict: 'notSupported',
  kind: 'hatch',
  reason: 'entity.get reads a hatch boundary as loop count/types only',
  unsupportedFeatures: ['properties.transparency']
}

// The stored pre-image shape, likewise pinned three ways (C# EntityPreImage class, this table, the
// TS EntityPreImage interface). Note the ABSENCE of a `restorability` key: the plugin derives the
// verdict on read from `detail`, so it must never be persisted — a stored verdict would go stale
// against the geometry it describes.
const entityPreImageWireShape = {
  detail: vectors[0].value,
  revisionAtCapture: null,
  document: {
    documentId: 'doc-7f3a',
    fingerprintGuid: 'a91b7c2d4e5f60718293a4b5c6d7e8f9',
    path: 'C:/drawings/r1.dwg'
  },
  capturedAtUtc: '2026-10-24T09:15:30.000Z'
}

const fixture = {
  $comment:
    'Shared pre-image contract fixture. REGENERATE with `bun run gen:preimage-vectors` from aleph-cloud/; never hand-edit a digest or a verdict. `vectors` binds a pre-image payload to a digest from aleph-cloud/packages/engineering/src/spatial/fingerprint.ts (the design-guard digest) — the plugin port aleph-desktop/integrations/autocad/plugin/Edits/PreImageCanonical.cs must reproduce it byte for byte, because Cloud stores only the digest while the payload stays on the user machine and the restore path re-computes it inside AutoCAD. `createVectors` is one table asserted by BOTH the C# Restorability.IsRoundTripPayload theory and the TypeScript zod createEntityParams parse. `restorabilityVectors` is the verdict table and `restorabilityWireShape`/`entityPreImageWireShape` the serialized field names, pinned by the C# RestorabilityTests against the plugin types and by apps/mcp-autocad/src/tools/edit.test.ts against the Restorability/EntityPreImage interfaces in wire-protocol/local-ipc/methods.ts.',
  canonicalFormExample: canonicalize(vectors[0].value),
  vectors: vectors.map((v) => ({
    name: v.name,
    note: v.note,
    value: v.value,
    expectedDigest: hashCanonical(v.value)
  })),
  createVectors,
  restorabilityVectors,
  restorabilityWireShape,
  entityPreImageWireShape
}

const target = new URL(
  '../../../windows/contracts/preimage-contract-vectors.json',
  import.meta.url
)
writeFileSync(target, JSON.stringify(fixture, null, 2) + '\n')

// The repo's prettier gate is `bunx oxfmt --check`. JSON.stringify alone collapses arrays
// one-per-line and fails that gate, so the generator formats what it writes — otherwise every
// regeneration leaves a commit that the pre-commit hook rejects.
const autocadRoot = new URL('../../../', import.meta.url)
const formatted = Bun.spawnSync([process.execPath, 'x', 'oxfmt', fileURLToPath(target)], {
  cwd: fileURLToPath(autocadRoot),
  stdout: 'inherit',
  stderr: 'inherit'
})
if (formatted.exitCode !== 0) {
  console.error('oxfmt could not format the fixture; the autocad-format pre-commit gate will fail.')
  process.exit(formatted.exitCode ?? 1)
}
console.log('wrote', fileURLToPath(target))
for (const v of fixture.vectors) console.log(' digest', v.name, '=>', v.expectedDigest)
console.log(
  'createVectors:',
  createVectors.length,
  '| accepted:',
  createVectors.filter((v) => v.accepted).length
)
