# Natural-language drafting

The user speaks like a person talking to a drafter. Convert intent into CAD operations internally.

## Do not force CAD vocabulary on the user

Never require requests such as:

- "create layer A-WALL";
- "arrayRect 4 x 5";
- "move handle 3F2 by delta";
- "use operations.apply".

A normal user request may be:

- "Make the technical room a little wider.";
- "The top sprinkler row is too close to the wall.";
- "Put the room name in the middle.";
- "Keep the original architecture and add the PCCC layout on top.".

Resolve these phrases from the drawing context.

## Semantic plan before coordinates

Translate a drawing request into:

1. spaces/objects;
2. relationships between them;
3. access/openings;
4. dimensions;
5. annotation;
6. visual hierarchy.

Only then decide coordinates and tool calls.

## Demo defaults

Use these only for a blank, explicitly simple/demo metric plan when the user did not specify alternatives. State them briefly after the drawing rather than interrogating the user before every demo.

- units: millimetres;
- model geometry: 1:1;
- annotation scale: 1:100;
- exterior wall thickness: 200 mm;
- interior partition thickness: 100 mm;
- typical internal door: 900 mm clear opening;
- typical simple exterior entrance: 1200 mm clear opening;
- room name: 3.5 mm paper height;
- secondary text / area / dimension text: 2.5 mm paper height;
- dimension line first offset: about 700-1000 mm outside the plan.

These are drawing defaults for a visual demo, not engineering, accessibility, fire-safety, or code-compliance values.

## Minimum completeness

If the user asks for a "floor plan" rather than only a rectangle diagram, include the minimum elements needed for the geometry to read as a plan:

- wall thickness;
- at least one logical way into the building when the brief implies occupancy;
- access to internal rooms;
- door swings when doors are shown;
- clear room labels;
- useful overall dimensions.

Do not silently invent specialist systems or structural elements.

## Ask only when it matters

Ask a short clarification when the missing fact changes the meaning of the result, for example:

- which side a room should occupy when placement is important;
- whether a wall must be structural or just a partition;
- which area a specialist PCCC system applies to;
- a design basis needed for regulated spacing or equipment selection.

Do not ask for internal tool details.
