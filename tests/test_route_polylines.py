"""Drawn routes follow the walk the route length measures: round corners, through doors, never through a wall."""

import itertools
import random
from pathlib import Path

import pytest
from shapely.errors import ShapelyError
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from lostfound.core import directions
from lostfound.core.building import DOOR_PREFIX, Building, NoRouteError
from lostfound.hazards import evacuation, spread
from starter_agent.building_map import walking_lengths, walking_path

ALL_DEV = sorted(path for path in Path("data/dev").iterdir() if (path / "building.json").exists())
# Two buildings of every source (osm, proc-campus, proc-factory, resplan, swiss): their geometry differs most.
DEV = [path for source, group in itertools.groupby(ALL_DEV, key=lambda p: p.name.rsplit("-", 1)[0].removesuffix("-dev"))
       for path in list(group)[:2]]


def test_walking_path_turns_round_the_inner_corner():
    # An L: up the left leg, then right along the top. The straight line cuts the inner corner at (2, 2).
    room = Polygon([(0, 0), (2, 0), (2, 2), (6, 2), (6, 4), (0, 4)])
    start, end = (1.0, 0.5), (5.5, 3.0)
    corners = walking_path(room, start, end)
    assert corners and all(Point(corner).distance(Point(2, 2)) < 0.25 for corner in corners)
    walk = LineString([start, *corners, end])
    assert walk.length == pytest.approx(walking_lengths(room, [start, end])[(0, 1)], abs=1e-6)
    assert room.covers(walk)


def test_walking_path_is_empty_when_the_line_is_clear():
    assert walking_path(Polygon([(0, 0), (4, 0), (4, 4), (0, 4)]), (1.0, 1.0), (3.0, 3.0)) == []


def _through_walls(building: Building, polylines: list[dict]) -> list[tuple]:
    """Segments that leave every single space of their floor, apart from where they pass a door: walls are
    thick, so a door sits in the gap between the two spaces it joins, and wide openings are crossed anywhere."""
    bad = []
    for run in polylines:
        spaces = [Polygon(space["polygon"]).buffer(0.05) for space in building.spaces_by_floor[run["floor_id"]]]
        doors = unary_union([
            Point(opening["position"]).buffer(max(
                0.5,
                opening["width_m"] / 2 + 0.3,
                0.3 + max((Polygon(building.spaces[s]["polygon"]).distance(Point(opening["position"]))
                           for s in opening["space_ids"] if s in building.spaces), default=0.0),
            ))
            for opening in building.openings.values() if opening["floor_id"] == run["floor_id"]
        ])
        for first, second in itertools.pairwise(run["points"]):
            rest = LineString([first, second]).difference(doors)
            pieces = [] if rest.is_empty else getattr(rest, "geoms", [rest])
            if any(piece.length > 0.01 and not any(space.covers(piece) for space in spaces) for piece in pieces):
                bad.append((run["floor_id"], first, second))
    return bad


@pytest.mark.parametrize("directory", DEV, ids=[d.name for d in DEV])
def test_routes_never_cut_through_walls(directory):
    building = Building.load(directory)
    rooms = sorted(s for s, space in building.spaces.items() if space["type"] in ("room", "hall"))
    picker = random.Random(directory.name)
    for _ in range(6):
        start, end = picker.sample(rooms, 2)
        try:
            details = directions.route_details(building, start, end)
        except NoRouteError:
            continue
        assert not _through_walls(building, details["polylines"]), (start, end)
        # The drawn route starts in the start room and ends in the destination, as before.
        first, last = details["polylines"][0]["points"][0], details["polylines"][-1]["points"][-1]
        assert tuple(first) == pytest.approx(building.anchor(start), abs=1e-3)
        assert tuple(last) == pytest.approx(building.anchor(end), abs=1e-3)


@pytest.mark.parametrize("directory", DEV[:4], ids=[d.name for d in DEV[:4]])
def test_evacuation_walkers_never_cut_through_walls(directory):
    building = Building.load(directory)
    origin = max((s for s in building.spaces.values() if s["type"] == "room"), key=lambda s: building.polygon(s["id"]).area)["id"]
    plan = evacuation.evacuate(building, spread.simulate(building, "fire", origin))
    for walker in plan["walkers"]:
        runs = [{"floor_id": floor_id, "points": [point for _, *point in group]}
                for floor_id, group in itertools.groupby(walker["path"], key=lambda point: point[0])]
        assert not _through_walls(building, runs), walker["space_id"]


def test_a_failing_drawing_never_changes_the_route_answer(monkeypatch):
    building = Building.load(DEV[0])
    rooms = sorted(s for s, space in building.spaces.items() if space["type"] in ("room", "hall"))
    start, end = rooms[0], rooms[-1]
    expected = directions.route_details(building, start, end)

    def broken(*_):
        raise ShapelyError("broken geometry")

    directions._corners.cache_clear()
    monkeypatch.setattr(directions, "walking_path", broken)
    details = directions.route_details(building, start, end)
    directions._corners.cache_clear()
    assert {k: v for k, v in details.items() if k != "polylines"} == {k: v for k, v in expected.items() if k != "polylines"}
    # The fallback draws the straight line through the route's anchors and doors, as before (without repeating a point).
    straight: list[tuple[str, list[float]]] = []
    for node in details["nodes"]:
        node = node if node in building.spaces else DOOR_PREFIX + node
        here = (directions._floor_of(building, node), [round(c, 3) for c in directions._point(building, node)])
        if not straight or straight[-1] != here:
            straight.append(here)
    assert [(run["floor_id"], point) for run in details["polylines"] for point in run["points"]] == straight
