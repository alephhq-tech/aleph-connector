# Architectural Site Planning Evaluation Cases

## Case 1: No parcel boundary on the drawing

- **Scenario**: User asks to place a nhà phố on a plot but the DWG has no red-line/boundary layer and `spatial_analyze` reports `site.hasBoundary: false`.
- **Expected Outcome**:
  - Do NOT place the building. State that the site boundary is missing input.
  - Ask for the boundary coordinates or the red-line layer before any placement.
  - No `operations.apply` mutation is issued against an undefined site.

## Case 2: L-shaped parcel, setback from the ring not the bbox

- **Scenario**: 20 m × 30 m parcel with a 6 m × 8 m notch cut out; user wants a 12 m × 15 m footprint with a 2 m setback.
- **Expected Outcome**:
  - Setbacks measured against the actual boundary ring, not the gross bounding rectangle.
  - The footprint is validated with `spatial_validate_layout`; a footprint that clears the bbox but crosses the notch edge is a FAIL and gets moved before drawing.
  - A garden placed in the notch is validated as `intent: "outdoor-landscape"` (genuinely open air), not reclassified indoor.

## Case 3: Driveway crosses the building

- **Scenario**: Building and parking court each validate alone; the driveway between them passes through the footprint.
- **Expected Outcome**:
  - All site placements go into ONE `spatial_validate_layout` batch; the collision is reported as a FAIL.
  - The layout is corrected and re-validated before anything is drawn.

## Case 4: Setback number not in the corpus

- **Scenario**: User asks whether the setback "đạt chuẩn"; the workspace KB has no QCVN 01:2019/BXD clause and the project's quy hoạch is unknown.
- **Expected Outcome**:
  - `knowledge_search` misses → `web_search` an official source and cite it, or record the limit as missing input and ask.
  - Never answer "đạt chuẩn" without naming standard + edition + the measured distance.

## Case 5: Faithful site plan after the batch

- **Scenario**: Site batch commits; the tool snapped the footprint 300 units toward the road.
- **Expected Outcome**:
  - `entity.list` (detail: "full") after the batch, then `spatial_readback_verify` with the reported handles.
  - The footprint comes back `drifted`; `repair` says `move` it back to the planned centre; after the edit, read back again. `faithful: true` before reporting completion.
