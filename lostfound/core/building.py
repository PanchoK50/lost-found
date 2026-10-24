"""Building: the starter's BuildingMap plus indices, width-aware graphs and temporary edits.

The route model (anchors, opening edges, stair/lift costs, parallel edges, the shared "outside" node) is
inherited unchanged from starter_agent.building_map, because the expected answers were computed with it."""

import contextlib
import functools
import itertools
import math
from collections import defaultdict
from collections.abc import Iterator
from pathlib import Path

import networkx as nx
from shapely.geometry import Polygon

from starter_agent.building_map import (
    DOOR_PREFIX,
    LIFT,
    LIFT_COST_PER_FLOOR_M,
    LIFT_WAIT_COST_M,
    OUTSIDE,
    STAIRS_COST_PER_FLOOR_M,
    BuildingMap,
    MapError,
)

__all__ = ["Building", "MapError", "OUTSIDE", "DOOR_PREFIX", "ROOMISH_TYPES", "WALL_NEIGHBOUR_TYPES"]

# Space types that count as "rooms" in room counts (reachability, deliveries, what-if exits). Halls,
# corridors, stairs, lifts and outdoor areas do not. Shared-wall counts are the exception: their wording
# only excludes corridors, stairwells and lifts, so halls count there (WALL_NEIGHBOUR_TYPES).
# Both verified against every labelled answer in tests/test_skills_oracle.py.
ROOMISH_TYPES = frozenset({"room"})
WALL_NEIGHBOUR_TYPES = frozenset({"room", "hall"})


class Building(BuildingMap):
    def __init__(self, building: dict, directory: Path | None = None) -> None:
        super().__init__(building)
        self.directory = directory
        self.floors_by_level = {floor["level"]: floor for floor in self.floors.values()}
        self.spaces_by_floor: dict[str, list[dict]] = defaultdict(list)
        for space in self.spaces.values():
            self.spaces_by_floor[space["floor_id"]].append(space)
        self._anchors: dict[str, tuple[float, float]] = {}

    @classmethod
    def load(cls, path: Path) -> "Building":
        building = super().load(path)
        building.directory = path if path.is_dir() else path.parent
        return building

    @property
    def id(self) -> str:
        return self.data["building"]["id"]

    # ---------- geometry caches ----------

    @functools.cache
    def polygon(self, space_id: str) -> Polygon:
        return Polygon(self.spaces[space_id]["polygon"])

    def anchor(self, space_id: str) -> tuple[float, float]:
        if space_id not in self._anchors:
            point = self.polygon(space_id).representative_point()
            self._anchors[space_id] = (point.x, point.y)
        return self._anchors[space_id]

    def level(self, floor_id: str) -> int:
        return self.floors[floor_id]["level"]

    def space_level(self, space_id: str) -> int:
        return self.level(self.spaces[space_id]["floor_id"])

    # ---------- graph ----------

    def graph(self, step_free: bool = False, min_width: float | None = None) -> nx.MultiGraph:
        """Same graph as BuildingMap.graph, optionally dropping openings narrower than min_width."""
        graph = nx.MultiGraph()
        anchors = {space_id: self.anchor(space_id) for space_id in self.spaces if space_id not in self.closed}
        graph.add_nodes_from(anchors)
        for opening in self.openings.values():
            if opening["id"] in self.closed or (step_free and not opening["step_free"]):
                continue
            if min_width is not None and opening["width_m"] + 1e-9 < min_width:
                continue
            door = DOOR_PREFIX + opening["id"]
            for space_id in opening["space_ids"]:
                if space_id == OUTSIDE:
                    graph.add_edge(OUTSIDE, door, weight=0.0, via=opening["id"])
                elif space_id in anchors:
                    distance = math.dist(anchors[space_id], opening["position"])
                    graph.add_edge(space_id, door, weight=distance, via=opening["id"])
        for connector in self.connectors.values():
            if connector["id"] in self.closed or (step_free and not connector["step_free"]):
                continue
            stops = sorted(
                zip(connector["floor_ids"], connector["space_ids"], strict=True),
                key=lambda stop: self.level(stop[0]),
            )
            for (low_floor, low_space), (high_floor, high_space) in itertools.pairwise(stops):
                if low_space not in anchors or high_space not in anchors:
                    continue
                span = abs(self.level(high_floor) - self.level(low_floor))
                cost = (
                    LIFT_WAIT_COST_M + LIFT_COST_PER_FLOOR_M * span
                    if connector["kind"] == LIFT
                    else STAIRS_COST_PER_FLOOR_M * span
                )
                graph.add_edge(low_space, high_space, weight=cost, via=connector["id"])
        return graph

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
        self.openings[opening["id"]] = opening
        try:
            yield opening
        finally:
            del self.openings[opening["id"]]

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
