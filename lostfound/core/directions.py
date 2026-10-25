"""Human-followable directions for a route: per-floor polylines for the map, and short steps with turns and
landmarks ("Turn left through the door into Lab 0.12, past the CNC mill")."""

import functools
import itertools
import math

import networkx as nx

from lostfound.core.building import DOOR_PREFIX, Building
from starter_agent.building_map import door_landing, outline, walking_path

TURN_DEGREES = 35
LANDMARK_CATEGORIES = ("machine", "equipment", "fixture", "furniture")
MAX_STEPS = 8


def route_details(
    building: Building,
    start: str,
    destination: str,
    step_free: bool = False,
    via: list[str] | None = None,
    min_width: float | None = None,
    forklift: bool = False,
    bays: bool | None = None,
) -> dict:
    """Raises NoRouteError (a MapError) when a leg has no route under the rules. `bays` as in Building.route_graph."""
    stops = [start, *(via or []), destination]
    length, nodes, graph = building.route_nodes(stops, step_free, min_width, forklift, bays)
    return {
        "length_m": round(length, 2),
        "space_path": building.spaces_passed(graph, nodes),
        # Every node walked through, in order: spaces and the openings (doors) between them.
        "nodes": [node.removeprefix(DOOR_PREFIX) for node in nodes],
        "polylines": _polylines(building, nodes, graph),
        "steps": _steps(building, graph, nodes),
        "highlights": building.spaces_passed(graph, nodes),
        "step_free": step_free,
        "forklift": forklift,
    }


def _point(building: Building, node: str) -> tuple[float, float] | None:
    if node in building.spaces:
        return building.anchor(node)
    if node.startswith(DOOR_PREFIX):
        return tuple(building.openings[node.removeprefix(DOOR_PREFIX)]["position"])
    return None


def _floor_of(building: Building, node: str) -> str | None:
    if node in building.spaces:
        return building.spaces[node]["floor_id"]
    if node.startswith(DOOR_PREFIX):
        return building.openings[node.removeprefix(DOOR_PREFIX)]["floor_id"]
    return None


def _polylines(building: Building, nodes: list[str], graph: nx.MultiGraph | None = None) -> list[dict]:
    """Consecutive runs of points on one floor: [{level, floor_id, points: [[x, y], ...]}]. Inside each space the
    run follows the walk the route length measures: from the door into its landing, round the corners, out
    through the next door's landing, so a drawn route never cuts through a wall. `graph` holds the route's edges
    and tells which space a walk between two doors crosses."""
    runs: list[dict] = []

    def add(floor_id: str, point: tuple[float, float]) -> None:
        if not runs or runs[-1]["floor_id"] != floor_id:
            runs.append({"floor_id": floor_id, "level": building.level(floor_id), "points": []})
        rounded = [round(point[0], 3), round(point[1], 3)]
        if not runs[-1]["points"] or runs[-1]["points"][-1] != rounded:
            runs[-1]["points"].append(rounded)

    for index, node in enumerate(nodes):
        floor_id, point = _floor_of(building, node), _point(building, node)
        if floor_id is None or point is None:
            continue
        if index:
            space_id = _walked_space(building, graph, nodes[index - 1], node)
            if space_id is not None:
                for corner in _walk_points(building, space_id, nodes[index - 1], node):
                    add(building.spaces[space_id]["floor_id"], corner)
        add(floor_id, point)
    return runs


def _walked_space(building: Building, graph: nx.MultiGraph | None, first: str, second: str) -> str | None:
    """The space walked through between two consecutive route nodes; None for a stair or lift ride."""
    if first in building.spaces and second in building.spaces:
        return None
    if graph is not None and graph.has_edge(first, second):
        return building.cheapest(graph, first, second).get("space")
    candidates = set.intersection(*(_spaces_of(building, node) for node in (first, second)))
    walks = {
        space_id: length
        for space_id in candidates
        for a, b, length in building.space_walks(space_id)
        if {a, b} == {first, second}
    }
    return min(walks, key=walks.__getitem__) if walks else None


def _spaces_of(building: Building, node: str) -> set[str]:
    if node in building.spaces:
        return {node}
    if node.startswith(DOOR_PREFIX):
        opening = building.openings.get(node.removeprefix(DOOR_PREFIX))
        return {space_id for space_id in opening["space_ids"] if space_id in building.spaces} if opening else set()
    return set()


def _walk_points(building: Building, space_id: str, first: str, second: str) -> list[tuple[float, float]]:
    """The points between two route nodes inside a space: door landings and the corners walked round."""
    polygon_points = tuple(tuple(point) for point in building.spaces[space_id]["polygon"])
    ends = [_inside_point(building, space_id, polygon_points, node) for node in (first, second)]
    corners = _corners(polygon_points, ends[0], ends[1])
    return [
        *([ends[0]] if first.startswith(DOOR_PREFIX) else []),
        *corners,
        *([ends[1]] if second.startswith(DOOR_PREFIX) else []),
    ]


def _inside_point(building: Building, space_id: str, polygon_points: tuple, node: str) -> tuple[float, float]:
    """Where a route node sits inside a space, as in space_walks: its anchor, or a door's landing."""
    if node == space_id:
        return building.anchor(space_id)
    position = building.openings[node.removeprefix(DOOR_PREFIX)]["position"]
    return _landing(polygon_points, (position[0], position[1]))


@functools.lru_cache(maxsize=8192)
def _landing(polygon_points: tuple, position: tuple[float, float]) -> tuple[float, float]:
    return door_landing(outline(list(polygon_points)), position)


@functools.lru_cache(maxsize=8192)
def _corners(polygon_points: tuple, start: tuple[float, float], end: tuple[float, float]) -> tuple:
    # Keyed by the outline itself, so an edited space never reuses a stale walk.
    return tuple(walking_path(outline(list(polygon_points)), start, end))


def _turn(previous: tuple, here: tuple, following: tuple) -> str:
    first = math.atan2(here[1] - previous[1], here[0] - previous[0])
    second = math.atan2(following[1] - here[1], following[0] - here[0])
    delta = math.degrees((second - first + math.pi) % (2 * math.pi) - math.pi)
    if abs(delta) < TURN_DEGREES:
        return "continue straight"
    return "turn left" if delta > 0 else "turn right"


def landmark(building: Building, space_id: str, near: tuple[float, float]) -> str | None:
    """A salient thing in a space near a point: machines first, then equipment, fixtures, furniture."""
    assets = [asset for asset in building.assets.values() if asset["space_id"] == space_id]
    for category in LANDMARK_CATEGORIES:
        candidates = [asset for asset in assets if asset["category"] == category]
        if candidates:
            nearest = min(candidates, key=lambda asset: math.dist(asset["position"], near))
            return nearest["name"]
    return None


def _steps(building: Building, graph: nx.MultiGraph, nodes: list[str]) -> list[str]:
    """One step per door or floor change, with the turn at the door and a landmark in the room entered."""
    steps = [f"Start in {building.label(nodes[0])}."]
    walked = 0.0
    previous_point = _point(building, nodes[0])
    for index, (here, following) in enumerate(itertools.pairwise(nodes), start=1):
        edge = building.cheapest(graph, here, following)
        walked += edge["weight"]
        if "via" in edge:
            connector = building.connectors[edge["via"]]
            target_floor = building.floor_name(building.spaces[following]["floor_id"])
            verb = "Take" if connector["kind"] == "lift" else "Use"
            steps.append(f"{verb} {connector['name']} to {target_floor}.")
            walked, previous_point = 0.0, _point(building, following)
            continue
        if following.startswith(DOOR_PREFIX) and index + 1 < len(nodes):
            entered = building.cheapest(graph, following, nodes[index + 1]).get("space")
            if entered is None:
                continue
            door_point = _point(building, following)
            target_point = building.anchor(entered)
            turn = _turn(previous_point, door_point, target_point) if previous_point else "go"
            opening = building.openings[following.removeprefix(DOOR_PREFIX)]
            passage = "through the door" if opening["kind"] == "door" else "through the opening"
            thing = landmark(building, entered, door_point)
            arrived = entered == nodes[-1]
            if arrived:
                tail = f", you have arrived{f' (look for the {thing})' if thing else ''}."
            else:
                tail = f"{f', past the {thing}' if thing else ''}."
            steps.append(f"After about {walked:.0f} m, {turn} {passage} into {building.spaces[entered]['name']}{tail}")
            walked, previous_point = 0.0, door_point
    if len(steps) > MAX_STEPS:
        steps = [*steps[:2], *[step for step in steps[2:-2] if step.startswith(("Take", "Use"))], *steps[-2:]]
    return steps
