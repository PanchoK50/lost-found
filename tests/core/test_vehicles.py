"""Tests for core.vehicles: width-constrained profiles and the forklift sanity check."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.geometry import Geometry
from core.graph import RouteError, distances_from, route
from core.model import Building
from core.vehicles import Vehicle, for_vehicle, forklift
from tests.core.fixtures import rectangle


def _factory() -> Building:
    """A main aisle (4 m), a logistics zone behind a 6 m opening, an office behind a 0.9 m door."""
    return Building.from_dict(
        {
            "building": {"id": "mini-factory", "name": "Mini Factory", "source": "test",
                         "license": "CC0-1.0", "units": "m"},
            "floors": [{"id": "F0", "level": 0, "name": "Ground floor",
                        "elevation_m": 0.0, "height_m": 8.0}],
            "spaces": [
                {"id": "AISLE", "floor_id": "F0", "type": "corridor", "room_type": "corridor",
                 "name": "Main aisle", "ref": "H-A", "polygon": rectangle(0, 0, 4, 30)},
                {"id": "ZONE1", "floor_id": "F0", "type": "hall", "room_type": "logistics_zone",
                 "name": "Logistics zone 1", "ref": "H-C1", "polygon": rectangle(4, 0, 10, 10)},
                {"id": "ZONE2", "floor_id": "F0", "type": "hall", "room_type": "logistics_zone",
                 "name": "Logistics zone 2", "ref": "H-C2", "polygon": rectangle(14, 0, 8, 8)},
                {"id": "OFFICE", "floor_id": "F0", "type": "room", "room_type": "office",
                 "name": "Office 0.01", "ref": "0.01", "polygon": rectangle(4, 12, 6, 6)},
            ],
            "openings": [
                {"id": "E1", "floor_id": "F0", "space_ids": ["outside", "AISLE"], "kind": "entrance",
                 "position": [2.0, 0.0], "width_m": 5.0, "step_free": True},
                {"id": "O1", "floor_id": "F0", "space_ids": ["AISLE", "ZONE1"], "kind": "opening",
                 "position": [4.0, 5.0], "width_m": 6.0, "step_free": True},
                {"id": "O2", "floor_id": "F0", "space_ids": ["ZONE1", "ZONE2"], "kind": "opening",
                 "position": [14.0, 4.0], "width_m": 6.0, "step_free": True},
                {"id": "O3", "floor_id": "F0", "space_ids": ["AISLE", "OFFICE"], "kind": "door",
                 "position": [4.0, 15.0], "width_m": 0.9, "step_free": True},
            ],
            "vertical_connectors": [],
            "assets": [],
        }
    )


def test_forklift_uses_wide_aisles_and_openings_only() -> None:
    building = _factory()
    geometry = Geometry(building)
    distances = distances_from(building, geometry, "AISLE", forklift(building))
    assert "ZONE1" in distances
    assert "ZONE2" not in distances  # ZONE2 sits behind ZONE1, and bays may not be crossed
    assert "OFFICE" not in distances  # 0.9 m door
    # With the width filter alone (no bay sinks), the chained zone is reachable too.
    plain = for_vehicle(building, Vehicle(width_m=3.0))
    assert "ZONE2" in distances_from(building, geometry, "AISLE", plain)


def test_trolley_profile() -> None:
    building = _factory()
    geometry = Geometry(building)
    constraints = for_vehicle(building, Vehicle(width_m=1.1))
    distances = distances_from(building, geometry, "AISLE", constraints)
    assert "ZONE1" in distances
    assert "OFFICE" not in distances
    pedestrian = for_vehicle(building, Vehicle(width_m=0.9))
    assert "OFFICE" in distances_from(building, geometry, "AISLE", pedestrian)


def test_zones_are_destinations_not_shortcuts() -> None:
    building = _factory()
    geometry = Geometry(building)
    constraints = forklift(building)
    # ZONE1 sits between the aisle and ZONE2, but bays may not be crossed.
    with pytest.raises(RouteError):
        route(building, geometry, "AISLE", "ZONE2", constraints=constraints)
    # Delivering INTO a bay works, and starting in one may leave it (directly to the aisle).
    assert route(building, geometry, "AISLE", "ZONE1", constraints=constraints).space_path[-1] == "ZONE1"
    assert route(building, geometry, "ZONE1", "AISLE", constraints=constraints).space_path[-1] == "AISLE"
    # ZONE2's only exit would cross ZONE1, so even starting there cannot reach the aisle.
    with pytest.raises(RouteError):
        route(building, geometry, "ZONE2", "AISLE", constraints=constraints)


def test_width_profile_reaches_every_logistics_zone_in_real_factories() -> None:
    data_root = Path(__file__).resolve().parents[2] / "data"
    buildings = sorted(data_root.glob("*/proc-factory-*/building.json"))
    if not buildings:
        pytest.skip("dataset not present")
    checked = 0
    for building_file in buildings:
        building = Building.load(building_file)
        wide_entrances = [
            opening_id
            for opening_id in building.entrances
            if building.openings[opening_id].width_m >= 3.0
        ]
        if not wide_entrances:
            continue
        geometry = Geometry(building)
        start = building.entrance_into(wide_entrances[0])
        # Width filter only: every logistics zone is drivable from its dock entrance.
        distances = distances_from(
            building, geometry, start, for_vehicle(building, Vehicle(width_m=3.0))
        )
        zones = [
            space.id
            for space in building.spaces.values()
            if space.room_type == "logistics_zone" and space.floor_id == building.spaces[start].floor_id
        ]
        assert zones, building_file.parent.name
        for zone in zones:
            assert zone in distances, (building_file.parent.name, zone)
        checked += 1
    assert checked >= 15
