# Sample uploads for "Add a building"

All three folders describe the same unseen test factory, *Halle Isar 26* (`data/test/proc-factory-test-002`,
procedural, CC0): 3 floors, 129 spaces. Upload in the app via the building picker → **Add a building**, give it
a name, and select **all files** in one folder.

| Folder | What it tests | Expect |
|---|---|---|
| `1-svg-plans/` | Plans as SVG (exact geometry, room numbers as text) | All rooms and doors, room numbers, room types guessed from the furniture; a few checks in the chat |
| `2-png-plans/` | Plans as images only (`floor_X.png` + `floor_X_plain.png`) | Rooms from colours, scale from furniture sizes (a few % off), room numbers read by Claude (~$0.05), more checks, starting with "Is room X about N m²?" |
| `3-building-json/` | A ready-made `building.json` in the challenge format (like the Sunday building) | Imported as it is, nothing to check |

These are the plan formats the challenge kit ships (`floor_<level>.svg`, `floor_<level>.png`,
`floor_<level>_plain.png`) and the building format (`building.json`). The challenge does not specify any other
plan format.
