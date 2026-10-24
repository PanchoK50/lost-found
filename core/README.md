# core — the deterministic building core

Typed, validated, LLM-free core for the Lost & Found agent. Every fact the agent
will ever state comes from here.

```
building.json ─▶ model.py     entities, referential validation, indexes
               ▶ geometry.py shapely: areas, centroids, wall adjacency, stacking,
                              3D, door-to-door walking (15 cm off walls), widths
               ▶ graph.py    Dijkstra routing under RouteConstraints
               ▶ vehicles.py width profiles (trolley, forklift with bay sinks)
               ▶ queries.py  one function per benchmark question kind
               ▶ validate.py the calibration gate (python -m core.validate)
```

## Route model (kit 1.1.0 — the rules the judges grade with)

- One node per space (representative_point centre) and one per opening; walking
  inside a space goes door to door on a visibility graph of the outline shrunk
  by 15 cm; a door lands 30 cm inside each space.
- Stairs cost 2 m per metre climbed; a lift ride 15 m once plus 1 m per metre,
  with every pair of lift stops joined directly.
- No shortcut round the outside: entrances lead out, and two building parts that
  meet only outdoors have no route (`reachable: false`).
- Constraints combine with AND: `step_free`, `min_door_width_m`,
  `min_space_width_m`, `closed`, `extra_openings` (what-if doors),
  `no_transit` (bays are destinations, never shortcuts), `space_filter`.

## Calibrated question semantics (100 % on train+dev via core.validate)

| Question kind | Rule |
|---|---|
| `largest_room`, `floor_area_total`, errand target | candidates are spaces of type **room or hall** (lecture halls count), by polygon area |
| `wide_delivery_count`, `step_free_reachable_count`, `what_if_door` | count only spaces of type **room** |
| `shared_walls_count` | neighbours of type **room or hall** sharing ≥ 1 m of outline within 0.35 m (measured with the proximity buffer, ends included) |
| `errand` | nearest room holding the asset by **walking distance**; then largest room of the type |
| `what_if_door` | door at the shared-wall midpoint; rooms whose nearest-entrance walk shrinks by > 1 m |
| `room_stacked` | maximum polygon overlap on the adjacent floor |
| `straight_line_3d` | centroids at the floors' `elevation_m` |

## Commands

```sh
uv run pytest                                   # unit tests (tests/core/)
uv run python -m core.validate data/dev --basic # every dev question incl. warm-up
uv run python -m core.validate data/train --basic
uv run python -m core.validate data/dev --stats # distinct inputs keys per kind
```

`validate` exits non-zero on any mismatch, so it doubles as the regression gate
for future changes. Vehicles: `core.vehicles.forklift(building)` composes the
3 m profile (wide aisles and openings only, hall zones as destinations);
`Vehicle(width_m=…)` builds any other profile.

The layers above this package (Claude tools with `strict=True`, the
`answer()` benchmark entry point, the HTTP bridge for the website) consume
`queries.py` results and `graph.route` `RouteResult` objects as-is.
