"""One function per question kind. Inputs are resolved ids; outputs are plain dicts with the answer and the
facts needed to explain it. Every function is checked against the labelled answers in tests/."""

from shapely.geometry import Point

from lostfound.core import geometry, reach
from lostfound.core.building import ROOMISH_TYPES, Building, MapError

WHAT_IF_DOOR_WIDTH_M = 0.9
WHAT_IF_MIN_GAIN_M = 1.0


def _space_summary(building: Building, space_id: str) -> dict:
    space = building.spaces[space_id]
    return {
        "space_id": space_id,
        "name": space["name"],
        "ref": space.get("ref") or "",
        "floor": building.floor_name(space["floor_id"]),
    }


def _rooms_of_type(building: Building, floor_id: str, room_type: str) -> list[dict]:
    rooms = building.rooms_on_floor(floor_id, room_type)
    if not rooms:
        raise MapError(f"No {room_type.replace('_', ' ')} on {building.floor_name(floor_id)}.")
    return rooms


# ---------- plan facts ----------


def largest_room(building: Building, floor_id: str, room_type: str) -> dict:
    ranked = sorted(
        _rooms_of_type(building, floor_id, room_type),
        key=lambda space: geometry.area(building, space["id"]),
        reverse=True,
    )
    winner = ranked[0]["id"]
    return {
        **_space_summary(building, winner),
        "area_m2": round(geometry.area(building, winner), 2),
        "runners_up": [
            {**_space_summary(building, space["id"]), "area_m2": round(geometry.area(building, space["id"]), 2)}
            for space in ranked[1:4]
        ],
    }


def floor_area_total(building: Building, floor_id: str, room_type: str) -> dict:
    rooms = _rooms_of_type(building, floor_id, room_type)
    areas = {space["id"]: geometry.area(building, space["id"]) for space in rooms}
    return {
        "total_m2": round(sum(areas.values()), 2),
        "room_count": len(rooms),
        "floor": building.floor_name(floor_id),
        "room_type": room_type,
    }


def errand(
    building: Building, start: str, asset_type: str, floor_id: str, room_type: str, step_free: bool = False
) -> dict:
    """Walk to the nearest room holding an asset of this type, then carry it to the largest room of a type."""
    holders = {asset["space_id"] for asset in building.assets.values() if asset["type"] == asset_type}
    if not holders:
        raise MapError(f"No {asset_type.replace('_', ' ')} anywhere in the building.")
    from_start = building.distances_from(start, step_free)
    reachable = [space_id for space_id in holders if space_id in from_start]
    if not reachable:
        raise MapError(f"No reachable room holds a {asset_type.replace('_', ' ')}.")
    pickup = min(reachable, key=lambda space_id: from_start[space_id])
    target = largest_room(building, floor_id, room_type)["space_id"]
    from_pickup = building.distances_from(pickup, step_free)
    if target not in from_pickup:
        raise MapError(f"No route from {building.label(pickup)} to {building.label(target)}.")
    first_leg, second_leg = from_start[pickup], from_pickup[target]
    return {
        "total_m": round(first_leg + second_leg, 2),
        "start": start,
        "pickup": _space_summary(building, pickup),
        "first_leg_m": round(first_leg, 2),
        "target": _space_summary(building, target),
        "second_leg_m": round(second_leg, 2),
        "step_free": step_free,
    }


def wide_delivery_count(building: Building, start: str, floor_id: str, min_width: float) -> dict:
    """Rooms on a floor a load of this width reaches: no stairs or steps, every door at least min_width."""
    reached = reach.reachable_spaces(building, start, step_free=True, min_width=min_width)
    rooms = reach.rooms_reached(building, reached, floor_id)
    return {"count": len(rooms), "floor": building.floor_name(floor_id), "min_width_m": min_width}


def step_free_reachable_count(building: Building, start: str, floor_id: str, closed: list[str]) -> dict:
    with building.temporarily_closed(*closed):
        reached = reach.reachable_spaces(building, start, step_free=True)
    rooms = reach.rooms_reached(building, reached, floor_id)
    return {"count": len(rooms), "floor": building.floor_name(floor_id), "closed": closed}


# ---------- spatial reasoning ----------


def room_stacked(building: Building, space_id: str, direction: str) -> dict:
    other, share = geometry.stacked(building, space_id, direction)
    return {**_space_summary(building, other), "direction": direction, "overlap_share": round(share, 3)}


def shared_walls_count(building: Building, space_id: str) -> dict:
    neighbours = geometry.shared_walls(building, space_id)
    return {
        "count": len(neighbours),
        "neighbours": [
            {**_space_summary(building, other), "shared_m": round(length, 2)} for other, length in neighbours
        ],
    }


def straight_line_3d(building: Building, first: str, second: str) -> dict:
    return {
        "distance_m": round(geometry.distance_3d(building, first, second), 2),
        "first": _space_summary(building, first),
        "second": _space_summary(building, second),
    }


def what_if_door(building: Building, first: str, second: str, floor_id: str) -> dict:
    """Rooms on floor_id whose walk to the nearest entrance gets shorter by more than 1 m with a new door."""
    midpoint: Point = geometry.shared_wall_midpoint(building, first, second)
    before = reach.exit_distances(building)
    door = {
        "id": "what-if-door",
        "floor_id": building.spaces[first]["floor_id"],
        "space_ids": [first, second],
        "kind": "door",
        "position": [midpoint.x, midpoint.y],
        "width_m": WHAT_IF_DOOR_WIDTH_M,
        "step_free": True,
        "synthetic": True,
    }
    with building.temporary_opening(door):
        after = reach.exit_distances(building)
    improved = [
        space["id"]
        for space in building.spaces_by_floor[floor_id]
        if space["type"] in ROOMISH_TYPES
        and space["id"] in after
        and before.get(space["id"], float("inf")) - after[space["id"]] > WHAT_IF_MIN_GAIN_M
    ]
    return {
        "count": len(improved),
        "floor": building.floor_name(floor_id),
        "door_position": [round(midpoint.x, 3), round(midpoint.y, 3)],
    }


# ---------- warm-up kinds: locate, count, route, tour ----------


def locate(building: Building, asset_type: str) -> dict:
    matches = [asset for asset in building.assets.values() if asset["type"] == asset_type]
    return {
        "matches": [
            {
                "asset_id": asset["id"],
                "name": asset["name"],
                **_space_summary(building, asset["space_id"]),
                "position": asset["position"],
            }
            for asset in matches
        ]
    }


def count_assets(building: Building, asset_type: str, floor_id: str) -> dict:
    count = sum(
        1 for asset in building.assets.values() if asset["type"] == asset_type and asset["floor_id"] == floor_id
    )
    return {"count": count, "asset_type": asset_type, "floor": building.floor_name(floor_id)}


def route(
    building: Building,
    start: str,
    destination: str,
    step_free: bool = False,
    closed: list[str] | None = None,
    via: list[str] | None = None,
) -> dict:
    with building.temporarily_closed(*(closed or [])):
        try:
            result = building.route(start, destination, step_free, via)
        except MapError as error:
            return {"reachable": False, "reason": str(error)}
    return {
        "reachable": True,
        "length_m": result.length_m,
        "space_path": result.space_path,
        "steps": result.steps,
        "step_free": step_free,
        "closed": closed or [],
    }


SKILLS = {
    "largest_room": largest_room,
    "floor_area_total": floor_area_total,
    "errand": errand,
    "wide_delivery_count": wide_delivery_count,
    "step_free_reachable_count": step_free_reachable_count,
    "room_stacked": room_stacked,
    "shared_walls_count": shared_walls_count,
    "straight_line_3d": straight_line_3d,
    "what_if_door": what_if_door,
    "locate": locate,
    "count": count_assets,
    "route": route,
}
