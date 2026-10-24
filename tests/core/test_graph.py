"""Tests for core.graph under the 1.1.0 ruleset, cross-checked against the reference starter."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import networkx as nx
import pytest

from core.geometry import Geometry
from core.graph import (
    CLEAR,
    RouteConstraints,
    RouteError,
    build_graph,
    distances_from,
    exit_distance,
    route,
)
from core.model import Building, Opening
from starter_agent.building_map import BuildingMap
from tests.core.fixtures import minimal_building, rectangle


@pytest.fixture
def building() -> Building:
    return Building.from_dict(minimal_building())


@pytest.fixture
def geometry(building: Building) -> Geometry:
    return Geometry(building)


def _with_lift() -> dict:
    data = copy.deepcopy(minimal_building())
    data["vertical_connectors"].append(
        {
            "id": "V02",
            "kind": "lift",
            "name": "Lift",
            "floor_ids": ["F0", "F1"],
            "space_ids": ["F0-S004", "F1-S002"],
            "step_free": True,
        }
    )
    return data


def test_same_floor_route_matches_reference(building: Building, geometry: Geometry) -> None:
    reference = BuildingMap(minimal_building()).route("F0-S001", "F0-S003")
    result = route(building, geometry, "F0-S001", "F0-S003")
    assert result.length_m == pytest.approx(reference.length_m)
    assert result.space_path == reference.space_path


def test_stairs_cost_two_metres_per_metre_climbed() -> None:
    building = Building.from_dict(minimal_building())  # floors 3.0 m apart
    geometry = Geometry(building)
    assert route(building, geometry, "F0-S004", "F1-S002").length_m == pytest.approx(6.0)


def test_lift_costs_fixed_once_plus_one_per_metre() -> None:
    building = Building.from_dict(_with_lift())
    geometry = Geometry(building)
    graph = build_graph(building, geometry)
    assert len(graph["F0-S004"]["F1-S002"]) == 2  # stair and lift both present
    assert route(building, geometry, "F0-S004", "F1-S002").length_m == pytest.approx(6.0)  # stairs 2x3
    step_free = route(
        building, geometry, "F0-S004", "F1-S002", constraints=RouteConstraints(step_free=True)
    )
    assert step_free.length_m == pytest.approx(15.0 + 3.0)  # lift: 15 m once + 1 x 3.0 m


def test_step_free_drops_stairs_but_keeps_lifts() -> None:
    building = Building.from_dict(_with_lift())
    geometry = Geometry(building)
    only_stairs = Building.from_dict(minimal_building())
    with pytest.raises(RouteError, match="step-free"):
        route(
            only_stairs, Geometry(only_stairs), "F0-S001", "F1-S001", constraints=RouteConstraints(step_free=True)
        )
    result = route(building, geometry, "F0-S001", "F1-S001", constraints=RouteConstraints(step_free=True))
    assert result.step_free is True


def test_min_door_width_filters_openings(building: Building, geometry: Geometry) -> None:
    narrow = RouteConstraints(min_door_width_m=1.0)
    with pytest.raises(RouteError):
        route(building, geometry, "F0-S002", "F0-S003", constraints=narrow)  # office door is 0.9 m
    ok = route(building, geometry, "F0-S002", "F0-S003", constraints=RouteConstraints(min_door_width_m=0.9))
    assert ok.space_path == ["F0-S002", "F0-S003"]


def test_closed_drops_elements(building: Building, geometry: Geometry) -> None:
    constraints = RouteConstraints(closed=frozenset({"F0-O0003"}))
    with pytest.raises(RouteError, match="F0-O0003"):
        route(building, geometry, "F0-S001", "F0-S003", constraints=constraints)


def test_extra_openings_act_as_normal_doors(building: Building, geometry: Geometry) -> None:
    wide_door = Opening(
        id="F0-O9999",
        floor_id="F0",
        space_ids=("F0-S002", "F0-S003"),
        kind="door",
        position=(10.0, 8.0),
        width_m=1.5,
    )
    constraints = RouteConstraints(min_door_width_m=1.0, extra_openings=(wide_door,))
    result = route(building, geometry, "F0-S002", "F0-S003", constraints=constraints)
    assert result.space_path == ["F0-S002", "F0-S003"]
    assert result.element_path == ["F0-O9999"]


def _building_with_backyard() -> Building:
    data = copy.deepcopy(minimal_building())
    data["spaces"].append(
        {
            "id": "F0-S005",
            "floor_id": "F0",
            "type": "room",
            "room_type": "storage",
            "name": "Backyard 0.05",
            "ref": "0.05",
            "polygon": rectangle(20, 0, 4, 10),
        }
    )
    data["openings"].append(
        {
            "id": "F0-O0006",
            "floor_id": "F0",
            "space_ids": ["F0-S003", "F0-S005"],
            "kind": "door",
            "position": [20.0, 5.0],
            "width_m": 1.0,
            "step_free": True,
        }
    )
    return Building.from_dict(data)


def test_no_transit_spaces_are_sinks_but_reachable() -> None:
    building = _building_with_backyard()
    geometry = Geometry(building)
    constraints = RouteConstraints(no_transit=frozenset({"F0-S003"}))
    with pytest.raises(RouteError):
        route(building, geometry, "F0-S001", "F0-S005", constraints=constraints)  # office would be a shortcut
    destination = route(building, geometry, "F0-S001", "F0-S003", constraints=constraints)
    assert destination.space_path[-1] == "F0-S003"
    leaving = route(building, geometry, "F0-S003", "F0-S005", constraints=constraints)  # start may leave its bay
    assert leaving.space_path == ["F0-S003", "F0-S005"]


def test_distances_from_lists_reachable_spaces_only(building: Building, geometry: Geometry) -> None:
    distances = distances_from(building, geometry, "F0-S002")
    assert set(distances) == {"F0-S001", "F0-S002", "F0-S003", "F0-S004", "F1-S001", "F1-S002"}
    assert distances["F0-S001"] == pytest.approx(
        route(building, geometry, "F0-S002", "F0-S001").length_m, abs=0.011
    )
    narrow = distances_from(building, geometry, "F0-S002", RouteConstraints(min_door_width_m=1.0))
    assert "F0-S003" not in narrow


def test_exit_distance_walks_to_the_entrance_itself(building: Building, geometry: Geometry) -> None:
    length, entrance = exit_distance(building, geometry, "F0-S003")
    reference_map = BuildingMap(minimal_building())
    reference_graph = reference_map.graph(step_free=False)
    reference_length = nx.single_source_dijkstra(
        reference_graph, "F0-S003", "door:F0-O0001", weight="weight"
    )[0]
    assert entrance == "F0-O0001"
    assert length == pytest.approx(round(reference_length, 2))


def test_exit_distance_none_when_unreachable(building: Building, geometry: Geometry) -> None:
    length, entrance = exit_distance(building, geometry, "F1-S001", constraints=RouteConstraints(step_free=True))
    assert length is None and entrance is None


def test_tour_routes_stops_in_order(building: Building, geometry: Geometry) -> None:
    result = route(building, geometry, "F0-S001", "F1-S001", via=["F0-S003"])
    assert [leg.destination_id for leg in result.legs] == ["F0-S003", "F1-S001"]
    expected = (
        route(building, geometry, "F0-S001", "F0-S003").length_m
        + route(building, geometry, "F0-S003", "F1-S001").length_m
    )
    assert result.length_m == pytest.approx(expected)


def test_routes_match_reference_on_a_real_dev_building() -> None:
    building_file = Path(__file__).resolve().parents[2] / "data/dev/proc-factory-dev-003/building.json"
    if not building_file.exists():
        pytest.skip("dataset not present")
    data = json.loads(building_file.read_text())
    building = Building.from_dict(data)
    geometry = Geometry(building)
    reference_map = BuildingMap(data)
    space_ids = list(building.spaces)[:8]
    compared = 0
    for start in space_ids:
        for destination in space_ids:
            if start == destination:
                continue
            expected = reference_map.route(start, destination)
            result = route(building, geometry, start, destination)
            assert result.length_m == pytest.approx(expected.length_m), (start, destination)
            assert result.space_path == expected.space_path, (start, destination)
            compared += 1
    assert compared >= 20
