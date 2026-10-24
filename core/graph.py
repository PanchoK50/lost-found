"""Routing graph and Dijkstra queries under RouteConstraints.

The model is the one the judges grade with and the one behind the dataset's
expected answers since kit 1.1.0 (README section 3, `starter_agent/building_map.py`):

- Nodes: one per space (at its representative_point centre) plus one per opening.
- Walking inside a space goes door to door, 15 cm off the walls and round corners,
  never through a wall (a visibility graph over the shrunken outline, computed in
  core.geometry). A door lands 30 cm inside the space; that step is paid too.
- Stairs cost 2 m per metre climbed; a lift ride costs 15 m once plus 1 m per metre
  climbed, and every pair of lift stops is joined directly.
- There is no shortcut round the outside: an entrance leads out of the building,
  not into another part of it. Two parts meeting only outside have no route.
- Parallel connections (a stair and a lift between the same spaces, two doors
  between the same rooms) are all kept.

Constraints compose with logical AND: step-free drops every stair and every
opening with step_free=False, min_door_width_m drops too-narrow openings,
min_space_width_m excludes spaces whose polygon is too narrow, closed drops
elements by id, and no_transit turns spaces into sinks: enterable as a
destination, never a shortcut ("production bays are destinations"). The graph is
directed only to express sinks; every ordinary edge exists in both directions.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field, replace
from typing import Callable

import networkx as nx

from core.geometry import Geometry
from core.model import DOOR_PREFIX, Building, Space

# Vertical movement in equivalent walking metres per metre of height (floors' elevation_m).
STAIRS_M_PER_RISE = 2.0
LIFT_FIXED_M = 15.0
LIFT_M_PER_RISE = 1.0
LENGTH_DECIMALS = 3


class RouteError(ValueError):
    """Raised for anything the caller should be told (unknown place, no route)."""


SpaceFilter = Callable[[Space], bool]


@dataclass(frozen=True, slots=True)
class RouteConstraints:
    step_free: bool = False
    min_door_width_m: float | None = None
    min_space_width_m: float | None = None
    closed: frozenset[str] = frozenset()
    extra_openings: tuple = ()
    no_transit: frozenset[str] = frozenset()
    space_filter: SpaceFilter | None = field(default=None, compare=False)

    def allows_opening(self, opening) -> bool:
        if opening.id in self.closed:
            return False
        if self.step_free and not opening.step_free:
            return False
        if self.min_door_width_m is not None and opening.width_m < self.min_door_width_m:
            return False
        return True

    def allows_space(self, space_id: str, space: Space, geometry: Geometry) -> bool:
        if space_id in self.closed:
            return False
        if self.min_space_width_m is not None and geometry.min_width_m(space_id) < self.min_space_width_m:
            return False
        if self.space_filter is not None and not self.space_filter(space):
            return False
        return True

    def cache_key(self) -> tuple:
        return (
            self.step_free,
            self.min_door_width_m,
            self.min_space_width_m,
            tuple(sorted(self.closed)),
            tuple(opening.id for opening in self.extra_openings),
            tuple(sorted(self.no_transit)),
            id(self.space_filter) if self.space_filter is not None else None,
        )


CLEAR = RouteConstraints()


@dataclass(frozen=True, slots=True)
class Leg:
    start_id: str
    destination_id: str
    length_m: float
    space_path: list[str]


@dataclass(frozen=True, slots=True)
class RouteResult:
    start_id: str
    destination_id: str
    length_m: float
    space_path: list[str]
    element_path: list[str]
    legs: tuple[Leg, ...]
    step_free: bool
    closed: tuple[str, ...]


def build_graph(
    building: Building,
    geometry: Geometry,
    constraints: RouteConstraints = CLEAR,
) -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    eligible = {
        space_id: space
        for space_id, space in building.spaces.items()
        if constraints.allows_space(space_id, space, geometry)
    }
    graph.add_nodes_from(eligible)
    allowed_openings = [
        opening
        for opening in list(building.openings.values()) + list(constraints.extra_openings)
        if constraints.allows_opening(opening)
    ]
    allowed_doors = {DOOR_PREFIX + opening.id for opening in allowed_openings}
    for space_id in eligible:
        sink = space_id in constraints.no_transit
        for first, second, length in geometry.space_walks(space_id, constraints.extra_openings):
            doors = [node for node in (first, second) if node.startswith(DOOR_PREFIX)]
            if any(door not in allowed_doors for door in doors):
                continue
            weight = round(length, LENGTH_DECIMALS)
            via = doors[0].removeprefix(DOOR_PREFIX)
            crosses_sink = first.startswith(DOOR_PREFIX) and second.startswith(DOOR_PREFIX)
            for source, target in ((first, second), (second, first)):
                # A sink space may be entered as a destination but never left or crossed.
                if sink and (source == space_id or crosses_sink):
                    continue
                graph.add_edge(source, target, weight=weight, space=space_id, via=via)
    levels = {floor_id: floor.level for floor_id, floor in building.floors.items()}
    elevations = {floor_id: floor.elevation_m for floor_id, floor in building.floors.items()}
    for connector in building.connectors.values():
        if connector.id in constraints.closed:
            continue
        if constraints.step_free and not connector.step_free:
            continue
        stops = sorted(
            zip(connector.floor_ids, connector.space_ids, strict=True),
            key=lambda stop: levels[stop[0]],
        )
        # A lift ride pays the fixed 15 m once however many floors it passes, so every
        # pair of stops gets an edge; stairs keep one edge per flight.
        pairs = itertools.combinations(stops, 2) if connector.kind == "lift" else itertools.pairwise(stops)
        for (low_floor, low_space), (high_floor, high_space) in pairs:
            if low_space not in eligible or high_space not in eligible:
                continue
            rise = abs(elevations[high_floor] - elevations[low_floor])
            cost = (
                LIFT_FIXED_M + LIFT_M_PER_RISE * rise
                if connector.kind == "lift"
                else STAIRS_M_PER_RISE * rise
            )
            weight = round(cost, LENGTH_DECIMALS)
            if low_space not in constraints.no_transit:
                graph.add_edge(high_space, low_space, weight=weight, via=connector.id)
            if high_space not in constraints.no_transit:
                graph.add_edge(low_space, high_space, weight=weight, via=connector.id)
    return graph


def _element_path(graph: nx.MultiDiGraph, nodes: list[str]) -> list[str]:
    elements = []
    for previous, current in itertools.pairwise(nodes):
        edge = min(graph[previous][current].values(), key=lambda candidate: candidate["weight"])
        if edge.get("via") and edge["via"] not in elements:
            elements.append(edge["via"])
    return elements


def _spaces_passed(graph: nx.MultiDiGraph, nodes: list[str]) -> list[str]:
    """Every space the route goes through, in order, including those crossed door to door."""
    spaces: list[str] = []
    for index, node in enumerate(nodes):
        edge_space = None
        if index:
            edge = min(graph[nodes[index - 1]][node].values(), key=lambda candidate: candidate["weight"])
            edge_space = edge.get("space")
        for space_id in (edge_space, None if node.startswith(DOOR_PREFIX) else node):
            if space_id is not None and (not spaces or spaces[-1] != space_id):
                spaces.append(space_id)
    return spaces


def route(
    building: Building,
    geometry: Geometry,
    start: str,
    destination: str,
    constraints: RouteConstraints = CLEAR,
    via: list[str] | None = None,
) -> RouteResult:
    """Shortest walking route through stop list [start, *via, destination]."""
    stops = [start, *(via or []), destination]
    for stop in stops:
        if stop not in building.spaces:
            raise RouteError(f"Unknown space {stop!r}.")
    if start in constraints.no_transit:
        # Leaving the start bay must be possible even though bays are sinks.
        constraints = replace(constraints, no_transit=constraints.no_transit - {start})
    graph = build_graph(building, geometry, constraints)
    nodes: list[str] = []
    legs: list[Leg] = []
    length = 0.0
    for leg_start, leg_end in itertools.pairwise(stops):
        try:
            leg_length, leg_nodes = nx.single_source_dijkstra(graph, leg_start, leg_end, weight="weight")
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            reason = "step-free " if constraints.step_free else ""
            raise RouteError(
                f"No {reason}route from {building.describe_space(leg_start)} to "
                f"{building.describe_space(leg_end)}"
                + (f" with closures {sorted(constraints.closed)}." if constraints.closed else ".")
            ) from None
        length += leg_length
        leg_space_path = _spaces_passed(graph, leg_nodes)
        legs.append(Leg(leg_start, leg_end, round(leg_length, 2), leg_space_path))
        nodes += leg_nodes if not nodes else leg_nodes[1:]
    return RouteResult(
        start_id=start,
        destination_id=destination,
        length_m=round(length, 2),
        space_path=_spaces_passed(graph, nodes),
        element_path=_element_path(graph, nodes),
        legs=tuple(legs),
        step_free=constraints.step_free,
        closed=tuple(sorted(constraints.closed)),
    )


def distances_from(
    building: Building,
    geometry: Geometry,
    start: str,
    constraints: RouteConstraints = CLEAR,
) -> dict[str, float]:
    """Walking distances from one space to every reachable space (space ids only)."""
    if start not in building.spaces:
        raise RouteError(f"Unknown space {start!r}.")
    if start in constraints.no_transit:
        constraints = replace(constraints, no_transit=constraints.no_transit - {start})
    graph = build_graph(building, geometry, constraints)
    try:
        distances = nx.single_source_dijkstra_path_length(graph, start, weight="weight")
    except nx.NodeNotFound:
        raise RouteError(f"{building.describe_space(start)} is excluded by the constraints.") from None
    return {
        node: distance
        for node, distance in distances.items()
        if not node.startswith(DOOR_PREFIX) and node != "outside"
    }


def exit_distance(
    building: Building,
    geometry: Geometry,
    space_id: str,
    constraints: RouteConstraints = CLEAR,
) -> tuple[float | None, str | None]:
    """Walking distance to the nearest entrance, and that entrance's opening id.

    An entrance leads out of the building (no shortcut round the outside), so the
    distance is the walk to the entrance door itself. None when no entrance is
    reachable under the constraints.
    """
    if space_id not in building.spaces:
        raise RouteError(f"Unknown space {space_id!r}.")
    graph = build_graph(building, geometry, constraints)
    try:
        distances = nx.single_source_dijkstra_path_length(graph, space_id, weight="weight")
    except nx.NodeNotFound:
        return (None, None)
    best_length: float | None = None
    best_entrance: str | None = None
    for opening_id, opening in building.openings.items():
        if "outside" not in opening.space_ids or not constraints.allows_opening(opening):
            continue
        door = DOOR_PREFIX + opening_id
        length = distances.get(door)
        if length is not None and (best_length is None or length < best_length):
            best_length = length
            best_entrance = opening_id
    if best_length is None:
        return (None, None)
    return (round(best_length, 2), best_entrance)
