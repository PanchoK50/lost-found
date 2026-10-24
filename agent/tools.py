"""Claude tools on top of the deterministic core.

AgentToolkit holds the plain, LLM-free methods (dicts in, dicts out) so tests
and the deterministic replay can drive them directly. make_tools wraps them as
@beta_tool(strict=True) Claude tools: every fact the model states comes from
these calls. Session state (closures, added doors) lives in a per-conversation
dict and flows into every routing call as constraints — the building itself is
never mutated.

Every question-shaped tool returns a ready-to-commit "answer_line" with the
scorer's required shape: exactly one number for numeric answers, the expected
room named first for room answers, an ordered space list for routes.
"""

from __future__ import annotations

import functools
import json

from anthropic import beta_tool
from anthropic.lib.tools import ToolError

from agent.resolve import (
    ResolveError,
    resolve_element,
    resolve_floor,
    resolve_space,
    search,
)
from core.geometry import Geometry
from core.graph import RouteConstraints, RouteError, distances_from, route
from core.model import Building, Opening
from core.queries import (
    AREA_TYPES,
    REACHABLE_ROOM_TYPES,
    QueryError,
    errand,
    floor_area_total,
    largest_room,
    straight_line_3d,
    what_if_door,
)

MAX_RESULTS = 15


def _space_label(building: Building, space_id: str) -> str:
    """Name plus room number when the number is not already part of the name.

    A few buildings (OSM) have repeated room names like "Büro"; the number is the
    discriminator the scorer's accept/reject labels use.
    """
    space = building.spaces[space_id]
    if space.ref and space.ref not in space.name:
        return f"{space.name} ({space.ref})"
    return space.name


def _constraints(session: dict, step_free: bool = False, min_door_width_m: float | None = None,
                 closed_elements: list[str] | None = None) -> RouteConstraints:
    closed = set(session.get("closed", ())) | set(closed_elements or [])
    return RouteConstraints(
        step_free=step_free,
        min_door_width_m=min_door_width_m,
        closed=frozenset(closed),
        extra_openings=tuple(session.get("extra_openings", ())),
    )


class AgentToolkit:
    """Plain tool functions bound to one building; no anthropic imports needed to use them."""

    def __init__(self, building: Building, geometry: Geometry, session: dict | None = None) -> None:
        self.building = building
        self.geometry = geometry
        self.session = session if session is not None else {"closed": set(), "extra_openings": []}

    # ---------- context ----------

    def building_overview(self) -> dict:
        building = self.building
        floors = [
            {
                "floor_id": floor.id,
                "level": floor.level,
                "name": floor.name,
                "spaces": len(building.spaces_by_floor[floor.id]),
            }
            for floor in building.floors_sorted()
        ]
        return {
            "name": building.meta.name,
            "source": building.meta.source,
            "floors": floors,
            "stairs_and_lifts": [
                {"id": c.id, "name": c.name, "kind": c.kind, "step_free": c.step_free,
                 "floors": [building.floor_name(f) for f in c.floor_ids]}
                for c in building.connectors.values()
            ],
            "entrances": [
                {"id": o.id, "into": building.describe_space(building.entrance_into(o.id)),
                 "width_m": o.width_m, "step_free": o.step_free}
                for o in (building.openings[i] for i in building.entrances)
            ],
            "asset_count": len(building.assets),
            "closed": sorted(self.session.get("closed", ())),
            "hint": "Room numbers like 0.29 are unique refs; pass names or refs to the tools as written.",
        }

    def search_building(self, query: str, floor_level: int | None = None) -> dict:
        results = search(self.building, query, floor_level)
        if not results:
            raise QueryError(f"Nothing matches '{query}'. Try fewer or more general words.")
        return {"matches": len(results), "results": results[:MAX_RESULTS]}

    # ---------- routing ----------

    def find_route(
        self,
        start: str,
        destination: str,
        step_free: bool = False,
        via: list[str] | None = None,
        min_door_width_m: float | None = None,
        closed_elements: list[str] | None = None,
    ) -> dict:
        building = self.building
        stops = [resolve_space(building, start)] + [resolve_space(building, s) for s in via or []]
        stops.append(resolve_space(building, destination))
        result = route(
            building,
            self.geometry,
            stops[0],
            stops[-1],
            constraints=_constraints(self.session, step_free, min_door_width_m, closed_elements),
            via=stops[1:-1],
        )
        names = [_space_label(building, s) for s in result.space_path]
        return {
            "length_m": result.length_m,
            "space_path": names,
            "space_ids": result.space_path,
            "element_path": result.element_path,
            "legs": [
                {"from": building.spaces[leg.start_id].name, "to": building.spaces[leg.destination_id].name,
                 "length_m": leg.length_m}
                for leg in result.legs
            ],
            "step_free": step_free,
            "answer_line": "Answer: " + " -> ".join(names),
        }

    def set_closed(self, element: str, closed: bool = True) -> dict:
        element_id = resolve_element(self.building, element)
        if closed:
            self.session.setdefault("closed", set()).add(element_id)
        else:
            self.session.get("closed", set()).discard(element_id)
        return {
            "element_id": element_id,
            "closed": closed,
            "all_closed": sorted(self.session.get("closed", ())),
            "hint": "Routing tools avoid closed elements from now on.",
        }

    def add_door(self, first_space: str, second_space: str) -> dict:
        building, geometry = self.building, self.geometry
        first_id = resolve_space(building, first_space)
        second_id = resolve_space(building, second_space)
        wall = geometry.wall_between(first_id, second_id)
        if wall is None:
            raise QueryError(f"{building.spaces[first_id].name} and {building.spaces[second_id].name} share no wall.")
        opening = Opening(
            id=f"added-door-{len(self.session.get('extra_openings', [])) + 1}",
            floor_id=building.spaces[first_id].floor_id,
            space_ids=(first_id, second_id),
            kind="door",
            position=wall.midpoint,
            width_m=0.9,
            step_free=True,
            synthetic=True,
        )
        self.session.setdefault("extra_openings", []).append(opening)
        return {
            "added_door": {"id": opening.id, "between": [first_id, second_id], "position": list(wall.midpoint)},
            "hint": "Routes now use this door too. Use what_if_door to test a door without adding it.",
        }

    # ---------- room facts ----------

    def room_facts(self, reference: str) -> dict:
        building, geometry = self.building, self.geometry
        space_id = resolve_space(building, reference)
        space = building.spaces[space_id]
        facts = {
            "id": space_id,
            "name": space.name,
            "ref": space.ref,
            "type": space.type,
            "room_type": space.room_type,
            "floor": building.floor_name(space.floor_id),
            "area_m2": round(geometry.area_m2(space_id), 2),
            "centroid_xy": [round(value, 2) for value in geometry.centroid(space_id)],
            "min_width_m": round(geometry.min_width_m(space_id), 2),
            "holds_asset_types": sorted(
                {building.assets[a].type for a in building.assets_by_space.get(space_id, [])}
            )[:MAX_RESULTS],
        }
        suggestions = {}
        if space.type in AREA_TYPES:
            neighbours = [
                building.spaces[w.space_b if w.space_a == space_id else w.space_a]
                for w in geometry.shared_walls(space.floor_id).values()
                if space_id in (w.space_a, w.space_b)
                and building.spaces[w.space_b if w.space_a == space_id else w.space_a].type in AREA_TYPES
            ]
            facts["shared_walls"] = {
                "count": len(neighbours),
                "neighbours": [{"id": n.id, "name": n.name} for n in neighbours[:MAX_RESULTS]],
                "counts_rooms_and_halls_only": True,
            }
            suggestions["shared_walls"] = f"Answer: {len(neighbours)}"
        for key, getter in (("directly_above", geometry.space_above), ("directly_below", geometry.space_below)):
            neighbour_id = getter(space_id)
            if neighbour_id is not None:
                label = _space_label(building, neighbour_id)
                facts[key] = {"id": neighbour_id, "name": building.spaces[neighbour_id].name}
                suggestions[key] = f"Answer: {label}"
        if suggestions:
            facts["answer_line_suggestions"] = suggestions
        return facts

    # ---------- question-shaped answers ----------

    def largest_room(self, floor: str, room_type: str) -> dict:
        floor_id = resolve_floor(self.building, floor)
        result = largest_room(self.building, self.geometry, floor_id, room_type)
        return {
            "space_id": result.space_id,
            "name": result.name,
            "ref": result.ref,
            "floor": self.building.floor_name(floor_id),
            "area_m2": result.area_m2,
            "answer_line": f"Answer: {result.name}, {result.area_m2} m²",
        }

    def floor_area_total(self, floor: str, room_type: str) -> dict:
        floor_id = resolve_floor(self.building, floor)
        total = floor_area_total(self.building, self.geometry, floor_id, room_type)
        counted = sum(
            1
            for s in self.building.spaces.values()
            if s.floor_id == floor_id and s.room_type == room_type and s.type in AREA_TYPES
        )
        return {
            "total_m2": total,
            "rooms_counted": counted,
            "floor": self.building.floor_name(floor_id),
            "room_type": room_type,
            "answer_line": f"Answer: {total} m²",
        }

    def errand_plan(self, start: str, asset_type: str, floor: str, room_type: str) -> dict:
        building = self.building
        floor_id = resolve_floor(building, floor)
        start_id = resolve_space(building, start)
        result = errand(building, self.geometry, start_id, asset_type, floor_id, room_type)
        via = building.spaces[result.via_id]
        target = building.spaces[result.target_id]
        return {
            "total_m": result.total_m,
            "leg_1": {"from": building.describe_space(start_id), "to": via.name, "length_note": "nearest room with the item"},
            "leg_2": {"from": via.name, "to": target.name, "length_note": f"largest {room_type} on that floor"},
            "answer_line": f"Answer: {result.total_m} m",
        }

    def reachable_rooms(
        self,
        start: str,
        floor: str,
        step_free: bool = False,
        min_door_width_m: float | None = None,
        closed_elements: list[str] | None = None,
    ) -> dict:
        building = self.building
        floor_id = resolve_floor(building, floor)
        start_id = resolve_space(building, start)
        constraints = _constraints(self.session, step_free, min_door_width_m, closed_elements)
        distances = distances_from(building, self.geometry, start_id, constraints)
        rooms = [
            {"id": sid, "name": building.spaces[sid].name}
            for sid in distances
            if building.spaces[sid].floor_id == floor_id and building.spaces[sid].type in REACHABLE_ROOM_TYPES
        ]
        return {
            "count": len(rooms),
            "rooms": rooms[:MAX_RESULTS],
            "floor": building.floor_name(floor_id),
            "rules": {
                "step_free": step_free,
                "min_door_width_m": min_door_width_m,
                "closed": sorted(constraints.closed),
                "counts_rooms_only": True,
            },
            "answer_line": f"Answer: {len(rooms)} rooms",
        }

    def distance_3d(self, first: str, second: str) -> dict:
        building = self.building
        first_id = resolve_space(building, first)
        second_id = resolve_space(building, second)
        distance = straight_line_3d(building, self.geometry, first_id, second_id)
        return {
            "distance_m": distance,
            "first": building.describe_space(first_id),
            "second": building.describe_space(second_id),
            "answer_line": f"Answer: {distance} m",
        }

    def what_if_door(self, first_space: str, second_space: str, target_floor: str) -> dict:
        building = self.building
        first_id = resolve_space(building, first_space)
        second_id = resolve_space(building, second_space)
        target_floor_id = resolve_floor(building, target_floor)
        wall = self.geometry.wall_between(first_id, second_id)
        result = what_if_door(building, self.geometry, first_id, second_id, target_floor_id)
        return {
            "improved_count": result.improved_count,
            "affected_rooms": [
                {"id": sid, "name": building.spaces[sid].name} for sid in result.affected_space_ids[:MAX_RESULTS]
            ],
            "door_position": list(wall.midpoint) if wall else None,
            "target_floor": building.floor_name(target_floor_id),
            "answer_line": f"Answer: {result.improved_count} rooms",
        }


def as_json(value: object) -> str:
    return json.dumps(value, indent=1, ensure_ascii=False, default=str)


def catching(func):
    """Turn core/resolve errors into ToolError so the model sees the candidates and can retry."""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except (ResolveError, QueryError, RouteError) as error:
            raise ToolError(str(error)) from error

    return wrapper


def make_tools(toolkit: AgentToolkit) -> list:
    """Wrap the toolkit as strict Claude tools. Errors become is_error tool results."""

    @beta_tool(strict=True)
    @catching
    def building_overview() -> str:
        """Floors, stairs and lifts, entrances, and current closures of the building. Call this first."""
        return as_json(toolkit.building_overview())

    @beta_tool(strict=True)
    @catching
    def search_building(query: str, floor_level: int | None = None) -> str:
        """Find rooms and things (furniture, machines, equipment) by name, room number or type.

        Args:
            query: Words to look for, e.g. "3d printer", "0.29", "toilet", "production zone".
            floor_level: Only search this floor (0 = ground floor, -1 = basement). Omit for all floors.
        """
        return as_json(toolkit.search_building(query, floor_level))

    @beta_tool(strict=True)
    @catching
    def find_route(
        start: str,
        destination: str,
        step_free: bool = False,
        via: list[str] | None = None,
        min_door_width_m: float | None = None,
        closed_elements: list[str] | None = None,
    ) -> str:
        """Shortest walking route between two places: ordered spaces, step directions, metres.

        Args:
            start: Room number, name or id of where the person is.
            destination: Room number, name or id of where they want to go.
            step_free: True to avoid stairs and steps (wheelchair, trolley, pram).
            via: Places to visit in order between start and destination (multi-stop tour).
            min_door_width_m: Every door on the way must be at least this wide (wide loads).
            closed_elements: Names or ids of lifts, stairs, doors or rooms to avoid.
        """
        return as_json(toolkit.find_route(start, destination, step_free, via, min_door_width_m, closed_elements))

    @beta_tool(strict=True)
    @catching
    def set_closed(element: str, closed: bool = True) -> str:
        """Close or reopen a lift, staircase, door or room (maintenance, blockage). Affects later routes.

        Args:
            element: Name or id of the lift/staircase/door/room, e.g. "Lift 1".
            closed: True to close it, False to reopen.
        """
        return as_json(toolkit.set_closed(element, closed))

    @beta_tool(strict=True)
    @catching
    def add_door(first_space: str, second_space: str) -> str:
        """Add a door between two neighbouring rooms on one floor, in the middle of their shared wall.

        Args:
            first_space: Room number, name or id of the first room.
            second_space: Room number, name or id of the second room.
        """
        return as_json(toolkit.add_door(first_space, second_space))

    @beta_tool(strict=True)
    @catching
    def room_facts(reference: str) -> str:
        """Everything about one room: area, centre, width, wall neighbours, what is directly above/below.

        Args:
            reference: Room number, name or id, e.g. "0.29", "Server room 1.14".
        """
        return as_json(toolkit.room_facts(reference))

    @beta_tool(strict=True)
    @catching
    def largest_room(floor: str, room_type: str) -> str:
        """The largest room of one type on one floor, with its area in m2.

        Args:
            floor: Floor reference: "ground floor", "floor 1", "basement 2" or a floor name.
            room_type: Room type such as kitchen, office, meeting_room, lecture_hall.
        """
        return as_json(toolkit.largest_room(floor, room_type))

    @beta_tool(strict=True)
    @catching
    def floor_area_total(floor: str, room_type: str) -> str:
        """Summed floor area in m2 of all rooms of one type on one floor.

        Args:
            floor: Floor reference: "ground floor", "floor 1", "basement 2" or a floor name.
            room_type: Room type such as office, storage, production_zone.
        """
        return as_json(toolkit.floor_area_total(floor, room_type))

    @beta_tool(strict=True)
    @catching
    def errand_plan(start: str, asset_type: str, floor: str, room_type: str) -> str:
        """Total walking metres for an errand: nearest room holding an item, then the largest room of a type.

        Args:
            start: Room number, name or id of where the person starts.
            asset_type: Asset type to pick up, e.g. stove, printer, pallet.
            floor: Floor of the final destination, e.g. "floor 1".
            room_type: Room type of the final destination, e.g. meeting_room.
        """
        return as_json(toolkit.errand_plan(start, asset_type, floor, room_type))

    @beta_tool(strict=True)
    @catching
    def reachable_rooms(
        start: str,
        floor: str,
        step_free: bool = False,
        min_door_width_m: float | None = None,
        closed_elements: list[str] | None = None,
    ) -> str:
        """How many rooms on a floor can be reached under rules (step-free, wide doors, closures).

        Args:
            start: Room number, name or id of where the person starts.
            floor: The floor to count rooms on, e.g. "floor 2".
            step_free: True to allow lifts, ramps and doors only (no stairs or steps).
            min_door_width_m: Every door on the way must be at least this wide.
            closed_elements: Names or ids of lifts, stairs, doors or rooms to avoid.
        """
        return as_json(toolkit.reachable_rooms(start, floor, step_free, min_door_width_m, closed_elements))

    @beta_tool(strict=True)
    @catching
    def distance_3d(first: str, second: str) -> str:
        """Straight-line distance in metres between the centres of two rooms (3D, floors included).

        Args:
            first: Room number, name or id of the first room.
            second: Room number, name or id of the second room.
        """
        return as_json(toolkit.distance_3d(first, second))

    @beta_tool(strict=True)
    @catching
    def what_if_door(first_space: str, second_space: str, target_floor: str) -> str:
        """Hypothetical door between two rooms: how many rooms' walk out of the building gets shorter by over 1 m.

        Args:
            first_space: Room number, name or id of one side of the new door.
            second_space: Room number, name or id of the other side.
            target_floor: The floor to count affected rooms on, e.g. "floor 3".
        """
        return as_json(toolkit.what_if_door(first_space, second_space, target_floor))

    return [
        building_overview,
        search_building,
        find_route,
        set_closed,
        add_door,
        room_facts,
        largest_room,
        floor_area_total,
        errand_plan,
        reachable_rooms,
        distance_3d,
        what_if_door,
    ]
