import { describe, expect, it } from 'bun:test'
import {
  traceRegionBoundaries,
  type TraceBoundaryRequest,
  type TraceBoundaryResponse
} from '../src/index'

const SHAFT_RING = [
  { x: 17000, y: 109000, z: 0 },
  { x: 19000, y: 109000, z: 0 },
  { x: 19000, y: 111000, z: 0 },
  { x: 17000, y: 111000, z: 0 }
]

const shaftResponse = (
  islands: TraceBoundaryResponse['boundaries'] = []
): TraceBoundaryResponse => ({
  found: true,
  boundaries: [
    { kind: 'outer', points: SHAFT_RING, area: 4_000_000, perimeter: 8000, isClosed: true },
    ...islands
  ],
  netArea: 4_000_000
})

const NOT_FOUND: TraceBoundaryResponse = { found: false, boundaries: [], netArea: 0 }

describe('boundary-trace: vision names a region, CAD supplies its ring', () => {
  it('turns one interior pick point into the real closed polygon and a restricted zone', async () => {
    const result = await traceRegionBoundaries(
      async () => shaftResponse(),
      [
        {
          id: 'lift_1',
          point: [18000, 110000],
          suggestedClass: 'elevator_shaft',
          label: 'Thang may B1'
        }
      ],
      { documentName: 'mat-bang-pccc.dwg', unitsPerMetre: 1000 }
    )

    expect(result.unresolvedPoints).toHaveLength(0)
    expect(result.regions).toHaveLength(1)

    const region = result.regions[0]!
    expect(region.id).toBe('lift_1')
    expect(region.zoneClass).toBe('elevator_shaft')
    expect(region.label).toBe('Thang may B1')
    expect(region.verified).toBe(true)
    expect(region.confidence).toBe('high')
    expect(region.areaM2).toBe(4)
    expect(region.outer).toEqual([
      [17000, 109000],
      [19000, 109000],
      [19000, 111000],
      [17000, 111000]
    ])

    const zone = result.restrictedZones[0]!
    expect(zone.zoneClass).toBe('elevator_shaft')
    expect(zone.verified).toBe(true)
    expect(zone.outer).toEqual(region.outer)
  })

  it('carries island rings as holes so a column inside the shaft is not re-traced', async () => {
    const result = await traceRegionBoundaries(
      async () =>
        shaftResponse([
          {
            kind: 'island',
            points: [
              { x: 17500, y: 109500, z: 0 },
              { x: 17900, y: 109500, z: 0 },
              { x: 17900, y: 109900, z: 0 },
              { x: 17500, y: 109900, z: 0 }
            ],
            area: 160_000,
            isClosed: true
          }
        ]),
      [{ point: [18000, 110000], suggestedClass: 'elevator_shaft' }],
      { unitsPerMetre: 1000 }
    )

    expect(result.regions[0]!.holes).toEqual([
      [
        [17500, 109500],
        [17900, 109500],
        [17900, 109900],
        [17500, 109900]
      ]
    ])
  })

  it('jitters the pick point when it lands on geometry, and asks the CAD engine again', async () => {
    const requested: TraceBoundaryRequest[] = []
    const result = await traceRegionBoundaries(
      async (request) => {
        requested.push(request)
        return requested.length === 1 ? NOT_FOUND : shaftResponse()
      },
      [{ point: [18000, 110000], suggestedClass: 'elevator_shaft' }],
      { unitsPerMetre: 1000 }
    )

    expect(requested).toHaveLength(2)
    expect(requested[0]!.point).toEqual({ x: 18000, y: 110000, z: 0 })
    expect(requested[1]!.point.x).not.toBe(18000)
    expect(result.regions).toHaveLength(1)
    expect(result.unresolvedPoints).toHaveLength(0)
  })

  it('refuses a traced ring that does not contain the pick point (E2: neighbour/corridor swallow)', async () => {
    // The engine closed a ring, but it is the ring of a DIFFERENT region than the one pointed at:
    // the pick sits outside it. The old code marked this verified and drew on the wrong room.
    const result = await traceRegionBoundaries(
      async () => shaftResponse(), // SHAFT_RING spans x[17000,19000] y[109000,111000]
      [{ id: 'bad', point: [5000, 5000], suggestedClass: 'room' }],
      { unitsPerMetre: 1000 }
    )
    expect(result.regions).toHaveLength(0)
    expect(result.restrictedZones).toHaveLength(0)
    expect(result.unresolvedPoints).toHaveLength(1)
    expect(result.unresolvedPoints[0]!.reason).toContain('does not contain the pick point')
  })

  it('keeps a ring that contains an on-wall pick point (shared wall counts as inside)', async () => {
    // A tiny room whose label sits right on the wall: the pick lands exactly on the ring boundary.
    // pointInRing treats on-boundary as inside, so this must stay a verified region, not unresolved.
    const roomRing = [
      { x: 10000, y: 10000, z: 0 },
      { x: 12000, y: 10000, z: 0 },
      { x: 12000, y: 12000, z: 0 },
      { x: 10000, y: 12000, z: 0 }
    ]
    const result = await traceRegionBoundaries(
      async () => ({
        found: true,
        boundaries: [
          { kind: 'outer', points: roomRing, area: 4_000_000, perimeter: 8000, isClosed: true }
        ],
        netArea: 4_000_000
      }),
      [{ point: [10000, 11000], suggestedClass: 'room' }], // on the left wall
      { unitsPerMetre: 1000 }
    )
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]!.verified).toBe(true)
    expect(result.unresolvedPoints).toHaveLength(0)
  })

  it('marks a contained-but-out-of-band ring unverified so preflight refuses to certify it', async () => {
    // Ring DOES contain the point, but a "room" of 400 m2 is outside the room band (max 400 is the
    // bound; use a bigger one) — the polygon stays (drawn/inspected) but verified:false + medium.
    const bigRoom = [
      { x: 0, y: 0, z: 0 },
      { x: 100000, y: 0, z: 0 },
      { x: 100000, y: 100000, z: 0 },
      { x: 0, y: 100000, z: 0 }
    ]
    const result = await traceRegionBoundaries(
      async () => ({
        found: true,
        boundaries: [
          {
            kind: 'outer',
            points: bigRoom,
            area: 10_000_000_000,
            perimeter: 400000,
            isClosed: true
          }
        ],
        netArea: 10_000_000_000
      }),
      [{ point: [50000, 50000], suggestedClass: 'room' }],
      { unitsPerMetre: 1000 }
    )
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]!.areaM2).toBe(10000)
    expect(result.regions[0]!.verified).toBe(false)
    expect(result.regions[0]!.confidence).toBe('medium')
  })

  it('reports a point that yields no closed boundary instead of inventing a rectangle', async () => {
    const result = await traceRegionBoundaries(
      async () => NOT_FOUND,
      [{ point: [50000, 50000], suggestedClass: 'stairwell' }],
      { unitsPerMetre: 1000 }
    )

    expect(result.regions).toHaveLength(0)
    expect(result.restrictedZones).toHaveLength(0)
    expect(result.unresolvedPoints).toHaveLength(1)
    expect(result.unresolvedPoints[0]!.candidate.point).toEqual([50000, 50000])
  })

  it('carries the CAD engine reason for a point it could not trace', async () => {
    const result = await traceRegionBoundaries(
      async () => ({
        ...NOT_FOUND,
        reason: 'AutoCAD found no closed boundary containing [50000, 50000].'
      }),
      [{ point: [50000, 50000], suggestedClass: 'stairwell' }],
      { unitsPerMetre: 1000 }
    )

    expect(result.unresolvedPoints[0]!.reason).toContain('no closed boundary')
  })

  it('downgrades confidence when the traced area is implausible for the named class', async () => {
    const result = await traceRegionBoundaries(
      async () => ({
        found: true,
        boundaries: [
          {
            kind: 'outer',
            points: [
              { x: 0, y: 0, z: 0 },
              { x: 20000, y: 0, z: 0 },
              { x: 20000, y: 20000, z: 0 },
              { x: 0, y: 20000, z: 0 }
            ],
            area: 400_000_000,
            isClosed: true
          }
        ],
        netArea: 400_000_000
      }),
      [{ point: [10000, 10000], suggestedClass: 'elevator_shaft' }],
      { unitsPerMetre: 1000 }
    )

    expect(result.regions[0]!.areaM2).toBe(400)
    expect(result.regions[0]!.confidence).toBe('medium')
  })
})
