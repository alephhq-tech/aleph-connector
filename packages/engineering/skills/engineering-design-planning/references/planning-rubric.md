# Engineering Planning Rubric

## Stage Ordering Rubric for Technical Design

1. **Phase 1: Inspection & Context Verification**
   - Read drawing extents, units, layers, and blocks (`drawing.summary`).
   - Identify base building boundaries and protected compartments.
   - Stopping condition: Base drawing legible, units confirmed (e.g. millimeters).

2. **Phase 2: Equipment & Symbol Placement**
   - Calculate grid spacing based on verified standards rules.
   - Place equipment symbols in batches (e.g. 10 to 50 items per batch).
   - Read back created entities to verify coordinates.
   - Stopping condition: All heads/equipment within protected boundary with required clearances.

3. **Phase 3: Network / Pipe Routing**
   - Establish mains from source / riser location.
   - Connect branch lines to equipment symbols.
   - Check topological continuity (no orphan branches).
   - Stopping condition: Complete connected graph from source to all terminals.

4. **Phase 4: Read-Back Verification & Reporting**
   - Run CAD quality check (`drawing.check`).
   - Run Engineering compliance verification (`engineering-design-verification`).
   - Stopping condition: Verification report generated with tri-state verdicts.
