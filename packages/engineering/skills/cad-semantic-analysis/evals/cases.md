# CAD Semantic Analysis Evaluation Cases

## Case 1: Simple Workshop with One Door

- **Input**: 4 boundary walls (10m x 8m), 1 door block (`DOOR_SINGLE`) on south wall.
- **Expected Outcome**:
  - 1 Room detected, area ~80 m².
  - 1 Opening detected, type `door`, width ~900 mm.
  - Wall handles classified under walls.

## Case 2: Two Connected Rooms

- **Input**: Room A (50 m²) and Room B (30 m²) sharing a common partition wall with an interconnecting door.
- **Expected Outcome**:
  - 2 Rooms detected.
  - Door classified with relationship `connects_to` linking Room A and Room B.
