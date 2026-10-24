"""Tests for core.geometry: areas, centroids, widths, walls, stacking, 3D."""

from __future__ import annotations

import copy
import math
from pathlib import Path

import pytest
from shapely.geometry import Polygon

from core.geometry import Geometry
from core.model import Building
from tests.core.fixtures import minimal_building, rectangle


@pytest.fixture
def building() -> Building:
    return Building.from_dict(minimal_building())


@pytest.fixture
def geometry(building: Building) -> Geometry:
    return Geometry(building)


def test_area_centroid_and_anchor(geometry: Geometry) -> None:
    assert geometry.area_m2("F0-S001") == pytest.approx(48.0)
    assert geometry.centroid("F0-S001") == pytest.approx((4.0, 3.0))
    anchor = geometry.anchor("F0-S001")
    assert Polygon(rectangle(0, 0, 8, 6)).contains(Polygon([anchor, (anchor[0] + 0.01, anchor[1]), (anchor[0], anchor[1] + 0.01)]))
    # The anchor must be exactly shapely's representative_point of the same polygon.
    reference = Polygon(minimal_building()["spaces"][0]["polygon"]).representative_point()
    assert anchor == (reference.x, reference.y)


def test_min_width_matches_rectangle_sides(geometry: Geometry) -> None:
    assert geometry.min_width_m("F0-S002") == pytest.approx(2.0)  # corridor 2 x 20
    assert geometry.min_width_m("F0-S003") == pytest.approx(10.0)  # office 10 x 10


def test_shared_walls_on_ground_floor(geometry: Geometry) -> None:
    walls = geometry.shared_walls("F0")
    pairs = {tuple(sorted((wall.space_a, wall.space_b))): wall for wall in walls.values()}
    assert set(pairs) == {
        ("F0-S001", "F0-S002"),  # lobby | corridor: x=8, y in [0, 6]
        ("F0-S002", "F0-S003"),  # corridor | office: x=10, y in [0, 10]
        ("F0-S002", "F0-S004"),  # corridor | stairwell: x=10, y in [10, 14]
        ("F0-S003", "F0-S004"),  # office | stairwell: y=10, x in [10, 14]
    }
    lobby_wall = walls[frozenset(("F0-S001", "F0-S002"))]
    # Measured with the 0.35 m proximity buffer, the stretch inflates by the buffer
    # radius at both ends (6.0 m shared + 2 x 0.35 m). This matches the dataset's
    # expected answers exactly (calibrated 143/143 on train+dev).
    assert lobby_wall.length_m == pytest.approx(6.7)
    # The midpoint is the middle of the main shared stretch (where a what-if door goes).
    assert lobby_wall.midpoint == pytest.approx((8.0, 3.0))
    assert geometry.wall_between("F0-S001", "F0-S003") is None  # 2 m gap


def test_shared_wall_threshold_semantics() -> None:
    # The measured length includes the 0.35 m buffer fan-out at the stretch ends,
    # so an outline overlap of 0.5 m measures 1.2 m and counts, while 0.2 m (0.9 m
    # measured) does not. Calibrated against all train+dev shared_walls_count answers.
    data = copy.deepcopy(minimal_building())
    data["spaces"] = [
        {**data["spaces"][0], "id": "A", "polygon": rectangle(0, 0, 5, 5)},
        {**data["spaces"][1], "id": "B", "polygon": rectangle(5, 2, 5, 0.5)},
    ]
    data["openings"] = []
    data["vertical_connectors"] = []
    data["assets"] = []
    geometry = Geometry(Building.from_dict(data))
    assert geometry.wall_between("A", "B") is not None
    data["spaces"][1]["polygon"] = rectangle(5, 2, 5, 0.2)
    geometry = Geometry(Building.from_dict(data))
    assert geometry.wall_between("A", "B") is None


def test_walls_through_thickness_count_as_shared() -> None:
    # Parallel outlines 0.2 m apart (wall thickness) share, per the definition.
    data = copy.deepcopy(minimal_building())
    data["spaces"] = [
        {**data["spaces"][0], "id": "A", "polygon": rectangle(0, 0, 5, 4)},
        {**data["spaces"][1], "id": "B", "polygon": rectangle(5.2, 0, 5, 4)},
    ]
    data["openings"] = []
    data["vertical_connectors"] = []
    data["assets"] = []
    geometry = Geometry(Building.from_dict(data))
    wall = geometry.wall_between("A", "B")
    assert wall is not None
    assert wall.length_m == pytest.approx(4.3)  # 4.0 m shared + 2 x 0.35 m buffer fan-out
    assert wall.midpoint == pytest.approx((5.0, 2.0))


def test_stacking_above_and_below(geometry: Geometry) -> None:
    assert geometry.space_above("F0-S003") == "F1-S001"  # office 1.01 fully overlaps office 0.03
    assert geometry.space_below("F1-S001") == "F0-S003"
    assert geometry.space_above("F0-S001") is None  # nothing above the lobby
    assert geometry.space_above("F1-S001") is None  # top floor


def test_distance_3d_uses_centroids_and_elevations(geometry: Geometry) -> None:
    # Same centroid (15, 5), floors 3.0 m apart.
    assert geometry.distance_3d("F0-S003", "F1-S001") == pytest.approx(3.0)
    assert geometry.distance_3d("F0-S001", "F1-S001") == math.dist((4, 3, 0), (15, 5, 3))


def test_geometry_on_real_dev_building() -> None:
    building_file = Path(__file__).resolve().parents[2] / "data/dev/proc-factory-dev-003/building.json"
    if not building_file.exists():
        pytest.skip("dataset not present")
    building = Building.load(building_file)
    geometry = Geometry(building)
    areas = [geometry.area_m2(space_id) for space_id in building.spaces]
    assert all(area > 0 for area in areas)
    floor_id = building.floors_sorted()[0].id
    assert geometry.shared_walls(floor_id)  # a real factory floor has shared walls
