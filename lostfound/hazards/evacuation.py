"""Evacuation during a fire: each occupied room's way out avoiding what burns at that moment (lifts off)."""

import networkx as nx

from lostfound.core import directions
from lostfound.core.building import DOOR_PREFIX, Building
from lostfound.hazards.model import occupancy
from lostfound.hazards.spread import affected_at

WALK_M_PER_MIN = 60.0  # evacuation pace including queues at doors and stairs
MAX_ROUTES = 12


def evacuate(building: Building, result: dict, at_min: float = 3.0) -> dict:
    """Ways out at `at_min` minutes after the start (default: alarm plus reaction time)."""
    blocked = affected_at(result, at_min, kind="fire", min_level=0.5) if result["hazard"] == "fire" else set()
    lifts = [c["id"] for c in building.connectors.values() if c["kind"] == "lift"] if result["hazard"] == "fire" else []
    with building.temporarily_closed(*blocked, *lifts):
        graph = building.graph()
        exits = [node for node in building.entrance_nodes() if node in graph]
        lengths, paths = nx.multi_source_dijkstra(graph, exits, weight="weight") if exits else ({}, {})
        rooms, cut_off = [], []
        for space in building.spaces.values():
            if space["type"] not in ("room", "hall") or space["id"] in blocked:
                continue
            people = occupancy(building, space["id"])
            if not people:
                continue
            if space["id"] not in lengths:
                cut_off.append({"space_id": space["id"], "name": space["name"], "floor": building.floor_name(space["floor_id"]), "people": people})
                continue
            path = list(reversed(paths[space["id"]]))
            exit_door = path[-1].removeprefix(DOOR_PREFIX)
            rooms.append({
                "space_id": space["id"], "name": space["name"], "floor": building.floor_name(space["floor_id"]), "floor_id": space["floor_id"],
                "people": people, "distance_m": round(lengths[space["id"]], 1), "minutes": round(lengths[space["id"]] / WALK_M_PER_MIN, 1),
                "exit": exit_door, "nodes": path,
            })
    # Routes to draw: the rooms nearest the fire (they leave first) and the longest ways out.
    origin_floor = building.spaces[result["origin"]]["floor_id"]
    rooms.sort(key=lambda r: (r["floor_id"] != origin_floor, -r["people"]))
    drawn = rooms[: MAX_ROUTES // 2] + sorted(rooms, key=lambda r: -r["distance_m"])[: MAX_ROUTES // 2]
    routes, seen = [], set()
    for room in drawn:
        if room["space_id"] in seen:
            continue
        seen.add(room["space_id"])
        routes.append({"space_id": room["space_id"], "name": room["name"], "exit": room["exit"], "distance_m": room["distance_m"],
                       "polylines": directions._polylines(building, room["nodes"]), "space_path": building.spaces_passed(graph, room["nodes"])})
    for room in rooms:
        room.pop("nodes")
    exits_used: dict[str, int] = {}
    for room in rooms:
        exits_used[room["exit"]] = exits_used.get(room["exit"], 0) + room["people"]
    return {
        "at_min": at_min, "blocked": sorted(blocked), "lifts_off": lifts,
        "people": sum(r["people"] for r in rooms) + sum(c["people"] for c in cut_off),
        "rooms": sorted(rooms, key=lambda r: -r["distance_m"])[:60], "cut_off": cut_off,
        "longest_m": max((r["distance_m"] for r in rooms), default=0.0),
        "longest_min": max((r["minutes"] for r in rooms), default=0.0),
        "exits": [{"opening_id": opening_id, "people": people, "position": building.openings[opening_id]["position"], "floor_id": building.openings[opening_id]["floor_id"]}
                  for opening_id, people in sorted(exits_used.items(), key=lambda item: -item[1])],
        "routes": routes,
    }
