"""Storey heights for buildings imported from plans: plans don't show heights, so each floor gets the standard of
its kind of building, and the agent asks the user to confirm.

Measured on every kit building: a floor's elevation is its level times the storey height (basements below 0), and
the storey height depends on the kind of building:
- factories (production, assembly, warehouse halls): 3.5 m storeys; the ground floor holds the halls, 8.0 m high;
- campus and institutional buildings (lecture halls, seminar rooms, labs, libraries, makerspaces): 3.8 m;
- homes and offices: 3.0 m."""

from shapely.geometry import Polygon

STYLES = {
    # style: (storey height = elevation step, ground floor height)
    "factory": (3.5, 8.0),
    "campus": (3.8, 3.8),
    "standard": (3.0, 3.0),
}
FACTORY_HALL_AREA_M2 = 150.0  # a drawn hall this large is a production hall (kit factories: 170 m² and up)
CAMPUS_ROOM_TYPES = frozenset({"lecture_hall", "seminar_room", "lab", "library", "makerspace"})


def style(building: dict) -> str:
    spaces = building["spaces"]
    if any(space["room_type"].endswith("_zone") for space in spaces) or any(
        space["type"] == "hall" and Polygon(space["polygon"]).area >= FACTORY_HALL_AREA_M2 for space in spaces
    ):
        return "factory"
    if any(space["room_type"] in CAMPUS_ROOM_TYPES for space in spaces):
        return "campus"
    return "standard"


def apply(building: dict) -> dict:
    """Set every floor's elevation_m and height_m from the building's style; returns what was assumed."""
    kind = style(building)
    step, ground = STYLES[kind]
    for floor in building["floors"]:
        floor["elevation_m"] = round(floor["level"] * step, 2)
        floor["height_m"] = ground if floor["level"] == 0 else step
    return {"style": kind, "storey_height_m": step, "ground_floor_height_m": ground}

