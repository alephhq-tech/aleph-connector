# Design Basis Template

A structured Design Basis captures all foundational parameters governing an engineering task.

## Markdown Format

```markdown
# DESIGN BASIS

## 1. Project & Scope

- **Project Ref**: [Project Name / Drawing Number]
- **Discipline**: [pccc | mep | architecture | structural | general]
- **Design Scope**: [new_design | modification | inspection | verification]
- **Status**: [draft | needs_input | ready_for_planning | approved]

## 2. Known Inputs

- Building usage: [e.g. Industrial Warehouse / Cattle Barn]
- Dimensions / Area: [e.g. 50 m x 20 m, 1000 m²]
- Ceiling Height: [e.g. 6.5 m]
- Available Water Supply: [e.g. 25 L/s @ 6.0 bar]

## 3. Missing Inputs (Safety-Critical)

- [ ] Hazard group classification (TCVN 7336 / NFPA 13)
- [ ] Obstruction layout (structural beams, HVAC ducts)

## 4. Assumptions & Tolerances

- Assumption 1: Standard wet-pipe system (unheated freeze risk absent).
- Units: Coordinates in millimeters (mm), flow in L/min, pressure in bar.

## 5. Applicable Standards

- TCVN 7336:2021 (Automatic sprinkler systems — Design requirements)
- QCVN 06:2022/BXD (National technical regulation on fire safety of buildings)
- QCVN 10:2025/BCA (Fire-fighting and rescue vehicles, equipment, systems)
```
