"""Cross-building routing: a campus places member buildings in one shared frame and links their entrance
doors with outdoor edges, so a journey can be composed: indoor route out of building A, the walk between
the buildings, indoor route through building B.

Where the outdoor distance comes from (never invented):
- curated: a campus file in data/campus/*.json places the buildings (offsets in metres);
- measured: data/campus/building-geo.json holds the real-world centroids of the OSM buildings, giving true
  distances (and honest "too far to walk" answers);
- assumed: the person said how far it is (chat); the placement is remembered for the session.

The single-building route model stays untouched — the graded model has no way round the outside
(CHANGELOG 1.1.0), so this layer only ever adds edges between *different* buildings' entrance doors.
"""

from __future__ import annotations

import itertools
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import networkx as nx

from lostfound.core import directions
from lostfound.core.building import Building, DOOR_PREFIX, OUTSIDE, MapError

REPO = Path(__file__).resolve().parents[2]
CAMPUS_DIR = REPO / "data" / "campus"
EARTH_M_PER_DEGREE = 111_320.0
WALK_M_PER_S = 1.3
# Choosing an exit: basement or upper-floor exits mean stairs to reach the street; a small penalty makes
# the ground-floor entrance win when it is close. The penalty only affects the choice, never the reported length.
NON_GROUND_EXIT_PENALTY_M = 8.0
TOO_FAR_TO_WALK_M = 1500.0


# ---------- placement sources ----------

def geo_table() -> dict:
    file = CAMPUS_DIR / "building-geo.json"
    if not file.exists():
        return {}
    return json.loads(file.read_text(encoding="utf-8")).get("buildings", {})


def geo_placement(a_id: str, b_id: str) -> dict | None:
    """Real displacement of b relative to a from measured centroids (x east, y north), or None if unknown."""
    table = geo_table()
    if a_id not in table or b_id not in table:
        return None
    a, b = table[a_id], table[b_id]
    dx = (b["lon"] - a["lon"]) * EARTH_M_PER_DEGREE * math.cos(math.radians(a["lat"]))
    dy = (b["lat"] - a["lat"]) * EARTH_M_PER_DEGREE
    return {
        "offset": [round(dx, 1), round(dy, 1)],
        "distance_m": round(math.hypot(dx, dy), 1),
        "source": "measured",
    }


def campus_files() -> dict[str, dict]:
    return {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(CAMPUS_DIR.glob("*.json")) if path.name != "building-geo.json"}


def curated_placement(a_id: str, b_id: str) -> dict | None:
    """Placement of b relative to a from a campus file that contains both buildings."""
    for definition in campus_files().values():
        members = definition.get("members", [])
        ids = {m["building_id"]: m for m in members}
        if a_id in ids and b_id in ids:
            a, b = ids[a_id], ids[b_id]
            offset = [b["offset"][0] - a["offset"][0], b["offset"][1] - a["offset"][1]]
            return {
                "offset": offset,
                "distance_m": None,
                "source": "curated",
                "campus_id": definition["id"],
                "members": members,
                "walkways": definition.get("walkways", []),
            }
    return None


# ---------- campus ----------

@dataclass
class CampusMember:
    building: Building
    offset: tuple[float, float]  # campus-frame position of this building's local origin (x east, y north)
    source: str = "curated"  # curated | measured | assumed | here


class Campus:
    """Member buildings placed in one frame, their entrance doors linked across buildings."""

    def __init__(self, members: list[CampusMember], walkways: list[dict] | None = None) -> None:
        self.members = members
        self.by_building = {member.building.id: member for member in members}
        if len(self.by_building) != len(members):
            raise MapError("A campus cannot place the same building twice.")
        self.walkways = walkways or []
        # entrance openings per building: (opening id, position in the campus frame, level)
        self._entrances: dict[str, list[tuple[str, tuple[float, float], int]]] = {}
        for member in members:
            entries = []
            for opening in member.building.openings.values():
                if OUTSIDE not in opening["space_ids"]:
                    continue
                position = (opening["position"][0] + member.offset[0], opening["position"][1] + member.offset[1])
                entries.append((opening["id"], position, member.building.level(opening["floor_id"])))
            if not entries:
                raise MapError(f"{member.building.data['building']['name']} has no entrance on the plan.")
            self._entrances[member.building.id] = entries

    def placement(self) -> list[dict]:
        """The scene's campus definition: which buildings, where, and how the distance is known."""
        return [
            {"buildingId": member.building.id, "name": member.building.data["building"]["name"], "offset": list(member.offset), "source": member.source}
            for member in self.members
        ]

    def pair_source(self, a_id: str, b_id: str) -> str:
        return self.by_building[b_id].source

    def graph(self, step_free: bool = False) -> nx.MultiGraph:
        """Union of the members' graphs plus outdoor edges between every entrance pair of different buildings."""
        graph = nx.MultiGraph()
        for member in self.members:
            graph = nx.compose(graph, member.building.graph(step_free))
        for a, b in itertools.combinations(self.members, 2):
            for id_a, pos_a, level_a in self._entrances[a.building.id]:
                for id_b, pos_b, level_b in self._entrances[b.building.id]:
                    weight = math.dist(pos_a, pos_b) + NON_GROUND_EXIT_PENALTY_M * (abs(level_a) + abs(level_b))
                    graph.add_edge(DOOR_PREFIX + id_a, DOOR_PREFIX + id_b, weight=max(weight, 1.0), outdoor=True)
        return graph

    def _walkway_path(self, door_a: str, door_b: str) -> list[tuple[float, float]] | None:
        """A curated outdoor course between two specific entrances, if the campus file defines one."""
        for way in self.walkways:
            if {way.get("from"), way.get("to")} == {door_a, door_b} and way.get("path"):
                return way["path"]
        return None

    def outdoor_distance(self, opening_a: str, opening_b: str) -> float:
        positions = {opening_id: position for member in self.members for opening_id, position, _ in self._entrances[member.building.id]}
        return math.dist(positions[opening_a], positions[opening_b])

    def cross_route(self, start: tuple[str, str], destination: tuple[str, str], step_free: bool = False) -> dict:
        """A whole journey from a space in one member building to a space in another.

        start/destination: (building id, space id). Returns legs (indoor route details per building, the
        outdoor leg with its campus-frame path) and combined step-by-step directions.
        """
        if start[0] not in self.by_building or destination[0] not in self.by_building:
            raise MapError("Route endpoints must be in campus buildings.")
        if start[0] == destination[0]:
            raise MapError("Both places are in the same building; use the normal route.")
        graph = self.graph(step_free)
        try:
            _, nodes = nx.single_source_dijkstra(graph, start[1], destination[1], weight="weight")
        except (nx.NetworkXNoPath, nx.NodeNotFound) as error:
            raise MapError("No route between these buildings (check the entrances).") from error

        # Split the node path into per-building runs at the outdoor edges; door nodes stay at the run ends.
        runs: list[list[str]] = []
        crossings: list[tuple[str, str]] = []
        run: list[str] = [nodes[0]]
        for here, following in itertools.pairwise(nodes):
            data = graph.get_edge_data(here, following) or {}
            if any(attrs.get("outdoor") for attrs in data.values()):
                runs.append(run)
                crossings.append((here.removeprefix(DOOR_PREFIX), following.removeprefix(DOOR_PREFIX)))
                run = []
            run.append(following)
        runs.append(run)
        # The exit/entry door nodes (and chains of doors between them) belong to the outdoor leg;
        # the indoor runs start and end at spaces.
        trimmed = []
        for index, path in enumerate(runs):
            if index > 0:
                while path and path[0].startswith(DOOR_PREFIX):
                    path = path[1:]
            if index < len(runs) - 1:
                while path and path[-1].startswith(DOOR_PREFIX):
                    path = path[:-1]
            if not path:
                raise MapError("No walkable spaces between the entrances.")
            trimmed.append(path)

        legs: list[dict] = []
        steps: list[str] = []
        length = 0.0
        for index, path in enumerate(trimmed):
            member = self.by_building[self._building_of(path[0])]
            name = member.building.data["building"]["name"]
            # Door chains pass through spaces without visiting them as nodes: the indoor leg runs to the space
            # the exit door stands in, and from the space the entry door leads into.
            first = path[0] if index == 0 else _inside_space(member.building, crossings[index - 1][1])
            last = path[-1] if index == len(trimmed) - 1 else _inside_space(member.building, crossings[index][0])
            details = directions.route_details(member.building, first, last, step_free)
            length += details["length_m"]
            legs.append({"kind": "indoor", "building_id": member.building.id, "building_name": name, "route": details})
            if index == 0:
                steps.extend(details["steps"])
                if index < len(crossings):  # a way point, not the destination: no "arrived" yet
                    steps[-1] = re.sub(r", you have arrived.*$", ".", steps[-1])
            else:
                enter = _entrance_label(member.building, crossings[index - 1][1])
                steps.append(f"Enter {name} through the entrance at {enter}, then continue.")
                steps.extend(step for step in details["steps"] if not step.startswith("Start in"))
            if index < len(crossings):
                door_a, door_b = crossings[index]
                next_member = self.by_building[self._building_of_door(door_b)]
                outdoor = self._outdoor_leg(door_a, door_b)
                length += outdoor["length_m"]
                legs.append(outdoor)
                leave = _entrance_label(member.building, door_a)
                note = {"measured": " (real distance, from OpenStreetMap)", "assumed": " (as you said)", "curated": ""}.get(outdoor["source"], "")
                steps.append(
                    f"Leave {name} through the entrance at {leave}, walk about {outdoor['length_m']:.0f} m across to "
                    f"{next_member.building.data['building']['name']}{note}."
                )
        return {
            "length_m": round(length, 2),
            "minutes": max(1, round(length / WALK_M_PER_S / 60)),
            "legs": legs,
            "steps": steps,
            "from": _place(self.by_building[start[0]].building, start[1]),
            "to": _place(self.by_building[destination[0]].building, destination[1]),
            "distance_source": self.pair_source(start[0], destination[0]),
        }

    def _outdoor_leg(self, door_a: str, door_b: str) -> dict:
        positions = {opening_id: position for member in self.members for opening_id, position, _ in self._entrances[member.building.id]}
        path = self._walkway_path(door_a, door_b)
        points = path if path else [list(positions[door_a]), list(positions[door_b])]
        if path:  # curated walkway: its length along the path
            length = sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))
        else:
            length = math.dist(positions[door_a], positions[door_b])
        return {
            "kind": "outdoor",
            "from": {"building_id": self._building_of_door(door_a), "opening_id": door_a},
            "to": {"building_id": self._building_of_door(door_b), "opening_id": door_b},
            "length_m": round(length, 1),
            "path": [[round(x, 3), round(y, 3)] for x, y in points],
            "source": self.pair_source(self._building_of_door(door_a), self._building_of_door(door_b)),
        }

    def _building_of(self, node: str) -> str:
        for member in self.members:
            if node in member.building.spaces:
                return member.building.id
        return self._building_of_door(node.removeprefix(DOOR_PREFIX))

    def _building_of_door(self, opening_id: str) -> str:
        for member in self.members:
            if opening_id in member.building.openings:
                return member.building.id
        raise MapError(f"Unknown opening {opening_id}.")


def _place(building: Building, space_id: str) -> dict:
    space = building.spaces[space_id]
    return {"building_id": building.id, "building_name": building.data["building"]["name"], "space_id": space_id, "name": space["name"], "floor": building.floor_name(space["floor_id"])}


def _entrance_label(building: Building, opening_id: str) -> str:
    """What the entrance looks like from inside: the space it leads from, with its floor."""
    return _entrance_room(building, opening_id)[1]


def _entrance_room(building: Building, opening_id: str) -> tuple[str, str]:
    """(space id, label) of the space an entrance opening leads from, excluding the outside pseudo-space."""
    opening = building.openings[opening_id]
    inside = next(space for space in opening["space_ids"] if space != OUTSIDE)
    return inside, f"{building.spaces[inside]['name']} ({building.floor_name(opening['floor_id'])})"


def _inside_space(building: Building, opening_id: str) -> str:
    return _entrance_room(building, opening_id)[0]


# ---------- the building catalog (for cross-building questions) ----------

class Catalog:
    """Building ids and names for everything the agent serves, with cached Building loads."""

    def __init__(self, directories: dict[str, Path] | None = None) -> None:
        self.directories = dict(directories or {})
        self.names: dict[str, str] = {}
        manifest = REPO / "data" / "manifest.csv"
        if manifest.exists():
            for line in manifest.read_text(encoding="utf-8").splitlines()[1:]:
                cells = line.split(",")
                if len(cells) >= 5:
                    self.names.setdefault(cells[0], cells[4])
        self._cache: dict[str, Building] = {}

    def search(self, text: str, limit: int = 6) -> list[dict]:
        needle = text.strip().casefold()
        hits = []
        for building_id, name in sorted(self._all_names().items()):
            if building_id == needle or needle in name.casefold() or needle in building_id.casefold():
                hits.append({"id": building_id, "name": name})
            if len(hits) >= limit:
                break
        return hits

    def _all_names(self) -> dict[str, str]:
        return {building_id: self.names.get(building_id, building_id) for building_id in self.directories}

    def load(self, building_id: str) -> Building:
        if building_id not in self._cache:
            directory = self.directories.get(building_id)
            if directory is None:
                raise MapError(f"Unknown building '{building_id}'.")
            self._cache[building_id] = Building.load(directory)
        return self._cache[building_id]

    def geo_distance(self, a_id: str, b_id: str) -> float | None:
        """Real-world distance in metres between two buildings, when both have measured positions."""
        placement = geo_placement(a_id, b_id)
        return placement["distance_m"] if placement else None
