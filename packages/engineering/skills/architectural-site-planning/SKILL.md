---
name: architectural-site-planning
description: Plan a building on its parcel — site boundary, setbacks, footprint, access, parking, drainage and landscaping — before any wall is drawn. Use when the drawing has a site/parcel layer or the task is a tổng mặt bằng, công trình trên đất, or choosing where a building sits.
---

# Architectural Site Planning

Act as a site planner. The first job is not the building — it is the relationship between the building and its land. Decide the whole-site arrangement, validate it, and only then hand the footprint to space planning.

Work in the drawing's real units (millimetres for metric DWGs). One drawing unit = one millimetre unless `drawing.summary`/`insUnits` says otherwise; state the assumption before computing setbacks.

## Workflow

1. **Read the site, don't assume it.** `drawing.summary` first (entity count, layers, extents, units) to see what exists. Then `entity.list` (detail: "full", scoped by `layer`/`window` on a large DWG) for the parcel boundary and any existing structures. Feed the boundary + structure entities to `spatial_analyze` — it returns `site` (`hasBoundary`, `outdoorRegions`, `buildingRings`) and per-space `areaM2`. Never compute a setback from the gross bounding rectangle when the parcel is L-shaped or irregular: the engine's building footprint is the honest ring set, not a convex hull, and a garden sitting in a concave notch is genuinely open air.
2. **Fix the constraints before placing anything.** Setback limits (red line → building), access points, fire separation between buildings, parking demand, drainage fall. Where a number comes from a standard (QCVN 01:2019/BXD setbacks, PCCC separation distances), `knowledge_search` the workspace corpus for the clause; if it is missing or the edition-in-force matters, `web_search` an official source and cite it. Record any constraint you could not source as missing input — do not invent a number.
3. **Place the footprint and outdoor program.** Building footprint (closed polyline), then outdoor items: driveway, parking, landscaping, open space. Each is a placement with a real centre and footprint.
4. **Validate the whole site together.** `spatial_validate_layout` with every placement in one batch — a building that clears the setback alone can still collide with the parking court or block the only access. A FAIL or INSUFFICIENT_DATA verdict means do NOT draw: move the footprint or gather the missing boundary geometry first.
5. **Draw, then read back.** Commit the site in one `operations.apply` batch (or `construct` for the footprint outline). Then `entity.list` (detail: "full") the result and run `spatial_readback_verify` with the planned items and the handles the batch reported. `faithful: true` is the only signal the site plan on screen is the one you validated.

## Hard rules

- The parcel boundary is data, not a guess. If `spatial_analyze` reports `site.hasBoundary: false`, the site is not defined — ask for the red-line layer or draw it from given coordinates before placing the building.
- Setbacks, separations and access are checked against the drawn geometry, not against a bounding box. A building rotated 5° changes every setback; re-validate after any rotation.
- Outdoor landscaping is validated by intent (`intent: "outdoor-landscape"`), so a garden outside the building ring is not forced through a fake indoor reclassification.
- Never present a site layout as compliant with a setback/fire rule without naming the standard, edition and the measured distance that satisfies it.

## References

- `references/site-constraints.md`: the constraint checklist (setbacks, separation, access, drainage) and how each maps to a validation finding.
- `evals/cases.md`: worked site-planning cases.
