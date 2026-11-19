# Professional drawing QA rubric

Score the final capture against all sections. Any hard-fail item means the drawing is not ready.

## A. Geometry and topology

- walls are consistent and joined cleanly;
- no accidental duplicate outlines;
- openings actually interrupt walls;
- occupied/internal rooms have a logical access path;
- repeated elements align when they are intended to align;
- geometry is not accidentally far from the main drawing extents.

Hard fail: sealed room caused by omission, door on top of intact wall, obvious duplicate geometry.

## B. Semantic completeness

- requested spaces/objects exist;
- room names match the intended spaces;
- room areas refer to the intended clear polygon;
- dimensions describe the requested overall/layout information;
- specialist overlays remain on top of the correct base geometry.

Hard fail: wrong space name, missing requested element, area derived from the wrong boundary.

## C. Annotation

- no garbled characters;
- text size is readable at the intended plot scale;
- room names are visually centered or deliberately placed;
- room areas are subordinate to names;
- dimension values and arrows are visible;
- text does not collide with walls, door swings, pipes, or dimensions.

Hard fail: `?` replacing letters, invisible dimension values, label outside the room.

## D. Visual hierarchy

- primary geometry reads first;
- dimensions/grids/notes read as secondary;
- lineweights are not uniform across everything;
- whitespace exists around labels and dimensions;
- repeated symbols use consistent size and orientation.

## E. CAD hygiene

Run `drawing` -> `check` with relevant checks.

Target:

- no layer-0 production entities;
- no duplicates;
- no zero-length entities;
- no unexplained open outlines where a closed boundary is required;
- no obvious text-size outliers;
- no unintended dimension overrides;
- no off-extents geometry.

## F. User-intent check

Ask internally: if the user gave this DWG to an experienced drafter without the chat transcript, would the drawing communicate the intended design?

If the answer is no, keep working.

## Screenshot-specific failure pattern

A result like this is not ready even if all objects were created successfully:

- a 12 x 8 m outer rectangle;
- a 4 x 3 m inner rectangle;
- no doors;
- room labels containing `?` instead of Vietnamese letters;
- red dimension lines but no readable values;
- room area based on gross subtraction rather than clear internal boundaries.

Treat each symptom as a defect, not as cosmetic polish.
