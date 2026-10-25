"""What a spread means for the building: rooms hit (and how they relate to the origin), people and assets at risk."""

from lostfound.core.building import Building
from lostfound.hazards.model import HAZARD_NAMES, asset_weight, occupancy
from lostfound.hazards.spread import _structure

RELATION_ORDER = {"origin": 0, "below": 1, "next door": 2, "above": 3, "same floor": 4, "other floor": 5}


def relation(building: Building, origin: str, space_id: str) -> str:
    if space_id == origin:
        return "origin"
    diff = building.space_level(space_id) - building.space_level(origin)
    if diff == -1:
        return "below"
    if diff == 1:
        return "above"
    if diff:
        return "other floor"
    s = _structure(building)
    if space_id in s["walls"][origin] or any(other == space_id for other, _ in s["doors"][origin]):
        return "next door"
    return "same floor"


def impact(building: Building, result: dict, at_min: float | None = None) -> dict:
    """Affected spaces with relation, people and assets; `at_min` limits to what has been reached by then."""
    origin = result["origin"]
    horizon = result["minutes"] if at_min is None else at_min
    assets_by_space: dict[str, list[dict]] = {}
    for asset in building.assets.values():
        assets_by_space.setdefault(asset["space_id"], []).append(asset)
    rooms, at_risk, people = [], [], 0
    seen_people: set[str] = set()
    for entry in result["spaces"]:
        if entry["arrival_min"] > horizon:
            continue
        space_id = entry["space_id"]
        space = building.spaces[space_id]
        hazard = entry["kind"]
        here = sorted(assets_by_space.get(space_id, []), key=lambda a: -asset_weight(a, hazard))
        critical = [a for a in here if asset_weight(a, hazard) >= 4]
        count = occupancy(building, space_id)
        if space_id not in seen_people:
            people += count
            seen_people.add(space_id)
        rooms.append({
            "space_id": space_id, "name": space["name"], "floor": building.floor_name(space["floor_id"]), "floor_id": space["floor_id"],
            "type": space["type"], "room_type": space["room_type"], "kind": hazard, "relation": relation(building, origin, space_id),
            "arrival_min": entry["arrival_min"], "peak": entry["peak"], "via": entry["via"], "people": count,
            "critical_assets": [{"asset_id": a["id"], "name": a["name"], "type": a["type"]} for a in critical[:6]],
            "assets": len(here),
        })
        for asset in critical:
            at_risk.append({"asset_id": asset["id"], "name": asset["name"], "type": asset["type"], "space_id": space_id, "room": space["name"],
                            "kind": hazard, "arrival_min": entry["arrival_min"], "weight": asset_weight(asset, hazard)})
    rooms.sort(key=lambda r: (RELATION_ORDER[r["relation"]], r["arrival_min"]))
    at_risk.sort(key=lambda a: (-a["weight"], a["arrival_min"]))
    floors = sorted({r["floor"] for r in rooms}, key=lambda name: name)
    origin_space = building.spaces[origin]
    return {
        "hazard": result["hazard"], "hazard_name": HAZARD_NAMES[result["hazard"]],
        "origin": {"space_id": origin, "name": origin_space["name"], "floor": building.floor_name(origin_space["floor_id"]), "floor_id": origin_space["floor_id"]},
        "rooms": rooms, "assets_at_risk": at_risk[:40], "people_at_risk": people, "floors": floors,
        "by_relation": {rel: sum(1 for r in rooms if r["relation"] == rel) for rel in RELATION_ORDER},
        "power_outage_spaces": sum(1 for r in rooms if r["kind"] == "electrical"),
        "cascades": [{k: v for k, v in c.items() if k != "outage"} for c in result["cascades"]],
        "at_min": horizon,
    }
