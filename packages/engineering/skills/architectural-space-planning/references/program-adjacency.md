# Program, Adjacency and Circulation Checklist

| Item                   | What to decide before drawing                                        | Engine enforcement                                                                                                               |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Program                | Every space, its target area, its role                               | `spatial_validate_layout` containment: a room placed outside the slab is `FURNITURE_OUTSIDE_SPACE`/containment FAIL              |
| Adjacency              | Which pairs must share a wall (bed–bath, bếp–ăn, kho–lối thoát hiểm) | `adjacentSpaces` in `spatial_analyze`; a required pair that does not share a boundary is a design FAIL you must fix before walls |
| Access graph           | Every room reachable from an entrance through doors                  | `checkAccessibility` → `ROOM_INACCESSIBLE`; an exterior door (`connectionType: "exterior"`) counts as a way in                   |
| Circulation            | A spine/corridor with the required clear width                       | free-space measurement (not bbox): furniture narrowing a corridor below `requiredCirculationWidth` fails                         |
| Door on a real opening | Each door sits on a wall that is actually broken at its position     | `DOOR_ON_UNCUT_WALL` advisory + `cutsWall` from the model; build walls with `openings` so the gap is real                        |
| Door validity          | A door joins two spaces (interior) or one space + outside (exterior) | `DOOR_CONNECTS_NOTHING` FAIL always; `DOOR_CONNECTS_ONE_SPACE` FAIL only for non-exterior doors                                  |

## Batch validation is not optional

Validate the whole floor in ONE `spatial_validate_layout` call. Pairwise checks miss the failure that matters: two rooms each inside the slab that overlap each other, or a corridor that is wide everywhere except where a placed wardrobe pinches it.

## Sizing without inventing

Room minimum areas and corridor widths come from the project brief or a standard (QCVN 06:2022/BXD egress, the client's program). If neither gives the number, record it as missing input and ask. A schema-valid plan is not authorization to draw — only a plan carrying a passing validation verdict is.

## Failure modes this prevents

- A sealed bathroom (no opening path) that looks fine on screen but fails `ROOM_INACCESSIBLE`.
- A "3 m corridor" that is 3 m at the door and 0.8 m where the shoe cabinet lands.
- Walls drawn as one continuous polyline with door arcs painted over them — the room is sealed for hatching, area take-offs and every later topology question.
- Reporting adjacency from how the plan looks instead of from `adjacentSpaces`.
