# Units, scale, and sizes

## Drawing units

Coordinates are plain numbers in drawing units; the tools never convert. Pick the unit once and never mix.

- Metric architecture, civil, and mechanical drawings: **1 unit = 1 mm** (a 5 m wall is `5000`).
- US drawings: **1 unit = 1 inch** (a 12 ft wall is `144`).

Call `drawing → setup` first with `insUnits`/`linearUnits`/`linearPrecision` matching your chosen unit — blocks placed later size correctly only when `insUnits` is set, and the drawing's `LUNITS`/`LUPREC` display matches what you're drawing in. `drawing.info` doesn't expose the current unit setting; `drawing.setup`'s own return value is the round-trip. To infer the unit of an _existing_ drawing before you touch it, `entity.list` a sample and look at the size of known objects: a door ~900 wide → mm; ~0.9 → m; ~36 → inches. If you can't tell, ask. For an empty drawing, say which unit you're assuming before you draw.

## Annotation scale (recommended): draft 1:1, size text in paper millimetres

Real drafters draw geometry at true size (1:1) always, and let AutoCAD's annotation scale (`CANNOSCALE`) size text, dimensions, and hatch for whatever sheet scale is plotted — instead of hand-multiplying every text height by the plot-scale denominator (the old workflow; kept below as a fallback for when you aren't using it).

`drawing → setup` also sets the linetype/dimension-scale variables the tools used to leave to the user: `scale: 100` (for 1:100) is equivalent to `ltScale: 50, dimScale: 100` — the exact formula is `ltScale = scale × 0.5` (the ISO linetype-scale convention; AutoCAD's own metric ISO templates use it) and `dimScale = scale`. Pass explicit `ltScale`/`dimScale` instead of `scale` only if you need a different linetype-scale ratio. It also takes `insUnits`/`linearUnits`/`linearPrecision` (see "Drawing units" above), `angularUnits` (display only), and `lwDisplay` (turns on visible lineweights so `layer.ensure`'s `lineweight` shows on screen) — all in one undoable call.

1. Draw all geometry at 1:1, real-world size, regardless of what scale the sheet plots at.
2. Call `drawing → setup` once with `annotationScale: "1:100"` (or whatever the sheet scale is), right after step 2's unit decision — this sets `CANNOSCALE` and adds `"1:100"` to the drawing's scale list if it wasn't already there. From this call on, `entity.create`'s `mtext`/`text.singleLine`/`dimension.linear`/`dimension.aligned`/`dimension.ordinate`/`hatch` default to `annotative: true` automatically — you don't need to pass it yourself.
3. Give text a `paperHeight` (millimetres, as it will measure on the plotted sheet) instead of `height`: `paperHeight: 2.5` for notes, `paperHeight: 3.5` for names/titles, at _any_ scale — the plugin computes the real model-space height from the drawing's current annotation scale for you (`paperHeight × the "1:X" factor`; 2.5 mm at 1:100 lands at 250 drawing units, matching the fallback table below exactly — you just don't compute it by hand anymore).
4. Dimensions and hatch created after `setup` are annotative the same way. Dimension text/arrow size still comes from the current dimension style (`style → dimStyles.create`/`setCurrent`), same as always — an annotation scale multiplies whatever that style specifies at render time, it doesn't replace the style. If dimensions come out unreadably small or huge at your scale, say so to the user rather than faking dimensions with text and lines.
5. Pass `annotative: false` explicitly on one `entity.create` call to opt that single entity out of the document default (rare — e.g. a title-block note that must stay a fixed size regardless of sheet scale).

**Known gap:** this only attaches the annotation scale that's current _when the entity is created_ — there's no `entity.addScale`-style call yet to add a second viewport scale to an entity already drawn. If the same note or dimension genuinely needs to display correctly on two different-scale viewports, ask the user whether that matters yet; the current answer is "draw it once per scale that needs it," not one object supporting several scales after the fact.

## Fallback: absolute height (non-annotative)

Only needed when you are **not** using `annotationScale` — a drawing that must stay non-annotative on purpose, or an existing non-annotative drawing you're adding to consistently. Compute the model-space height yourself: annotation is specified in paper millimetres and multiplied by the scale denominator, passed as `height` (not `paperHeight`), with no `annotative` field — this is the exact behavior every `entity.create` call had before annotative support existed, unchanged.

| Scale | Factor | Text 2.5 (notes) | Text 3.5 (names, titles) | First dimension row, 8 mm off | Next rows, every 7 mm |
| ----- | ------ | ---------------- | ------------------------ | ----------------------------- | --------------------- |
| 1:1   | 1      | 2.5              | 3.5                      | 8                             | 7                     |
| 1:5   | 5      | 12.5             | 17.5                     | 40                            | 35                    |
| 1:10  | 10     | 25               | 35                       | 80                            | 70                    |
| 1:20  | 20     | 50               | 70                       | 160                           | 140                   |
| 1:50  | 50     | 125              | 175                      | 400                           | 350                   |
| 1:100 | 100    | 250              | 350                      | 800                           | 700                   |
| 1:200 | 200    | 500              | 700                      | 1600                          | 1400                  |
| 1:500 | 500    | 1250             | 1750                     | 4000                          | 3500                  |

Inch drawings: multiply paper inches by the scale factor (1/4" = 1'-0" is factor 48, so 1/8" text = 6 units).

Approximate text width for placement: about 0.7 × height per character for standard fonts. To centre `text.singleLine` on a point, start it half that width to the left and 0.35 × height below.

## Lineweights

`layer.set_properties` `lineweight` is in hundredths of a millimetre and must be one of: 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211. Anything else fails.

| Use                                    | Lineweight |
| -------------------------------------- | ---------- |
| Cut walls, section outlines            | 50         |
| Visible outlines, columns              | 35         |
| Doors, windows, general linework       | 25         |
| Text, dimensions, furniture            | 18         |
| Hatch, centre lines, grid, thin detail | 13         |

## Hatch pattern scale

`SOLID` ignores scale — prefer it for wall poché and column fills. For line patterns (`ANSI31` general section, `ANSI32` steel, `AR-CONC` concrete, `AR-SAND` sand, `NET` grid), `patternScale` multiplies the pattern definition: start around half the scale factor in a millimetre drawing (≈50 at 1:100, 1 at 1:1). If the hatch call fails with a density message, or the fill looks solid, increase the scale. A `hatch` created annotative (explicitly, or by this document's `annotationScale` default) still uses this same `patternScale` as its base — the annotation scale multiplies it at render time on top, it doesn't replace it.

## Angles

Radians everywhere, counter-clockwise from +X.

| Degrees | Radians   |
| ------- | --------- |
| 30      | 0.5235988 |
| 45      | 0.7853982 |
| 60      | 1.0471976 |
| 90      | 1.5707963 |
| 120     | 2.0943951 |
| 180     | 3.1415927 |
| 270     | 4.7123890 |
| 360     | 6.2831853 |

radians = degrees × π / 180. A point at angle θ on a circle of radius r around (cx, cy) is (cx + r·cos θ, cy + r·sin θ) — use it for bolt circles, polar patterns, and arc end points.
