# Clearance Table (starting points, not law)

These are ergonomic defaults for laying out a room. They are NOT code: where a standard governs (egress width, kitchen gas clearances, accessible sanitary), source the number (`knowledge_search` → `web_search` → record as missing) and cite it.

| Item | Typical footprint (mm) | Clearance to model |
| ---- | ---------------------- | ------------------ |
| Bed 1m8 | 2000 × 1600 | 600 walk sides, 900 at foot; door swing must not hit it |
| Bed 1m6 | 2000 × 1400 | 600 walk sides |
| Wardrobe (swing doors) | 2000 × 600 | 600 in front (leaf swing) — model as part of the footprint |
| Wardrobe (sliding) | 2000 × 650 | 500 in front |
| Sofa 3-seat | 2200 × 900 | 900–1200 to the coffee table |
| Coffee table | 1200 × 600 | counted in the sofa gap |
| Dining table 4 | 1400 × 800 | 750–900 per chair side |
| Desk | 1400 × 700 | 900 behind the chair |
| Toilet | 400 × 700 | 600 in front, 380 to the side |
| Wash basin | 600 × 450 | 700 in front |
| Fridge | 700 × 700 | 1000 door-side service |
| Washing machine | 600 × 600 | 600 front access |
| TV + cabinet | 1500 × 450 | viewing distance is design intent |

## Modelling rules

- A clearance zone is either part of the placement footprint or an explicit obstacle — never a comment.
- Corridors and walk-arounds are checked as free space: the engine measures the gap between drawn footprints, so a 1000 walk that a 600 wardrobe eats is a FAIL, not a suggestion.
- Rotation rotates the footprint. A 2000×1600 bed at 90° blocks a different sweep than at 0°.
- Existing furniture in the DWG is an obstacle automatically; add user equipment you know is fixed (columns are handled by the engine) rather than drawing over them.

## When the defaults are not enough

Accessible-sanitary clearances, kitchen gas distances, and anything PCCC-related must come from the standard corpus or an official source, with the edition named. If the number cannot be sourced, record it as missing input and place the item conservatively while telling the user what is unverified.
