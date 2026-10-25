"""Hazard kinds, what each one threatens, and the virtual sensors any building gets."""

from lostfound.core.building import Building

HAZARDS = ("fire", "water", "electrical")
HAZARD_NAMES = {"fire": "Fire", "water": "Water damage", "electrical": "Electrical fault"}

WET_ROOM_TYPES = frozenset({"bathroom", "toilet", "shower", "kitchen", "locker_room", "canteen"})
WET_ASSETS = frozenset({"sink", "toilet", "shower", "bathtub", "dishwasher", "washing_machine", "kitchen_counter", "boiler", "water_dispenser", "coffee_machine"})
TECHNICAL_ROOM_TYPES = frozenset({"server_room", "technical_room"})
POWERED_ASSETS = frozenset({"server_rack", "electrical_panel", "boiler", "vending_machine", "fridge", "washing_machine", "dishwasher", "printer", "multifunction_printer", "3d_printer", "laser_cutter"})

# How much each asset type matters when it is hit (0–5); machines and equipment default by category.
CRITICAL = {
    "server_rack": 5, "electrical_panel": 5, "boiler": 4, "defibrillator": 4, "fire_extinguisher": 3,
    "3d_printer": 3, "laser_cutter": 3, "fume_hood": 3, "chemical_cabinet": 4, "high_bay_rack": 3, "pallet_rack": 3,
}
CATEGORY_CRITICAL = {"machine": 4, "equipment": 3, "fixture": 1, "furniture": 1}
SEAT_ASSETS = frozenset({"chair", "office_chair", "dining_chair", "armchair", "stool", "lecture_seating_row", "bench", "sofa"})


def asset_weight(asset: dict, hazard: str) -> int:
    weight = CRITICAL.get(asset["type"], CATEGORY_CRITICAL.get(asset["category"], 1))
    if hazard in ("water", "electrical") and asset["type"] in POWERED_ASSETS | {"server_rack"}:
        weight = max(weight, 4)
    return weight


def is_wet_room(building: Building, space_id: str) -> bool:
    space = building.spaces[space_id]
    return space["room_type"] in WET_ROOM_TYPES or any(a["space_id"] == space_id and a["type"] in WET_ASSETS for a in building.assets.values())


def occupancy(building: Building, space_id: str) -> int:
    """Rough number of people a room holds in a working day: its seats, else one per 10 m² of room."""
    space = building.spaces[space_id]
    seats = sum(1 for a in building.assets.values() if a["space_id"] == space_id and a["type"] in SEAT_ASSETS)
    rows = sum(1 for a in building.assets.values() if a["space_id"] == space_id and a["type"] == "lecture_seating_row")
    seats += rows * 7
    if seats:
        return seats
    if space["type"] in ("room", "hall"):
        return max(0, round(building.polygon(space_id).area / 10))
    return 0


def sensors(building: Building) -> list[dict]:
    """Virtual sensors: a smoke detector in every room and hall, leak sensors where water is or where it does harm,
    and a power monitor on every electrical panel."""
    found = []
    for space in building.spaces.values():
        if space["type"] in ("room", "hall", "corridor"):
            found.append({"id": f"smoke:{space['id']}", "kind": "smoke", "hazard": "fire", "space_id": space["id"], "name": f"Smoke detector · {space['name']}"})
        if space["type"] in ("room", "hall") and (is_wet_room(building, space["id"]) or space["room_type"] in TECHNICAL_ROOM_TYPES):
            found.append({"id": f"leak:{space['id']}", "kind": "leak", "hazard": "water", "space_id": space["id"], "name": f"Leak sensor · {space['name']}"})
    for asset in building.assets.values():
        if asset["type"] == "electrical_panel":
            found.append({"id": f"power:{asset['id']}", "kind": "power", "hazard": "electrical", "space_id": asset["space_id"], "asset_id": asset["id"], "name": f"Power monitor · {asset['name']}"})
    return found
