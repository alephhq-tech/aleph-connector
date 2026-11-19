# Annotation, text, and dimension quality

## Scale first

Draw model geometry at 1:1. Set the intended annotation scale before annotation.

For a simple metric demo, 1:100 is a reasonable default unless the user gives another scale.

Use `paperHeight` for text when possible so the requested size is based on plotted millimetres.

## Text hierarchy

Typical starting values for architectural model-space annotation:

- major title: 5.0 mm paper height or larger;
- room/space name: 3.5 mm;
- notes, room area, dimension text: 2.5 mm.

Existing office/template standards take precedence.

## Vietnamese and other non-ASCII text

Never accept replacement question marks, boxes, or missing glyphs.

Before creating non-ASCII text:

1. call `style` -> `textStyles.list`;
2. inspect the available/current style;
3. prefer an existing Unicode-capable TrueType style if the drawing already has one; otherwise
   create one with `style` -> `textStyles.create` using `trueTypeFace` (e.g. `"Arial"`) and
   `charSet: 163` for Vietnamese;
4. capture after placing the first sample text;
5. if the sample renders incorrectly, stop the annotation phase and fix the style or use a verified existing style.

`style.textStyles.create` supports real TrueType styles via `trueTypeFace` (+ optional `bold`,
`italic`, `charSet`, `pitchAndFamily`); it no longer only writes the SHX `FileName` field. Prefer
`trueTypeFace` + `charSet: 163` for new Vietnamese-capable styles. The plain `font` field remains
available for SHX-based styles when that is genuinely intended.

A capability still missing is native text justification (see below) — a correct TrueType style
only fixes glyph rendering, not centering.

## Annotative dimension style

The plugin routes annotative dimensions through the `CadAI-Annotative` dim style. For a blank drawing, configure it explicitly before creating dimensions instead of relying on a blank record.

A useful simple metric starting point is:

- name: `CadAI-Annotative`;
- textHeight: 2.5;
- arrowSize: 2.5;
- extensionOffset: 0.625;
- extensionBeyond: 1.25;
- decimalPlaces: 0 for whole-millimetre architectural dimensions;
- unitsFormat: decimal;
- scale: 1;
- update: true.

Then create annotative dimensions at the drawing annotation scale.

## Dimension visibility gate

After the first dimension:

- capture it;
- confirm the numeric text is visible;
- confirm arrowheads are visible;
- confirm extension lines start/end sensibly;
- confirm the dimension is outside the plan and not colliding with other annotation.

If only red/colored lines appear but no readable number, do not continue adding dimensions. Fix the style first.

## Text placement

The current single-line text tool is baseline-left and MText is insertion-based; native center justification is not yet exposed. Treat placement as a visual iteration:

1. estimate a center placement;
2. capture;
3. move the label if needed.

For long labels, prefer MText with a controlled width so the tag does not run into walls.
