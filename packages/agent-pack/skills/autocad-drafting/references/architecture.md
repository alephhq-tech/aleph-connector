# Architectural floor-plan drafting

## Draw a floor plan as a connected system

Do not treat each room as an independent rectangle. The floor plan is a wall-and-opening topology.

For a simple plan:

1. establish the exterior clear/gross boundary;
2. establish exterior wall thickness;
3. place interior partitions from the wall faces;
4. split walls around door/window openings;
5. draw door leaves and swing arcs;
6. place room tags inside clear floor polygons;
7. add dimensions outside the geometry.

## Walls

Use consistent thickness unless the brief says otherwise. Join corners cleanly. Avoid accidental double outlines or overlapping wall polygons.

`construct` -> `walls` is opening-aware: pass `openings: [{ at | along, width }]` and the run is built
as `walls.segmentN` pieces with a genuine gap at each door/window. Prefer this over drawing a
continuous wall and painting a door arc across it — a sealed outline breaks hatches, area take-offs
and any later "is this room open to that one?" reasoning.

To open a wall that already exists (no trim/break yet), erase the affected pieces and redraw them
with the opening supplied.

## Doors

A door is not only an arc symbol.

A professional 2D door representation needs:

- an actual opening in the wall;
- a leaf from hinge to latch;
- a swing arc representing the chosen opening direction;
- a width consistent with the opening.

Place internal-room doors so they connect to a meaningful adjacent space unless the user states otherwise.

## Windows

A window must occupy an opening in the wall, not overlap an intact wall. Keep its centerline and frame geometry visually distinct from the wall outline.

## Room boundaries and areas

The room area should come from the clear usable room polygon when that is what the label means.

Do not calculate a production-room area as "gross building area minus another gross rectangle" when wall thickness is shown. Wall thickness changes clear area.

Do not use `construct` -> `room` merely to draw a second outline on top of wall geometry. Use it only when the room outline itself is the intended geometry. Otherwise place the room tag/area separately.

## Room tags

Put room tags in the visually open part of the room. Keep a clear margin from walls, door swings, equipment, and dimensions.

Use a two-level hierarchy when area is shown:

ROOM NAME
84.00 m2

The room name is more prominent than the area.

If native center justification is unavailable, estimate the initial placement, capture the result, then move the text based on what is actually visible. Never assume the first insertion is visually centered.

## Dimensions

For a simple plan, use at least the meaningful overall width/height. Add internal dimensions only when they convey layout or opening locations.

Overall dimensions should normally sit beyond the outer wall, with enough clearance that arrows and text do not collide with wall lines.

Avoid dimension chains that cross room names or specialist overlays.

## Example: 12 m x 8 m workshop with 4 m x 3 m technical room

A credible simple-demo layout is not two closed rectangles.

One acceptable interpretation is:

- exterior footprint 12000 x 8000 mm;
- 200 mm exterior wall;
- 100 mm technical-room partition in the lower-right corner;
- technical room clear target approximately 4000 x 3000 mm;
- 900 mm technical-room door opening toward the production space;
- 1200 mm exterior entrance on a sensible exterior wall;
- production and technical-room tags centered in clear space;
- overall 12000 and 8000 dimensions outside the plan.

Use these details only as demo defaults when the user has not specified them.
