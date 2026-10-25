"""Building readiness: weak spots a building manager should fix before anything happens, each tied to rooms.

Distances follow the German workplace rules where they give a number: fire extinguishers within 20 m walking
(ASR A2.2), escape routes at most 35 m to an exit or a stairwell (ASR A2.3). Defibrillator reach is a common
guideline (about 150 m, i.e. there and back in under three minutes)."""

import networkx as nx

from lostfound.core.building import OUTSIDE, Building
from lostfound.hazards.model import TECHNICAL_ROOM_TYPES, is_wet_room, occupancy
from lostfound.hazards.spread import _structure

EXTINGUISHER_M = 20.0
ESCAPE_M = 35.0
AED_M = 150.0
MIN_CUT_OFF_PEOPLE = 10
MAX_SINGLE = 5
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def readiness(building: Building) -> dict:
    findings: list[dict] = []
    graph = building.graph()
    rooms = [s for s in building.spaces.values() if s["type"] in ("room", "hall")]

    def reach_from(space_ids: set[str]) -> dict[str, float]:
        sources = [s for s in space_ids if s in graph]
        return nx.multi_source_dijkstra_path_length(graph, sources, weight="weight") if sources else {}

    # Fire extinguishers.
    with_extinguisher = {a["space_id"] for a in building.assets.values() if a["type"] == "fire_extinguisher"}
    distances = reach_from(with_extinguisher)
    far = [s for s in rooms if distances.get(s["id"], float("inf")) > EXTINGUISHER_M]
    if not with_extinguisher:
        findings.append(_finding("high", "fire", "No fire extinguishers on the plan", f"None of the {len(rooms)} rooms has an extinguisher within reach.", [s["id"] for s in rooms][:200], "ASR A2.2"))
    elif far:
        findings.append(_finding("high" if len(far) > len(rooms) * 0.2 else "medium", "fire", f"{len(far)} rooms more than {EXTINGUISHER_M:.0f} m from an extinguisher",
                                 "Walking distance from the room to the nearest fire extinguisher is above the limit.", [s["id"] for s in far][:200], "ASR A2.2"))

    # Escape distance: to an exit or into a stairwell (a protected route).
    stair_spaces = {s["id"] for s in building.spaces.values() if s["type"] == "stair"}
    exits = [n for n in building.entrance_nodes() if n in graph]
    escape = nx.multi_source_dijkstra_path_length(graph, exits + [s for s in stair_spaces if s in graph], weight="weight") if exits or stair_spaces else {}
    long_escape = [s for s in rooms if escape.get(s["id"], float("inf")) > ESCAPE_M]
    if long_escape:
        findings.append(_finding("high" if any(escape.get(s["id"], float("inf")) == float("inf") for s in long_escape) else "medium", "fire",
                                 f"{len(long_escape)} rooms with an escape route over {ESCAPE_M:.0f} m",
                                 "Walking distance to the nearest exit or stairwell is above the limit.", [s["id"] for s in long_escape][:200], "ASR A2.3"))

    # Single points of failure: losing one space cuts people off from every exit.
    spaces_graph = nx.Graph()
    spaces_graph.add_nodes_from(building.spaces)
    spaces_graph.add_node(OUTSIDE)
    for opening in building.openings.values():
        a, b = opening["space_ids"]
        spaces_graph.add_edge(a, b)
    for connector in building.connectors.values():
        stops = [s for s in connector["space_ids"] if s in building.spaces]
        for a, b in zip(stops, stops[1:]):
            spaces_graph.add_edge(a, b)
    single: list[tuple[int, str, list[str]]] = []
    for cut in nx.articulation_points(spaces_graph):
        if cut == OUTSIDE:
            continue
        rest = spaces_graph.copy()
        rest.remove_node(cut)
        stranded = [s for s in rest.nodes if s != OUTSIDE and not nx.has_path(rest, s, OUTSIDE)] if OUTSIDE in rest else []
        people = sum(occupancy(building, s) for s in stranded)
        if people >= MIN_CUT_OFF_PEOPLE:
            single.append((people, cut, stranded))
    # The worst few as their own findings (dead-end corridors are common; listing all of them is noise).
    single.sort(key=lambda item: -item[0])
    for people, cut, stranded in single[:MAX_SINGLE]:
        findings.append(_finding("high" if people >= 50 else "medium", "fire", f"Only one way out through {building.spaces[cut]['name']}",
                                 f"If {building.label(cut)} is blocked, {len(stranded)} spaces with about {people} people have no way out.", [cut, *stranded][:200], "single escape route", focus=cut))
    if len(single) > MAX_SINGLE:
        rest = single[MAX_SINGLE:]
        findings.append(_finding("low", "fire", f"{len(rest)} more spaces are the only way out for someone",
                                 f"About {sum(p for p, _, _ in rest)} people in total depend on one corridor or stairwell.", [cut for _, cut, _ in rest][:200], "single escape route"))

    # Water above sensitive rooms.
    s = _structure(building)
    for space in building.spaces.values():
        sensitive = space["room_type"] in TECHNICAL_ROOM_TYPES or any(a["space_id"] == space["id"] and a["type"] in ("server_rack", "electrical_panel") for a in building.assets.values())
        if not sensitive:
            continue
        wet_above = [other for other, share in s["above"][space["id"]] if share >= 0.1 and is_wet_room(building, other)]
        if wet_above:
            findings.append(_finding("high", "water", f"{space['name']} sits below {building.spaces[wet_above[0]]['name']}",
                                     "A leak upstairs runs straight onto servers or electrical equipment. Add a leak sensor and a drip tray, or move the equipment.",
                                     [space["id"], *wet_above], "water over electrics", focus=space["id"]))

    # Leak sensors where water does the most harm (we assume none are fitted: plans don't show them).
    wet = [sp["id"] for sp in rooms if is_wet_room(building, sp["id"])]
    if wet:
        findings.append(_finding("low", "water", f"{len(wet)} wet rooms without leak sensors on the plan", "Bathrooms, kitchens and rooms with water connections. A leak sensor in each raises the alarm in minutes instead of hours.", wet[:200], "leak detection"))

    # Defibrillators.
    aeds = {a["space_id"] for a in building.assets.values() if a["type"] == "defibrillator"}
    people_total = sum(occupancy(building, sp["id"]) for sp in rooms)
    if not aeds and people_total >= 50:
        findings.append(_finding("medium", "safety", "No defibrillator on the plan", f"About {people_total} people work here.", [], "AED"))
    elif aeds:
        reach = reach_from(aeds)
        far_aed = [sp["id"] for sp in rooms if reach.get(sp["id"], float("inf")) > AED_M]
        if far_aed:
            findings.append(_finding("low", "safety", f"{len(far_aed)} rooms more than {AED_M:.0f} m from a defibrillator", "Getting it there and back takes more than about three minutes.", far_aed[:200], "AED"))

    # Electrical panels.
    floors_with_panel = {a["floor_id"] for a in building.assets.values() if a["type"] == "electrical_panel"}
    missing = [f for f in building.floors.values() if f["id"] not in floors_with_panel]
    if missing:
        findings.append(_finding("low", "electrical", f"{len(missing)} floors without an electrical panel on the plan",
                                 "Circuits are estimated as zones. Add the distribution boards to see exactly what a fault switches off.", [], "electrical documentation",
                                 floor_ids=[f["id"] for f in missing]))

    findings.sort(key=lambda f: (SEVERITY_ORDER[f["severity"]], -len(f["space_ids"])))
    for index, finding in enumerate(findings, start=1):
        finding["id"] = f"r{index}"
    count = lambda sev: sum(1 for f in findings if f["severity"] == sev)  # noqa: E731
    score = max(0, 100 - min(45, 12 * count("high")) - min(30, 5 * count("medium")) - min(10, 2 * count("low")))
    return {"building_id": building.id, "score": score, "findings": findings,
            "counts": {sev: sum(1 for f in findings if f["severity"] == sev) for sev in SEVERITY_ORDER}}


def _finding(severity: str, category: str, title: str, detail: str, space_ids: list[str], rule: str, focus: str | None = None, floor_ids: list[str] | None = None) -> dict:
    # floor_ids: for findings about whole floors (nothing on them), so the map can still show which ones.
    return {"severity": severity, "category": category, "title": title, "detail": detail, "space_ids": space_ids, "floor_ids": floor_ids or [], "rule": rule, "focus": focus or (space_ids[0] if space_ids else None)}
