"""Fire brigade attack route: from the best entrance to the fire, by the stairs (lifts are never used in a fire),
around spaces that are fully burning, as early as possible after the brigade arrives.

The chosen entrance is the one with the shortest clear way to the fire; the stairwell is reported, and whether the
route crosses smoke (spaces the fire reaches at a low level by the arrival time). Distances use the same route model
as every other answer; pace is slower than a walk (gear, hose, checking doors)."""

import math

import networkx as nx

from lostfound.core import directions
from lostfound.core.building import DOOR_PREFIX, OUTSIDE, Building
from lostfound.hazards.spread import affected_at, level_at

ARRIVAL_MIN = 8.0          # fire brigade on site (typical German target: 8–10 min)
ADVANCE_M_PER_MIN = 35.0   # pace inside with breathing apparatus and hose
STAGING_OFFSET_M = 10.0    # where the engine and crew stand, outside the chosen entrance


def attack_route(building: Building, result: dict, arrival_min: float = ARRIVAL_MIN) -> dict | None:
    if result["hazard"] != "fire":
        return None
    origin = result["origin"]
    burning = affected_at(result, arrival_min, kind="fire", min_level=0.6) - {origin}
    lifts = [c["id"] for c in building.connectors.values() if c["kind"] == "lift"]
    entries = [o for o in building.openings.values() if OUTSIDE in o["space_ids"]]
    if not entries:
        return None
    plan = _best(building, origin, entries, burning, lifts) or _best(building, origin, entries, set(), lifts)
    if plan is None:
        return None
    length, nodes, entrance, graph = plan
    smoke = []
    for node in nodes:
        if node in building.spaces and node != origin:
            level = max((level_at(e, arrival_min) for e in result["spaces"] if e["space_id"] == node and e["kind"] == "fire"), default=0.0)
            if level >= 0.12:
                smoke.append({"space_id": node, "name": building.spaces[node]["name"], "level": round(level, 2)})
    stairs = []
    for a, b in zip(nodes, nodes[1:]):
        for data in (graph.get_edge_data(a, b) or {}).values():
            if data.get("via") and data["via"] not in stairs:
                stairs.append(data["via"])
    position = entrance["position"]
    inside = next(s for s in entrance["space_ids"] if s != OUTSIDE)
    cx, cy = building.anchor(inside)
    dx, dy = position[0] - cx, position[1] - cy
    norm = math.hypot(dx, dy) or 1.0
    staging = [round(position[0] + dx / norm * STAGING_OFFSET_M, 2), round(position[1] + dy / norm * STAGING_OFFSET_M, 2)]
    path = [[run["floor_id"], *point] for run in directions._polylines(building, nodes) for point in run["points"]]
    path = [[entrance["floor_id"], *staging], *path]
    minutes = (length + STAGING_OFFSET_M) / ADVANCE_M_PER_MIN
    return {
        "entrance": entrance["id"], "entrance_room": building.spaces[inside]["name"], "entrance_floor_id": entrance["floor_id"],
        "staging": staging, "stairs": [building.connectors[s]["name"] for s in stairs if s in building.connectors],
        "distance_m": round(length + STAGING_OFFSET_M, 1), "arrive_min": arrival_min, "at_fire_min": round(arrival_min + minutes, 1),
        "through_smoke": smoke, "avoided": sorted(burning)[:40], "path": path,
        "space_path": [n for n in building.spaces_passed(graph, nodes) if n in building.spaces],
    }


def _best(building: Building, origin: str, entries: list[dict], burning: set[str], lifts: list[str]):
    with building.temporarily_closed(*burning, *lifts):
        graph = building.graph()
        if origin not in graph:
            return None
        sources = [DOOR_PREFIX + e["id"] for e in entries if DOOR_PREFIX + e["id"] in graph]
        if not sources:
            return None
        try:
            length, path = nx.multi_source_dijkstra(graph, sources, target=origin, weight="weight")
        except nx.NetworkXNoPath:
            return None
        entrance = building.openings[path[0].removeprefix(DOOR_PREFIX)]
        return length, path, entrance, graph.copy()
