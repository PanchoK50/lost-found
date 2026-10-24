"""Deterministic final "Answer:" lines. benchmark/score.py reads only the last such line, so the line holds
exactly one number, or the room label (before any other room) plus the area for largest_room."""

from lostfound.core.building import Building


def number(value: float) -> str:
    """Plain decimal without thousands separators; trailing zeros dropped (40.19, 5, 214.7)."""
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def room_label(building: Building, space_id: str) -> str:
    """The room's ref when it is unique in the building, else its full name."""
    space = building.spaces[space_id]
    ref = (space.get("ref") or "").strip()
    if ref and sum(1 for other in building.spaces.values() if (other.get("ref") or "").strip() == ref) == 1:
        return ref
    return space["name"]


def answer_line(building: Building, kind: str, result: dict) -> str:
    if kind == "largest_room":
        return f"Answer: {room_label(building, result['space_id'])}, {number(result['area_m2'])} m²"
    if kind == "room_stacked":
        return f"Answer: {room_label(building, result['space_id'])}"
    value = {
        "floor_area_total": "total_m2",
        "errand": "total_m",
        "straight_line_3d": "distance_m",
        "route": "length_m",
    }.get(kind, "count")
    return f"Answer: {number(result[value])}"
