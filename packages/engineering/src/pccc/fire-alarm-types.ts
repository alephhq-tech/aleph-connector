import type { Point2D } from '../schemas/semantic-model'
import type { DrawingUnits } from './drawing-units'

export type FireAlarmDeviceType =
  | 'HEAT_DETECTOR'
  | 'SMOKE_DETECTOR'
  | 'MANUAL_CALL_POINT'
  | 'COMBINATION_ALARM'
  | 'JUNCTION_BOX'
  | 'END_OF_LINE_RESISTOR'

export type FireAlarmRoomUsage =
  | 'garage'
  | 'parking'
  | 'kitchen'
  | 'generator'
  | 'electrical'
  | 'pump_room'
  | 'office'
  | 'corridor'
  | 'stairwell'
  | 'elevator'
  | 'storage'
  | 'general'

export interface FireAlarmDevice {
  id: string
  type: FireAlarmDeviceType
  x: number
  y: number
  z?: number
  zoneId: string
  label: string
  address?: number
  roomUsage?: FireAlarmRoomUsage
  blockName?: string
  isEndOfLine?: boolean
}

export interface FireAlarmZone {
  zoneId: string
  name: string
  areaM2: number
  deviceCount: number
  maxAreaM2: number // 2000 m2 continuous per TCVN 7568-14:2025 5.7.2.1
}

export interface FireAlarmRoomInput {
  id: string
  name: string
  usage: FireAlarmRoomUsage
  boundary: Point2D[]
  heightMm?: number
  excludedBoundaries?: Point2D[][]
}

export interface FireAlarmLayoutInput {
  rooms: FireAlarmRoomInput[]
  panelLocation?: Point2D
  junctionBoxLocation?: Point2D
  /**
   * Real panel/junction-box block names (from `block.list`), named in NO_PANEL_ANCHOR
   * when no `junctionBoxLocation` was supplied, so the caller picks a real anchor (E7).
   */
  junctionBoxCandidates?: string[]
  /** Drawing units from `drawing.summary` `insUnits` (E8). Absent/`unitless` blocks the plan. */
  insUnits?: DrawingUnits
  stairDoors?: Array<{
    doorPoint: Point2D
    stairName?: string
  }>
  wallObstacles?: Point2D[][]
  elevatorShafts?: Point2D[][]
  maxSmokeSpacingMm?: number
  maxHeatSpacingMm?: number
  /**
   * Symbol block scale (same value the planner draws at). The clause wall clearance bounds the
   * detector's INSERT POINT, but the drawn graphic has a radius: at scale 1 a point detector is a
   * 400 mm circle, so a centre legal at 300 mm from the wall prints the symbol across the wall.
   * The placement inset is the larger of the clause clearance and this radius.
   */
  symbolScale?: number
}

export interface FireAlarmLayoutResult {
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
  zones: FireAlarmZone[]
  devices: FireAlarmDevice[]
  deviceCounts: Record<FireAlarmDeviceType, number>
  totalProtectedAreaM2: number
  violations: string[]
}

export interface FireAlarmWireSegment {
  id: string
  zoneId: string
  startDeviceId: string
  endDeviceId: string
  points: Point2D[]
  lengthM: number
}

/**
 * A point exactly as the AutoCAD wire carries it. Routers work in `[x, y]` internally; a CAD
 * operation is not internal — it is deserialized by the plugin's `Point3dDto`, which has no array
 * form, so every emitted operation uses this shape.
 */
export interface CadPoint {
  x: number
  y: number
  z: number
}

/** One `operations.apply` step a planner proposes to draw, in wire form. */
export interface CadOperation {
  op: 'create'
  entity: {
    kind: 'polyline' | 'line' | 'blockReference' | 'text.singleLine'
    layer: string
    blockName?: string
    position?: CadPoint
    scale?: CadPoint
    rotation?: number
    text?: string
    height?: number
    /** mtext / text.singleLine anchor (#25 naming). */
    insertion?: CadPoint
    points?: CadPoint[]
    start?: CadPoint
    end?: CadPoint
  }
}

export interface FireAlarmRouteResult {
  status: 'PASS' | 'FAIL'
  zoneId: string
  sequence: string[]
  segments: FireAlarmWireSegment[]
  totalLengthM: number
  eolrDeviceId: string
  violations: string[]
  cadOperations: Array<{
    op: 'create'
    entity: {
      kind: 'polyline'
      layer: string
      // Wire contract (`CreateEntityParams`): polyline vertices are Point3d objects, not
      // [x, y] tuples — the plugin's `Point3dDto` has no array form, and read-back matches on them.
      points: CadPoint[]
    }
  }>
}

export interface FireAlarmFullPlanResult {
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA'
  layout: FireAlarmLayoutResult
  routes: FireAlarmRouteResult[]
  totalDevices: number
  totalWireLengthM: number
  cadOperations: CadOperation[]
  violations: string[]
}
