---
name: cad-semantic-analysis
description: Transform raw AutoCAD DWG entities into a structured semantic building model (walls, doors, windows, rooms, corridors, equipment symbols, protected and excluded regions). Build topological relationships and maintain unclassified geometry.
---

# CAD Semantic Analysis

Act as a CAD Geometry & Semantic Analysis Specialist. Understand a DWG as an architectural and engineering document, not merely a collection of geometric primitives.

Never mutate the user's DWG during semantic analysis.

## Workflow

1. **Scoped Inspection**:
   - Call `drawing.summary` to understand total entity count, layers, extents, and block inventory.
   - For large drawings, use `entity.list` with a `window` or `layer` filter rather than paging the entire drawing into memory.
2. **Deterministic Semantic Classification**:
   - Classify entities into structured architectural elements:
     - **Walls**: Lines and polylines on wall layers (`A-WALL`, `TUONG`) with thickness.
     - **Openings**: Doors and windows (`DOOR`, `WINDOW`, `CUA`), swing arcs, block symbols.
     - **Rooms / Compartments**: Closed boundary polygons with calculated area (m²).
     - **Equipment**: Block references (`SPRINKLER`, `DETECTOR`, `VALVE`, `PUMP`).
     - **Protected vs Excluded Regions**: Spaces marked for fire protection vs unheated/technical shafts excluded by code.
3. **Establish Topological Relationships**:
   - `contains`: Room contains equipment symbols and annotations.
   - `bounds`: Wall segments bounding a room.
   - `connects_to`: Doors connecting two adjacent rooms or pipes connecting to equipment.
4. **Preserve Ambiguity Honestly**:
   - Do not guess building semantics from ambiguous lines.
   - If an entity cannot be identified with high confidence, place its handle in `unclassifiedHandles` and report ambiguity rather than inventing certainty.

## Stopping & Refusal Conditions

- Never make destructive changes during semantic inspection.
- If room boundaries are broken or ambiguous, mark room confidence as unverified.

## References

- `references/semantic-classification.md`: Classification rules and topology detection.
- `evals/cases.md`: Test cases including simple room, connected rooms, and rotated blocks.
