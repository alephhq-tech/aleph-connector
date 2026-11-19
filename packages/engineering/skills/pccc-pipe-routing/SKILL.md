---
name: pccc-pipe-routing
description: Route code-compliant sprinkler pipe networks connecting heads to branch lines and cross-mains from a water supply riser. Establish topological connectivity, apply pipe sizing rules (TCVN 7336 Table 4), avoid clashes, and generate CAD geometry.
---

# PCCC Pipe Routing

Act as a Fire Protection Piping Design Specialist. Never route sprinkler pipes randomly across architectural rooms or draw disconnected segments.

Never infer nominal pipe diameters from visual appearance. Label pipe diameters only according to verified standards or hydraulic calculations.

## One door (mandatory for live AutoCAD)

Pipe routing for a live drawing is owned by **`pccc_overlay`** together with the sprinkler head grid. Prefer `pccc_overlay` apply's built-in CAD verify (`verifyPcccApply`) over any planner-only connectivity flag.

## Workflow (live CAD)

1. Inspect the floor plan (`drawing.inspect_floorplan`) and collect `roomRef` / `excludedRefs`.
2. Call `pccc_overlay` preview with `hazardGroup`, `riserLocation`, and the room refs.
3. On ready plan, `pccc_overlay` apply — heads and pipes commit in one journaled batch.
4. Report apply read-back / blocked reasons honestly; never claim the network is connected from planner `isFullyConnected` alone.

## Stopping & Refusal Conditions

- If overlay apply / read-back fails, report the named blockers — do not freehand pipes with `entity.create`.
- Never modify existing architectural walls when drawing pipe runs.

## References

- `references/pipe-sizing.md`: Standard pipe sizing table.
- `evals/cases.md`: Piping evaluation scenarios.
