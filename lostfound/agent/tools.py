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
import re
import uuid
from pathlib import Path

from benchmark.score import numbers_in
from lostfound.agent.format import answer_line
from lostfound.api import scene
from lostfound.core import campus, directions, geometry, skills
from lostfound.core.edits import apply_edits
from lostfound.core.building import Building, MapError, NoRouteError
from lostfound.core.resolve import Resolver

REPO = Path(__file__).resolve().parents[2]
NO_ROUTE = re.compile(r"\bno\b\W*(?:\w+\W+){0,3}?(?:route|path|way)\b|not reachable|unreachable|cannot be reached|can't be reached", re.IGNORECASE)
MATCH_TOLERANCE = 0.01  # a committed number rounded differently from the tool line still identifies its call


def _plain(text: str) -> str:
    """Answer text without markdown, a final full stop and case: '**84.16 m**.' -> '84.16 m'."""
    return re.sub(r"[*`_]", "", text).strip().rstrip(".").strip().casefold()
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
        "description": "Shortest route (metres, rooms passed, steps). Optional stops in order, step-free, closures, minimum "
        "opening width, forklift. Reports when no route exists under the rules; then the answer is that there is no route.",
        "input_schema": _schema(
            {
                "start": PLACE,
                "destination": PLACE,
                "via": {"type": "array", "items": {"type": "string"}, "description": "Stops in order between start and destination (can be empty)."},
                "step_free": {"type": "boolean", "description": "No stairs or steps (wheelchair, pram, trolley, 'without stairs'): lifts, ramps and doors only."},
                "closed": {"type": "array", "items": {"type": "string"}, "description": "Closed or blocked lifts/stairs/doors/rooms/aisles (can be empty)."},
                "min_door_width_m": {"type": "number", "description": "Every door and opening at least this wide (a wide load); 0 for no limit."},
                "forklift": {"type": "boolean", "description": "Route for a forklift or other industrial vehicle: forklift aisles and openings of 3 m or "
                             "more only, no stairs or lifts, production bays only as start or destination (never driven through)."},
            }
        ),
    },
    {
        "name": "nearest",
        "description": "Nearest room of a type (e.g. 'toilet', 'kitchen') or nearest thing of an asset type (e.g. 'coffee machine') "
        "from a start room, by walking distance. Returns the place, distance and route steps. Use the person's current room as the "
        "start when they say 'nearest', 'closest', 'here' or 'from me'.",
        "input_schema": _schema(
            {
                "start": PLACE,
                "what": _string("Room type or asset type, as the person said it, e.g. 'toilet', 'meeting room', 'printer'."),
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
        "name": "rename_room",
        "description": "Give a room its number and/or name (fix a plan import, or a renamed room). Saved for everyone.",
        "input_schema": _schema({"room": PLACE, "ref": _string("Room number, e.g. '1.04', or '' to keep it."), "name": _string("Full name, e.g. 'Meeting room 1.04', or '' to build it from type + number.")}),
    },
    {
        "name": "set_room_type",
        "description": "Set what a room is used for (e.g. 'bathroom', 'office', 'kitchen'); fixes a wrong guess from a plan import. Saved for everyone.",
        "input_schema": _schema({"room": PLACE, "room_type": _string("Room type, e.g. 'meeting room'.")}),
    },
    {
        "name": "set_door_width",
        "description": "Set the width of a door (by its id, or the door between two rooms). Saved for everyone.",
        "input_schema": _schema({"door": _string("Door id, or two rooms as 'Room A | Room B'."), "width_m": {"type": "number"}}),
    },
    {
        "name": "rescale_building",
        "description": "Fix the scale of an imported plan from one known measurement: a room's real area (m²) or real width (m). "
        "Everything is rescaled. Saved for everyone.",
        "input_schema": _schema({"room": PLACE, "real_area_m2": {"type": "number", "description": "0 if unknown"}, "real_width_m": {"type": "number", "description": "0 if unknown; the room's longer side"}}),
    },
    {
        "name": "set_floor_height",
        "description": "Set the storey height of one floor, or of every floor with floor 'all' (plans don't show heights). "
        "Floors above move up or down with it. Saved for everyone.",
        "input_schema": _schema({"floor": _string("Floor as written, a floor id, or 'all'."), "height_m": {"type": "number", "description": "Storey height in metres, e.g. 3.0."}}),
    },
    {
        "name": "move_asset",
        "description": "Record that a thing (machine, furniture, equipment) is now in another room (edits the building).",
        "input_schema": _schema({"asset": _string("Asset name or id, e.g. 'Press 3' or 'Desk 2.03-B'."), "to_room": PLACE}),
    },
]

CROSS_TOOLS = [
    {
        "name": "cross_route",
        "description": "Route from a place in THIS building to a place in ANOTHER building — use it whenever the person names a "
        "destination outside this building (a building name, 'the other building', a campus). Routes out of the best exit here, "
        "across between the buildings, and through the other building to the destination. The distance between the buildings "
        "comes from real positions or a saved layout when known; when the tool reports need_distance, ask the person one short "
        "question (how far, roughly), remember the answer with set_building_placement, then call cross_route again.",
        "input_schema": _schema(
            {
                "start": PLACE,
                "destination": _string("The destination, as the person wrote it (room in the other building)."),
                "building": _string("The other building, as the person named it, e.g. 'N8', 'Fertigung Ost 27', or its id."),
                "step_free": {"type": "boolean"},
            }
        ),
    },
    {
        "name": "set_building_placement",
        "description": "Remember for this conversation where another building is, from what the person just said "
        "(after cross_route reported need_distance). Distance from this building, roughly; which way, if they said.",
        "input_schema": _schema(
            {
                "building": _string("The other building, as in cross_route."),
                "distance_m": {"type": "number", "description": "Distance between the buildings in metres, as the person said."},
                "bearing": {"type": "string", "enum": ["north", "east", "south", "west"], "description": "Which way the other building lies; default 'east'."},
            }
        ),
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
          b.distances_from(space_id, step_free=False, min_width=None) -> {node: metres};  b.route(a, b2, step_free, via, min_width, forklift)
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


def infer_room_types() -> list[str]:
    from lostfound.ingest import infer

    return sorted(infer.model()["priors"])


class Toolbox:
    """Executes tool calls for one building. `last_answer_line` holds the most recent formatted answer."""

    def __init__(
        self,
        building: Building,
        design: str,
        excluded_kinds: frozenset[str] = frozenset(),
        catalog: campus.Catalog | None = None,
    ) -> None:
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
        # Cross-building routing: the catalog knows every building, and placements learned in conversation.
        self.catalog = catalog
        if self.chat and catalog is not None:
            self.schemas = [*self.schemas, *CROSS_TOOLS]
        self.placements: dict[str, dict] = {}
        self.last_answer_line: str | None = None
        self.last_result: dict | None = None  # structured result of the last answering tool (for answers.json)
        self.answered: list[tuple[str, dict]] = []  # (answer line, structured result) of every answering call, in order
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
        # The API allows at most 20 strict tools: keep the answer tools strict (exact arguments matter for the
        # benchmark); edit tools and run_python validate their arguments themselves.
        relaxed = {tool["name"] for tool in [*EDIT_TOOLS, PYTHON_TOOL]}
        return [{**tool, "strict": tool["name"] not in relaxed} for tool in self.schemas]

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

    def _remember(self, line: str | None, record: dict) -> None:
        if line is not None:
            self.last_answer_line = line
        self.last_result = record
        self.answered.append((line or "", record))

    def result_for(self, committed: str | None) -> dict | None:
        """The structured result behind the answer the reply committed to (the agent may explore a fallback after the
        answer it gives): the latest call whose answer line says the same, ignoring markdown, units and a final full
        stop; else the call whose numbers match within 1% (closest, then latest); for a "no route" answer the latest
        call without a route; else the latest answering call."""
        if committed is None:
            return self.last_result
        wanted = _plain(committed)
        records = [(_plain(line.removeprefix("Answer:")), record) for line, record in self.answered if line]
        for line, record in reversed(records):
            if line == wanted:
                return record
        values = numbers_in(wanted)
        if not values and NO_ROUTE.search(wanted):
            return next((record for _, record in reversed(records) if record.get("reachable") is False), self.last_result)
        best, best_gap = None, MATCH_TOLERANCE
        for line, record in reversed(records):
            found = numbers_in(line)
            if values and len(found) == len(values):
                gap = max(abs(a - b) / max(abs(b), 1.0) for a, b in zip(values, found))
                if gap < best_gap or (best is None and gap <= best_gap):
                    best, best_gap = record, gap
        return best if best is not None else self.last_result

    def _answer(self, kind: str, result: dict, ambiguous: list[str] | None = None, record: dict | None = None) -> dict:
        line = answer_line(self.building, kind, result)
        self._remember(line, record or {"kind": kind, **result})
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
        try:
            result = skills.errand(
                self.building,
                start_id,
                self.resolver.asset_type(asset_type),
                self._floor(target_floor),
                self.resolver.room_type(target_room_type),
                step_free=not can_use_stairs,
            )
        except NoRouteError as error:
            return self._no_route({"kind": "errand", "start": start_id, "step_free": not can_use_stairs}, str(error))
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

    def _no_route(self, record: dict, reason: str) -> dict:
        line = "Answer: no route"
        self._remember(line, {**record, "reachable": False, "reason": reason})
        return {"reachable": False, "reason": reason, "answer_line": line}

    def tool_route(self, start, destination, via, step_free, closed, min_door_width_m=0, forklift=False) -> dict:
        stops = [self._space(start), *[self._space(v) for v in via], self._space(destination)]
        closed_ids = self._closed(closed)
        min_width = min_door_width_m if min_door_width_m and min_door_width_m > 0 else None
        result = skills.route(self.building, stops[0], stops[-1], step_free, closed_ids, stops[1:-1], min_width, forklift)
        record = {"kind": "route", "stops": stops, **result}
        keep_previous = False
        if self.chat:
            # The agent sometimes also works out a fallback (e.g. "if staircase 1 is blocked too") after the route it
            # recommends. Within one chat turn, the route shown is the one for the real situation: fewest extra
            # closures from the same start, then the shortest. A route from another start always replaces it.
            # Batch answers instead store every call and pick the one the reply commits to (result_for).
            rank = (len(closed_ids), result["length_m"] if result["reachable"] else float("inf"))
            kept = self.turn.get("route_rank")
            key = (stops[0], step_free, min_width, forklift)
            keep_previous = bool(kept and kept[0] == key and kept[1] <= rank)
            if not keep_previous:
                self.turn["route_rank"] = (key, rank)
                self._scene(lambda: scene.route(self.building, stops, step_free, closed_ids, result, min_width, forklift))
        if not result["reachable"]:
            if keep_previous:
                return {**result, "answer_line": "Answer: no route"}
            return {**self._no_route(record, result["reason"]), **result}
        if self.chat:
            # Directions with turns and landmarks for the reply; the viewer draws the route itself.
            with self.building.temporarily_closed(*closed_ids):
                details = directions.route_details(self.building, stops[0], stops[-1], step_free, stops[1:-1], min_width, forklift)
            if not keep_previous:
                self.turn["route"] = details
                self.last_result = record
            return {
                "length_m": result["length_m"],
                "steps": details["steps"],
                "rooms": [self.building.label(s) for s in details["space_path"] if s in self.building.spaces],
            }
        labelled = {**result, "space_path": [self.building.label(s) if s in self.building.spaces else s for s in result["space_path"]]}
        return self._answer("route", labelled, record=record)

    def tool_nearest(self, start: str, what: str, step_free: bool, closed: list[str] | None = None) -> dict:
        start_id = self._space(start)
        closed_ids = self._closed(closed or [])
        with self.building.temporarily_closed(*closed_ids):
            # The same rules as the route computed below, so the nearest target is one that route can reach.
            distances = self.building.route_distances(start_id, step_free)
        targets: dict[str, str] = {}  # space id -> what was found there
        try:
            room_type = self.resolver.room_type(what)
            targets.update({s["id"]: s["name"] for s in self.building.spaces.values() if s["room_type"] == room_type and s["id"] != start_id})
        except MapError:
            room_type = None
        try:
            asset_type = self.resolver.asset_type(what)
            for asset in self.building.assets.values():
                if asset["type"] == asset_type:
                    targets.setdefault(asset["space_id"], asset["name"])
        except MapError:
            asset_type = None
        if room_type is None and asset_type is None:
            raise MapError(f"I don't know '{what}' in this building. Room types: {', '.join(self.resolver.room_types)}.")
        reachable = [space_id for space_id in targets if space_id in distances]
        if not reachable:
            reason = f"No reachable {what} from {self.building.label(start_id)}."
            return self._no_route({"kind": "route", "stops": [start_id], "step_free": step_free, "closed": closed_ids}, reason)
        best = min(reachable, key=lambda space_id: distances[space_id])
        result = self.tool_route(start_id, best, [], step_free, closed_ids)
        return {"found": targets[best], "in": self.building.label(best), "distance_m": round(distances[best], 1), **result}

    def tool_find_assets(self, asset_type, floor) -> dict:
        result = skills.locate(self.building, self.resolver.asset_type(asset_type))
        if floor:
            floor_name = self.building.floor_name(self._floor(floor))
            result["matches"] = [match for match in result["matches"] if match["floor"] == floor_name]
        result["matches"] = result["matches"][:25]
        self._scene(lambda: scene.locate(self.building, result["matches"]))
        self._remember(None, {"kind": "locate", **result})
        return result

    def tool_count_assets(self, asset_type, floor) -> dict:
        kind, floor_id = self.resolver.asset_type(asset_type), self._floor(floor)
        result = skills.count_assets(self.building, kind, floor_id)
        self._scene(lambda: scene.count_assets(self.building, kind, floor_id, result))
        return self._answer("count", result)

    # ---------- other buildings (chat) ----------

    def _placement_for(self, other_id: str) -> dict | None:
        """Where the other building is, relative to this one: curated campus, learned in chat, or measured.
        Every pair routes — far buildings too (with their real distance); nothing is cut off."""
        curated = campus.curated_placement(self.building.id, other_id)
        if curated is not None:
            return curated
        learned = self.placements.get(other_id)
        if learned is not None:
            return learned
        return campus.geo_placement(self.building.id, other_id)

    def tool_cross_route(self, start: str, destination: str, building: str, step_free: bool = False) -> dict:
        if self.catalog is None:
            raise MapError("No other buildings are known here.")
        matches = [match for match in self.catalog.search(building) if match["id"] != self.building.id]
        if not matches:
            raise MapError(f"No building called '{building}'. Ask which building they mean.")
        other = matches[0]
        if len({match["name"] for match in matches}) > 1:
            # 'Fertigung Ost' matches several buildings: never guess silently — the agent asks which one.
            return {
                "need_clarify_building": building,
                "candidates": matches[:4],
                "what_to_ask": f"'{building}' matches several buildings: {', '.join(m['name'] for m in matches[:4])}. Ask which one they mean, then call cross_route with the full name.",
            }
        other_building = self.catalog.load(other["id"])
        other_resolver = Resolver(other_building)
        destination_id = self._resolve_elsewhere(other_building, other_resolver, destination)
        if destination_id is None:
            return {
                "need_clarify": destination,
                "what_to_ask": f"Ask which room in {other['name']} they mean (a room number or name); the tools cannot resolve '{destination}' there.",
            }
        placement = self._placement_for(other["id"])
        if placement is None:
            return {
                "need_distance": True,
                "building": other,
                "what_to_ask": (
                    f"Ask one short question: roughly how far is {other['name']} from "
                    f"{self.building.data['building']['name']} (metres), and which way? Then remember it with "
                    "set_building_placement and call cross_route again."
                ),
            }
        start_id = self._space(start)
        site = campus.Campus(
            [campus.CampusMember(self.building, (0, 0), "here"), campus.CampusMember(other_building, tuple(placement["offset"]), placement["source"])],
            placement.get("walkways", []),
        )
        result = site.cross_route((self.building.id, start_id), (other["id"], destination_id), step_free)
        self._highlight(start_id)
        self._scene(lambda: scene.cross_route(site, result))
        self.last_result = {"kind": "cross_route", **{k: result[k] for k in ("length_m", "minutes", "steps", "distance_source")}}
        return {
            "length_m": result["length_m"],
            "minutes": result["minutes"],
            "steps": result["steps"],
            "from": result["from"],
            "to": result["to"],
            "distance_source": result["distance_source"],
        }

    def _resolve_elsewhere(self, other_building: Building, resolver: Resolver, text: str) -> str | None:
        """Resolve a place in another building: by name, or by superlative ('the largest generic room')."""
        try:
            resolution = resolver.space(text)
            if resolution.candidates and not resolution.ambiguous:
                return resolution.best
        except MapError:
            pass
        text = re.sub(r"\s+in\s+\S+\s*$", "", text.strip(), flags=re.IGNORECASE)  # '… room in N8'
        superlative = re.search(r"\b(largest|biggest)\s+(.+?)(?:\s+on\s+(.+))?$", text, re.IGNORECASE)
        if not superlative:
            return None
        try:
            kind = resolver.room_type(superlative.group(2))
        except MapError:
            return None
        floor_ids = [resolver.floor(superlative.group(3))] if superlative.group(3) else list(other_building.floors)
        best: tuple[float, str] | None = None
        for floor_id in floor_ids:
            for space in other_building.rooms_on_floor(floor_id, kind):
                area = other_building.polygon(space["id"]).area
                if best is None or area > best[0]:
                    best = (area, space["id"])
        return best[1] if best else None

    def tool_set_building_placement(self, building: str, distance_m: float, bearing: str = "east") -> dict:
        if self.catalog is None:
            raise MapError("No other buildings are known here.")
        matches = [match for match in self.catalog.search(building) if match["id"] != self.building.id]
        if not matches:
            raise MapError(f"No building called '{building}'.")
        if not 3 <= distance_m <= 100_000:
            raise MapError("The distance should be between 3 m and 100 km — check what the person said.")
        direction = {"north": (0, 1), "east": (1, 0), "south": (0, -1), "west": (-1, 0)}[bearing]
        other = matches[0]
        self.placements[other["id"]] = {
            "offset": [round(direction[0] * distance_m, 1), round(direction[1] * distance_m, 1)],
            "distance_m": round(distance_m, 1),
            "source": "assumed",
        }
        return {"building": other, "distance_m": round(distance_m, 1), "bearing": bearing, "remembered": True}

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
            "id": f"{self.building.spaces[first_id]['floor_id']}-O-edit-{uuid.uuid4().hex[:8]}",
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
        edit = {"action": "move_asset", "asset_id": asset_id, "to_space_id": room_id, "position": record["position"]}
        self.edits.append(edit)
        self.turn["edits"].append(edit)
        self._scene(lambda: scene.edit(self.building, edit))
        return edit

    def _record(self, edit: dict) -> dict:
        self.edits.append(edit)
        self.turn["edits"].append(edit)
        self._scene(lambda: scene.edit(self.building, edit))
        return edit

    def _rebuild(self, data: dict) -> None:
        closed = set(self.building.closed)
        self.building = Building(data, self.building.directory)
        self.building.closed = closed
        self.resolver = Resolver(self.building)

    def tool_rename_room(self, room: str, ref: str, name: str) -> dict:
        space_id = self._space(room)
        space = self.building.spaces[space_id]
        ref = ref.strip() or space.get("ref", "")
        name = name.strip() or f"{space['room_type'].replace('_', ' ').capitalize()} {ref}".strip()
        space.update(ref=ref, name=name)
        self.resolver = Resolver(self.building)
        return self._record({"action": "rename_room", "space_id": space_id, "ref": ref, "name": name})

    def tool_set_room_type(self, room: str, room_type: str) -> dict:
        space_id = self._space(room)
        known = sorted({s["room_type"] for s in self.building.spaces.values()} | set(infer_room_types()))
        try:
            kind = Resolver(self.building).room_type(room_type)
        except MapError:
            kind = room_type.strip().lower().replace(" ", "_")
            if not re.fullmatch(r"[a-z_]{2,40}", kind):
                raise MapError(f"'{room_type}' is not a room type. Known: {', '.join(known)}.") from None
        space = self.building.spaces[space_id]
        old = space["room_type"]
        space["room_type"] = kind
        if space.get("name", "").lower().startswith(old.replace("_", " ")):  # the name was generated from the type
            self.tool_rename_room(space_id, space.get("ref", ""), "")
        self.resolver = Resolver(self.building)
        return self._record({"action": "set_room_type", "space_id": space_id, "room_type": kind})

    def tool_set_door_width(self, door: str, width_m: float) -> dict:
        if not 0.4 <= width_m <= 10:
            raise MapError("A door width should be between 0.4 and 10 m.")
        if door in self.building.openings:
            opening_id = door
        else:
            parts = [p.strip() for p in door.split("|")]
            if len(parts) != 2:
                raise MapError("Name the door by its id or as 'Room A | Room B'.")
            pair = {self._space(parts[0]), self._space(parts[1])}
            opening_id = next((o["id"] for o in self.building.openings.values() if set(o["space_ids"]) == pair), None)
            if opening_id is None:
                raise MapError("There is no door between those two rooms.")
        self.building.openings[opening_id]["width_m"] = float(width_m)
        return self._record({"action": "set_door_width", "opening_id": opening_id, "width_m": float(width_m)})

    def tool_set_floor_height(self, floor: str, height_m: float) -> dict:
        if not 2.0 <= height_m <= 20.0:
            raise MapError("A storey height should be between 2 and 20 m.")
        every = floor.strip().lower() in ("all", "every floor", "all floors", "")
        floor_ids = [f["id"] for f in sorted(self.building.floors.values(), key=lambda f: f["level"])] if every else [self._floor(floor)]
        edits = [{"action": "set_floor_height", "floor_id": floor_id, "height_m": float(height_m)} for floor_id in floor_ids]
        data, _ = apply_edits(self.building.data, edits)
        self._rebuild(data)
        for edit in edits:
            self._record(edit)
        heights = {self.building.floor_name(f["id"]): f"{f['height_m']:g} m at {f['elevation_m']:g} m" for f in self.building.floors.values()}
        return {"action": "set_floor_height", "floors": heights}

    def tool_rescale_building(self, room: str, real_area_m2: float, real_width_m: float) -> dict:
        space_id = self._space(room)
        polygon = self.building.polygon(space_id)
        if real_area_m2 > 0:
            factor = (real_area_m2 / polygon.area) ** 0.5
        elif real_width_m > 0:
            rectangle = polygon.minimum_rotated_rectangle
            xs = list(rectangle.exterior.coords)
            sides = sorted(((xs[i][0] - xs[i + 1][0]) ** 2 + (xs[i][1] - xs[i + 1][1]) ** 2) ** 0.5 for i in range(2))
            factor = real_width_m / sides[-1]
        else:
            raise MapError("Give the room's real area or width.")
        if not 0.5 <= factor <= 2:
            raise MapError(f"That would change the scale by {factor:.2f}x, which looks wrong. Please check the measurement.")
        edit = {"action": "rescale", "factor": round(factor, 5)}
        data, _ = apply_edits(self.building.data, [edit])
        self._rebuild(data)
        return {**self._record(edit), "now": f"{self.building.label(space_id)} is {self.building.polygon(space_id).area:.1f} m²"}

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
