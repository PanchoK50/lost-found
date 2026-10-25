"""An independent reference for the geometry and reachability benchmark kinds, written only from README sections 3
and 4 and the raw building.json (json + shapely, no lostfound.core geometry or reach code). It is first calibrated
against every labelled train/dev answer, then compared with `skills.SKILLS` on many generated inputs on every
building of train, dev and test, so layouts the labels never show (test split) are covered too.

Where the README leaves something open, the labels decided:
- largest_room / floor_area_total: every space on the floor with that `room_type`, whatever its `type`
  (lobbies are halls), area of the raw polygon.
- room_stacked: candidates are every space on the next floor up/down (any type); share = overlap / this room's area.
- shared_walls_count: neighbours are spaces of type `room` or `hall`. Corridors (incl. corridor-typed stairwells),
  stairs, lifts and outdoor spaces (balconies) don't count. The balcony exclusion is not in the README; 53 labels
  need it. Halls count (19 labels need them).
- wide_delivery_count / step_free_reachable_count: only spaces of type `room` count (halls do not: 19 labels),
  the start room counts too if it is a room. Entrances lead outside only, so they are not edges. The width rule
  applies to openings; lifts join every pair of stops.

Tie cases are not compared: largest_room within 3 % of the runner-up, room_stacked within 0.05 overlap share, and
for shared walls any neighbour whose shared length is close to 1 m or whose wall gap is close to 0.35 m only bounds
the expected count (the skill must fall inside the bounds)."""

import collections
import functools
import json
import math
from pathlib import Path

import pytest
from shapely.geometry import Polygon

from lostfound.core import skills
from tests.conftest import DATA, building

ALL_SPLITS = ("train", "dev", "test")
KINDS = (
    "largest_room",
    "floor_area_total",
    "straight_line_3d",
    "room_stacked",
    "shared_walls_count",
    "wide_delivery_count",
    "step_free_reachable_count",
)
DIRECTORIES = [path.parent for split in ALL_SPLITS for path in sorted((DATA / split).glob("*/building.json"))]
IDS = [f"{directory.parent.name}/{directory.name}" for directory in DIRECTORIES]

CAP_SPACES = 40  # rooms per building for room_stacked and shared_walls_count
CAP_PAIRS = 40  # room pairs per building for straight_line_3d
CAP_STARTS = 4  # entrance spaces per building for the reach kinds
CAP_CLOSURES = 6  # closed connectors per building for step_free_reachable_count
WIDTHS = (1.0, 1.1)

WALL_NEIGHBOUR_TYPES = {"room", "hall"}
COUNTED_ROOM_TYPES = {"room"}


# ---------- reference ----------


@functools.cache
def raw(directory: Path) -> dict:
    data = json.loads((directory / "building.json").read_text(encoding="utf-8"))
    data["space_by_id"] = {space["id"]: space for space in data["spaces"]}
    data["floor_by_id"] = {floor["id"]: floor for floor in data["floors"]}
    data["polygons"] = {}
    for space in data["spaces"]:
        polygon = Polygon(space["polygon"])
        data["polygons"][space["id"]] = polygon if polygon.is_valid else polygon.buffer(0)
    return data


def spaces_on(data: dict, floor_id: str) -> list[dict]:
    return [space for space in data["spaces"] if space["floor_id"] == floor_id]


def ref_room_areas(data: dict, floor_id: str, room_type: str) -> dict[str, float]:
    return {s["id"]: data["polygons"][s["id"]].area for s in spaces_on(data, floor_id) if s["room_type"] == room_type}


def ref_centre_3d(data: dict, space_id: str) -> tuple[float, float, float]:
    centroid = data["polygons"][space_id].centroid
    return centroid.x, centroid.y, data["floor_by_id"][data["space_by_id"][space_id]["floor_id"]]["elevation_m"]


def ref_stacked(data: dict, space_id: str, direction: str) -> list[tuple[float, str]]:
    """(overlap share, space id) on the next floor up or down, best first; [] if there is no such floor."""
    level = data["floor_by_id"][data["space_by_id"][space_id]["floor_id"]]["level"]
    floors = [f for f in data["floors"] if (f["level"] > level if direction == "above" else f["level"] < level)]
    if not floors:
        return []
    target = min(floors, key=lambda floor: abs(floor["level"] - level))
    polygon = data["polygons"][space_id]
    ranked = [(data["polygons"][s["id"]].intersection(polygon).area / polygon.area, s["id"]) for s in spaces_on(data, target["id"])]
    return sorted(ranked, reverse=True)


def shared_lengths(first: Polygon, second: Polygon, gap: float) -> tuple[float, float]:
    """Length of each outline that runs within `gap` of the other outline."""
    return (
        first.exterior.intersection(second.exterior.buffer(gap)).length,
        second.exterior.intersection(first.exterior.buffer(gap)).length,
    )


def ref_shared_walls_bounds(data: dict, space_id: str) -> tuple[int, int]:
    """(lower, upper) bound on the neighbour count; equal unless a neighbour is a near-threshold case.

    "At least 1 m of one room's outline runs within 0.35 m of the other's" does not say whose outline carries the
    metre (this room's, or the neighbour's: "every room whose wall runs along it"). Where the two readings differ
    (wrap-around corners, offset walls) the neighbour only widens the bounds. No label distinguishes them."""
    space, polygon = data["space_by_id"][space_id], data["polygons"][space_id]
    sure = maybe = 0
    for other in spaces_on(data, space["floor_id"]):
        if other["id"] == space_id or other["type"] not in WALL_NEIGHBOUR_TYPES:
            continue
        other_polygon = data["polygons"][other["id"]]
        if polygon.distance(other_polygon) > 0.4:
            continue
        exact = max(shared_lengths(polygon, other_polygon, 0.35)) >= 1.0
        strict = min(shared_lengths(polygon, other_polygon, 0.32)) >= 1.1
        loose = max(shared_lengths(polygon, other_polygon, 0.38)) >= 0.9
        if strict:
            sure += 1
        elif loose:
            maybe += 1
        elif exact:  # cannot happen (strict <= exact <= loose), kept as a guard
            raise AssertionError(other["id"])
    return sure, sure + maybe


def ref_reachable(data: dict, start: str, min_width: float | None = None, closed: frozenset = frozenset()) -> set[str]:
    """Spaces reachable step-free from `start`: no stairs, no step_free=false openings, lifts join every stop pair,
    entrances are not edges (no way round the outside), closed elements and spaces are unusable."""
    edges = collections.defaultdict(set)
    for opening in data["openings"]:
        if opening["id"] in closed or not opening["step_free"] or "outside" in opening["space_ids"]:
            continue
        if min_width is not None and opening["width_m"] < min_width:
            continue
        first, second = opening["space_ids"]
        edges[first].add(second)
        edges[second].add(first)
    for connector in data["vertical_connectors"]:
        if connector["kind"] != "lift" or not connector["step_free"] or connector["id"] in closed:
            continue
        for first in connector["space_ids"]:
            for second in connector["space_ids"]:
                if first != second:
                    edges[first].add(second)
    if start in closed:
        return set()
    seen, stack = {start}, [start]
    while stack:
        for nxt in edges[stack.pop()]:
            if nxt not in seen and nxt not in closed:
                seen.add(nxt)
                stack.append(nxt)
    return seen


def ref_count_rooms(data: dict, reached: set[str], floor_id: str) -> int:
    return sum(
        1 for sid in reached if data["space_by_id"][sid]["floor_id"] == floor_id and data["space_by_id"][sid]["type"] in COUNTED_ROOM_TYPES
    )


# ---------- calibration on the labels ----------


def labelled(kinds) -> list[tuple[Path, dict]]:
    items = []
    for split in ("train", "dev"):
        for path in sorted((DATA / split).glob("*/questions.jsonl")):
            for line in path.read_text(encoding="utf-8").splitlines():
                if line and (question := json.loads(line))["kind"] in kinds:
                    items.append((path.parent, question))
    return items


LABELLED = labelled(KINDS)


def within(value: float, answer: dict) -> bool:
    tolerance = max(answer.get("absolute_tolerance", 0.0), answer.get("relative_tolerance", 0.0) * abs(answer["value"]))
    return abs(value - answer["value"]) <= tolerance + 1e-9


@pytest.mark.parametrize("item", LABELLED, ids=[question["id"] for _, question in LABELLED])
def test_reference_matches_label(item):
    directory, question = item
    data, inputs, answer = raw(directory), question["inputs"], question["answer"]
    match question["kind"]:
        case "largest_room":
            areas = ref_room_areas(data, inputs["floor_id"], inputs["room_type"])
            winner = max(areas, key=areas.get)
            assert winner == answer["space_id"] and within(areas[winner], answer["area"])
        case "floor_area_total":
            assert within(sum(ref_room_areas(data, inputs["floor_id"], inputs["room_type"]).values()), answer)
        case "straight_line_3d":
            assert within(math.dist(ref_centre_3d(data, inputs["first"]), ref_centre_3d(data, inputs["second"])), answer)
        case "room_stacked":
            assert ref_stacked(data, inputs["start"], inputs["direction"])[0][1] == answer["space_id"]
        case "shared_walls_count":
            assert ref_shared_walls_bounds(data, inputs["start"]) == (answer["value"], answer["value"])
        case "wide_delivery_count":
            reached = ref_reachable(data, inputs["start"], min_width=inputs["min_width"])
            assert ref_count_rooms(data, reached, inputs["floor_id"]) == answer["value"]
        case "step_free_reachable_count":
            reached = ref_reachable(data, inputs["start"], closed=frozenset([inputs["closed"]]))
            assert ref_count_rooms(data, reached, inputs["floor_id"]) == answer["value"]


# ---------- cross-check against skills on every building ----------


def room_ids(data: dict) -> list[str]:
    return sorted(s["id"] for s in data["spaces"] if s["type"] in WALL_NEIGHBOUR_TYPES)


def entrance_spaces(data: dict) -> list[str]:
    ids = {sid for o in data["openings"] if "outside" in o["space_ids"] for sid in o["space_ids"] if sid != "outside"}
    return sorted(ids)[:CAP_STARTS]


def spread(items: list, cap: int) -> list:
    """Every k-th item so a cap still covers the whole building (all floors), deterministically."""
    if len(items) <= cap:
        return items
    return [items[i * len(items) // cap] for i in range(cap)]


def check_largest_room(directory, data, b):
    problems, checked, ties = [], 0, 0
    for floor in data["floors"]:
        for room_type in sorted({s["room_type"] for s in spaces_on(data, floor["id"])}):
            areas = sorted(ref_room_areas(data, floor["id"], room_type).items(), key=lambda kv: -kv[1])
            if len(areas) > 1 and areas[1][1] > 0.97 * areas[0][1]:
                ties += 1
                continue
            checked += 1
            got = skills.SKILLS["largest_room"](b, floor["id"], room_type)
            if got["space_id"] != areas[0][0] or abs(got["area_m2"] - areas[0][1]) > 0.01 + 1e-3 * areas[0][1]:
                problems.append((floor["id"], room_type, got["space_id"], got["area_m2"], areas[0]))
    return problems, checked, ties


def check_floor_area_total(directory, data, b):
    problems, checked = [], 0
    for floor in data["floors"]:
        for room_type in sorted({s["room_type"] for s in spaces_on(data, floor["id"])}):
            checked += 1
            expected = sum(ref_room_areas(data, floor["id"], room_type).values())
            got = skills.SKILLS["floor_area_total"](b, floor["id"], room_type)["total_m2"]
            if abs(got - expected) > 0.01 + 1e-3 * expected:
                problems.append((floor["id"], room_type, got, round(expected, 2)))
    return problems, checked, 0


def check_straight_line_3d(directory, data, b):
    problems = []
    rooms = room_ids(data)
    pairs = spread([(a, z) for i, a in enumerate(rooms) for z in rooms[i + 1 :]], CAP_PAIRS)
    for first, second in pairs:
        expected = math.dist(ref_centre_3d(data, first), ref_centre_3d(data, second))
        got = skills.SKILLS["straight_line_3d"](b, first, second)["distance_m"]
        if abs(got - expected) > 0.01 + 1e-3 * expected:
            problems.append((first, second, got, round(expected, 2)))
    return problems, len(pairs), 0


def check_room_stacked(directory, data, b):
    # README: only buildings whose floors share one XY frame (procedural and OSM) get these questions.
    if data["building"]["source"] not in {"procedural", "osm_indoor"}:
        return [], 0, 0
    problems, checked, ties = [], 0, 0
    for space_id in spread(room_ids(data), CAP_SPACES):
        for direction in ("above", "below"):
            ranked = ref_stacked(data, space_id, direction)
            if not ranked or ranked[0][0] <= 0:
                continue
            if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.05:
                ties += 1
                continue
            checked += 1
            try:
                got = skills.SKILLS["room_stacked"](b, space_id, direction)
            except Exception as error:  # noqa: BLE001 - a crash is a disagreement too
                problems.append((space_id, direction, repr(error), ranked[0][1]))
                continue
            if got["space_id"] != ranked[0][1]:
                problems.append((space_id, direction, got["space_id"], got.get("overlap_share"), ranked[:2]))
    return problems, checked, ties


def check_shared_walls_count(directory, data, b):
    problems, checked, ties = [], 0, 0
    for space_id in spread(room_ids(data), CAP_SPACES):
        lower, upper = ref_shared_walls_bounds(data, space_id)
        got = skills.SKILLS["shared_walls_count"](b, space_id)["count"]
        if lower == upper:
            checked += 1
        else:
            ties += 1
        if not lower <= got <= upper:
            problems.append((space_id, got, (lower, upper)))
    return problems, checked, ties


def check_wide_delivery_count(directory, data, b):
    problems, checked = [], 0
    for start in entrance_spaces(data):
        for width in WIDTHS:
            reached = ref_reachable(data, start, min_width=width)
            for floor in data["floors"]:
                checked += 1
                expected = ref_count_rooms(data, reached, floor["id"])
                got = skills.SKILLS["wide_delivery_count"](b, start, floor["id"], width)["count"]
                if got != expected:
                    problems.append((start, floor["id"], width, got, expected))
    return problems, checked, 0


def check_step_free_reachable_count(directory, data, b):
    problems, checked = [], 0
    connectors = sorted(data["vertical_connectors"], key=lambda c: (c["kind"] != "lift", c["id"]))
    closures = [c["id"] for c in connectors[:CAP_CLOSURES]]
    for start in entrance_spaces(data)[:2]:
        for closed in closures:
            reached = ref_reachable(data, start, closed=frozenset([closed]))
            for floor in data["floors"]:
                checked += 1
                expected = ref_count_rooms(data, reached, floor["id"])
                got = skills.SKILLS["step_free_reachable_count"](b, start, floor["id"], [closed])["count"]
                if got != expected:
                    problems.append((start, closed, floor["id"], got, expected))
    return problems, checked, 0


CHECKS = {kind: globals()[f"check_{kind}"] for kind in KINDS}

# Known disagreements where we believe the skill is wrong (not fixed here; see the report in the PR/issue).
# (building, kind) pairs where the skill is known to disagree with the reference; empty since room_stacked takes the
# next existing level (osm-way58216509 has levels 0 and 2, osm-way27326387 has -2, 0 and 1).
KNOWN: dict[tuple[str, str], str] = {}
CASES = [
    pytest.param(
        directory,
        kind,
        id=f"{name}-{kind}",
        marks=[pytest.mark.xfail(strict=True, reason=KNOWN[directory.name, kind])] if (directory.name, kind) in KNOWN else [],
    )
    for directory, name in zip(DIRECTORIES, IDS)
    for kind in KINDS
]


@pytest.mark.parametrize(("directory", "kind"), CASES)
def test_skills_match_reference(directory, kind):
    problems, _, _ = CHECKS[kind](directory, raw(directory), building(directory))
    assert not problems, problems
