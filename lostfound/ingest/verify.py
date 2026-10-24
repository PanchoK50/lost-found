"""Verification layer for imported buildings: flag what is probably wrong or unknown, so the agent can fix it or
ask the user, instead of trusting every inferred fact.

Layers (free, deterministic; a Claude vision critic for flagged rooms can sit on top):
- L0 rules: topology and consistency (doors join spaces, rooms reachable, labels unique, stairs line up);
- L1 confidence: low room-type probability, room area implausible for its type, door widths with no prior,
  weak scale or registration evidence.
Each issue: {"field", "id", "severity", "message", "question"} where field is one of
room_type | ref | door | connector | registration | scale | topology."""

import networkx as nx
from shapely.geometry import Polygon

from lostfound.ingest import infer

ROOM_TYPE_CONFIDENCE = 0.8
DOOR_WIDTH_RELIABILITY = 0.9
LABEL_DISTANCE_M = 1.0
SCALE_CONFIDENCE = 0.3


def verify(building: dict) -> list[dict]:
    issues: list[dict] = []
    spaces = {space["id"]: space for space in building["spaces"]}
    report = building.get("ingest_report", {})
    area_range = infer.model().get("area_range", {})

    def add(field, element_id, severity, message, question=None):
        issues.append({"field": field, "id": element_id, "severity": severity, "message": message, "question": question})

    # ---------- rooms ----------
    refs_per_floor: dict[tuple, list[str]] = {}
    for space in spaces.values():
        label = space["ref"] or space["id"]
        if space["type"] in ("room", "hall"):
            confidence = space.get("room_type_confidence", 1.0)
            if confidence < ROOM_TYPE_CONFIDENCE:
                options = [space["room_type"], *space.get("room_type_alternatives", [])]
                add("room_type", space["id"], "medium", f"room type of {label} uncertain ({confidence:.0%})",
                    f"Is {label} a {' or a '.join(o.replace('_', ' ') for o in options[:3])}?")
            low, high = area_range.get(space["room_type"], (0, float("inf")))
            area = Polygon(space["polygon"]).area
            if not low <= area <= high:
                add("room_type", space["id"], "medium",
                    f"{label}: {area:.1f} m² is unusual for a {space['room_type'].replace('_', ' ')} ({low}–{high} m²)",
                    f"What is room {label} used for?")
            if not space["ref"]:
                add("ref", space["id"], "low", f"room {space['id']} has no room number on the plan",
                    "This room has no number on the plan. What should it be called?")
        if space["ref"]:
            refs_per_floor.setdefault((space["floor_id"], space["ref"]), []).append(space["id"])
        if space.get("label_distance_m", 0) > LABEL_DISTANCE_M:
            add("ref", space["id"], "medium", f"label {space['ref']} sits {space['label_distance_m']} m from the room centre",
                f"Does the label {space['ref']} belong to this room?")
    for (floor_id, ref), ids in refs_per_floor.items():
        if len(ids) > 1:
            for space_id in ids:
                add("ref", space_id, "high", f"room number {ref} used {len(ids)} times on {floor_id}", f"Which room is {ref}?")

    # ---------- doors and reachability ----------
    door_counts = {space_id: 0 for space_id in spaces}
    for opening in building["openings"]:
        for space_id in opening["space_ids"]:
            if space_id in door_counts:
                door_counts[space_id] += 1
        if opening.get("width_reliability", 0.0) < DOOR_WIDTH_RELIABILITY:
            add("door", opening["id"], "low",
                f"width of {opening['id']} is an estimate ({opening['width_m']} m, holds for {opening.get('width_reliability', 0):.0%} of such doors)",
                "How wide is this door?")
    for space_id, count in door_counts.items():
        if count == 0 and spaces[space_id]["type"] in ("room", "hall", "corridor"):
            add("topology", space_id, "high", f"{spaces[space_id]['ref'] or space_id} has no door",
                f"How do you get into {spaces[space_id]['ref'] or 'this room'}?")
    graph = nx.Graph()
    graph.add_nodes_from(spaces)
    for opening in building["openings"]:
        first, second = opening["space_ids"]
        graph.add_edge(first, second)
    for connector in building["vertical_connectors"]:
        for first, second in zip(connector["space_ids"], connector["space_ids"][1:]):
            graph.add_edge(first, second)
    if "outside" in graph:
        reachable = nx.node_connected_component(graph, "outside")
        for space_id, space in spaces.items():
            if space_id not in reachable and space["type"] in ("room", "hall") and door_counts[space_id] > 0:
                add("topology", space_id, "high", f"{space['ref'] or space_id} cannot be reached from any entrance",
                    f"Is there a door or stair missing on the way to {space['ref'] or 'this room'}?")

    # ---------- floors ----------
    levels = sorted(floor["level"] for floor in building["floors"])
    linked_floors = {floor_id for connector in building["vertical_connectors"] for floor_id in connector["floor_ids"]}
    if len(levels) > 1:
        for floor in building["floors"]:
            if floor["id"] not in linked_floors:
                add("connector", floor["id"], "high", f"{floor['name']} has no stairs or lift linking it to other floors",
                    f"Where are the stairs or lifts on {floor['name']}?")
        for space in spaces.values():
            if space["type"] in ("stair", "lift") and not any(space["id"] in c["space_ids"] for c in building["vertical_connectors"]):
                add("connector", space["id"], "medium", f"{space['type']} {space['ref'] or space['id']} links to no other floor",
                    f"Which floors does {space['ref'] or 'this ' + space['type']} serve?")
    for level, registration in report.get("registration", {}).items():
        if registration.get("matched_cores", 0) < 1:
            add("registration", f"level {level}", "high", f"level {level} could not be aligned via stairs/lifts",
                f"Which stair on level {level} sits above/below which stair on level {registration['to_level']}?")
    for level, scale in report.get("scales", {}).items():
        if scale["confidence"] < SCALE_CONFIDENCE:
            add("scale", f"level {level}", "high", f"scale of level {level} weakly supported ({scale['confidence']:.0%} of furniture matched)",
                f"How wide is one known room on level {level}, in metres?")
    return issues


def summary(issues: list[dict]) -> dict:
    by_field: dict[str, int] = {}
    for issue in issues:
        by_field[issue["field"]] = by_field.get(issue["field"], 0) + 1
    return {"issues": len(issues), "by_field": by_field, "high": sum(1 for i in issues if i["severity"] == "high")}
