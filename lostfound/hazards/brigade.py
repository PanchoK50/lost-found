"""Fire brigade edition (docs/BRIGADE_BRIEF.md): briefing, people who can't get out alone, crew routes.

Everything is derived from building.json, the asset list and the fire model; demo people are labelled demo."""

from functools import lru_cache

import networkx as nx

from lostfound.core import directions, geometry
from lostfound.core.building import DOOR_PREFIX, OUTSIDE, Building, MapError
from lostfound.hazards import evacuation, spread
from lostfound.hazards.model import occupancy

FIRE_LEVEL, SMOKE_LEVEL, CLOSE_LEVEL = 0.5, 0.12, 0.5
STRETCHER_M = 1.1
HAZARD_TYPES = {
    "fume_hood": "lab_chemicals", "chemical_cabinet": "lab_chemicals",
    "server_rack": "server_batteries", "ups_unit": "server_batteries", "ups": "server_batteries",
    "electrical_panel": "main_power",
}
HAZARD_TEXT = {"lab_chemicals": "Lab with chemicals", "server_batteries": "Server room, batteries", "main_power": "Main power"}


@lru_cache(maxsize=32)
def _sim(building: Building, origin: str, horizon: float) -> dict:
    return spread.simulate(building, "fire", origin, horizon)


def _levels(result: dict, t: float) -> dict[str, float]:
    out: dict[str, float] = {}
    for e in result["spaces"]:
        if e["kind"] == "fire":
            out[e["space_id"]] = max(out.get(e["space_id"], 0.0), spread.level_at(e, t))
    return out


def _space(b: Building, sid: str | None) -> dict | None:
    if not sid or sid not in b.spaces:
        return None
    s = b.spaces[sid]
    return {"space_id": sid, "name": s["name"], "floor": b.floor_name(s["floor_id"]), "floor_id": s["floor_id"]}


def _status(level: float) -> str:
    return "fire" if level >= FIRE_LEVEL else "smoke" if level >= SMOKE_LEVEL else "clear"


def _stairwells(b: Building, levels: dict[str, float]) -> list[dict]:
    out = []
    for c in b.connectors.values():
        if c["kind"] == "lift":
            continue
        level = max((levels.get(s, 0.0) for s in c["space_ids"]), default=0.0)
        out.append({"connector_id": c["id"], "name": c["name"], "level": round(level, 2), "status": _status(level)})
    return out


STAIR_CLOSE_LEVEL = 0.12  # crews avoid a stairwell with smoke in it if another one is clear


def closures_at(b: Building, result: dict, t: float, keep: set[str], fire_floor: str | None = None) -> list[str]:
    """What a crew avoids at t: burning spaces (≥ 0.5) except on the fire floor itself (that is where the attack goes)
    and except the targets; stairwells with smoke, as long as a less smoky one stays open; all lifts."""
    levels = _levels(result, t)
    closed = [s for s, lv in levels.items() if lv >= CLOSE_LEVEL and s not in keep and b.spaces[s]["floor_id"] != fire_floor
              and b.spaces[s]["type"] != "stair"]
    closed += [c["id"] for c in b.connectors.values() if c["kind"] == "lift"]
    stairs = [(max((levels.get(s, 0) for s in c["space_ids"]), default=0), c["id"]) for c in b.connectors.values() if c["kind"] != "lift"]
    if stairs:
        cleanest = min(stairs)[0]
        closed += [cid for lv, cid in stairs if lv >= STAIR_CLOSE_LEVEL and lv > cleanest + 0.02]
    return closed


def reachable_closures(b: Building, result: dict, t: float, keep: set[str], fire_floor: str | None, target: str) -> list[str]:
    """closures_at, then reopen the least smoky closed stairwells one by one until some entrance reaches the target
    (a smoky stairwell is better than none)."""
    levels = _levels(result, t)
    closed = closures_at(b, result, t, keep, fire_floor)
    stairs = sorted((c for c in closed if c in b.connectors and b.connectors[c]["kind"] != "lift"),
                    key=lambda c: max((levels.get(s, 0) for s in b.connectors[c]["space_ids"]), default=0))
    entries = [next(s for s in o["space_ids"] if s != OUTSIDE) for o in b.openings.values() if OUTSIDE in o["space_ids"]]

    def ok(cl: list[str]) -> bool:
        with b.temporarily_closed(*cl):
            graph = b.graph()
            return target in graph and any(e in graph and nx.has_path(graph, e, target) for e in entries)

    while not ok(closed) and stairs:
        closed.remove(stairs.pop(0))
    return closed


def _route(b: Building, start: str, target: str, closed: list[str], min_width: float | None = None) -> dict | None:
    with b.temporarily_closed(*closed):
        try:
            d = directions.route_details(b, start, target, False, [], min_width)
        except MapError:
            return None
        graph = b.graph(False, min_width)
    nodes = [n for n in d["nodes"]]
    doors = [b.openings[n] for n in nodes if n in b.openings]
    narrow = min(doors, key=lambda o: o["width_m"]) if doors else None
    stairs = []
    for a, c in zip(d["space_path"], d["space_path"][1:]):
        for conn in b.connectors.values():
            if a in conn["space_ids"] and c in conn["space_ids"] and conn["name"] not in stairs:
                stairs.append(conn["name"])
    _ = graph
    return {"space_path": [s for s in d["space_path"] if s in b.spaces], "element_path": [n for n in nodes if n not in b.spaces],
            "length_m": d["length_m"], "steps": d["steps"], "polylines": d["polylines"], "used_stairwell": stairs,
            "narrowest_door": {"opening_id": narrow["id"], "width_m": narrow["width_m"]} if narrow else None}


def entrances(b: Building, result: dict, origin: str, t_arrival: float) -> list[dict]:
    closed = reachable_closures(b, result, t_arrival, {origin}, b.spaces[origin]["floor_id"], origin)
    out = []
    for o in b.openings.values():
        if OUTSIDE not in o["space_ids"]:
            continue
        inside = next(s for s in o["space_ids"] if s != OUTSIDE)
        r = _route(b, inside, origin, closed)
        out.append({"opening_id": o["id"], "into_space": b.spaces[inside]["name"], "into_space_id": inside, "floor_id": o["floor_id"],
                    "position": o["position"], "width_m": o["width_m"], "step_free": o["step_free"], "recommended": False,
                    "distance_m": r["length_m"] if r else None, "stairwell": (r or {}).get("used_stairwell", [])})
    usable = [e for e in out if e["distance_m"] is not None]
    if usable:
        best = min(usable, key=lambda e: e["distance_m"])
        best["recommended"] = True
        levels = _levels(result, t_arrival)
        stair = next((c for c in b.connectors.values() if c["name"] in best["stairwell"]), None)
        state = _status(max((levels.get(x, 0) for x in stair["space_ids"]), default=0)) if stair else None
        best["reason"] = (f"Shortest way to the fire at arrival: {best['distance_m']:.0f} m"
                          + (f", via {stair['name']} ({'smoke-free' if state == 'clear' else 'least smoke'})" if stair else ""))
    return out


def briefing(b: Building, origin: str, t_now: float = 4.0, eta: float = 8.0, horizon: float = 30.0) -> dict:
    if origin not in b.spaces:
        raise MapError(f"Unknown room {origin}.")
    result = _sim(b, origin, horizon)
    t_arr = t_now + eta
    ev = evacuation.evacuate(b, result, 3.0)
    walkers = ev["walkers"]
    total = sum(w["people"] for w in walkers)

    def inside(t: float) -> int:
        return total - sum(w["people"] for w in walkers if not w.get("cut_off") and (w.get("out_min") or 1e9) <= t)

    def on_fire(t: float) -> int:
        return sum(1 for s, lv in _levels(result, t).items() if lv >= FIRE_LEVEL and b.spaces[s]["type"] in ("room", "hall"))

    def smoke(t: float) -> int:
        return sum(1 for lv in _levels(result, t).values() if SMOKE_LEVEL <= lv < FIRE_LEVEL)

    lv_arr = _levels(result, t_arr)
    floors_arr = sorted({b.spaces[s]["floor_id"] for s, lv in lv_arr.items() if lv >= SMOKE_LEVEL}, key=b.level)
    above = below = None
    for direction in ("above", "below"):
        try:
            sid, _share = geometry.stacked(b, origin, direction)
            if direction == "above":
                above = _space(b, sid)
            else:
                below = _space(b, sid)
        except (MapError, KeyError):
            pass
    walls = [_space(b, sid) for sid, _len in geometry.shared_walls(b, origin)]
    arrival = {e["space_id"]: e["arrival_min"] for e in result["spaces"] if e["kind"] == "fire"}
    lvl0 = b.space_level(origin)
    hazards: dict[str, dict] = {}
    for a in b.assets.values():
        kind = HAZARD_TYPES.get(a["type"])
        if not kind or a["space_id"] not in b.spaces:
            continue
        sid = a["space_id"]
        near = abs(b.space_level(sid) - lvl0) <= 1 or (arrival.get(sid, 1e9) <= t_arr + 15)
        if not near:
            continue
        h = hazards.setdefault(f"{sid}:{kind}", {**_space(b, sid), "kind": kind, "label": HAZARD_TEXT[kind], "assets": [],
                                                  "fire_arrival_min": round(arrival[sid], 1) if sid in arrival else None, "source": "from asset list"})
        h["assets"].append(a["type"].replace("_", " "))
    hazard_list = sorted(hazards.values(), key=lambda h: (h["fire_arrival_min"] is None, h["fire_arrival_min"] or 0, h["floor"]))
    for h in hazard_list:
        h["assets"] = sorted(set(h["assets"]))
    nxt, seen_floors = [], {b.spaces[origin]["floor_id"]}
    hazard_spaces = {h["space_id"]: h for h in hazard_list}
    for e in sorted((e for e in result["spaces"] if e["kind"] == "fire" and e["peak"] >= FIRE_LEVEL), key=lambda e: e["arrival_min"]):
        sid = e["space_id"]
        fl = b.spaces[sid]["floor_id"]
        if fl not in seen_floors:
            seen_floors.add(fl)
            names = [h["name"] for h in hazard_list if h["floor_id"] == fl][:2]
            nxt.append({"t": round(e["arrival_min"], 1), "text": f"Fire reaches {b.floor_name(fl)}" + (f" ({', '.join(names)})" if names else ""), "space_ids": [sid]})
        elif sid in hazard_spaces:
            nxt.append({"t": round(e["arrival_min"], 1), "text": f"Fire reaches {hazard_spaces[sid]['name']} ({hazard_spaces[sid]['label'].lower()})", "space_ids": [sid]})
    for st in b.connectors.values():
        if st["kind"] == "lift":
            continue
        times = [arrival[s] for s in st["space_ids"] if s in arrival]
        if times:
            nxt.append({"t": round(min(times), 1), "text": f"Smoke in {st['name']}", "space_ids": [s for s in st["space_ids"] if s in arrival][:1]})
    nxt.sort(key=lambda n: n["t"])
    return {
        "building_id": b.id, "origin": _space(b, origin), "t_now": t_now, "eta": eta, "t_arrival": t_arr, "horizon": horizon,
        "facts": {"rooms_on_fire_now": on_fire(t_now), "rooms_on_fire_at_arrival": on_fire(t_arr), "people_inside_now": inside(t_now),
                  "floors_affected": len(floors_arr)},
        "timeline": [{"t": t, "rooms_fire": on_fire(t), "rooms_smoke": smoke(t), "people_inside": inside(t)} for t in range(0, int(horizon) + 1)],
        "stairwells": [{**s_arr, "status_at_now": s_now["status"], "status_at_arrival": s_arr["status"]}
                       for s_now, s_arr in zip(_stairwells(b, _levels(result, t_now)), _stairwells(b, lv_arr))],
        "above_below": {"above": above, "below": below, "source": "from plan geometry"},
        "wall_neighbours": [w for w in walls if w],
        "hazards": hazard_list,
        "entrances": entrances(b, result, origin, t_arr),
        "next_consequences": [n for n in nxt if n["t"] > 0][:8],
    }


DEMO_PEOPLE = {
    "proc-campus-test-005": [
        {"name": "Lea", "room": "Office 4.12", "need": "wheelchair"},
        {"name": "Mia", "room": None, "floor_level": 3, "need": None},
        {"name": "Jonas", "room": None, "floor_level": 1, "need": None},
    ],
}


def demo_people(b: Building, origin: str) -> list[dict]:
    """The scenario's demo people; for other buildings one wheelchair user in an office above the fire (demo)."""
    people = []
    for p in DEMO_PEOPLE.get(b.id, []):
        sid = next((s["id"] for s in b.spaces.values() if s["name"] == p["room"]), None) if p["room"] else \
            next((s["id"] for s in b.spaces.values() if s["type"] == "room" and b.space_level(s["id"]) == p["floor_level"] and s["id"] != origin), None)
        if sid:
            people.append({"name": p["name"], "space_id": sid, "need": p["need"]})
    if not people:
        lvl = b.space_level(origin)
        upper = sorted((s for s in b.spaces.values() if s["type"] == "room" and b.space_level(s["id"]) > lvl), key=lambda s: (b.space_level(s["id"]), s["name"]))
        same = sorted((s for s in b.spaces.values() if s["type"] == "room" and s["id"] != origin and b.space_level(s["id"]) == lvl), key=lambda s: s["name"])
        pick = (upper or same)[:1]
        people = [{"name": "Lea", "space_id": pick[0]["id"], "need": "wheelchair"}] if pick else []
    return people


def people(b: Building, origin: str, t: float = 4.0) -> dict:
    result = _sim(b, origin, 30.0)
    ev = evacuation.evacuate(b, result, 3.0)
    by_floor: dict[str, int] = {}
    for w in ev["walkers"]:
        if w.get("cut_off") or (w.get("out_min") or 1e9) > t:
            fl = b.spaces[w["space_id"]]["floor_id"]
            by_floor[fl] = by_floor.get(fl, 0) + w["people"]
    burning = [s for s, lv in _levels(result, t).items() if lv >= CLOSE_LEVEL]
    lifts = [c["id"] for c in b.connectors.values() if c["kind"] == "lift"]
    with b.temporarily_closed(*burning, *lifts):
        graph = b.graph(step_free=True)
        exits = [n for n in b.entrance_nodes() if n in graph]
        reach = nx.multi_source_dijkstra_path_length(graph, exits, weight="weight") if exits else {}
    cannot = []
    for p in demo_people(b, origin):
        sid = p["space_id"]
        if p["need"] == "wheelchair" and sid not in reach:
            cannot.append({**_space(b, sid), "person": p["name"], "reason": "wheelchair · lifts off · no step-free way out", "demo": True})
        elif sid in burning:
            cannot.append({**_space(b, sid), "person": p["name"], "reason": "room on fire", "demo": True})
    for c in ev["cut_off"]:
        cannot.append({"person": f"{c['people']} people", "space_id": c["space_id"], "name": c["name"], "floor": c["floor"],
                       "floor_id": b.spaces[c["space_id"]]["floor_id"], "reason": "cut off by the fire", "demo": False})
    return {"inside": [{"floor": b.floor_name(f), "floor_id": f, "count": n} for f, n in sorted(by_floor.items(), key=lambda x: -b.level(x[0]))],
            "total_inside": sum(by_floor.values()), "cannot_self_evacuate": cannot,
            "demo_people": [{**_space(b, p["space_id"]), "person": p["name"], "need": p["need"]} for p in demo_people(b, origin)], "informed": 0}


def routes(b: Building, origin: str, t_arrival: float, targets: list[dict], start_opening: str | None = None) -> dict:
    result = _sim(b, origin, 30.0)
    ents = entrances(b, result, origin, t_arrival)
    start = next((e for e in ents if e["opening_id"] == start_opening), None) or next((e for e in ents if e["recommended"]), None)
    if start is None:
        raise MapError("No entrance can reach the fire.")
    levels = _levels(result, t_arrival)
    out = []
    for target in targets:
        sid = target["space_id"]
        closed = reachable_closures(b, result, t_arrival, {sid, origin, start["into_space_id"]}, b.spaces[origin]["floor_id"], sid)
        width = target.get("min_width_m")
        r = _route(b, start["into_space_id"], sid, closed, width) or _route(b, start["into_space_id"], sid, closed)
        avoided = [{"connector_or_space": b.connectors[c]["name"], "connector_id": c,
                    "reason": f"{_status(max((levels.get(s, 0) for s in b.connectors[c]['space_ids']), default=0))} at arrival"}
                   for c in closed if c in b.connectors and b.connectors[c]["kind"] != "lift"]
        avoided += [{"connector_or_space": c["name"], "connector_id": c["id"], "reason": "lift: never used in a fire"} for c in b.connectors.values() if c["kind"] == "lift"]
        entry = {"label": target.get("label", ""), "target": _space(b, sid), "start": {k: start[k] for k in ("opening_id", "into_space", "position", "floor_id")}, "avoided": avoided}
        if r is None:
            out.append({**entry, "reachable": False})
            continue
        # Stretcher check only for rescue routes (a min width was asked for).
        ok = None if not width else (r["narrowest_door"] is None or r["narrowest_door"]["width_m"] + 1e-9 >= width)
        out.append({**entry, **r, "reachable": True, "stretcher_ok": ok, "stretcher_m": width})
    return {"start": start, "routes": out}


__all__ = ["briefing", "people", "routes", "entrances", "DOOR_PREFIX"]
