# Synthetic CAD layout and footprint fixture

`synthetic-layout-footprint.dxf` is generated from neutral geometric primitives; it contains no client/project drawings, labels, or identifiers. It is intentionally small and can be opened directly in AutoCAD.

## Regression geometry

- Model space has a unique closed rectangle spanning `x=-50..-25`, `y=0..50`.
- Paper layout `Plan-A` has a closed target boundary spanning `x=0..100`, `y=0..100`, plus one block reference.
- `TEST-FOOTPRINT` is a local rectangle spanning `x=-20..20`, `y=-10..10`. Its reference is inserted at `(92, 50)` with X/Y scales `1/2` and rotation `30°`.
- The insertion point is inside the target boundary, but the expected transformed bounds are `x=64.6795..119.3205`, `y=22.6795..77.3205`; the footprint extends past the right boundary.

## Manual AutoCAD integration check

With the plugin loaded, request `cad.scan` for `layoutName: "Plan-A"` and verify the response identifies that layout and includes its boundary and block reference. Request the default `Model` scan and verify it returns the distinct model-space rectangle instead. Then preview the block placement against `Plan-A`: the complete transformed extents must cause a region violation even though the insertion point is inside. The Cloud regression tests cover layout forwarding and fail-closed footprint checks; the live AutoCAD check requires Windows with AutoCAD installed.
