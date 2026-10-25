"""Straightening of raster-traced room outlines (lostfound.ingest.straighten)."""

import math

import cv2
import numpy as np
import pytest
from shapely.geometry import Polygon

from lostfound.ingest.straighten import straighten_floor


def jag(points, pixel=0.07, seed=0):
    """Trace a ring like the PNG pipeline does: rasterise it at `pixel` metres per pixel, flip a few boundary
    pixels (anti-aliasing noise), take the contour and simplify it by 0.9 px."""
    rng = np.random.default_rng(seed)
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    x0, y0 = min(xs) - 1, min(ys) - 1
    width, height = int((max(xs) - x0 + 1) / pixel) + 1, int((max(ys) - y0 + 1) / pixel) + 1
    image = np.zeros((height, width), np.uint8)
    cv2.fillPoly(image, [np.array([[(x - x0) / pixel, (y - y0) / pixel] for x, y in points], np.int32)], 1)
    edge = cv2.dilate(image, np.ones((3, 3), np.uint8)) - cv2.erode(image, np.ones((3, 3), np.uint8))
    flip = (edge == 1) & (rng.random(image.shape) < 0.03)
    image[flip] = 1 - image[flip]
    _, labels, stats, _ = cv2.connectedComponentsWithStats(image, connectivity=4)
    image = (labels == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    contour = max(cv2.findContours(image, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], key=cv2.contourArea)
    simplified = cv2.approxPolyDP(contour, 0.9, True)[:, 0, :].astype(float)
    return [[float(x0 + x * pixel), float(y0 + y * pixel)] for x, y in simplified]


def rotate(points, degrees, origin=(0.0, 0.0)):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return [[origin[0] + (x - origin[0]) * c - (y - origin[1]) * s, origin[1] + (x - origin[0]) * s + (y - origin[1]) * c] for x, y in points]


def edge_angles(points):
    return [math.degrees(math.atan2(q[1] - p[1], q[0] - p[0])) % 180 for p, q in zip(points, points[1:] + points[:1])]


def gap(a, b, period=90.0):
    d = abs(a - b) % period
    return min(d, period - d)


def chamfer(points, size=0.07):
    """Cut every corner by a tiny chamfer (the stair-step corners of a pixel trace)."""
    out = []
    n = len(points)
    for i, p in enumerate(points):
        prev, nxt = points[i - 1], points[(i + 1) % n]
        for q in (prev, nxt):
            d = math.dist(p, q)
            out.append([p[0] + (q[0] - p[0]) * size / d, p[1] + (q[1] - p[1]) * size / d])
    return out


def test_jagged_rectangle_becomes_four_corners():
    truth = [(0, 0), (6, 0), (6, 4), (0, 4)]
    trace = jag(truth)
    spaces = [{"polygon": [list(p) for p in trace]}]
    report = straighten_floor(spaces)
    polygon = spaces[0]["polygon"]
    assert len(polygon) == 4
    assert report["changed"] == 1
    assert all(gap(a, 0) < 0.5 for a in edge_angles(polygon))
    assert Polygon(polygon).area == pytest.approx(24, rel=0.02)
    # the trace sits up to half a pixel inside the drawn outline; the straight result follows the trace
    assert Polygon(polygon).symmetric_difference(Polygon(trace)).area < 0.3


def test_rotated_l_shape_keeps_its_angle():
    l_shape = [(0, 0), (8, 0), (8, 3), (3, 3), (3, 7), (0, 7)]
    truth = rotate([list(p) for p in l_shape], 23)
    spaces = [{"polygon": jag(truth, seed=1)}]
    report = straighten_floor(spaces)
    polygon = spaces[0]["polygon"]
    assert len(polygon) == 6
    assert gap(report["angle_deg"], 23) < 1.0
    assert all(gap(a, 23) < 1.0 for a in edge_angles(polygon))
    assert Polygon(polygon).area == pytest.approx(Polygon(truth).area, rel=0.03)


def test_neighbours_share_one_wall_line():
    left = [[0, 0], [5.03, 0], [5.03, 4], [0, 4]]
    right = [[4.94, 0], [9, 0], [9, 4], [4.94, 4]]
    spaces = [{"polygon": chamfer(left)}, {"polygon": chamfer(right)}]
    straighten_floor(spaces)
    a, b = Polygon(spaces[0]["polygon"]), Polygon(spaces[1]["polygon"])
    assert len(spaces[0]["polygon"]) == len(spaces[1]["polygon"]) == 4
    assert max(x for x, _ in spaces[0]["polygon"]) == pytest.approx(min(x for x, _ in spaces[1]["polygon"]), abs=1e-3)
    assert a.intersection(b).area < 1e-3
    assert a.union(b).area == pytest.approx(36, rel=0.02)


def test_diagonal_wall_stays_diagonal():
    truth = [(0, 0), (6, 0), (6, 2), (4, 4), (0, 4)]  # one 45 degree wall
    trace = jag(truth, seed=2)
    spaces = [{"polygon": [list(p) for p in trace]}]
    straighten_floor(spaces)
    polygon = spaces[0]["polygon"]
    assert len(polygon) == 5
    angles = edge_angles(polygon)
    assert sum(gap(a, 45, 180) < 2 or gap(a, 135, 180) < 2 for a in angles) == 1
    assert Polygon(polygon).symmetric_difference(Polygon(trace)).area < 0.3


def test_circle_falls_back_unchanged():
    circle = [[3 + 2.5 * math.cos(2 * math.pi * k / 48), 3 + 2.5 * math.sin(2 * math.pi * k / 48)] for k in range(48)]
    spaces = [{"polygon": [list(p) for p in circle]}]
    report = straighten_floor(spaces)
    assert spaces[0]["polygon"] == circle
    assert report["kept"] == 1


def test_area_stays_within_tolerance_on_a_floor():
    rooms = [
        [(0, 0), (4, 0), (4, 3), (0, 3)],
        [(4, 0), (10, 0), (10, 3), (4, 3)],
        [(0, 3), (10, 3), (10, 5), (0, 5)],
        [(0, 5), (6, 5), (6, 9), (3, 9), (3, 7), (0, 7)],
    ]
    spaces = [{"polygon": jag(rotate([list(p) for p in r], 67), seed=i)} for i, r in enumerate(rooms)]
    before = [Polygon(s["polygon"]).area for s in spaces]
    report = straighten_floor(spaces)
    assert report["changed"] == 4
    for space, area in zip(spaces, before):
        assert Polygon(space["polygon"]).is_valid
        assert Polygon(space["polygon"]).area == pytest.approx(area, rel=0.05)
    polygons = [Polygon(s["polygon"]) for s in spaces]
    for i in range(len(polygons)):
        for j in range(i + 1, len(polygons)):
            assert polygons[i].intersection(polygons[j]).area < 0.05


def test_deterministic():
    truth = rotate([[0, 0], [8, 0], [8, 3], [3, 3], [3, 7], [0, 7]], 23)
    first, second = [{"polygon": jag(truth, seed=4)}], [{"polygon": jag(truth, seed=4)}]
    straighten_floor(first)
    straighten_floor(second)
    assert first == second


def test_wall_gap_between_facing_rooms_stays():
    """Plans that leave the wall between two rooms empty keep it: only rooms that touch or overlap share a line."""
    below = [[0, 0], [5, 0], [5, 3.0], [0, 3.0]]
    above = [[0, 3.12], [5, 3.12], [5, 6], [0, 6]]
    spaces = [{"polygon": chamfer(below)}, {"polygon": chamfer(above)}]
    straighten_floor(spaces)
    top = max(y for _, y in spaces[0]["polygon"])
    bottom = min(y for _, y in spaces[1]["polygon"])
    assert top == pytest.approx(3.0, abs=0.01)
    assert bottom == pytest.approx(3.12, abs=0.01)


def test_rooms_in_a_row_align_with_the_corridor():
    corridor = [[0, 0], [12, 0], [12, 2], [0, 2]]
    rooms = [[[x, 1.96 + 0.04 * k], [x + 4, 1.96 + 0.04 * k], [x + 4, 6], [x, 6]] for k, x in enumerate((0, 4, 8))]
    spaces = [{"polygon": chamfer(corridor)}] + [{"polygon": chamfer(r)} for r in rooms]
    straighten_floor(spaces)
    corridor_top = max(y for _, y in spaces[0]["polygon"])
    for space in spaces[1:]:
        assert min(y for _, y in space["polygon"]) == pytest.approx(corridor_top, abs=1e-3)


FLOOR = [  # two rows of rooms along a corridor, 24 x 14 m
    [(0, 0), (14, 0), (14, 6), (0, 6)],
    [(14, 0), (24, 0), (24, 6), (14, 6)],
    [(0, 6), (24, 6), (24, 8), (0, 8)],
    [(0, 8), (9, 8), (9, 14), (0, 14)],
    [(9, 8), (24, 8), (24, 14), (9, 14)],
]


@pytest.mark.parametrize("degrees", [1.5, 3.0])
def test_slightly_rotated_floor_keeps_its_angle(degrees):
    """A pixel trace of a plan rotated by a few degrees is a staircase of exactly horizontal runs; the grid
    angle must still be the plan's, not 0 (else every wall comes out as a staircase or slanted)."""
    spaces = [{"polygon": jag(rotate([list(p) for p in room], degrees), pixel=0.05, seed=i)} for i, room in enumerate(FLOOR)]
    report = straighten_floor(spaces)
    assert gap(report["angle_deg"], degrees) < 0.2
    assert [len(space["polygon"]) for space in spaces] == [4] * len(FLOOR)
    assert all(gap(a, degrees) < 0.2 for space in spaces for a in edge_angles(space["polygon"]))


def test_coarse_plan_scales_with_its_pixel():
    """At 0.2 m per pixel the pixel steps are longer than the jaggy threshold; with pixel_m the thresholds
    grow with the pixel and the walls still come out straight."""
    spaces = [{"polygon": jag([list(p) for p in room], pixel=0.2, seed=i)} for i, room in enumerate(FLOOR)]
    before = [Polygon(space["polygon"]).area for space in spaces]
    report = straighten_floor(spaces, pixel_m=0.2)
    assert report["length_scale"] == pytest.approx(0.2 / 0.07, rel=1e-3)
    assert sum(len(space["polygon"]) for space in spaces) <= 4 * len(FLOOR) + 4
    for space, area in zip(spaces, before):
        assert Polygon(space["polygon"]).is_valid
        assert Polygon(space["polygon"]).area == pytest.approx(area, rel=0.05)
        assert all(gap(a, 0) < 0.5 for a in edge_angles(space["polygon"]))


def test_single_small_room_is_not_tilted():
    """Too few walls to refine the grid angle: a lone lift stays on the histogram angle."""
    spaces = [{"polygon": jag([(0, 0), (1.4, 0), (1.4, 1.4), (0, 1.4)], seed=3)}]
    report = straighten_floor(spaces)
    assert report["angle_deg"] == 0.0
    assert len(spaces[0]["polygon"]) == 4


def test_degenerate_polygons_are_kept():
    spaces = [
        {"polygon": []},
        {"polygon": [[0, 0], [1, 1]]},
        {"polygon": [[0, 0], [4, 0], [8, 0]]},
        {"polygon": [[0, 0], [4, 3], [4, 0], [0, 3]]},  # bow tie
        {"polygon": jag([(10, 0), (16, 0), (16, 4), (10, 4)])},
    ]
    originals = [list(space["polygon"]) for space in spaces[:4]]
    report = straighten_floor(spaces)
    assert [space["polygon"] for space in spaces[:4]] == originals
    assert report["changed"] == 1 and len(spaces[4]["polygon"]) == 4


def test_duplicate_and_closing_points():
    spaces = [{"polygon": [[0, 0], [0, 0], [4, 0], [4, 0], [4, 3], [0, 3], [0, 0]]}]
    straighten_floor(spaces)
    polygon = spaces[0]["polygon"]
    assert len(polygon) == 4 and polygon[0] != polygon[-1]
    assert Polygon(polygon).area == pytest.approx(12)


@pytest.mark.parametrize("clockwise", [False, True])
def test_orientation_kept_and_no_micro_edges(clockwise):
    """Results keep the trace's orientation and have no vertices a few millimetres apart (shifting the floor
    later rounds them onto each other)."""
    rooms = [[(0, 0), (5, 0), (5, 4), (0, 4)], [(5, 0), (9, 0), (9, 4), (5, 4)], [(0, 4), (9, 4), (9, 6), (0, 6)]]
    spaces = []
    for i, room in enumerate(rooms):
        trace = jag(rotate([list(p) for p in room], 31), seed=10 + i)
        spaces.append({"polygon": trace[::-1] if clockwise else trace})
    ccw = [Polygon(space["polygon"]).exterior.is_ccw for space in spaces]
    straighten_floor(spaces)
    assert [Polygon(space["polygon"]).exterior.is_ccw for space in spaces] == ccw
    for space in spaces:
        ring = space["polygon"]
        assert all(math.dist(ring[k - 1], ring[k]) >= 0.004 for k in range(len(ring)))


def test_bumps_in_a_noisy_wall_do_not_become_diagonals():
    """Short slanted edges of a bump in the trace are noise: a noisy rectangle has four corners."""
    corners = []
    for seed in range(10):
        spaces = [{"polygon": jag([(0, 0), (16, 0), (16, 4), (0, 4)], seed=seed)}]
        straighten_floor(spaces)
        corners.append(len(spaces[0]["polygon"]))
    assert corners == [4] * 10


def test_tidy_merges_micro_edges_and_restores_orientation():
    """The overlap repair rebuilds rings from shapely's difference: other orientation, millimetre edges."""
    from lostfound.ingest.straighten import _tidy

    original = [[0, 0], [4, 0], [4, 3], [0, 3]]  # counter-clockwise
    repaired = [[0, 0], [0, 3], [4, 3], [4, 0.001], [4, 0]]  # clockwise, with a 1 mm edge
    tidy = _tidy(repaired, original)
    assert len(tidy) == 4
    assert Polygon(tidy).exterior.is_ccw
    assert Polygon(tidy).area == pytest.approx(12, abs=0.01)
