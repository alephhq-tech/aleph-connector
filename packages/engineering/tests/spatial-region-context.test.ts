import { describe, expect, it } from 'bun:test'
import {
  deriveRestrictedZones,
  extractSpatialModel,
  buildRegionContext,
  regionCacheKey,
  REGION_SCHEMA_VERSION
} from '../src/index'
import { basementEntities } from './fixtures/basement-fire-alarm'

/**
 * P1 semantic grounding: the elevator shaft and stairwell in a real drawing become enforceable
 * zones with native source handles — the step that turns "the model saw a shaft" into "a route
 * through it is blocked".
 */

describe('region inspection — classification from native evidence', () => {
  const model = extractSpatialModel(basementEntities() as never, {
    documentName: 'basement.dwg',
    unitsPerMetre: 1000
  })
  const { zones, findings } = deriveRestrictedZones(model, new Map())

  it('recognizes the elevator shaft as a restricted zone with its source handle', () => {
    const elev = zones.find((z) => z.zoneClass === 'elevator_shaft')
    expect(elev).toBeDefined()
    expect(elev!.sourceHandles).toContain('ELEV_SHAFT_1')
    // Geometry came from real polyline vertices, so it is authoritative.
    expect(elev!.verified).toBe(true)
    expect(elev!.outer.length).toBeGreaterThanOrEqual(4)
    expect(elev!.confidence).toBe('high')
  })

  it('recognizes the stairwell', () => {
    const stair = zones.find((z) => z.zoneClass === 'stairwell')
    expect(stair).toBeDefined()
    expect(stair!.sourceHandles).toContain('STAIR_1')
  })

  it('does not invent a zone out of the corridor or the plate', () => {
    expect(zones.some((z) => z.sourceHandles.includes('CORRIDOR_1'))).toBe(false)
    expect(zones.some((z) => z.sourceHandles.includes('BASEMENT_PLATE'))).toBe(false)
  })

  it('an unrecoverable shaft-shaped ring surfaces as insufficient data, never as a clean region', () => {
    // A closed ring whose vertices could not be read never becomes a Space, so model-level
    // classification alone would report "no shaft here". The region sweep reports the candidate.
    const degenerate = [
      {
        handle: 'ELEV_BAD',
        kind: 'polyline',
        layer: 'ELEVATOR',
        geometry: { closed: true, vertices: [{ point: { x: 0, y: 0 } }, { point: { x: 1, y: 1 } }] }
      }
    ]
    const region = buildRegionContext(degenerate as never, {
      documentName: 'bad.dwg',
      unitsPerMetre: 1000
    })
    expect(region.zones.filter((z) => z.verified)).toHaveLength(0)
    const finding = region.findings.find((f) => f.code === 'REGION_BOUNDARY_UNRECOVERABLE')
    expect(finding?.status).toBe('INSUFFICIENT_DATA')
    expect(finding?.entityIds).toContain('ELEV_BAD')
  })
})

describe('region context — identity, coverage and cache reuse', () => {
  const entities = basementEntities()

  it('carries drawing identity, revision, units and schema version', () => {
    const region = buildRegionContext(entities as never, {
      documentName: 'basement.dwg',
      documentRevision: 'tdu:100;saves:1',
      unitsPerMetre: 1000,
      floorHint: 'B1'
    })
    expect(region.schemaVersion).toBe(REGION_SCHEMA_VERSION)
    expect(region.drawing.documentName).toBe('basement.dwg')
    expect(region.drawing.documentRevision).toBe('tdu:100;saves:1')
    expect(region.drawing.units.declared).toBe(true)
    expect(region.region.floorHint).toBe('B1')
    expect(region.zones.length).toBeGreaterThan(0)
  })

  it('scopes to the requested window and reports coverage honestly', () => {
    const far = buildRegionContext(entities as never, {
      documentName: 'basement.dwg',
      documentRevision: 'tdu:100;saves:1',
      unitsPerMetre: 1000,
      window: { min: [30000, 20000], max: [40000, 24000] }
    })
    // The shaft is outside that window: it must not be claimed as in-region.
    expect(far.zones.some((z) => z.zoneClass === 'elevator_shaft')).toBe(false)
    expect(['partial', 'complete']).toContain(far.coverage.status)
  })

  it('a cache key changes when the drawing revision changes', () => {
    const window = { min: [0, 0] as [number, number], max: [40000, 24000] as [number, number] }
    const a = regionCacheKey({ drawingId: 'basement.dwg', revision: 'tdu:100;saves:1', window })
    const b = regionCacheKey({ drawingId: 'basement.dwg', revision: 'tdu:101;saves:1', window })
    const sameWindow = regionCacheKey({
      drawingId: 'basement.dwg',
      revision: 'tdu:100;saves:1',
      window
    })
    expect(a).toBe(sameWindow)
    expect(a).not.toBe(b)
  })

  it('an explicitly hinted classification is honored and recorded as such', () => {
    const hinted = buildRegionContext(entities as never, {
      documentName: 'basement.dwg',
      unitsPerMetre: 1000,
      zoneHints: [{ handle: 'CORRIDOR_1', zoneClass: 'electrical_riser' }]
    })
    const zone = hinted.zones.find((z) => z.zoneClass === 'electrical_riser')
    expect(zone).toBeDefined()
    expect(zone!.evidence).toBe('user-declared hint')
  })
})
