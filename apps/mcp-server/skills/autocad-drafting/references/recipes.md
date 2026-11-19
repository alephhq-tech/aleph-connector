# Tool recipes

Exact argument shapes for the current tools. Points are `{ "x": …, "y": … }`; `z` is optional and defaults to 0 — leave it out for 2D work. All lengths are drawing units, all angles radians.

## Batches (`operations`)

The main way to draw or edit **directly in the selected DWG**. The native scheduler may commit multiple short phases; always inspect `status` and `committedBatchIds` and use task-scoped recovery where appropriate.

```json
{
  "operation": "apply",
  "operations": [
    {
      "op": "create",
      "entity": {
        "kind": "rectangle",
        "layer": "A-WALL",
        "corner1": { "x": -200, "y": -200 },
        "corner2": { "x": 0, "y": 4200 }
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "line",
        "layer": "A-DOOR",
        "start": { "x": 600, "y": 0 },
        "end": { "x": 600, "y": 900 }
      }
    },
    {
      "op": "transform",
      "transform": { "op": "move", "handles": ["2A9"], "delta": { "x": 100, "y": 0 } }
    },
    { "op": "erase", "handles": ["2B0", "2B1"] }
  ]
}
```

Result:

```json
{ "batchId": "…", "sequence": 3, "status": "committed", "entityRefs": [{ "handle": "2C4", "kind": "rectangle", "layer": "A-WALL" }, …], "undo": { "supported": true, "mode": "native-lifo", "state": "top" } }
```

- **Always check `status`.** `"aborted"` means the whole batch rolled back and nothing was drawn. `error.code` is always `TransactionFailed` for an aborted batch; the real reason is in `error.message` (a missing layer, a missing field, a bad value). Fix it and resend the whole batch.
- `entityRefs` follow step order: each `create` adds exactly one ref, `update` returns the **same original handle**, `erase` adds the erased entities, and `transform` adds the affected (for `copy`, the new) entities. Keep batches whose handles you'll need **all-create**, so `entityRefs[i]` is step `i`.
- **Shorthand the tools accept.** Points as `[x, y]` (z = 0) or `[x, y, z]` — about half the tokens of `{ "x": …, "y": … }` in big batches; `angleUnit: "deg"` next to `operations`/`entity` if you'd rather give degrees; `ensureLayer: true` to create missing layers in the same call (you still choose sensible layer names and set colors/lineweights with `layer` afterwards); kind aliases `rect`, `pline`, `text`, `insert`, `dimlinear`, `dimaligned`. If a batch aborts, `error.failedStep` is the step index and `error.hint` the fix.
- **Result size (`result`).** Up to 20 refs come back in full as above. Above 20, `entityRefs` is `{ "count", "byKind", "byLayer", "handles": ["2C4", …] }` — still in step order, so `handles[i]` is step `i`. Pass `"result": "full"` to force per-ref objects, or `"result": "summary"` (counts + `handleRanges` like `"2C4..2D7"`) when you won't reuse the handles — the cheapest option for big batches. `entity` → `transform` takes the same `result`; `entity` → `list`/`get` and `layer` → `list` take `"fields": ["handle", "layer"]` to return only what you need.
- Later steps can refer to a create step by its batch-local `id` (e.g. `@wall`) for update/transform/erase/hatch, and Aleph splits dependent waves so real handles are available. Don't invent source handles.
- `rectangle` comes back as `kind: "rectangle"` here but lists as `polyline` later; AutoCAD has no rectangle entity.

Undo, redo, history:

```json
{ "operation": "undo", "batchId": "…" }
{ "operation": "redo", "batchId": "…" }
{ "operation": "history", "limit": 10 }
```

## Entity kinds (`entity` → `create`, or a batch `create` step)

| kind                 | fields                                                                                                                  | notes                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `line`               | `start`, `end`                                                                                                          |                                                                                                                                                                                                                                       |
| `circle`             | `center`, `radius`                                                                                                      |                                                                                                                                                                                                                                       |
| `arc`                | `center`, `radius`, `startAngle`, `endAngle`                                                                            | counter-clockwise from start to end, radians                                                                                                                                                                                          |
| `polyline`           | `points` (≥ 2), `closed`                                                                                                | straight segments only; `closed: true` for anything with an area                                                                                                                                                                      |
| `rectangle`          | `corner1`, `corner2`                                                                                                    | axis-aligned closed polyline                                                                                                                                                                                                          |
| `mtext`              | `insertion`, `text`, `height`, `width?`                                                                                 | `insertion` is the **top-left** corner of the text box; `width` wraps lines                                                                                                                                                           |
| `text.singleLine`    | `insertion`, `text`, `height`, `rotation?`                                                                              | `insertion` is the **baseline start** (bottom-left)                                                                                                                                                                                   |
| `dimension.linear`   | `extLine1`, `extLine2`, `dimLinePoint`, `dimText?`, `rotation?`, `direction?`                                           | horizontal by default; `direction: "vertical"` or a `rotation` (radians) for other angles                                                                                                                                             |
| `dimension.aligned`  | `extLine1`, `extLine2`, `dimLinePoint`, `dimText?`                                                                      | parallel to the two points — use it for sloped dimensions                                                                                                                                                                             |
| `dimension.ordinate` | `origin`, `featurePoint`, `leaderEndPoint`, `axis: "x"\|"y"`                                                            | X or Y callout from a datum, for plate/machining drawings                                                                                                                                                                             |
| `hatch`              | `boundaryHandles` **or** `loops`, `pattern` = `SOLID`, `patternScale` = 1, `patternAngle` = 0, `style?`, `associative?` | `boundaryHandles`: existing handles joined into one loop. `loops`: `loops[0]` = outer, rest = islands — each entry is `{ handles }`, `{ points, bulges? }` (no boundary entity created), or `{ circle }` (no boundary entity created) |
| `blockReference`     | `blockName`, `position`, `scale?`, `rotation?`, `attributes?`                                                           | places an existing block; not yet verified against real AutoCAD (#47)                                                                                                                                                                 |

Every kind takes an optional `layer`; always set it.

Common shapes:

- **Door swing** (hinge at H, width w, opening into +Y): leaf `line` H → (H.x, H.y + w); `arc` center H, radius w, `startAngle` 0, `endAngle` 1.5707963.
- **Horizontal dimension** under points P1, P2: `dimension.linear` with `extLine1` P1, `extLine2` P2, `dimLinePoint` (P1.x, P1.y − offset).
- **Vertical dimension** right of points P1, P2 on the same X: `dimension.linear` with `extLine1` P1, `extLine2` P2, `direction: "vertical"`, `dimLinePoint` (P1.x + offset, P1.y). A row of dimensions: `dimension.chain` instead of one `dimension.linear` per pair.
- **Centred label** of height h and n characters at (cx, cy): `text.singleLine` at (cx − 0.35·n·h, cy − 0.35·h).
- **Slab with a hole in one step** (no boundary polyline created, no second round trip): `{ "kind": "hatch", "layer": "A-HATCH", "loops": [{ "points": [[0,0],[8000,0],[8000,6000],[0,6000]] }, { "circle": { "center": [4000, 3000], "radius": 800 } }] }` — `loops[0]` is the outer rectangle, the circle is an island (a hole in the fill).

## Editing existing entities

Single transforms outside a batch (`entity` → `transform`); inside a batch use `{ "op": "transform", "transform": … }`.

```json
{ "operation": "transform", "transform": { "op": "copy", "handles": ["2C4"], "delta": { "x": 6000, "y": 0 } } }
{ "operation": "transform", "transform": { "op": "rotate", "handles": ["2C4"], "center": { "x": 0, "y": 0 }, "angle": 1.5707963 } }
{ "operation": "transform", "transform": { "op": "scale", "handles": ["2C4"], "center": { "x": 0, "y": 0 }, "factor": 2 } }
{ "operation": "transform", "transform": { "op": "mirror", "handles": ["2C4"], "axisStart": { "x": 0, "y": 0 }, "axisEnd": { "x": 0, "y": 1 }, "erase": false } }
{ "operation": "erase", "handles": ["2C4", "2C5"] }
```

**Direct editing is the default for existing drawings**. Do not clone/offset an entire floor plan or draw on a side-by-side copy unless the user explicitly requests that copy. Use the exact existing handle, document and world coordinates:

```json
{
  "operation": "apply",
  "documentName": "Tang_2.dwg",
  "taskId": "task_adjust_sprinklers",
  "operations": [
    {
      "op": "update",
      "update": {
        "handle": "2C4",
        "geometry": { "kind": "circle", "radius": 750 }
      }
    },
    {
      "op": "update",
      "update": {
        "handle": "2C5",
        "layer": "PCCC-SPRINKLER"
      }
    }
  ]
}
```

`op: "update"` patches the existing entity **without changing its handle** and writes a before/after pair to the task ledger for conflict-aware `operations.revert`. It supports the same kind-specific geometry and common properties as `entity.update`. An incompatible `geometry.kind` or unrestorable source fails closed. Use `operations.preview` for a complex read-only preflight when needed; source-side permissions and native conflict protections remain enforced independently of any validation ticket. Do not use candidate clones for ordinary updates. `edit.begin` remains available only for explicit human-reviewed edits.

`copy` takes one `delta` per call — to repeat an object N times _when copying was explicitly requested_, put N `copy` steps with different deltas in one batch. Existing wall openings requiring trim/break (#196) are not yet supported directly; report that limitation instead of silently erasing/redrawing.

## Reading the drawing

```json
{ "operation": "list", "layer": "A-WALL", "limit": 1000, "offset": 0 }
{ "operation": "get", "handle": "2C4" }
{ "operation": "get", "handle": "2C4", "detail": "full" }
```

`list`/`get` default to `{ entities: [{ handle, kind, layer, bounds }], total }` — handle, kind, layer, and bounding box only (`total` counts every match even when `limit` cuts the page). Pass `detail: "full"` to get the entity's actual geometry (a circle's center/radius, a polyline's vertices, a dimension's real measurement, …) and properties beyond layer (color, linetype, lineweight) instead — useful before editing something the model didn't just create, or to inspect what's already in the drawing. Types this server can't create come back as `kind: "other"` with a `dxfName`, never a made-up kind.

`drawing` → `info` returns name, path, entity and layer counts, and whether it has unsaved changes. `view` → `zoom_extents` fits everything on screen.

## Drafting elements (`construct`)

One call → one batch, one undo step. Every generator takes `layer`, `ensureLayer`, `dryRun`, `result`, `documentName`.

```json
{
  "operation": "walls",
  "centerline": [
    [0, 0],
    [8000, 0],
    [8000, 6000],
    [0, 6000]
  ],
  "closed": true,
  "thickness": 200,
  "layer": "A-WALL"
}
```

Closed run → `walls.leftFace` + `walls.rightFace`; open run → one closed `walls.outline` (hatch it with its handle). `justification`: `center` (default), `left` / `right` = the line is that face, by direction of travel.

Add `openings` to cut doors/windows out of the run — each one is `{ at: [x, y] }` (a point near the wall, projected onto the centreline) or `{ along: <distance from the run's start> }`, plus `width`:

```json
{
  "operation": "walls",
  "centerline": [
    [0, 0],
    [8000, 0]
  ],
  "thickness": 200,
  "layer": "A-WALL",
  "openings": [
    { "at": [2600, 120], "width": 900 },
    { "along": 6000, "width": 1200 }
  ]
}
```

The result is `walls.segment1`, `walls.segment2`, … — closed outlines with a real gap where each opening is, so the door leaf and swing arc go in the gap, not on top of the wall. Overlapping openings merge into one gap; openings that consume the whole run are rejected rather than silently drawing nothing.

```json
{
  "operation": "grid",
  "origin": [0, 0],
  "x": { "count": 5, "spacing": 6000 },
  "y": { "spacings": [5000, 7000] },
  "extension": 1500,
  "bubbleRadius": 400,
  "layer": "S-GRID"
}
```

Axes `1, 2, 3…` along X and `A, B, C…` (no I, O) along Y unless `labels` are given; `bubbles: "both"` adds the far-end bubbles. Labels are centred approximately (single-line text is baseline-left).

```json
{
  "operation": "room",
  "outline": [
    [0, 0],
    [4000, 0],
    [4000, 3000],
    [0, 3000]
  ],
  "name": "BEDROOM 1",
  "textHeight": 250,
  "unit": "mm",
  "layer": "A-AREA"
}
```

Closed outline + name + area in m² (`unit` = what one drawing unit is; `showArea: false` to omit).

```json
{
  "operation": "dimensions",
  "points": [
    [0, 0],
    [900, 0],
    [2400, 0],
    [4000, 0]
  ],
  "mode": "continue",
  "direction": "horizontal",
  "offset": -800,
  "layer": "A-DIMS"
}
```

`continue` = consecutive pairs on one line (DIMCONTINUE); `baseline` = every point from `points[0]`, lines stacked `spacing` apart (DIMBASELINE). `offset` is measured from `points[0]`: + is above (horizontal) or right (vertical).

## Shape presets (`entity` → `create`, or `create` steps in a batch)

Solved on the server into plain primitives — no trigonometry on your side:

| kind                                                                                                              | fields                                                                                                                                             | draws                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `polygon`                                                                                                         | `center`, `sides` 3–1024, `radius`, `mode` inscribed (default) / circumscribed, `rotation`                                                         | closed polyline                                                                    |
| `polygon.edge`                                                                                                    | `edgeStart`, `edgeEnd`, `sides`                                                                                                                    | closed polyline; the polygon winds counter-clockwise from `edgeStart` to `edgeEnd` |
| `rectangle` + `rotation` / `chamfer: { d1, d2 }` / `fillet: <radius>` (chamfer and fillet are mutually exclusive) | corner2 read in the rotated frame                                                                                                                  | closed polyline                                                                    |
| `donut`                                                                                                           | `center`, `innerDiameter`, `outerDiameter`                                                                                                         | closed polyline, constant width; `innerDiameter: 0` = a filled dot                 |
| `arc.threePoint`                                                                                                  | `start`, `mid`, `end`                                                                                                                              | arc                                                                                |
| `arc.startEndRadius`                                                                                              | `start`, `end`, `radius`, `direction` ccw (default) / cw, `large`                                                                                  | arc                                                                                |
| `circle.twoPoint` / `circle.threePoint`                                                                           | `p1`, `p2` (diameter) / `p1`, `p2`, `p3`                                                                                                           | circle                                                                             |
| `dimension.linear` + `direction: "vertical"` (or `rotation`)                                                      | as linear                                                                                                                                          | vertical / rotated dimension                                                       |
| `dimension.chain`                                                                                                 | `points` (≥ 2), `mode` continue / baseline, `direction`, `offset`, `spacing?` (baseline; default fixed ~9.375, not the drawing's live text height) | N `dimension.linear`, one per pair, one batch                                      |

The result's `kind` is the primitive (`polyline`, `arc`, `circle`, or `dimension.linear` per pair for `dimension.chain`). Collinear points, a radius shorter than half the chord, a chamfer or fillet over half the shorter side, coincident `polygon.edge` points, a `donut` `outerDiameter` not greater than `innerDiameter`, or a `dimension.chain` with `< 2` points, `offset: 0`, or duplicate consecutive points all return `InvalidGeometry`.

## Arrays (`transform` op, standalone or as a batch step)

```json
{
  "op": "transform",
  "transform": {
    "op": "arrayRect",
    "handles": ["2C4"],
    "rows": 4,
    "columns": 6,
    "rowSpacing": 6000,
    "columnSpacing": 7500
  }
}
```

```json
{
  "op": "transform",
  "transform": { "op": "arrayPolar", "handles": ["2D0"], "center": [0, 0], "count": 8 }
}
```

```json
{
  "op": "transform",
  "transform": {
    "op": "arrayPath",
    "handles": ["2E1"],
    "path": { "handle": "2C4" },
    "spacing": 500,
    "align": true
  }
}
```

One step instead of one `copy` per item: `arrayRect` fills rows × columns (the source is position 0,0; `angle` rotates the whole array), `arrayPolar` spreads `count` items (source included) over `fillAngle` (default a full circle), rotating them unless `rotateItems: false`, `arrayPath` places items at equal arc-length spacing along an existing line/arc/polyline handle's curve or an explicit `points` path — `count` divides the path evenly including both endpoints, `spacing` places items every distance from the start (no item past the end), `align` (default true) rotates each copy to the path's local tangent. Returns only the new copies. Limit: 5,000 copies per step.
