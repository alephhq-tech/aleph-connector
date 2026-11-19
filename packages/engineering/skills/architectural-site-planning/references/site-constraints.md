# Site Constraint Checklist

Each constraint below is a thing the site plan must satisfy. The right column says how the spatial engine can check it — if a constraint has no engine check, it must be verified by measurement and cited to a standard, not waved through.

| Constraint                        | What it means on the drawing                                                                        | Engine check                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Setback (lùi xây dựng)            | Distance from the parcel boundary (red line) to the building footprint, on every side               | containment + measured distance from the boundary ring; FAIL if the footprint touches or crosses the boundary   |
| Building coverage / mật độ        | Footprint area ÷ parcel area ≤ the allowed ratio                                                    | `spatial_analyze` reports `areaM2` for the site and the building ring — divide and compare to the sourced limit |
| Fire separation between buildings | Clear gap between separate structures (kho, nhà ở) per PCCC                                         | `spatial_validate_layout` collisions + measured ring-to-ring distance; cite the standard + clause               |
| Access / lối vào                  | At least one exterior opening connecting the parcel to the road, and a path from it to the building | `connectionType: "exterior"` openings + `checkAccessibility` (ROOM_INACCESSIBLE)                                |
| Parking                           | Count × stall footprint (e.g. 5.5 m × 2.5 m car stall) placed as real footprints                    | batch validation: stalls must not collide with the building or each other                                       |
| Drainage / thoát nước             | Site falls toward the outlet; permeable area share                                                  | not engine-checked — measure and state; record as design intent                                                 |
| Landscaping / cây xanh            | Open ground area share; trees as footprints, not as fake indoor space                               | `intent: "outdoor-landscape"` placements validated against the outdoor region                                   |

## Sourcing the numbers

Setback and coverage limits come from local regulation (QCVN 01:2019/BXD for urban planning, the project's approved 1/500 or quy hoạch detail), and fire separation from the PCCC corpus. The workflow is fixed:

1. `knowledge_search` the workspace knowledge base for the exact clause.
2. If the KB misses, or the edition in force depends on the project date, `web_search` an official source (Công báo, the issuing ministry) and say which source confirmed the edition.
3. If neither yields the number, record it as missing input and ask — never fill the gap from memory.

A "bảng đối chiếu" (comparison table) in the corpus is a checklist, not an independent legal source: it tells you which clause to read, not what the number is.

## Failure modes this prevents

- Placing the building from the gross bounding rectangle of an L-shaped parcel, so the wing sits in the notch and every setback is wrong.
- Treating a garden in a concave notch as indoor space (the old convex-hull bug) and "losing" open-area compliance.
- Drawing a driveway that crosses the building footprint because each was validated alone.
- Reporting a setback as compliant without naming the standard, the edition, and the measured distance.
