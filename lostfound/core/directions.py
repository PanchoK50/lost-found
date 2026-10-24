"""Human-followable directions for a route: per-floor polylines for the map, and short steps with turns and
landmarks ("Turn left through the door into Lab 0.12, past the CNC mill")."""

import itertools
import math

import networkx as nx

from lostfound.core.building import DOOR_PREFIX, OUTSIDE, Building, MapError

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
) -> dict:
    stops = [start, *(via or []), destination]
    graph = building.graph(step_free, min_width)
    nodes: list[str] = []
    length = 0.0
    for leg_start, leg_end in itertools.pairwise(stops):
        try:
            leg_length, leg_nodes = nx.single_source_dijkstra(graph, leg_start, leg_end, weight="weight")
        except (nx.NetworkXNoPath, nx.NodeNotFound) as error:
            raise MapError(f"No route from {building.label(leg_start)} to {building.label(leg_end)}.") from error
        length += leg_length
        nodes += leg_nodes if not nodes else leg_nodes[1:]
    return {
        "length_m": round(length, 2),
        "space_path": [node for node in nodes if not node.startswith(DOOR_PREFIX)],
        "polylines": _polylines(building, nodes),
        "steps": _steps(building, graph, nodes),
        "highlights": [node for node in nodes if node in building.spaces],
        "step_free": step_free,
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


def _polylines(building: Building, nodes: list[str]) -> list[dict]:
    """Consecutive runs of points on one floor: [{level, floor_id, points: [[x, y], ...]}]."""
    runs: list[dict] = []
    for node in nodes:
        floor_id, point = _floor_of(building, node), _point(building, node)
        if floor_id is None or point is None:
            continue
        if not runs or runs[-1]["floor_id"] != floor_id:
            runs.append({"floor_id": floor_id, "level": building.level(floor_id), "points": []})
        runs[-1]["points"].append([round(point[0], 3), round(point[1], 3)])
    return runs


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
    steps = [f"Start in {building.label(nodes[0])}."]
    walked = 0.0
    previous_point = _point(building, nodes[0])
    for here, following in itertools.pairwise(nodes):
        edge = min(graph[here][following].values(), key=lambda candidate: candidate["weight"])
        walked += edge["weight"]
        element = edge["via"]
        if element in building.connectors:
            connector = building.connectors[element]
            target_floor = building.floor_name(building.spaces[following]["floor_id"])
            verb = "Take" if connector["kind"] == "lift" else "Use"
            steps.append(f"{verb} {connector['name']} to {target_floor}.")
            walked, previous_point = 0.0, _point(building, following)
            continue
        if following == OUTSIDE:
            steps.append(f"Walk about {walked:.0f} m and leave through the entrance.")
            walked = 0.0
            continue
        if here.startswith(DOOR_PREFIX) and following in building.spaces:
            door_point = _point(building, here)
            target_point = _point(building, following)
            turn = _turn(previous_point, door_point, target_point) if previous_point else "go"
            opening = building.openings[here.removeprefix(DOOR_PREFIX)]
            passage = {"door": "through the door", "entrance": "in through the entrance"}.get(opening["kind"], "through the opening")
            thing = landmark(building, following, door_point)
            if following == nodes[-1]:
                tail = f", you have arrived{f' (look for the {thing})' if thing else ''}."
            else:
                tail = f"{f', past the {thing}' if thing else ''}."
            steps.append(f"After about {walked:.0f} m, {turn} {passage} into {building.spaces[following]['name']}{tail}")
            walked, previous_point = 0.0, door_point
    if len(steps) > MAX_STEPS:
        steps = [*steps[:2], *[step for step in steps[2:-2] if step.startswith(("Take", "Use"))], *steps[-2:]]
    return steps
