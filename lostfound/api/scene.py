"""Build the web viewer's scene (website/src/lib/chat/contract.ts) from the agent's tool results.

The viewer never computes answers: for every tool call the backend says what the answer card shows, which
spaces to colour (primary = the answer, secondary = the reference room, muted = context), where the camera
goes, and which routes, links, markers and closures to draw. Routes are sent as space paths per leg; the web
API draws the polyline and turn-by-turn steps from them."""

from lostfound.core import directions, geometry, reach
from lostfound.core.building import Building, MapError

MAX_MUTED = 40


def _floors_focus(floor_ids: list[str], spacing: str | None = None) -> dict:
    unique = list(dict.fromkeys(floor_ids))
    if len(unique) == 1:
        return {"mode": "floor", "floorId": unique[0]}
    if len(unique) <= 3:
        focus = {"mode": "stack", "floorIds": unique}
        if spacing:
            focus["spacing"] = spacing
        return focus
    return {"mode": "building"}


def _floor(b: Building, space_id: str) -> str:
    return b.spaces[space_id]["floor_id"]


def _point(b: Building, space_id: str) -> dict:
    centre = b.polygon(space_id).centroid
    return {"floorId": _floor(b, space_id), "position": [round(centre.x, 3), round(centre.y, 3)]}


def _highlight(space_id: str, tone: str, label: str | None = None) -> dict:
    item = {"spaceId": space_id, "tone": tone}
    if label:
        item["label"] = label
    return item


def _m2(value: float) -> str:
    return f"{value:.2f} m²"


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def show_space(b: Building, space_id: str) -> dict:
    space = b.spaces[space_id]
    return {
        "kind": "show",
        "answer": {"title": space["name"], "value": b.floor_name(space["floor_id"]), "detail": f"{_m2(geometry.area(b, space_id))}"},
        "scene": {"focus": {"mode": "floor", "floorId": space["floor_id"]}, "highlights": [_highlight(space_id, "primary", space["name"])]},
    }


def largest_room(b: Building, floor_id: str, room_type: str, result: dict) -> dict:
    winner = result["space_id"]
    others = [s["id"] for s in b.rooms_on_floor(floor_id, room_type) if s["id"] != winner]
    return {
        "kind": "largest_room",
        "answer": {
            "title": result["name"],
            "value": _m2(result["area_m2"]),
            "detail": f"Largest of {len(others) + 1} · {b.floor_name(floor_id)}",
        },
        "scene": {
            "focus": {"mode": "floor", "floorId": floor_id},
            "highlights": [
                _highlight(winner, "primary", f"{result['name']} · {_m2(result['area_m2'])}"),
                *[_highlight(space_id, "muted") for space_id in others[:MAX_MUTED]],
            ],
        },
    }


def floor_area_total(b: Building, floor_id: str, room_type: str, result: dict) -> dict:
    rooms = [s["id"] for s in b.rooms_on_floor(floor_id, room_type)]
    label = room_type.replace("_", " ")
    return {
        "kind": "floor_area_total",
        "answer": {
            "title": f"{_plural(len(rooms), label)} on {b.floor_name(floor_id)}",
            "value": _m2(result["total_m2"]),
            "detail": "Summed floor area",
        },
        "scene": {"focus": {"mode": "floor", "floorId": floor_id}, "highlights": [_highlight(r, "primary") for r in rooms]},
    }


def _route_legs(
    b: Building,
    stops: list[str],
    step_free: bool,
    closed: list[str],
    min_width: float | None = None,
    forklift: bool = False,
    bays: bool | None = None,
) -> list[dict]:
    legs = []
    with b.temporarily_closed(*closed):
        for start, end in zip(stops, stops[1:]):
            try:
                details = directions.route_details(b, start, end, step_free, None, min_width, forklift, bays)
            except MapError:
                continue
            legs.append(details)
    return legs


def route(
    b: Building,
    stops: list[str],
    step_free: bool,
    closed: list[str],
    result: dict,
    min_width: float | None = None,
    forklift: bool = False,
) -> dict:
    kind = "route_with_closure" if closed else "route_step_free" if step_free else "route"
    if len(stops) > 2:
        kind = "tour"
    start, end = stops[0], stops[-1]
    if not result.get("reachable", True):
        return {
            "kind": kind,
            "answer": {"title": f"{b.spaces[start]['name']} → {b.spaces[end]['name']}", "value": "No route", "detail": "with the current constraints"},
            "scene": {
                "focus": _floors_focus([_floor(b, start), _floor(b, end)]),
                "highlights": [_highlight(start, "secondary", "Start"), _highlight(end, "primary", "Destination")],
                "closed": closed,
            },
        }
    legs = _route_legs(b, stops, step_free, closed, min_width, forklift)
    passed = [s for leg in legs for s in leg["space_path"] if s in b.spaces and s not in stops]
    floor_ids = [_floor(b, s) for s in stops] + [run["floor_id"] for leg in legs for run in leg["polylines"] if len(run["points"]) >= 2]
    minutes = max(1, round(result["length_m"] / 1.3 / 60))
    notes = (
        [f"about {minutes} min"]
        + (["forklift"] if forklift else ["step-free"] if step_free else [])
        + ([f"doors ≥ {min_width:g} m"] if min_width and not forklift else [])
        + ([f"{len(closed)} closed"] if closed else [])
    )
    return {
        "kind": kind,
        "answer": {
            "title": " → ".join(b.spaces[s]["ref"] or b.spaces[s]["name"] for s in stops),
            "value": f"{result['length_m']:.0f} m",
            "detail": " · ".join(notes),
        },
        "scene": {
            "focus": _floors_focus(floor_ids),
            "highlights": [
                *[
                    _highlight(s, "secondary" if i == 0 else "primary", f"Start · {b.spaces[s]['name']}" if i == 0 else b.spaces[s]["name"])
                    for i, s in enumerate(stops)
                ],
                *[_highlight(s, "muted") for s in dict.fromkeys(passed)][:MAX_MUTED],
            ],
            "routes": [{"spacePath": [s for s in leg["space_path"] if s in b.spaces]} for leg in legs],
            "closed": closed,
        },
    }


def errand(b: Building, start: str, step_free: bool, result: dict) -> dict:
    pickup, target = result["pickup"]["space_id"], result["target"]["space_id"]
    legs = _route_legs(b, [start, pickup, target], step_free, [], bays=False)  # the errand number is kit-model
    floor_ids = [_floor(b, s) for s in (start, pickup, target)]
    return {
        "kind": "errand",
        "answer": {
            "title": f"{b.spaces[start]['ref'] or b.spaces[start]['name']} → pick up → {result['target']['ref'] or result['target']['name']}",
            "value": f"{result['total_m']:.2f} m",
            "detail": f"{result['first_leg_m']:.1f} m to {result['pickup']['name']} · {result['second_leg_m']:.1f} m to {result['target']['name']}",
        },
        "scene": {
            "focus": _floors_focus(floor_ids),
            "highlights": [
                _highlight(start, "secondary", f"Start · {b.spaces[start]['name']}"),
                _highlight(pickup, "primary", f"Pick up · {result['pickup']['name']}"),
                _highlight(target, "primary", result["target"]["name"]),
            ],
            "routes": [{"spacePath": [s for s in leg["space_path"] if s in b.spaces]} for leg in legs],
        },
    }


def wide_delivery(b: Building, start: str, floor_id: str, min_width: float, result: dict) -> dict:
    reached = reach.reachable_spaces(b, start, step_free=True, min_width=min_width)
    rooms = reach.rooms_reached(b, reached, floor_id)
    blocking = [
        o
        for o in b.openings.values()
        if o["floor_id"] == floor_id
        and o["width_m"] + 1e-9 < min_width
        and any(s in reached for s in o["space_ids"])
        and any(s in b.spaces and s not in reached for s in o["space_ids"])
    ]
    return {
        "kind": "wide_delivery_count",
        "answer": {
            "title": f"Rooms a {min_width} m load can reach on {b.floor_name(floor_id)}",
            "value": str(result["count"]),
            "detail": f"From {b.spaces[start]['name']} · no steps · doors ≥ {min_width} m",
        },
        "scene": {
            "focus": _floors_focus([floor_id, _floor(b, start)]),
            "highlights": [*[_highlight(r, "primary") for r in rooms], _highlight(start, "secondary", f"Entry · {b.spaces[start]['name']}")],
            "markers": [
                {"floorId": o["floor_id"], "position": o["position"], "label": f"{o['width_m']} m door", "tone": "muted"} for o in blocking[:30]
            ],
        },
    }


def step_free_reach(b: Building, start: str, floor_id: str, closed: list[str], result: dict) -> dict:
    with b.temporarily_closed(*closed):
        reached = reach.reachable_spaces(b, start, step_free=True)
    rooms = reach.rooms_reached(b, reached, floor_id)
    return {
        "kind": "step_free_reachable_count",
        "answer": {
            "title": f"Step-free rooms on {b.floor_name(floor_id)}",
            "value": str(result["count"]),
            "detail": f"From {b.spaces[start]['name']}" + (f" · {len(closed)} closed" if closed else ""),
        },
        "scene": {
            "focus": _floors_focus([floor_id, _floor(b, start)]),
            "highlights": [*[_highlight(r, "primary") for r in rooms], _highlight(start, "secondary", f"Entry · {b.spaces[start]['name']}")],
            "closed": closed,
        },
    }


def room_stacked(b: Building, source: str, direction: str, result: dict) -> dict:
    other = result["space_id"]
    return {
        "kind": "room_stacked",
        "answer": {"title": result["name"], "value": result["floor"], "detail": f"{direction.capitalize()} {b.spaces[source]['name']}"},
        "scene": {
            "focus": {"mode": "stack", "floorIds": [_floor(b, other), _floor(b, source)]},
            "highlights": [_highlight(other, "primary", result["name"]), _highlight(source, "secondary", b.spaces[source]["name"])],
        },
    }


def shared_walls(b: Building, room: str, result: dict) -> dict:
    return {
        "kind": "shared_walls_count",
        "answer": {
            "title": f"Rooms sharing a wall with {b.spaces[room]['name']}",
            "value": str(result["count"]),
            "detail": f"{b.floor_name(_floor(b, room))} · at least 1 m of shared wall",
        },
        "scene": {
            "focus": {"mode": "floor", "floorId": _floor(b, room)},
            "highlights": [
                _highlight(room, "secondary", b.spaces[room]["name"]),
                *[_highlight(n["space_id"], "primary", f"{n['shared_m']:.1f} m") for n in result["neighbours"]],
            ],
        },
    }


def straight_line(b: Building, first: str, second: str, result: dict) -> dict:
    same_floor = _floor(b, first) == _floor(b, second)
    value = f"{result['distance_m']:.2f} m"
    label = lambda s: b.spaces[s]["ref"] or b.spaces[s]["name"]  # noqa: E731
    return {
        "kind": "straight_line_3d",
        "answer": {"title": f"{label(first)} ↔ {label(second)}", "value": value, "detail": "Centre to centre"},
        "scene": {
            "focus": {"mode": "floor", "floorId": _floor(b, first)} if same_floor else _floors_focus([_floor(b, first), _floor(b, second)], "true"),
            "highlights": [_highlight(first, "primary", label(first)), _highlight(second, "primary", label(second))],
            "links": [{"from": _point(b, first), "to": _point(b, second), "label": value, "breakdown": not same_floor}],
        },
    }


def what_if_door(b: Building, first: str, second: str, floor_id: str, result: dict) -> dict:
    door_floor = _floor(b, first)
    midpoint = geometry.shared_wall_midpoint(b, first, second)
    before = reach.exit_distances(b)
    door = {
        "id": "what-if-door", "floor_id": door_floor, "space_ids": [first, second], "kind": "door",
        "position": [midpoint.x, midpoint.y], "width_m": 0.9, "step_free": True, "synthetic": True,
    }
    with b.temporary_opening(door):
        after = reach.exit_distances(b)
    improved = [
        s["id"] for s in b.spaces_by_floor[floor_id]
        if s["type"] == "room" and s["id"] in after and before.get(s["id"], float("inf")) - after[s["id"]] > 1.0
    ]
    return {
        "kind": "what_if_door",
        "answer": {
            "title": f"Rooms on {b.floor_name(floor_id)} with a shorter way out",
            "value": str(result["count"]),
            "detail": f"New door: {b.spaces[first]['ref'] or b.spaces[first]['name']} ↔ {b.spaces[second]['ref'] or b.spaces[second]['name']} · saving > 1 m",
        },
        "scene": {
            "focus": _floors_focus([door_floor, floor_id]),
            "highlights": [*[_highlight(r, "primary") for r in improved], _highlight(first, "secondary"), _highlight(second, "secondary")],
            "markers": [{"floorId": door_floor, "position": [round(midpoint.x, 3), round(midpoint.y, 3)], "label": "New door"}],
        },
    }


def locate(b: Building, matches: list[dict]) -> dict:
    assets = [b.assets[m["asset_id"]] for m in matches if m["asset_id"] in b.assets]
    if not assets:
        return {"kind": "locate", "answer": {"title": "Nothing found"}, "scene": {"focus": {"mode": "building"}}}
    first = assets[0]
    return {
        "kind": "locate",
        "answer": {
            "title": first["name"] if len(assets) == 1 else f"{len(assets)} found",
            "value": b.spaces[first["space_id"]]["name"],
            "detail": b.floor_name(first["floor_id"]),
        },
        "scene": {
            "focus": _floors_focus([a["floor_id"] for a in assets]),
            "highlights": [_highlight(s, "secondary") for s in dict.fromkeys(a["space_id"] for a in assets)][:MAX_MUTED],
            "markers": [
                {"floorId": a["floor_id"], "position": a["position"], "label": f"{a['name']} · {b.spaces[a['space_id']]['name']}"} for a in assets[:25]
            ],
            "assets": [a["id"] for a in assets[:50]],
        },
    }


def count_assets(b: Building, asset_type: str, floor_id: str, result: dict) -> dict:
    assets = [a for a in b.assets.values() if a["type"] == asset_type and a["floor_id"] == floor_id]
    return {
        "kind": "count",
        "answer": {"title": f"{asset_type.replace('_', ' ')} on {b.floor_name(floor_id)}", "value": str(result["count"])},
        "scene": {"focus": {"mode": "floor", "floorId": floor_id}, "assets": [a["id"] for a in assets]},
    }


def edit(b: Building, edit_record: dict) -> dict:
    action = edit_record["action"]
    scene: dict = {"focus": {"mode": "building"}, "closed": sorted(b.closed)}
    title = action.replace("_", " ").capitalize()
    if action in ("close", "reopen"):
        element = edit_record["element_id"]
        floor_ids = (
            b.connectors[element]["floor_ids"] if element in b.connectors
            else [b.openings[element]["floor_id"]] if element in b.openings
            else [b.spaces[element]["floor_id"]] if element in b.spaces else []
        )
        if floor_ids:
            scene["focus"] = _floors_focus(floor_ids)
        if element in b.spaces:
            scene["highlights"] = [_highlight(element, "secondary", "Closed" if action == "close" else "Reopened")]
        name = (b.connectors.get(element) or b.spaces.get(element) or {}).get("name", element)
        title = f"{name} {'closed' if action == 'close' else 'reopened'}"
    elif action == "add_door":
        opening = edit_record["opening"]
        scene["focus"] = {"mode": "floor", "floorId": opening["floor_id"]}
        scene["highlights"] = [_highlight(s, "secondary") for s in opening["space_ids"] if s in b.spaces]
        scene["markers"] = [{"floorId": opening["floor_id"], "position": opening["position"], "label": "New door"}]
        title = "Door added"
    elif action == "move_asset":
        asset = b.assets[edit_record["asset_id"]]
        scene["focus"] = {"mode": "floor", "floorId": asset["floor_id"]}
        scene["assets"] = [asset["id"]]
        scene["markers"] = [{"floorId": asset["floor_id"], "position": asset["position"], "label": asset["name"]}]
        scene["highlights"] = [_highlight(asset["space_id"], "primary", b.spaces[asset["space_id"]]["name"])]
        title = f"{asset['name']} moved"
    elif action in ("rename_room", "set_room_type") and edit_record["space_id"] in b.spaces:
        space = b.spaces[edit_record["space_id"]]
        scene["focus"] = {"mode": "floor", "floorId": space["floor_id"]}
        scene["highlights"] = [_highlight(space["id"], "primary", space["name"])]
        title = f"{space['name']} updated" if action == "rename_room" else f"{space['name']}: {space['room_type'].replace('_', ' ')}"
    elif action == "set_door_width" and edit_record["opening_id"] in b.openings:
        opening = b.openings[edit_record["opening_id"]]
        scene["focus"] = {"mode": "floor", "floorId": opening["floor_id"]}
        scene["markers"] = [{"floorId": opening["floor_id"], "position": opening["position"], "label": f"{opening['width_m']} m door"}]
        title = f"Door width {opening['width_m']} m"
    elif action == "rescale":
        title = f"Plan rescaled ×{edit_record['factor']:.3f}"
    return {"kind": "show", "answer": {"title": title, "detail": "Saved for everyone"}, "scene": scene}
