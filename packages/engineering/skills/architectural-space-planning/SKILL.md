---
name: architectural-space-planning
description: Lay out the rooms of a floor — program, zoning, adjacency, circulation and room sizes — before drawing walls. Use when the task is bố trí công năng, mặt bằng tầng, partitioning a slab, or deciding which rooms touch which.
---

# Architectural Space Planning

Act as a space planner. A floor plan is a graph before it is a set of walls: rooms, the doors between them, and the circulation that connects them. Get the graph right, validate it, then build the walls.

## Workflow

1. **Write the program first.** List every required space with its target area, its role (private/shared/service), and what it must touch (bedroom → bathroom, kitchen → dining, kho → lối thoát hiểm). Anything you cannot size from a standard or the user's brief is missing input — ask, don't invent.
2. **Read the available envelope.** `drawing.summary`, then `entity.list` (detail: "full", scoped by `layer`/`window`) for the slab/room boundaries, then `spatial_analyze` to get `spaces` (id, usage, `areaM2`, `adjacentSpaces`, `accessPoints`, `sourceHandles`). Never plan against an assumed rectangle when the drawing already has the boundary — and on an L-shaped plan the honest footprint is the ring set, not the bounding box.
3. **Zone, then place.** Group the program into public / private / service bands, lay rooms out along them, and keep a circulation spine. Each room is a placement with a real centre and footprint.
4. **Validate the whole batch together.** `spatial_validate_layout` with every room and opening in ONE call. Two rooms each valid alone can still overlap, seal a space off, or leave a corridor too narrow — the engine checks circulation width and accessibility across the batch. A FAIL or INSUFFICIENT_DATA verdict means do NOT draw walls yet.
5. **Build walls with real openings.** `construct` → `walls` with `openings: [{ at | along, width }]` for every door: the wall comes back as `walls.segmentN` closed outlines with a genuine gap. Never draw a continuous wall and lay a door arc across it — that seals the room and breaks hatches and area take-offs.
6. **Read back.** `entity.list` (detail: "full") after the batch, then `spatial_readback_verify` with the planned rooms/openings and the reported handles. `faithful: true` is the only completion signal.

## Hard rules

- Every space must be reachable: `checkAccessibility` reports `ROOM_INACCESSIBLE` when a room has no opening path. A plan with a sealed room is a FAIL, not a style choice.
- Circulation is measured as free space, not a bounding box — furniture that narrows a corridor to under the required width fails the check.
- Room areas come from the actual closed boundary. Never report the gross building rectangle as usable area.
- Adjacency claims ("the kitchen connects to the dining") must come from `adjacentSpaces`/`connectsSpaces` in the model, not from how the plan looks.

## References

- `references/program-adjacency.md`: the program/adjacency/circulation checklist and the findings that enforce each.
- `evals/cases.md`: worked space-planning cases.
