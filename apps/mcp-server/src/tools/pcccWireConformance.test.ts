import { describe, expect, it } from 'bun:test'
import { entityOperation } from '@aleph-connector/cad-tools'
import { planHighwayFireAlarm, resolvePcccBlocks } from '@aleph-connector/engineering'
import type { FireAlarmRoomInput } from '@aleph-connector/engineering'

/**
 * The PCCC planners build their `cadOperations` as loose records, so the compiler cannot see a kind
 * the plugin does not implement or a point shape the wire contract forbids. Both mistakes were
 * invisible to the mock bridge — which accepts any shape — and surfaced on a real AutoCAD as an
 * opaque C# deserialization error raised *inside* the transaction, after other entities in the same
 * batch had already been attempted. Whatever a planner proposes to draw must parse through the same
 * schema the public `entity` / `operations` tools already run their input through.
 */

const LIBRARY = [
  'DAU BAO KHOI',
  'DAU BAO NHIET',
  'NUT NHAN KHAN CAP',
  'CHUONG BAO CHAY',
  'BOX NOI DAY FA',
  'DIEN_TRO'
]

// Coordinates from the real SUNLAND basement sheet, so the plan exercises a realistic extent.
const garage: FireAlarmRoomInput = {
  id: 'gara',
  name: 'GARA DE XE TANG HAM',
  usage: 'garage',
  boundary: [
    [6878, 102858],
    [29518, 102858],
    [29518, 119283],
    [6878, 119283]
  ]
}
const shaft: FireAlarmRoomInput = {
  id: 'shaft',
  name: 'THANG MAY',
  usage: 'elevator',
  boundary: [
    [18700, 111100],
    [22800, 111100],
    [22800, 114500],
    [18700, 114500]
  ]
}

const plan = planHighwayFireAlarm({
  rooms: [garage, shaft],
  stairDoors: [{ doorPoint: [17900, 111100] }],
  junctionBoxLocation: [11000, 105500],
  beamYHighways: [105500, 117000],
  blockNames: resolvePcccBlocks(LIBRARY).blocks,
  insUnits: 'mm'
})

describe('PCCC fire-alarm plan is wire-conformant', () => {
  it('every operation parses as an EntityOperation the plugin can execute', () => {
    expect(plan.status).toBe('PASS')
    expect(plan.cadOperations.length).toBeGreaterThan(0)

    const rejected: string[] = []
    for (const [index, op] of plan.cadOperations.entries()) {
      const parsed = entityOperation.safeParse(op)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        rejected.push(`op ${index} ${issue?.path.join('.')}: ${issue?.message}`)
      }
    }
    expect(rejected).toEqual([])
  })

  it('emits only kinds the plugin implements, and never a device tag the wire has no name for', () => {
    // The plugin's create dispatch has no `single_line_text` arm: it threw InvalidGeometry, so no
    // label was ever drawn and the whole batch aborted — the reason the agent fell back to drawing
    // the overlay by hand, outside the floor-plan frame. The planner's operation type now makes
    // that kind unrepresentable, so this asserts what can be emitted rather than what cannot.
    const kinds = new Set(plan.cadOperations.map((op) => op.entity.kind))
    for (const kind of kinds) {
      expect(['polyline', 'blockReference', 'text.singleLine', 'line']).toContain(kind)
    }
  })

  it("sends points as wire objects, never the planners' internal [x,y] tuples", () => {
    const points = plan.cadOperations.flatMap((op) => {
      const e = op.entity as Record<string, unknown>
      const list = Array.isArray(e.points) ? (e.points as unknown[]) : []
      const singles = ['position', 'insertion', 'start', 'end']
        .map((key) => e[key])
        .filter((value) => value !== undefined)
      return [...list, ...singles]
    })
    expect(points.length).toBeGreaterThan(0)
    for (const point of points) {
      expect(Array.isArray(point)).toBe(false)
      const p = point as Record<string, unknown>
      expect(typeof p.x).toBe('number')
      expect(typeof p.y).toBe('number')
      expect(p.z).toBe(0)
    }
  })
})
