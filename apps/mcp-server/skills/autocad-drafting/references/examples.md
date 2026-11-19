# Worked examples

Complete call sequences with every coordinate computed. Follow the shape, not the numbers.

## 1. Single room plan — millimetres, 1:100

Brief: a 5000 × 4000 room (inside faces), 200 walls, a 900 door in the bottom wall starting 600 from the inside-left corner, a 1500 window centred in the top wall, room name and area, overall dimensions.

Sizes at 1:100 (`units-and-scale.md`): name text 350, area text 250, first dimension row 800 off.

Plan — inside faces from (0, 0) to (5000, 4000). Side walls run full height and cover the corners; top and bottom walls are split around the openings, so every wall piece is its own closed rectangle (hatched one by one later).

**Layers** — `layer` → `list`, then for each missing one `create` + `set_properties`: `A-WALL` 7/50, `A-WALL-PATT` 8/13, `A-DOOR` 3/25, `A-GLAZ` 4/25, `A-ANNO-TEXT` 2/18, `A-ANNO-DIMS` 1/18.

**Batch 1 — walls and openings** (all `create`, so `entityRefs[0..5]` are the six wall pieces):

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
        "kind": "rectangle",
        "layer": "A-WALL",
        "corner1": { "x": 5000, "y": -200 },
        "corner2": { "x": 5200, "y": 4200 }
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "rectangle",
        "layer": "A-WALL",
        "corner1": { "x": 0, "y": -200 },
        "corner2": { "x": 600, "y": 0 }
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "rectangle",
        "layer": "A-WALL",
        "corner1": { "x": 1500, "y": -200 },
        "corner2": { "x": 5000, "y": 0 }
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "rectangle",
        "layer": "A-WALL",
        "corner1": { "x": 0, "y": 4000 },
        "corner2": { "x": 1750, "y": 4200 }
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "rectangle",
        "layer": "A-WALL",
        "corner1": { "x": 3250, "y": 4000 },
        "corner2": { "x": 5000, "y": 4200 }
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "rectangle",
        "layer": "A-GLAZ",
        "corner1": { "x": 1750, "y": 4000 },
        "corner2": { "x": 3250, "y": 4200 }
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "line",
        "layer": "A-GLAZ",
        "start": { "x": 1750, "y": 4100 },
        "end": { "x": 3250, "y": 4100 }
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
      "op": "create",
      "entity": {
        "kind": "arc",
        "layer": "A-DOOR",
        "center": { "x": 600, "y": 0 },
        "radius": 900,
        "startAngle": 0,
        "endAngle": 1.5707963
      }
    }
  ]
}
```

The door arc starts at the latch side (1500, 0) and sweeps counter-clockwise to the open leaf end (600, 900).

**Batch 2 — annotation.** Labels centred on (2500, 2150) and (2500, 1750) with the centring rule from `recipes.md`; dimension rows 800 outside the wall faces:

```json
{
  "operation": "apply",
  "operations": [
    {
      "op": "create",
      "entity": {
        "kind": "text.singleLine",
        "layer": "A-ANNO-TEXT",
        "insertion": { "x": 1765, "y": 2027.5 },
        "text": "LIVING",
        "height": 350
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "text.singleLine",
        "layer": "A-ANNO-TEXT",
        "insertion": { "x": 1800, "y": 1662.5 },
        "text": "20.00 m2",
        "height": 250
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "dimension.linear",
        "layer": "A-ANNO-DIMS",
        "extLine1": { "x": -200, "y": -200 },
        "extLine2": { "x": 5200, "y": -200 },
        "dimLinePoint": { "x": -200, "y": -1000 }
      }
    },
    {
      "op": "create",
      "entity": {
        "kind": "dimension.aligned",
        "layer": "A-ANNO-DIMS",
        "extLine1": { "x": -200, "y": -200 },
        "extLine2": { "x": -200, "y": 4200 },
        "dimLinePoint": { "x": -1000, "y": -200 }
      }
    }
  ]
}
```

**Batch 3 — wall poché**: six steps, one `SOLID` hatch per wall piece, each with the single handle of `entityRefs[0]` … `entityRefs[5]` from batch 1. If batch 1 returned `2C4` as its first handle, the first step is:

```json
{
  "op": "create",
  "entity": {
    "kind": "hatch",
    "layer": "A-WALL-PATT",
    "boundaryHandles": ["2C4"],
    "pattern": "SOLID"
  }
}
```

**Verify** — one `entity` → `list` with `limit: 100`; expect `total` 20: `A-WALL` 6, `A-GLAZ` 2, `A-DOOR` 2, `A-ANNO-TEXT` 2, `A-ANNO-DIMS` 2, `A-WALL-PATT` 6. Then `view` → `zoom_extents`, and report the three `batchId`s.

## 2. Machined plate — millimetres, 1:1

Brief: 120 × 80 plate, four Ø10 corner holes 10 from the edges, a Ø30 centre bore, six Ø6 holes equally spaced on a Ø50 pitch circle.

Plan — plate from (0, 0) to (120, 80), centre C = (60, 40). Bolt holes at θ = k·60° on radius 25: (60 + 25 cos θ, 40 + 25 sin θ).

| k   | θ (rad)   | x    | y         |
| --- | --------- | ---- | --------- |
| 0   | 0         | 85   | 40        |
| 1   | 1.0471976 | 72.5 | 61.650635 |
| 2   | 2.0943951 | 47.5 | 61.650635 |
| 3   | 3.1415927 | 35   | 40        |
| 4   | 4.1887902 | 47.5 | 18.349365 |
| 5   | 5.2359878 | 72.5 | 18.349365 |

**Layers**: `M-OUTL` 7/35, `M-CNTR` 1/13, `M-DIMS` 3/18, `M-TEXT` 2/18.

**Batch 1 — geometry** (15 steps): `rectangle` (0, 0)–(120, 80) on `M-OUTL`; `circle` r 5 at (10, 10), (110, 10), (110, 70), (10, 70); `circle` r 15 at (60, 40); `circle` r 3 at the six points in the table; on `M-CNTR`: `line` (29, 40)–(91, 40), `line` (60, 22)–(60, 58), and the pitch `circle` r 25 at (60, 40).

**Batch 2 — annotation** (3 steps): `dimension.linear` (0, 0)–(120, 0) with `dimLinePoint` (0, −8); `dimension.aligned` (0, 0)–(0, 80) with `dimLinePoint` (−8, 0); `mtext` at (0, 95), height 3.5, "6x DIA 6 EQUALLY SPACED ON PCD 50".

**Verify** — `M-OUTL` 12, `M-CNTR` 3, `M-DIMS` 2, `M-TEXT` 1.

## 3. Structural column grid — millimetres, 1:100

Brief: grid lines 1–5 at 6000 centres (X) and A–D at 5000 centres (Y), 400 × 400 columns at every intersection.

Plan — x = 0, 6000, 12000, 18000, 24000; y = 0, 5000, 10000, 15000. Grid lines overrun by 1500. Bubbles are circles of radius 400 (8 mm at 1:100) touching the line ends; labels are 350 high, centred in the bubbles.

**Layers**: `S-GRID` 8/13, `S-GRID-IDEN` 2/18, `S-COLS` 7/35.

**Batch 1 — grid** (27 steps):

- for each x: `line` (x, −1500)–(x, 16500) on `S-GRID`; `circle` r 400 at (x, 16900) on `S-GRID-IDEN`; `text.singleLine` "1"…"5", height 350, at (x − 122.5, 16777.5) on `S-GRID-IDEN`
- for each y: `line` (−1500, y)–(25500, y) on `S-GRID`; `circle` r 400 at (−1900, y); `text.singleLine` "A"…"D" at (−2022.5, y − 122.5)

For example, the steps for grid line 1 and grid line A:

```json
{ "op": "create", "entity": { "kind": "line", "layer": "S-GRID", "start": { "x": 0, "y": -1500 }, "end": { "x": 0, "y": 16500 } } },
{ "op": "create", "entity": { "kind": "circle", "layer": "S-GRID-IDEN", "center": { "x": 0, "y": 16900 }, "radius": 400 } },
{ "op": "create", "entity": { "kind": "text.singleLine", "layer": "S-GRID-IDEN", "insertion": { "x": -122.5, "y": 16777.5 }, "text": "1", "height": 350 } },
{ "op": "create", "entity": { "kind": "line", "layer": "S-GRID", "start": { "x": -1500, "y": 0 }, "end": { "x": 25500, "y": 0 } } },
{ "op": "create", "entity": { "kind": "circle", "layer": "S-GRID-IDEN", "center": { "x": -1900, "y": 0 }, "radius": 400 } },
{ "op": "create", "entity": { "kind": "text.singleLine", "layer": "S-GRID-IDEN", "insertion": { "x": -2022.5, "y": -122.5 }, "text": "A", "height": 350 } }
```

**Batch 2 — columns** (20 steps, all `create`): `rectangle` (x − 200, y − 200)–(x + 200, y + 200) on `S-COLS` for every x, y.

**Batch 3 — column fill** (20 steps): `SOLID` hatch on `S-COLS`, one per column, handles from batch 2's `entityRefs` in order.

**Verify** — `S-GRID` 9, `S-GRID-IDEN` 18, `S-COLS` 40 (20 outlines + 20 hatches).

## 4. Dimension chain — a row of column offsets in one step

Brief: dimension the same five grid-line X positions from example 3 (0, 6000, 12000, 18000, 24000) along the bottom (Y = −1500), both `continue` (each bay separately) and `baseline` (every line from grid line 1).

Instead of four hand-computed `dimension.linear` steps per style, one `dimension.chain` step each:

```json
{
  "op": "create",
  "entity": {
    "kind": "dimension.chain",
    "layer": "S-GRID-IDEN",
    "points": [
      { "x": 0, "y": -1500 },
      { "x": 6000, "y": -1500 },
      { "x": 12000, "y": -1500 },
      { "x": 18000, "y": -1500 },
      { "x": 24000, "y": -1500 }
    ],
    "mode": "continue",
    "direction": "horizontal",
    "offset": 800
  }
}
```

This one step expands, server-side, to 4 `dimension.linear` entities — one per bay (0–6000, 6000–12000, …) — all on the dim line at `y = -1500 - 800 = -2300`, returned in `entityRefs` in point order.

For a baseline style instead (every grid line measured from grid line 1, stacked so they don't overlap), only `mode`/`spacing` change:

```json
{
  "kind": "dimension.chain",
  "layer": "S-GRID-IDEN",
  "points": [/* same 5 points */],
  "mode": "baseline",
  "direction": "horizontal",
  "offset": 800,
  "spacing": 400
}
```

4 dim lines, all starting at `(0, -1500)`, stacked at `y = -2300, -2700, -3100, -3500` (`offset + i * spacing`). Omitting `spacing` falls back to a fixed 9.375 (3.75x the tool's default text height 2.5) — pass it explicitly at a drawing's real scale (`units-and-scale.md`) instead of relying on the default.

**Verify** — `entity.create(dimension.chain)`'s result has 4 `entityRefs`, all `kind: "dimension.linear"`.
