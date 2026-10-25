"""How a fire, a leak or an electrical fault spreads through a building over time.

A simple, explainable model on the building's own structure (no CFD): spaces are nodes; fire and smoke travel
through doors, slowly through walls and floors, and up stairwells; water runs under doors, through walls and
down to the rooms below; an electrical fault takes out the circuit of its panel. Each reached space gets an
arrival time and a peak level (0–1); the level at time t ramps from arrival to the peak over `RAMP[kind]` minutes.

Water reaching powered equipment (server racks, panels, machines) or fire reaching an electrical panel
cascades into a power outage on that circuit."""

import heapq
import math
from functools import lru_cache

from shapely.strtree import STRtree

from lostfound.core.building import DOOR_PREFIX, OUTSIDE, Building
from lostfound.hazards.model import HAZARDS, POWERED_ASSETS, WET_ASSETS

RAMP = {"fire": 5.0, "water": 6.0, "electrical": 0.5}
MIN_LEVEL = {"fire": 0.12, "water": 0.25}
WALL_GAP_M = 0.35
MIN_WALL_M = 1.0
MIN_OVERLAP = 0.05

# (delay in minutes, level factor) per way of spreading; door delays add the walk between the room centres.
FIRE = {"door": (2.0, 0.95), "wall": (28.0, 0.75), "stairs": (4.0, 0.85), "above": (18.0, 0.7)}
# Fire grows across a room in minutes; smoke runs along corridors and up stairwells at tens of metres a minute.
STAIR_DOOR_FACTOR = 0.45
FIRE_M_PER_MIN = {"room": 6.0, "hall": 12.0, "corridor": 30.0, "stair": 30.0, "lift": 30.0, "outdoor": 2.0}
WATER = {"door": (1.0, 0.38), "wall": (12.0, 0.35), "below": (6.0, 0.8), "stairs": (3.0, 0.5)}
WATER_M_PER_MIN = 6.0
POOL_LEVEL = 0.45  # water drips to the floor below only from spaces at least this wet


def simulate(building: Building, hazard: str, origin: str, minutes: float = 30.0) -> dict:
    if hazard not in HAZARDS:
        raise ValueError(f"hazard must be one of {', '.join(HAZARDS)}")
    if origin not in building.spaces:
        raise ValueError(f"unknown space {origin}")
    if hazard == "electrical":
        reached = _circuit_outage(building, origin, 0.0, "origin")
    else:
        reached = _dijkstra(building, hazard, origin, minutes)
    entries = [{**value, "space_id": space_id, "kind": hazard} for space_id, value in reached.items()]
    cascades = _cascades(building, hazard, reached, minutes)
    for cascade in cascades:
        known = {e["space_id"] for e in entries if e["kind"] == "electrical"}
        for space_id, value in cascade.pop("outage").items():
            if space_id not in known:
                entries.append({**value, "space_id": space_id, "kind": "electrical"})
    entries.sort(key=lambda e: (e["arrival_min"], -e["peak"]))
    return {
        "hazard": hazard, "origin": origin, "minutes": minutes, "ramp_min": RAMP,
        "spaces": [{**e, "arrival_min": round(e["arrival_min"], 2), "peak": round(e["peak"], 3)} for e in entries],
        "cascades": cascades,
    }


def level_at(entry: dict, t: float) -> float:
    """Level of one reached space at minute t."""
    if t < entry["arrival_min"]:
        return 0.0
    ramp = RAMP[entry["kind"]]
    return entry["peak"] * min(1.0, (t - entry["arrival_min"]) / ramp if ramp else 1.0)


def frames(result: dict, step: float = 1.0) -> list[dict]:
    """Levels per minute, for clients that don't interpolate themselves."""
    out, t = [], 0.0
    while t <= result["minutes"] + 1e-9:
        levels = {}
        for entry in result["spaces"]:
            level = level_at(entry, t)
            if level > 0.01:
                key = f"{entry['kind']}:{entry['space_id']}"
                levels[key] = round(level, 3)
        out.append({"t": t, "levels": levels})
        t += step
    return out


def affected_at(result: dict, t: float, kind: str | None = None, min_level: float = 0.5) -> set[str]:
    return {e["space_id"] for e in result["spaces"] if (kind is None or e["kind"] == kind) and level_at(e, t) >= min_level}


# ---------- structure ----------

def _anchor(building: Building, space_id: str) -> tuple[float, float]:
    return tuple(building.anchor(space_id))


@lru_cache(maxsize=16)
def _structure(building: Building) -> dict:
    """Neighbours per space by way of spreading: doors (with walk length), walls, stairs, and stacking."""
    doors: dict[str, list[tuple[str, float]]] = {s: [] for s in building.spaces}
    for opening in building.openings.values():
        a, b = opening["space_ids"]
        if OUTSIDE in (a, b) or a not in building.spaces or b not in building.spaces:
            continue
        door = tuple(opening["position"])
        walk = math.dist(_anchor(building, a), door) + math.dist(door, _anchor(building, b))
        doors[a].append((b, walk))
        doors[b].append((a, walk))
    walls: dict[str, list[str]] = {s: [] for s in building.spaces}
    for floor_id, spaces in building.spaces_by_floor.items():
        ids = [s["id"] for s in spaces]
        polygons = [building.polygon(i) for i in ids]
        tree = STRtree(polygons)
        for index, polygon in enumerate(polygons):
            for other in tree.query(polygon.buffer(WALL_GAP_M)):
                if other <= index:
                    continue
                near = polygons[other].exterior.buffer(WALL_GAP_M)
                if polygon.exterior.intersection(near).length >= MIN_WALL_M:
                    walls[ids[index]].append(ids[other])
                    walls[ids[other]].append(ids[index])
    stairs: dict[str, list[tuple[str, int]]] = {s: [] for s in building.spaces}
    for connector in building.connectors.values():
        stops = [(building.level(f), s) for f, s in zip(connector["floor_ids"], connector["space_ids"]) if s in building.spaces]
        for (la, a), (lb, b) in zip(sorted(stops), sorted(stops)[1:]):
            stairs[a].append((b, lb - la))
            stairs[b].append((a, la - lb))
    below: dict[str, list[tuple[str, float]]] = {s: [] for s in building.spaces}
    above: dict[str, list[tuple[str, float]]] = {s: [] for s in building.spaces}
    for space_id in building.spaces:
        level = building.space_level(space_id)
        if level - 1 not in building.floors_by_level:
            continue
        outline = building.polygon(space_id)
        if outline.area <= 0:
            continue
        for other in building.spaces_by_floor[building.floors_by_level[level - 1]["id"]]:
            overlap = building.polygon(other["id"]).intersection(outline).area
            if overlap / outline.area >= MIN_OVERLAP or overlap / max(building.polygon(other["id"]).area, 1e-9) >= 0.5:
                share = min(1.0, overlap / outline.area)
                below[space_id].append((other["id"], share))
                above[other["id"]].append((space_id, overlap / max(building.polygon(other["id"]).area, 1e-9)))
    return {"doors": doors, "walls": walls, "stairs": stairs, "below": below, "above": above}


def _edges(building: Building, hazard: str, space_id: str, peak: float = 1.0):
    """(neighbour, delay minutes, factor, via) for one space; `peak` is how strongly it is hit."""
    s = _structure(building)
    if hazard == "fire":
        for other, walk in s["doors"][space_id]:
            rate = FIRE_M_PER_MIN.get(building.spaces[other]["type"], 6.0)
            # Stairwells are behind self-closing fire doors: smoke gets in, the fire itself much later.
            factor = FIRE["door"][1] * (STAIR_DOOR_FACTOR if building.spaces[other]["type"] == "stair" and building.spaces[space_id]["type"] != "stair" else 1.0)
            yield other, FIRE["door"][0] + walk / rate, factor, "door"
        for other in s["walls"][space_id]:
            yield other, *FIRE["wall"], "wall"
        for other, rise in s["stairs"][space_id]:
            # Smoke and fire climb stairwells fast; going down is much slower.
            yield other, FIRE["stairs"][0] * abs(rise) * (1 if rise > 0 else 3), FIRE["stairs"][1] * (1 if rise > 0 else 0.5), "stairs"
        for other, share in s["above"][space_id]:
            if share >= 0.3:
                yield other, *FIRE["above"], "above"
    else:
        for other, walk in s["doors"][space_id]:
            yield other, WATER["door"][0] + walk / WATER_M_PER_MIN, WATER["door"][1], "door"
        for other in s["walls"][space_id]:
            yield other, *WATER["wall"], "wall"
        # Water only comes through the ceiling below where it actually pools, not from a damp corridor.
        for other, share in s["below"][space_id] if peak >= POOL_LEVEL else []:
            yield other, WATER["below"][0], WATER["below"][1] * min(1.0, 0.4 + share), "below"
        for other, rise in s["stairs"][space_id]:
            if rise < 0:  # water only runs down
                yield other, WATER["stairs"][0], WATER["stairs"][1], "stairs"


def _dijkstra(building: Building, hazard: str, origin: str, minutes: float) -> dict[str, dict]:
    reached = {origin: {"arrival_min": 0.0, "peak": 1.0, "via": "origin", "from": None}}
    queue = [(0.0, -1.0, origin)]
    while queue:
        arrival, negative_peak, space_id = heapq.heappop(queue)
        if reached[space_id]["arrival_min"] < arrival - 1e-9:
            continue
        peak = -negative_peak
        for other, delay, factor, via in _edges(building, hazard, space_id, peak):
            time, level = arrival + delay, peak * factor
            if time > minutes or level < MIN_LEVEL[hazard]:
                continue
            known = reached.get(other)
            if known is None or time < known["arrival_min"] - 1e-9:
                reached[other] = {"arrival_min": time, "peak": max(level, known["peak"] if known else 0), "via": via, "from": space_id}
                heapq.heappush(queue, (time, -level, other))
    return reached


# ---------- electrical ----------

@lru_cache(maxsize=16)
def circuits(building: Building) -> dict[str, str]:
    """Circuit per space: the electrical panel on its floor that is the shortest walk away; a floor without panels
    is one circuit (the data rarely has panels, so this is the honest fallback)."""
    result: dict[str, str] = {}
    panels: dict[str, list[dict]] = {}
    for asset in building.assets.values():
        if asset["type"] == "electrical_panel" and asset["space_id"] in building.spaces:
            panels.setdefault(asset["floor_id"], []).append(asset)
    graph = building.graph()
    import networkx as nx  # local: only needed here

    for floor_id, spaces in building.spaces_by_floor.items():
        floor_panels = panels.get(floor_id, [])
        if not floor_panels:
            result.update(_zones(building, floor_id, spaces))
            continue
        distances = {p["id"]: nx.single_source_dijkstra_path_length(graph, p["space_id"], weight="weight") if p["space_id"] in graph else {} for p in floor_panels}
        for space in spaces:
            best = min(floor_panels, key=lambda p: (distances[p["id"]].get(space["id"], math.inf), math.dist(_anchor(building, space["id"]), p["position"])))
            result[space["id"]] = f"panel:{best['id']}"
    return result


ZONE_M2 = 800.0


def _zones(building: Building, floor_id: str, spaces: list[dict]) -> dict[str, str]:
    """No panels on this floor: estimate sub-distribution zones of about ZONE_M2 each (farthest-point seeds, then
    nearest seed by centroid), so one fault doesn't black out a whole factory floor."""
    centres = {s["id"]: _anchor(building, s["id"]) for s in spaces}
    area = sum(building.polygon(s["id"]).area for s in spaces)
    k = max(1, min(len(spaces), round(area / ZONE_M2)))
    mean = (sum(c[0] for c in centres.values()) / len(centres), sum(c[1] for c in centres.values()) / len(centres))
    seeds = [min(centres, key=lambda i: math.dist(centres[i], mean))]
    while len(seeds) < k:
        seeds.append(max(centres, key=lambda i: min(math.dist(centres[i], centres[s]) for s in seeds)))
    return {i: f"zone:{floor_id}:{min(range(k), key=lambda j: math.dist(centres[i], centres[seeds[j]]))}" for i in centres}


def circuit_spaces(building: Building, circuit: str) -> list[str]:
    return [space_id for space_id, c in circuits(building).items() if c == circuit]


def _circuit_outage(building: Building, origin: str, at: float, via: str) -> dict[str, dict]:
    circuit = circuits(building)[origin]
    out = {}
    for space_id in circuit_spaces(building, circuit):
        if building.spaces[space_id]["type"] in ("stair", "outdoor"):
            continue
        out[space_id] = {"arrival_min": at + (0.0 if space_id == origin else 0.3), "peak": 1.0 if space_id == origin else 0.8, "via": via, "from": origin if space_id != origin else None, "circuit": circuit}
    out.setdefault(origin, {"arrival_min": at, "peak": 1.0, "via": via, "from": None, "circuit": circuit})
    return out


def _cascades(building: Building, hazard: str, reached: dict[str, dict], minutes: float) -> list[dict]:
    """Water on powered equipment, or fire at an electrical panel, cuts the power of that circuit."""
    if hazard == "electrical":
        return []
    found, seen = [], set()
    for space_id, value in sorted(reached.items(), key=lambda item: item[1]["arrival_min"]):
        if value["peak"] < 0.4:
            continue
        # Kitchen and bathroom appliances are made for water; servers, panels and machines are not.
        risky = [a for a in building.assets.values() if a["space_id"] == space_id and (a["type"] == "electrical_panel" if hazard == "fire" else
                 (a["type"] in POWERED_ASSETS or a["category"] == "machine") and a["type"] not in WET_ASSETS | {"fridge", "stove"})]
        if not risky:
            continue
        circuit = circuits(building)[space_id]
        if circuit in seen:
            continue
        seen.add(circuit)
        at = value["arrival_min"] + (2.0 if hazard == "water" else 1.0)
        if at > minutes:
            continue
        found.append({
            "space_id": space_id, "circuit": circuit, "at_min": round(at, 2), "asset_ids": [a["id"] for a in risky][:12],
            "reason": f"{'Water' if hazard == 'water' else 'Fire'} reaches {', '.join(sorted({a['type'].replace('_', ' ') for a in risky})[:4])}",
            "outage": _circuit_outage(building, space_id, at, "cascade"),
        })
    return found


def door_node(opening_id: str) -> str:
    return DOOR_PREFIX + opening_id
