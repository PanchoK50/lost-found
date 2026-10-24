"""Tests for core.queries: the nine benchmark question kinds on hand-built buildings."""

from __future__ import annotations

import copy

import pytest

from core.geometry import Geometry
from core.graph import route
from core.model import Building
from core.queries import (
    QueryError,
    errand,
    floor_area_total,
    largest_room,
    room_stacked,
    shared_walls_count,
    step_free_reachable_count,
    straight_line_3d,
    what_if_door,
    wide_delivery_count,
)
from tests.core.fixtures import minimal_building, rectangle, with_lift


@pytest.fixture
def building() -> Building:
    return Building.from_dict(minimal_building())


@pytest.fixture
def geometry(building: Building) -> Geometry:
    return Geometry(building)


def _backyard_building() -> Building:
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


def test_largest_room(building: Building, geometry: Geometry) -> None:
    result = largest_room(building, geometry, "F0", "office")
    assert result.space_id == "F0-S003"
    assert result.area_m2 == pytest.approx(100.0)
    assert result.name == "Office 0.03"
    assert result.as_dict()["ref"] == "0.03"


def test_largest_room_without_candidates_raises(building: Building, geometry: Geometry) -> None:
    with pytest.raises(QueryError, match="kitchen"):
        largest_room(building, geometry, "F0", "kitchen")


def test_floor_area_total(building: Building, geometry: Geometry) -> None:
    assert floor_area_total(building, geometry, "F0", "office") == pytest.approx(100.0)
    assert floor_area_total(building, geometry, "F0", "lobby") == pytest.approx(48.0)


def test_errand_walks_via_nearest_asset_to_largest_target(building: Building, geometry: Geometry) -> None:
    result = errand(building, geometry, "F0-S001", "printer", "F1", "office")
    assert result.via_id == "F0-S003"  # the office holds the printer
    assert result.target_id == "F1-S001"  # the only (largest) office on F1
    first_leg = route(building, geometry, "F0-S001", "F0-S003").length_m
    second_leg = route(building, geometry, "F0-S003", "F1-S001").length_m
    assert result.total_m == pytest.approx(first_leg + second_leg, abs=0.011)


def test_errand_without_asset_raises(building: Building, geometry: Geometry) -> None:
    with pytest.raises(QueryError, match="stove"):
        errand(building, geometry, "F0-S001", "stove", "F1", "office")


def test_room_stacked(building: Building, geometry: Geometry) -> None:
    assert room_stacked(building, geometry, "F0-S003", "above").space_id == "F1-S001"
    assert room_stacked(building, geometry, "F1-S001", "below").space_id == "F0-S003"
    with pytest.raises(QueryError, match="above"):
        room_stacked(building, geometry, "F1-S001", "above")


def test_shared_walls_counts_rooms_and_halls_only(building: Building, geometry: Geometry) -> None:
    # The office touches corridor and stairwell (both excluded) only.
    assert shared_walls_count(building, geometry, "F0-S003") == 0
    backyard = _backyard_building()
    assert shared_walls_count(backyard, Geometry(backyard), "F0-S003") == 1  # backyard storage room


def test_straight_line_3d(building: Building, geometry: Geometry) -> None:
    assert straight_line_3d(building, geometry, "F0-S003", "F1-S001") == pytest.approx(3.0)


def test_wide_delivery_count(building: Building, geometry: Geometry) -> None:
    # Doors from the lobby: entrance 1.6, to corridor 1.2, office door only 0.9.
    assert wide_delivery_count(building, geometry, "F0-S001", "F0", 1.2) == 1
    assert wide_delivery_count(building, geometry, "F0-S001", "F0", 0.9) == 2  # lobby + office


def test_step_free_reachable_count() -> None:
    building = Building.from_dict(with_lift())
    geometry = Geometry(building)
    # The stairs are not step-free; the lift is. Closing the lift leaves no way up.
    assert step_free_reachable_count(building, geometry, "F0-S001", "F1", set()) == 1
    assert step_free_reachable_count(building, geometry, "F0-S001", "F1", {"V02"}) == 0


def _detour_building() -> Building:
    """Lobby -> corridor -> room B -> room A; A's only exit runs through B."""
    data = copy.deepcopy(minimal_building())
    data["spaces"] = [
        {**data["spaces"][0], "polygon": rectangle(0, 0, 8, 6)},
        {**data["spaces"][1], "id": "C1", "name": "Corridor", "ref": "0.02", "polygon": rectangle(8, 0, 2, 20)},
        {**data["spaces"][2], "id": "B", "name": "Room B", "ref": "0.03", "polygon": rectangle(10, 0, 10, 6)},
        {**data["spaces"][3], "id": "A", "name": "Room A", "ref": "0.04",
         "type": "room", "room_type": "office", "polygon": rectangle(10, 6, 10, 6)},
    ]
    data["floors"] = [data["floors"][0]]
    data["spaces"] = [space for space in data["spaces"] if space["floor_id"] == "F0"][:4]
    data["openings"] = [
        {"id": "O1", "floor_id": "F0", "space_ids": ["outside", data["spaces"][0]["id"]],
         "kind": "entrance", "position": [4.0, 0.0], "width_m": 1.6, "step_free": True},
        {"id": "O2", "floor_id": "F0", "space_ids": [data["spaces"][0]["id"], "C1"],
         "kind": "door", "position": [8.0, 3.0], "width_m": 1.2, "step_free": True},
        {"id": "O3", "floor_id": "F0", "space_ids": ["C1", "B"],
         "kind": "door", "position": [10.0, 1.0], "width_m": 1.2, "step_free": True},
        {"id": "O4", "floor_id": "F0", "space_ids": ["B", "A"],
         "kind": "door", "position": [19.0, 6.0], "width_m": 1.2, "step_free": True},
    ]
    data["vertical_connectors"] = []
    data["assets"] = []
    return Building.from_dict(data)


def test_what_if_door_counts_rooms_with_shorter_exit() -> None:
    building = _detour_building()
    geometry = Geometry(building)
    result = what_if_door(building, geometry, "C1", "A", "F0")
    assert result.affected_space_ids == ("A",)
    assert result.improved_count == 1
    lobby_id = next(space.id for space in building.spaces.values() if space.room_type == "lobby")
    with pytest.raises(QueryError, match="share no wall"):
        what_if_door(building, geometry, lobby_id, "A", "F0")
