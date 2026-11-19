# Fire Alarm Design Evaluation Cases

## Case 1: Basement Car Parking Garage with Egress Stairs and Elevator Shaft

- **Input**: Basement level -2.950m, vehicle entry ramp, elevator core, two emergency stairwells (buồng thang bộ thoát hiểm).
- **Correct Behavior**:
  - All detectors in parking stalls/driveways are Rate-of-Rise Heat Detectors (H).
  - Detectors in technical/electrical rooms are Smoke Detectors (S).
  - No detector within 1.5m of ramp entry portal or elevator door turbulence.
  - MCP and combination units positioned beside the doors to both stairwells at H=1.4m.
  - No MCP on elevator shaft walls.
  - Single continuous Daisy-Chain circuit per zone ending at EOL resistor.
  - All wiring orthogonal along structural beam lines.

## Case 2: Multi-tenant Commercial Office Floor

- **Input**: Office floor level +3.600m, acoustic ceiling grid at H=2.8m, central corridor, two stair exits.
- **Correct Behavior**:
  - Optical Point Smoke Detectors (S) across open plan and corridor.
  - Every point of the ceiling within 7.2 m of a detector (grid pitch <= 7.2·√2), detector spacing
    <= 10.2 m, outer row 0.5-5.1 m from the wall (TCVN 7568-14:2025 5.9.1.1.2 / 5.9.1.1.4).
  - MCP combination units beside stairwell doors.
