"""One deterministic function per benchmark question kind.

Every counting rule here is calibrated against ALL train+dev answers (core.validate):

- "Largest room" and summed areas count spaces of type room AND hall (a "largest
  lecture hall" question would fail otherwise), filtered by floor and room_type.
- Reachability counts (wide deliveries, step-free reachability, what-if doors)
  count only spaces of type room — proven by the 80 wide_delivery answers, where
  halls must NOT be counted.
- An errand's nearest stop is the room holding the asset with the shortest
  WALKING distance from the start (not straight line); its target is the largest
  room of the requested type by polygon area.
- A what-if door sits at the midpoint of the shared wall and counts rooms whose
  walk out of the building (to the nearest entrance) shrinks by more than 1 m.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from core.geometry import Geometry
from core.graph import CLEAR, RouteConstraints, distances_from, exit_distance, route
from core.model import Building, Opening

AREA_TYPES = frozenset({"room", "hall"})  # counted for largest/total area and shared-wall neighbours
REACHABLE_ROOM_TYPES = frozenset({"room"})  # counted for reachability questions
WHAT_IF_IMPROVEMENT_M = 1.0


class QueryError(ValueError):
    """Raised when a question cannot be answered on this building (no candidates, nothing above...)."""


@dataclass(frozen=True, slots=True)
class SpaceAnswer:
    space_id: str
    name: str
    ref: str | None
    floor_id: str
    area_m2: float

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class ErrandAnswer:
    total_m: float
    via_id: str
    target_id: str

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class WhatIfAnswer:
    improved_count: int
    affected_space_ids: tuple[str, ...]

    def as_dict(self) -> dict:
        return asdict(self)


def _spaces_on(building: Building, floor_id: str, room_type: str, types: frozenset[str]):
    return [
        space
        for space in building.spaces.values()
        if space.floor_id == floor_id and space.room_type == room_type and space.type in types
    ]


def largest_room(building: Building, geometry: Geometry, floor_id: str, room_type: str) -> SpaceAnswer:
    candidates = _spaces_on(building, floor_id, room_type, AREA_TYPES)
    if not candidates:
        raise QueryError(f"No {room_type} spaces on {building.floor_name(floor_id)}.")
    best = max(candidates, key=lambda space: geometry.area_m2(space.id))
    return SpaceAnswer(best.id, best.name, best.ref, best.floor_id, round(geometry.area_m2(best.id), 2))


def floor_area_total(building: Building, geometry: Geometry, floor_id: str, room_type: str) -> float:
    candidates = _spaces_on(building, floor_id, room_type, AREA_TYPES)
    if not candidates:
        raise QueryError(f"No {room_type} spaces on {building.floor_name(floor_id)}.")
    return round(sum(geometry.area_m2(space.id) for space in candidates), 2)


def errand(
    building: Building,
    geometry: Geometry,
    start: str,
    asset_type: str,
    floor_id: str,
    room_type: str,
    constraints: RouteConstraints = CLEAR,
) -> ErrandAnswer:
    """Total walk: start -> nearest room holding an asset of the type -> largest room of the type on the floor."""
    distances = distances_from(building, geometry, start, constraints)
    holders = [
        space_id
        for space_id, distance in distances.items()
        if any(building.assets[asset_id].type == asset_type for asset_id in building.assets_by_space.get(space_id, []))
    ]
    if not holders:
        raise QueryError(f"No reachable space holds an asset of type '{asset_type}'.")
    via = min(holders, key=lambda space_id: distances[space_id])
    target_answer = largest_room(building, geometry, floor_id, room_type)
    second_leg = route(building, geometry, via, target_answer.space_id, constraints).length_m
    return ErrandAnswer(
        total_m=round(distances[via] + second_leg, 2),
        via_id=via,
        target_id=target_answer.space_id,
    )


def wide_delivery_count(
    building: Building, geometry: Geometry, start: str, floor_id: str, min_width_m: float
) -> int:
    """Rooms on the floor reachable without stairs or steps, through openings at least min_width_m wide."""
    constraints = RouteConstraints(step_free=True, min_door_width_m=min_width_m)
    return _reachable_room_count(building, geometry, start, floor_id, constraints)


def step_free_reachable_count(
    building: Building, geometry: Geometry, start: str, floor_id: str, closed: frozenset[str] | set[str]
) -> int:
    """Rooms on the floor still reachable step-free with the given elements closed."""
    constraints = RouteConstraints(step_free=True, closed=frozenset(closed))
    return _reachable_room_count(building, geometry, start, floor_id, constraints)


def _reachable_room_count(
    building: Building, geometry: Geometry, start: str, floor_id: str, constraints: RouteConstraints
) -> int:
    distances = distances_from(building, geometry, start, constraints)
    return sum(
        1
        for space_id in distances
        if building.spaces[space_id].floor_id == floor_id and building.spaces[space_id].type in REACHABLE_ROOM_TYPES
    )


def room_stacked(building: Building, geometry: Geometry, space_id: str, direction: str) -> SpaceAnswer:
    if direction not in ("above", "below"):
        raise QueryError(f"direction must be 'above' or 'below', got {direction!r}.")
    neighbour_id = geometry.space_above(space_id) if direction == "above" else geometry.space_below(space_id)
    if neighbour_id is None:
        raise QueryError(f"Nothing is directly {direction} {building.describe_space(space_id)}.")
    neighbour = building.spaces[neighbour_id]
    return SpaceAnswer(
        neighbour.id,
        neighbour.name,
        neighbour.ref,
        neighbour.floor_id,
        round(geometry.area_m2(neighbour.id), 2),
    )


def shared_wall_neighbours(building: Building, geometry: Geometry, space_id: str) -> list[SpaceAnswer]:
    """Spaces of type room or hall that share at least a 1 m wall with the space."""
    space = building.spaces[space_id]
    answers = []
    for wall in geometry.shared_walls(space.floor_id).values():
        other = wall.space_b if wall.space_a == space_id else wall.space_a if wall.space_b == space_id else None
        if other is None or building.spaces[other].type not in AREA_TYPES:
            continue
        neighbour = building.spaces[other]
        answers.append(
            SpaceAnswer(neighbour.id, neighbour.name, neighbour.ref, neighbour.floor_id, round(geometry.area_m2(neighbour.id), 2))
        )
    return sorted(answers, key=lambda answer: answer.space_id)


def shared_walls_count(building: Building, geometry: Geometry, space_id: str) -> int:
    return len(shared_wall_neighbours(building, geometry, space_id))


def straight_line_3d(building: Building, geometry: Geometry, first: str, second: str) -> float:
    return round(geometry.distance_3d(first, second), 2)


def what_if_door(
    building: Building,
    geometry: Geometry,
    first: str,
    second: str,
    target_floor_id: str,
) -> WhatIfAnswer:
    """Rooms on the target floor whose walk out of the building shrinks by more than 1 m with the new door."""
    wall = geometry.wall_between(first, second)
    if wall is None:
        raise QueryError(f"{building.describe_space(first)} and {building.describe_space(second)} share no wall.")
    door = Opening(
        id="what-if-door",
        floor_id=building.spaces[first].floor_id,
        space_ids=(first, second),
        kind="door",
        position=wall.midpoint,
        width_m=0.9,
        step_free=True,
        synthetic=True,
    )
    scenario = RouteConstraints(extra_openings=(door,))
    affected = []
    for space in building.spaces.values():
        if space.floor_id != target_floor_id or space.type not in REACHABLE_ROOM_TYPES:
            continue
        baseline = exit_distance(building, geometry, space.id)[0]
        improved = exit_distance(building, geometry, space.id, scenario)[0]
        if baseline is not None and improved is not None and baseline - improved > WHAT_IF_IMPROVEMENT_M:
            affected.append(space.id)
    return WhatIfAnswer(len(affected), tuple(sorted(affected)))
