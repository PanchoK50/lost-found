"""Evacuation during a fire: each occupied room's way out avoiding what burns at that moment (lifts off)."""

import networkx as nx

from lostfound.core import directions
from lostfound.core.building import DOOR_PREFIX, Building
from lostfound.hazards.model import occupancy
from lostfound.hazards.spread import affected_at

WALK_M_PER_MIN = 60.0  # evacuation pace including queues at doors and stairs
MAX_ROUTES = 12
MAX_WALKERS = 160  # rooms whose people are animated walking out
REACTION_MIN = 1.0  # alarm, then people get up and go
EXIT_FLOW = 80.0  # people per metre of door width per minute (about 1.3 per second per metre)


def evacuate(building: Building, result: dict, at_min: float = 3.0) -> dict:
    """Ways out at `at_min` minutes after the start (default: alarm plus reaction time).

    Fire: everyone leaves the building, around the fire, lifts off. Water or power: only the people in the rooms
    that are hit leave (the rest of the building carries on)."""
    fire = result["hazard"] == "fire"
    blocked = affected_at(result, at_min, kind="fire", min_level=0.5) if fire else set()
    lifts = [c["id"] for c in building.connectors.values() if c["kind"] == "lift"] if fire else []
    hit = None if fire else {e["space_id"] for e in result["spaces"] if e["kind"] == result["hazard"] and e["peak"] >= 0.4}
    with building.temporarily_closed(*blocked, *lifts):
        graph = building.graph()
        exits = [node for node in building.entrance_nodes() if node in graph]
        lengths, paths = nx.multi_source_dijkstra(graph, exits, weight="weight") if exits else ({}, {})
        rooms, cut_off = [], []
        for space in building.spaces.values():
            if space["type"] not in ("room", "hall") or space["id"] in blocked or (hit is not None and space["id"] not in hit):
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
                       "polylines": directions._polylines(building, room["nodes"], graph), "space_path": building.spaces_passed(graph, room["nodes"])})
    # Walkers: every evacuated room's way out as one polyline across floors, for the people animation.
    walkers = []
    for room in sorted(rooms, key=lambda r: -r["people"])[:MAX_WALKERS]:
        start = _start_time(result, room["space_id"]) if not fire else REACTION_MIN
        path = [[run["floor_id"], *point] for run in directions._polylines(building, room["nodes"], graph) for point in run["points"]]
        walkers.append({"space_id": room["space_id"], "people": room["people"], "distance_m": room["distance_m"], "start_min": round(start, 2),
                        "exit": room["exit"], "path": path})
    # Queues at the exits: each door lets EXIT_FLOW people per metre per minute through, first come first served.
    clear: dict[str, float] = {}
    for walker in sorted(walkers, key=lambda w: w["start_min"] + w["distance_m"] / WALK_M_PER_MIN):
        width = max(0.8, building.openings[walker["exit"]]["width_m"])
        arrive = walker["start_min"] + walker["distance_m"] / WALK_M_PER_MIN
        done = max(arrive, clear.get(walker["exit"], 0.0)) + walker["people"] / (EXIT_FLOW * width)
        clear[walker["exit"]] = done
        walker["out_min"] = round(done, 2)
    for cut in cut_off:
        x, y = building.anchor(cut["space_id"])
        walkers.append({"space_id": cut["space_id"], "people": cut["people"], "distance_m": 0.0, "start_min": REACTION_MIN, "cut_off": True,
                        "path": [[building.spaces[cut["space_id"]]["floor_id"], round(x, 3), round(y, 3)]]})
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
        "exits": [{"opening_id": opening_id, "people": people, "position": building.openings[opening_id]["position"], "floor_id": building.openings[opening_id]["floor_id"],
                   "width_m": building.openings[opening_id]["width_m"], "clear_min": round(clear.get(opening_id, 0.0), 2)}
                  for opening_id, people in sorted(exits_used.items(), key=lambda item: -item[1])],
        "all_out_min": round(max(clear.values(), default=0.0), 2),
        "routes": routes,
        "walkers": walkers,
        "walk_m_per_min": WALK_M_PER_MIN,
    }


def _start_time(result: dict, space_id: str) -> float:
    """Water or power: people leave once it reaches their room (plus reaction time)."""
    arrival = min((e["arrival_min"] for e in result["spaces"] if e["space_id"] == space_id and e["kind"] == result["hazard"]), default=0.0)
    return arrival + REACTION_MIN
