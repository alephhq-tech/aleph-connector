# Layers

## If the drawing already has layers

Call `layer` → `list` first. If the drawing already follows a naming scheme, use its layers and don't impose a new set. Never change properties of layers you didn't create unless the user asked.

## Default set

Simplified from the AIA / ISO 13567 conventions. Create only the layers the drawing actually needs.

**Architecture / structure**

| Layer         | Holds                   | Colour (ACI) | Lineweight |
| ------------- | ----------------------- | ------------ | ---------- |
| `A-WALL`      | Wall outlines (cut)     | 7            | 50         |
| `A-WALL-PATT` | Wall hatch              | 8            | 13         |
| `A-DOOR`      | Door leaves and swings  | 3            | 25         |
| `A-GLAZ`      | Windows and glazing     | 4            | 25         |
| `A-FURN`      | Furniture and fixtures  | 6            | 18         |
| `A-ANNO-TEXT` | Room names, notes       | 2            | 18         |
| `A-ANNO-DIMS` | Dimensions              | 1            | 18         |
| `S-GRID`      | Structural grid lines   | 8            | 13         |
| `S-GRID-IDEN` | Grid bubbles and labels | 2            | 18         |
| `S-COLS`      | Columns                 | 7            | 35         |

**Mechanical / detail**

| Layer    | Holds                                                 | Colour (ACI) | Lineweight |
| -------- | ----------------------------------------------------- | ------------ | ---------- |
| `M-OUTL` | Visible outlines, holes                               | 7            | 35         |
| `M-HIDN` | Hidden edges (colour stands in for a dashed linetype) | 5            | 18         |
| `M-CNTR` | Centre lines, pitch circles                           | 1            | 13         |
| `M-HATC` | Section hatch                                         | 8            | 13         |
| `M-DIMS` | Dimensions                                            | 3            | 18         |
| `M-TEXT` | Notes                                                 | 2            | 18         |

**PCCC / fire-protection overlay** — only when the drawing actually carries one:

| Layer      | Holds             | Lineweight |
| ---------- | ----------------- | ---------- |
| `P-SPRINK` | Sprinkler symbols | 18         |
| `P-PIPE`   | Pipework          | 25–35      |
| `P-TEXT`   | PCCC labels       | 18         |

ACI colours: 1 red, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 7 white/black (follows the background), 8 dark grey, 9 light grey.

## Creating a layer set

`ensure` upserts a whole set in one call — the default way to set up layers, not `create` + `set_properties` per layer:

```json
{
  "operation": "ensure",
  "layers": [
    { "name": "A-WALL", "color": { "aci": 7 }, "lineweight": 50 },
    { "name": "A-DOOR", "color": { "aci": 3 }, "lineweight": 25 }
  ]
}
```

Each entry reports `"action": "created" | "updated" | "unchanged"`. Re-running the same call is safe: an entry whose properties already match reports `"unchanged"` and changes nothing on that layer. An invalid entry anywhere (bad lineweight, a linetype that isn't loaded) fails the whole call — nothing is written. Up to 200 layers per call. `setCurrent` optionally makes one of them current afterward. Use `create` + `set_properties` only for a single one-off layer or when you need `create`'s "did this already exist" distinction as its own step.

`rename { from, to }` fails if `to` is already taken. `delete { name }` refuses layer `0`, `Defpoints`, the current layer, or a layer with entities still on it — erase or move the entities first.

Linetypes: only `Continuous` is loaded by default. Call `style` → `linetypes.load { names: [...] }` (optional `file`, defaults to `acadiso.lin`) before setting any other `linetype` on `layer` → `set_properties`/`ensure` — an already-loaded name is a no-op, not an error. `style` → `linetypes.list` returns every linetype currently loaded. Setting an unloaded `linetype` still fails with a "not loaded" error.

Layer names can't contain any of `<` `>` `/` `\` `"` `:` `;` `?` `*` `|` `,` `=` or a backtick — the same rule applies to linetype, text style, and dimension style names (`style` → `linetypes.load`/`textStyles.create`/`dimStyles.create`).

## Color is not decoration

Use color-by-layer as an identity/plot-style mechanism, not to make a model-space screenshot
attractive. If the drawing already uses a CTB/STB convention, preserve it.

## Never leave production content on layer 0

Layer 0 is useful for block-definition behavior and AutoCAD's default state, but ordinary walls,
dimensions, room tags, and PCCC content must not remain there. `entity.create` never creates a
layer for you (unless you pass `ensureLayer: true`, which creates it with default properties).

## Line hierarchy

A professional 2D drawing reads in grayscale:

- cut/primary wall edges: strongest;
- visible secondary geometry and equipment: medium;
- dimensions, text, grids, and guidance: lighter.

If every entity carries the same visual weight, the result looks schematic even when the geometry
is correct. Use center/dashed/hidden linetypes only where they carry meaning; do not substitute a
bright color for a missing linetype when the line type itself is semantically important.
