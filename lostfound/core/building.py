"""Building: the starter's BuildingMap plus indices, width-aware graphs and temporary edits.

The route model (kit 1.1.0: door-to-door walking 15 cm off the walls, stairs 2 m and lifts 15 m + 1 m per metre
climbed, no way round the outside) is inherited unchanged from starter_agent.building_map, because the graded
answers are computed with it. Walking lengths per space are expensive, so they are cached per building file.

Routes can add the organizers' extra rules on top (lostfound.core.vehicles): a minimum opening width, forklift
routes, and production bays as destinations only. Reachability and distance answers keep the kit graph."""

import contextlib
import functools
import itertools
from collections import defaultdict
from collections.abc import Iterator
from pathlib import Path

import networkx as nx
from shapely.geometry import Polygon

from lostfound.core.vehicles import FORKLIFT_MIN_WIDTH_M, bay_rule_applies, is_bay, is_pedestrian_only
from starter_agent.building_map import DOOR_PREFIX, OUTSIDE, BuildingMap, MapError, RouteResult

__all__ = ["Building", "MapError", "NoRouteError", "OUTSIDE", "DOOR_PREFIX", "ROOMISH_TYPES", "WALL_NEIGHBOUR_TYPES"]

_WALKS_CACHE: dict[str, dict] = {}  # resolved building directory -> {space id: walks}, for unedited buildings

# Space types that count as "rooms" in room counts (reachability, deliveries, what-if exits). Halls,
# corridors, stairs, lifts and outdoor areas do not. Shared-wall counts are the exception: their wording
# only excludes corridors, stairwells and lifts, so halls count there (WALL_NEIGHBOUR_TYPES).
# Both verified against every labelled answer in tests/test_skills_oracle.py.
ROOMISH_TYPES = frozenset({"room"})
WALL_NEIGHBOUR_TYPES = frozenset({"room", "hall"})


class NoRouteError(MapError):
    """No route exists under the rules (closures, step-free, width, forklift, bays). The correct answer is to say so."""


class Building(BuildingMap):
    def __init__(self, building: dict, directory: Path | None = None) -> None:
        super().__init__(building)
        self.directory = directory
        self.floors_by_level = {floor["level"]: floor for floor in self.floors.values()}
        self.spaces_by_floor: dict[str, list[dict]] = defaultdict(list)
        for space in self.spaces.values():
            self.spaces_by_floor[space["floor_id"]].append(space)

    @classmethod
    def load(cls, path: Path) -> "Building":
        building = super().load(path)
        building.directory = path if path.is_dir() else path.parent
        building.walks = _WALKS_CACHE.setdefault(str(Path(building.directory).resolve()), {})
        return building

    @property
    def id(self) -> str:
        return self.data["building"]["id"]

    # ---------- geometry caches ----------

    @functools.cache
    def polygon(self, space_id: str) -> Polygon:
        return Polygon(self.spaces[space_id]["polygon"])

    def level(self, floor_id: str) -> int:
        return self.floors[floor_id]["level"]

    def space_level(self, space_id: str) -> int:
        return self.level(self.spaces[space_id]["floor_id"])

    # ---------- graph ----------

    def graph(self, step_free: bool = False, min_width: float | None = None) -> nx.MultiGraph:
        """The kit's graph, optionally without openings narrower than min_width (wide loads)."""
        graph = super().graph(step_free)
        if min_width is not None:
            narrow = [
                DOOR_PREFIX + opening["id"]
                for opening in self.openings.values()
                if opening["width_m"] + 1e-9 < min_width and DOOR_PREFIX + opening["id"] in graph
            ]
            graph.remove_nodes_from(narrow)
        return graph

    def route_graph(
        self,
        step_free: bool = False,
        min_width: float | None = None,
        forklift: bool = False,
        source: str | None = None,
    ) -> nx.MultiGraph | nx.MultiDiGraph:
        """The graph one route leg is searched in: the kit graph plus the organizers' extra route rules.

        forklift: openings at least 3 m wide, no steps, stairs or lifts, no pedestrian walkways.
        Production bays (when the bay rule applies): no walking through a bay from door to door, and a bay is only
        left from its own centre when it is the leg's `source`, so bays are reached as destinations but never
        crossed. That needs direction, so the graph becomes a MultiDiGraph."""
        if forklift:
            step_free = True
            min_width = max(min_width or 0.0, FORKLIFT_MIN_WIDTH_M)
        graph = self.graph(step_free, min_width)
        if forklift:
            graph.remove_edges_from([(a, b, key) for a, b, key, data in graph.edges(keys=True, data=True) if "via" in data])
            walkways = {space_id for space_id in self.spaces if is_pedestrian_only(self.spaces[space_id])}
            graph.remove_edges_from(
                [(a, b, key) for a, b, key, data in graph.edges(keys=True, data=True) if data.get("space") in walkways]
            )
            graph.remove_nodes_from([space_id for space_id in walkways if space_id in graph])
        if not bay_rule_applies(forklift):
            return graph
        bays = {space_id for space_id, space in self.spaces.items() if is_bay(space)}
        if not bays:
            return graph
        directed = graph.to_directed()
        directed.remove_edges_from(
            [(a, b, key) for a, b, key, data in directed.edges(keys=True, data=True) if data.get("space") in bays
             and a not in self.spaces and b not in self.spaces]
        )
        sinks = [space_id for space_id in bays if space_id in directed and space_id != source]
        directed.remove_edges_from(list(directed.out_edges(sinks, keys=True)))
        return directed

    def route_nodes(
        self, stops: list[str], step_free: bool = False, min_width: float | None = None, forklift: bool = False
    ) -> tuple[float, list[str], nx.MultiGraph | nx.MultiDiGraph]:
        """Shortest route through the stops in order: (length, nodes walked, a graph holding every edge used).
        Raises NoRouteError when a leg has no route under the rules."""
        per_leg = bay_rule_applies(forklift)  # each leg may leave its own start bay, so each leg has its own graph
        shared = None if per_leg else self.route_graph(step_free, min_width, forklift)
        used = shared
        nodes: list[str] = []
        length = 0.0
        for leg_start, leg_end in itertools.pairwise(stops):
            graph = shared if shared is not None else self.route_graph(step_free, min_width, forklift, leg_start)
            try:
                leg_length, leg_nodes = nx.single_source_dijkstra(graph, leg_start, leg_end, weight="weight")
            except (nx.NetworkXNoPath, nx.NodeNotFound) as error:
                raise NoRouteError(self.no_route_message(leg_start, leg_end, step_free, min_width, forklift)) from error
            used = graph if used is None else (used if used is graph else nx.compose(used, graph))
            length += leg_length
            nodes += leg_nodes if not nodes else leg_nodes[1:]
        return length, nodes, used

    def no_route_message(
        self, start: str, end: str, step_free: bool = False, min_width: float | None = None, forklift: bool = False
    ) -> str:
        reason = "forklift " if forklift else "step-free " if step_free else ""
        width = f" through openings at least {min_width:g} m wide" if min_width and not forklift else ""
        return (
            f"No {reason}route from {self.describe_space(start)} to {self.describe_space(end)}{width} "
            f"with the current closures {sorted(self.closed)}."
        )

    def route(
        self,
        start: str,
        destination: str,
        step_free: bool = False,
        via: list[str] | None = None,
        min_width: float | None = None,
        forklift: bool = False,
    ) -> RouteResult:
        """The kit's route (same graph, search and output), with the extra rules of route_graph when asked."""
        stops = [self.resolve_space(stop) for stop in (start, *(via or []), destination)]
        length, nodes, graph = self.route_nodes(stops, step_free, min_width, forklift)
        result = RouteResult(
            start_space_id=stops[0],
            destination_space_id=stops[-1],
            length_m=round(length, 2),
            space_path=self.spaces_passed(graph, nodes),
            steps=self.directions(graph, nodes),
            step_free=step_free or forklift,
            closed=sorted(self.closed),
        )
        self.last_route = result
        self.last_route_points = [self.node_point(node) for node in nodes]
        return result

    def entrance_nodes(self) -> list[str]:
        return [DOOR_PREFIX + opening["id"] for opening in self.openings.values() if OUTSIDE in opening["space_ids"]]

    def distances_from(
        self, source: str, step_free: bool = False, min_width: float | None = None
    ) -> dict[str, float]:
        graph = self.graph(step_free, min_width)
        if source not in graph:
            return {}
        return nx.single_source_dijkstra_path_length(graph, source, weight="weight")

    # ---------- temporary edits (what-if questions) ----------

    @contextlib.contextmanager
    def temporarily_closed(self, *element_ids: str) -> Iterator[None]:
        added = [element for element in element_ids if element not in self.closed]
        self.closed.update(added)
        try:
            yield
        finally:
            self.closed.difference_update(added)

    @contextlib.contextmanager
    def temporary_opening(self, opening: dict) -> Iterator[dict]:
        shared, self.walks = self.walks, dict(self.walks)  # never pollute the per-file cache
        self.openings[opening["id"]] = opening
        for space_id in opening["space_ids"]:
            self.walks.pop(space_id, None)
        try:
            yield opening
        finally:
            del self.openings[opening["id"]]
            self.walks = shared

    # ---------- lookups ----------

    def floor_by_level(self, level: int) -> dict:
        if level not in self.floors_by_level:
            known = ", ".join(str(item) for item in sorted(self.floors_by_level))
            raise MapError(f"No floor with level {level}. Levels: {known}.")
        return self.floors_by_level[level]

    def rooms_on_floor(self, floor_id: str, room_type: str | None = None) -> list[dict]:
        return [
            space
            for space in self.spaces_by_floor[floor_id]
            if room_type is None or space["room_type"] == room_type
        ]

    def label(self, space_id: str) -> str:
        """Short human label: name plus floor, e.g. 'Office 0.29 (Ground floor)'."""
        space = self.spaces[space_id]
        return f"{space['name']} ({self.floor_name(space['floor_id'])})"
