"""Building: the starter's BuildingMap plus indices, width-aware graphs and temporary edits.

The route model (kit 1.1.0: door-to-door walking 15 cm off the walls, stairs 2 m and lifts 15 m + 1 m per metre
climbed, no way round the outside) is inherited unchanged from starter_agent.building_map, because the graded
answers are computed with it. Walking lengths per space are expensive, so they are cached per building file."""

import contextlib
import functools
from collections import defaultdict
from collections.abc import Iterator
from pathlib import Path

import networkx as nx
from shapely.geometry import Polygon

from starter_agent.building_map import DOOR_PREFIX, OUTSIDE, BuildingMap, MapError

__all__ = ["Building", "MapError", "OUTSIDE", "DOOR_PREFIX", "ROOMISH_TYPES", "WALL_NEIGHBOUR_TYPES"]

_WALKS_CACHE: dict[str, dict] = {}  # resolved building directory -> {space id: walks}, for unedited buildings

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
