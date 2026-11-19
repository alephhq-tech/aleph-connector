# Semantic Classification & Topology Rules

## 1. Classification Heuristics

1. **Wall Geometry**:
   - `kind: line | polyline`
   - Layer keywords: `WALL`, `A-WALL`, `TUONG`, `VACH`.
   - Continuous wall runs forming boundary loops.

2. **Openings (Doors / Windows)**:
   - Door: blocks with `DOOR`, `CUA`, `DR_` or arc-line swing geometry.
   - Window: blocks or multi-line frames with `WINDOW`, `CUA_SO`, `WIN_`.
   - Width: measured across opening extents (typically 800 mm to 2400 mm).

3. **Rooms / Compartments**:
   - Closed polyline or boundary loop with area >= 2.0 m².
   - Text label inside polygon defines room usage (e.g. `KHO`, `VAN PHONG`, `XUONG`, `WC`).
   - If layer contains `EXCLUDE` or `TECHNICAL_SHAFT`: mark as `isProtected: false`.

4. **Equipment**:
   - Block references or circular markers on specialized MEP layers.
   - PCCC symbols: `SPRINKLER`, `DETECTOR_SMOKE`, `DETECTOR_HEAT`, `FIRE_HYDRANT`.

```

```
