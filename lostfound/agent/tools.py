"""Tools the Claude agent can call, bound to one building.

Two families:
- typed tools: one per question kind plus search/route/edit, taking room names or ids (resolved here, in
  code) and returning the computed facts plus a ready-made `answer_line`;
- run_python: Python against our verified library, for questions no typed tool covers.
Geometry always happens in code; the model only picks tools and arguments."""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

from lostfound.agent.format import answer_line
from lostfound.api import scene
from lostfound.core import directions, geometry, skills
from lostfound.core.building import Building, MapError
from lostfound.core.resolve import Resolver

REPO = Path(__file__).resolve().parents[2]
PYTHON_TIMEOUT_S = 60
MAX_TOOL_OUTPUT_CHARS = 6000


def _string(description: str) -> dict:
    return {"type": "string", "description": description}


def _schema(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


FLOOR = _string("Floor as written, e.g. 'ground floor', 'floor 2', 'Basement 1', or the floor id.")
PLACE = _string("Room as written in the question incl. any '(Floor 2)' qualifier, a room number like '0.21', or a space id.")

TYPED_TOOLS = [
    {
        "name": "resolve_place",
        "description": "Find which space(s) a room mention refers to. Returns ranked candidates and whether it is ambiguous.",
        "input_schema": _schema({"text": PLACE}),
    },
    {
        "name": "search",
        "description": "Search rooms and things (furniture, machines, equipment) by words, room number or type. "
        "Also lists the room types and asset types the building uses when called with query '*types*'.",
        "input_schema": _schema({"query": _string("Words, a number, or '*types*'.")}),
    },
    {
        "name": "largest_room",
        "description": "Largest room of a room type on a floor, with its area in m² (from the polygon).",
        "input_schema": _schema({"floor": FLOOR, "room_type": _string("Room type, e.g. 'bedroom', 'meeting room'.")}),
    },
    {
        "name": "total_floor_area",
        "description": "Sum of the floor areas (m², from polygons) of every room of a type on a floor.",
        "input_schema": _schema({"floor": FLOOR, "room_type": _string("Room type, e.g. 'office'.")}),
    },
    {
        "name": "errand_distance",
        "description": "Walk from a start room to the nearest room (by walking distance) holding an asset of a type, "
        "then carry it to the largest room of a type on a floor. Returns the total walking distance in metres.",
        "input_schema": _schema(
            {
                "start": PLACE,
                "asset_type": _string("Asset type to pick up, e.g. 'desk', 'fire extinguisher'."),
                "target_floor": FLOOR,
                "target_room_type": _string("Room type of the destination (its largest one on target_floor)."),
                "can_use_stairs": {"type": "boolean", "description": "False if the item cannot go on stairs/steps."},
            }
        ),
    },
    {
        "name": "delivery_reach_count",
        "description": "Count rooms on a floor that a wide load entering at a space can reach: no stairs or steps "
        "(lifts fine) and every door at least min_width_m wide.",
        "input_schema": _schema(
            {"entrance_space": PLACE, "floor": FLOOR, "min_width_m": {"type": "number", "description": "Load width in metres."}}
        ),
    },
    {
        "name": "step_free_reach_count",
        "description": "Count rooms on a floor a wheelchair user entering at a space can reach step-free, with some "
        "lifts/stairs/doors/rooms closed.",
        "input_schema": _schema(
            {
                "entrance_space": PLACE,
                "floor": FLOOR,
                "closed": {"type": "array", "items": {"type": "string"}, "description": "Names or ids of closed elements, e.g. ['Lift 2']."},
            }
        ),
    },
    {
        "name": "room_above_below",
        "description": "The room directly above or below a room (largest polygon overlap on the next floor).",
        "input_schema": _schema({"room": PLACE, "direction": {"type": "string", "enum": ["above", "below"]}}),
    },
    {
        "name": "shared_walls",
        "description": "Rooms on the same floor sharing at least 1 m of wall with a room (corridors, stairwells, "
        "lifts and outdoor areas excluded).",
        "input_schema": _schema({"room": PLACE}),
    },
    {
        "name": "straight_line_3d",
        "description": "Straight-line distance in metres between two room centres (polygon centroid at floor elevation).",
        "input_schema": _schema({"first": PLACE, "second": PLACE}),
    },
    {
        "name": "what_if_door",
        "description": "Add a door in the middle of the wall two spaces share; count rooms on a floor whose walk to the "
        "nearest entrance gets shorter by more than 1 m.",
        "input_schema": _schema({"first": PLACE, "second": PLACE, "floor": FLOOR}),
    },
    {
        "name": "route",
        "description": "Shortest walking route (metres, rooms passed, steps). Optional stops in order, step-free, closures. "
        "Reports when no route exists.",
        "input_schema": _schema(
            {
                "start": PLACE,
                "destination": PLACE,
                "via": {"type": "array", "items": {"type": "string"}, "description": "Stops in order between start and destination (can be empty)."},
                "step_free": {"type": "boolean"},
                "closed": {"type": "array", "items": {"type": "string"}, "description": "Closed lifts/stairs/doors/rooms (can be empty)."},
            }
        ),
    },
    {
        "name": "find_assets",
        "description": "Where things of an asset type are: room, floor and position. Optionally on one floor.",
        "input_schema": _schema({"asset_type": _string("Asset type, e.g. 'lectern'."), "floor": _string("Floor, or '' for all floors.")}),
    },
    {
        "name": "count_assets",
        "description": "How many things of an asset type are on a floor.",
        "input_schema": _schema({"asset_type": _string("Asset type, e.g. 'chair'."), "floor": FLOOR}),
    },
]

EDIT_TOOLS = [
    {
        "name": "set_closed",
        "description": "Close or reopen a lift, staircase, door or room (maintenance, blocked aisle). Affects all later answers.",
        "input_schema": _schema({"element": _string("Name or id, e.g. 'Lift 2', 'east stairs', a door id, a room."), "closed": {"type": "boolean"}}),
    },
    {
        "name": "add_door",
        "description": "Add a door in the middle of the wall two neighbouring spaces share (edits the building).",
        "input_schema": _schema(
            {"first": PLACE, "second": PLACE, "width_m": {"type": "number", "description": "Door width, e.g. 0.9."}, "step_free": {"type": "boolean"}}
        ),
    },
    {
        "name": "move_asset",
        "description": "Record that a thing (machine, furniture, equipment) is now in another room (edits the building).",
        "input_schema": _schema({"asset": _string("Asset name or id, e.g. 'Press 3' or 'Desk 2.03-B'."), "to_room": PLACE}),
    },
]

PYTHON_TOOL = {
    "name": "run_python",
    "description": textwrap.dedent(
        """\
        Run Python against this building with our verified library and print the result (stdout is returned).
        Preloaded: `b` (Building), `R` (Resolver for b), modules `skills`, `geometry`, `reach`.
        Useful API:
          R.space(text).best -> space id;  R.floor('floor 2') -> floor id;  R.room_type('meeting room');  R.asset_type('desk')
          b.spaces / b.floors / b.openings / b.connectors / b.assets (dicts by id; see building.json format)
          b.spaces_by_floor[floor_id] -> list of spaces;  b.polygon(space_id) -> shapely Polygon;  b.label(space_id)
          b.distances_from(space_id, step_free=False, min_width=None) -> {node: metres};  b.route(a, b2, step_free, via)
          b.temporarily_closed(*ids) / b.temporary_opening(opening_dict) -> context managers for what-ifs
          geometry.area / centroid_3d / distance_3d / stacked(b, id, 'above'|'below') / shared_walls / shared_wall_midpoint
          reach.reachable_spaces(b, start, step_free, min_width) / reach.exit_distances(b) / reach.rooms_reached(...)
          skills.<kind>(b, ...) for: """
    )
    + ", ".join(sorted(skills.SKILLS))
    + ". Room counts use space type 'room' only (not halls, corridors, stairs, lifts, outdoor); "
    "shared-wall neighbours also include halls. Never re-implement geometry the library already has.",
    "input_schema": _schema({"code": _string("Python code; print() what you need.")}),
}


# Benchmark kind -> typed tool that answers it (for leave-one-kind-out evals).
KIND_TOOLS = {
    "largest_room": "largest_room",
    "floor_area_total": "total_floor_area",
    "errand": "errand_distance",
    "wide_delivery_count": "delivery_reach_count",
    "step_free_reachable_count": "step_free_reach_count",
    "room_stacked": "room_above_below",
    "shared_walls_count": "shared_walls",
    "straight_line_3d": "straight_line_3d",
    "what_if_door": "what_if_door",
}


class Toolbox:
    """Executes tool calls for one building. `last_answer_line` holds the most recent formatted answer."""

    def __init__(self, building: Building, design: str, excluded_kinds: frozenset[str] = frozenset()) -> None:
        self.building = building
        self.resolver = Resolver(building)
        self.excluded_kinds = excluded_kinds
        excluded_tools = {KIND_TOOLS[kind] for kind in excluded_kinds}
        typed = [tool for tool in TYPED_TOOLS if tool["name"] not in excluded_tools]
        self.schemas = {
            "typed": typed,
            "code": [TYPED_TOOLS[0], PYTHON_TOOL],
            "hybrid": [*typed, PYTHON_TOOL],
            "chat": [*typed, *EDIT_TOOLS, PYTHON_TOOL],
        }[design]
        self.chat = design == "chat"
        self.last_answer_line: str | None = None
        self.resolutions: list[dict] = []
        self.edits: list[dict] = []
        self.reset_turn()

    def reset_turn(self) -> None:
        self.turn = {"highlights": [], "route": None, "edits": [], "ui": None}

    def turn_payload(self) -> dict:
        """What the UI needs besides the text: spaces to highlight, the route to draw, edits made this turn."""
        return {**self.turn, "closed": sorted(self.building.closed)}

    def _highlight(self, *space_ids: str) -> None:
        for space_id in space_ids:
            if space_id in self.building.spaces and space_id not in self.turn["highlights"]:
                self.turn["highlights"].append(space_id)

    def definitions(self) -> list[dict]:
        return [{**tool, "strict": True} for tool in self.schemas]

    def call(self, name: str, arguments: dict) -> tuple[str, bool]:
        """Returns (json text, is_error)."""
        try:
            result = getattr(self, f"tool_{name}")(**arguments)
        except MapError as error:
            return json.dumps({"error": str(error)}, ensure_ascii=False), True
        except (KeyError, ValueError, TypeError) as error:
            return json.dumps({"error": f"{type(error).__name__}: {error}"}, ensure_ascii=False), True
        text = json.dumps(result, ensure_ascii=False, default=str)
        if len(text) > MAX_TOOL_OUTPUT_CHARS:
            text = text[:MAX_TOOL_OUTPUT_CHARS] + " …(truncated)"
        return text, False

    # ---------- helpers ----------

    def _space(self, text: str) -> str:
        resolution = self.resolver.space(text)
        self.resolutions.append(resolution.as_dict(3))
        self._highlight(resolution.best)
        return resolution.best

    def _floor(self, text: str) -> str:
        return text if text in self.building.floors else self.resolver.floor(text)

    def _closed(self, names: list[str]) -> list[str]:
        return [self.building.find_element(name) for name in names]

    def _answer(self, kind: str, result: dict, ambiguous: list[str] | None = None) -> dict:
        line = answer_line(self.building, kind, result)
        self.last_answer_line = line
        output = {**result, "answer_line": line}
        if ambiguous:
            output["warning"] = f"Ambiguous room mention(s): {ambiguous}. Picked the best match; say so."
        return output

    def _ambiguous(self, *texts: str) -> list[str]:
        return [text for text in texts if self.resolver.space(text).ambiguous]

    # ---------- typed tools ----------

    def _scene(self, build) -> None:
        """Chat only: record the viewer scene for this tool result (lazily; batch mode never pays for it)."""
        if not self.chat:
            return
        try:
            self.turn["ui"] = build()
        except (MapError, KeyError, ValueError) as error:  # a scene problem must never break the answer
            self.turn["ui_error"] = str(error)

    def tool_resolve_place(self, text: str) -> dict:
        resolution = self.resolver.space(text)
        if resolution.candidates and not resolution.ambiguous:
            self._scene(lambda: scene.show_space(self.building, resolution.best))
        return resolution.as_dict()

    def tool_search(self, query: str) -> dict:
        if query.strip() == "*types*":
            return {"room_types": self.resolver.room_types, "asset_types": self.resolver.asset_types}
        results = self.building.search(query)
        return {"matches": len(results), "results": results[:20]}

    def tool_largest_room(self, floor: str, room_type: str) -> dict:
        floor_id, kind = self._floor(floor), self.resolver.room_type(room_type)
        result = skills.largest_room(self.building, floor_id, kind)
        self._scene(lambda: scene.largest_room(self.building, floor_id, kind, result))
        return self._answer("largest_room", result)

    def tool_total_floor_area(self, floor: str, room_type: str) -> dict:
        floor_id, kind = self._floor(floor), self.resolver.room_type(room_type)
        result = skills.floor_area_total(self.building, floor_id, kind)
        self._scene(lambda: scene.floor_area_total(self.building, floor_id, kind, result))
        return self._answer("floor_area_total", result)

    def tool_errand_distance(self, start, asset_type, target_floor, target_room_type, can_use_stairs) -> dict:
        start_id = self._space(start)
        result = skills.errand(
            self.building,
            start_id,
            self.resolver.asset_type(asset_type),
            self._floor(target_floor),
            self.resolver.room_type(target_room_type),
            step_free=not can_use_stairs,
        )
        self._scene(lambda: scene.errand(self.building, start_id, not can_use_stairs, result))
        return self._answer("errand", result, self._ambiguous(start))

    def tool_delivery_reach_count(self, entrance_space, floor, min_width_m) -> dict:
        start_id, floor_id = self._space(entrance_space), self._floor(floor)
        result = skills.wide_delivery_count(self.building, start_id, floor_id, min_width_m)
        self._scene(lambda: scene.wide_delivery(self.building, start_id, floor_id, min_width_m, result))
        return self._answer("wide_delivery_count", result, self._ambiguous(entrance_space))

    def tool_step_free_reach_count(self, entrance_space, floor, closed) -> dict:
        start_id, floor_id, closed_ids = self._space(entrance_space), self._floor(floor), self._closed(closed)
        result = skills.step_free_reachable_count(self.building, start_id, floor_id, closed_ids)
        self._scene(lambda: scene.step_free_reach(self.building, start_id, floor_id, closed_ids, result))
        return self._answer("step_free_reachable_count", result, self._ambiguous(entrance_space))

    def tool_room_above_below(self, room, direction) -> dict:
        room_id = self._space(room)
        result = skills.room_stacked(self.building, room_id, direction)
        self._scene(lambda: scene.room_stacked(self.building, room_id, direction, result))
        return self._answer("room_stacked", result, self._ambiguous(room))

    def tool_shared_walls(self, room) -> dict:
        room_id = self._space(room)
        result = skills.shared_walls_count(self.building, room_id)
        self._scene(lambda: scene.shared_walls(self.building, room_id, result))
        return self._answer("shared_walls_count", result, self._ambiguous(room))

    def tool_straight_line_3d(self, first, second) -> dict:
        first_id, second_id = self._space(first), self._space(second)
        result = skills.straight_line_3d(self.building, first_id, second_id)
        self._scene(lambda: scene.straight_line(self.building, first_id, second_id, result))
        return self._answer("straight_line_3d", result, self._ambiguous(first, second))

    def tool_what_if_door(self, first, second, floor) -> dict:
        first_id, second_id, floor_id = self._space(first), self._space(second), self._floor(floor)
        result = skills.what_if_door(self.building, first_id, second_id, floor_id)
        self._scene(lambda: scene.what_if_door(self.building, first_id, second_id, floor_id, result))
        return self._answer("what_if_door", result, self._ambiguous(first, second))

    def tool_route(self, start, destination, via, step_free, closed) -> dict:
        stops = [self._space(start), *[self._space(v) for v in via], self._space(destination)]
        closed_ids = self._closed(closed)
        result = skills.route(self.building, stops[0], stops[-1], step_free, closed_ids, stops[1:-1])
        self._scene(lambda: scene.route(self.building, stops, step_free, closed_ids, result))
        if not result["reachable"]:
            self.last_answer_line = "Answer: no route"
            return {**result, "answer_line": "Answer: no route"}
        if self.chat:
            # Directions with turns and landmarks for the reply; the viewer draws the route itself.
            with self.building.temporarily_closed(*closed_ids):
                details = directions.route_details(self.building, stops[0], stops[-1], step_free, stops[1:-1])
            self.turn["route"] = details
            return {
                "length_m": result["length_m"],
                "steps": details["steps"],
                "rooms": [self.building.label(s) for s in details["space_path"] if s in self.building.spaces],
            }
        result["space_path"] = [self.building.label(s) if s in self.building.spaces else s for s in result["space_path"]]
        return self._answer("route", result)

    def tool_find_assets(self, asset_type, floor) -> dict:
        result = skills.locate(self.building, self.resolver.asset_type(asset_type))
        if floor:
            floor_name = self.building.floor_name(self._floor(floor))
            result["matches"] = [match for match in result["matches"] if match["floor"] == floor_name]
        result["matches"] = result["matches"][:25]
        self._scene(lambda: scene.locate(self.building, result["matches"]))
        return result

    def tool_count_assets(self, asset_type, floor) -> dict:
        kind, floor_id = self.resolver.asset_type(asset_type), self._floor(floor)
        result = skills.count_assets(self.building, kind, floor_id)
        self._scene(lambda: scene.count_assets(self.building, kind, floor_id, result))
        return self._answer("count", result)

    # ---------- edits (chat) ----------

    def tool_set_closed(self, element: str, closed: bool) -> dict:
        element_id = self.building.set_closed(element, closed)
        edit = {"action": "close" if closed else "reopen", "element_id": element_id}
        self.edits.append(edit)
        self.turn["edits"].append(edit)
        self._scene(lambda: scene.edit(self.building, edit))
        return {**edit, "all_closed": sorted(self.building.closed)}

    def tool_add_door(self, first: str, second: str, width_m: float, step_free: bool) -> dict:
        first_id, second_id = self._space(first), self._space(second)
        if self.building.spaces[first_id]["floor_id"] != self.building.spaces[second_id]["floor_id"]:
            raise MapError("A door can only join two spaces on the same floor.")
        midpoint = geometry.shared_wall_midpoint(self.building, first_id, second_id)
        opening = {
            "id": f"{self.building.spaces[first_id]['floor_id']}-O-new{len(self.edits) + 1}",
            "floor_id": self.building.spaces[first_id]["floor_id"],
            "space_ids": [first_id, second_id],
            "kind": "door",
            "position": [round(midpoint.x, 3), round(midpoint.y, 3)],
            "width_m": width_m,
            "step_free": step_free,
            "synthetic": True,
        }
        self.building.walks = dict(self.building.walks)  # edited building: stop sharing the per-file walk cache
        for space_id in (first_id, second_id):
            self.building.walks.pop(space_id, None)
        self.building.openings[opening["id"]] = opening
        self.building.data["openings"].append(opening)
        edit = {"action": "add_door", "opening": opening}
        self.edits.append(edit)
        self.turn["edits"].append(edit)
        self._scene(lambda: scene.edit(self.building, edit))
        return edit

    def tool_move_asset(self, asset: str, to_room: str) -> dict:
        asset_id = asset if asset in self.building.assets else next(
            (a["id"] for a in self.building.assets.values() if a["name"].casefold() == asset.casefold()), None
        )
        if asset_id is None:
            matches = [r for r in self.building.search(asset) if r["kind"] == "asset"][:8]
            raise MapError(f"No asset named '{asset}'. Did you mean: {[m['name'] for m in matches]}?")
        room_id = self._space(to_room)
        centre = self.building.polygon(room_id).representative_point()
        record = self.building.assets[asset_id]
        record.update({"space_id": room_id, "floor_id": self.building.spaces[room_id]["floor_id"], "position": [round(centre.x, 3), round(centre.y, 3)]})
        edit = {"action": "move_asset", "asset_id": asset_id, "to_space_id": room_id}
        self.edits.append(edit)
        self.turn["edits"].append(edit)
        self._scene(lambda: scene.edit(self.building, edit))
        return edit

    # ---------- code ----------

    def tool_run_python(self, code: str) -> dict:
        with tempfile.TemporaryDirectory() as scratch:
            source = Path(self.building.directory).resolve()
            if self.edits:  # chat session with edits: run against the edited building, not the file on disk
                source = Path(scratch) / "building.json"
                source.write_text(json.dumps(self.building.data, ensure_ascii=False), encoding="utf-8")
            prelude = textwrap.dedent(
                f"""\
                import json, math, itertools, collections
                from pathlib import Path
                from lostfound.core.building import Building
                from lostfound.core.resolve import Resolver
                from lostfound.core import skills, geometry, reach
                b = Building.load(Path({str(source)!r}))
                b.closed.update({sorted(self.building.closed)!r})
                R = Resolver(b)
                for _name in {sorted(self.excluded_kinds)!r}:
                    _function = skills.SKILLS.pop(_name, None)
                    if _function is not None and hasattr(skills, _function.__name__):
                        delattr(skills, _function.__name__)
                """
            )
            script = Path(scratch) / "snippet.py"
            script.write_text(prelude + "\n" + code, encoding="utf-8")
            environment = {**os.environ, "PYTHONPATH": str(REPO)}
            environment.pop("ANTHROPIC_API_KEY", None)
            try:
                completed = subprocess.run(
                    [sys.executable, str(script)],
                    cwd=scratch,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=PYTHON_TIMEOUT_S,
                )
            except subprocess.TimeoutExpired:
                raise MapError(f"Code timed out after {PYTHON_TIMEOUT_S} s.") from None
        output = {"stdout": completed.stdout[-MAX_TOOL_OUTPUT_CHARS:]}
        if completed.returncode != 0:
            output["error"] = completed.stderr[-2000:]
        return output
