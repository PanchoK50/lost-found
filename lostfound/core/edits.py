"""Building edits made by conversation, as self-contained records that replay on a building.json.

The same records live in Supabase (`building_edits`), so every new session (and the web viewer, see
website/src/lib/buildings/edits.ts) loads base plan + edits: a closed lift, a new door or a moved machine
stays for everyone. Plan-import corrections use the same mechanism (rename, room type, door width, rescale).

Actions: close / reopen {element_id}; add_door {opening}; move_asset {asset_id, to_space_id, position};
rename_room {space_id, ref, name}; set_room_type {space_id, room_type}; set_door_width {opening_id, width_m};
rescale {factor}; set_floor_height {floor_id, height_m}."""

import copy


def apply_edits(data: dict, edits: list[dict]) -> tuple[dict, set[str]]:
    """A copy of the building with the edits applied, plus the set of closed element ids."""
    building = copy.deepcopy(data)
    closed: set[str] = set()
    for edit in edits:
        apply_edit(building, edit, closed)
    return building, closed


def apply_edit(building: dict, edit: dict, closed: set[str]) -> None:
    action = edit.get("action")
    spaces = {s["id"]: s for s in building["spaces"]}
    match action:
        case "close":
            closed.add(edit["element_id"])
        case "reopen":
            closed.discard(edit["element_id"])
        case "add_door":
            opening = edit["opening"]
            if not any(o["id"] == opening["id"] for o in building["openings"]) and all(
                s == "outside" or s in spaces for s in opening["space_ids"]
            ):
                building["openings"].append(copy.deepcopy(opening))
        case "move_asset":
            for asset in building["assets"]:
                if asset["id"] == edit["asset_id"] and edit["to_space_id"] in spaces:
                    asset.update(
                        space_id=edit["to_space_id"],
                        floor_id=spaces[edit["to_space_id"]]["floor_id"],
                        position=list(edit["position"]),
                    )
        case "rename_room":
            if edit["space_id"] in spaces:
                spaces[edit["space_id"]].update(ref=edit.get("ref", ""), name=edit["name"])
        case "set_room_type":
            if edit["space_id"] in spaces:
                spaces[edit["space_id"]]["room_type"] = edit["room_type"]
        case "set_door_width":
            for opening in building["openings"]:
                if opening["id"] == edit["opening_id"]:
                    opening["width_m"] = float(edit["width_m"])
        case "rescale":
            _rescale(building, float(edit["factor"]))
        case "set_floor_height":
            set_floor_height(building, edit["floor_id"], float(edit["height_m"]))


def _rescale(building: dict, factor: float) -> None:
    """Multiply every plan coordinate and size by factor (around the origin)."""
    scale = lambda point: [round(point[0] * factor, 3), round(point[1] * factor, 3)]  # noqa: E731
    for space in building["spaces"]:
        space["polygon"] = [scale(p) for p in space["polygon"]]
    for opening in building["openings"]:
        opening["position"] = scale(opening["position"])
        opening["width_m"] = round(opening["width_m"] * factor, 3)
    for asset in building["assets"]:
        asset["position"] = scale(asset["position"])
        footprint = asset.get("footprint")
        if footprint:
            footprint["width_m"] = round(footprint["width_m"] * factor, 3)
            footprint["depth_m"] = round(footprint["depth_m"] * factor, 3)


def set_floor_height(building: dict, floor_id: str, height_m: float) -> None:
    """Set one floor's height. Floors above move with it when they sat directly on top of it (a factory hall that
    reaches through the floor above moves nothing); a basement grows downwards, taking the floors below with it."""
    floors = sorted(building["floors"], key=lambda floor: floor["level"])
    index = next((i for i, floor in enumerate(floors) if floor["id"] == floor_id), None)
    if index is None:
        return
    target = floors[index]
    old, new = float(target["height_m"]), round(float(height_m), 3)
    target["height_m"] = new
    delta = new - old
    if target["level"] >= 0:
        above = floors[index + 1] if index + 1 < len(floors) else None
        if above is not None and abs(above["elevation_m"] - target["elevation_m"] - old) <= 0.01:
            for floor in floors[index + 1:]:
                floor["elevation_m"] = round(floor["elevation_m"] + delta, 3)
    else:
        for floor in floors[: index + 1]:
            floor["elevation_m"] = round(floor["elevation_m"] - delta, 3)
