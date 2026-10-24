"""Tests for core.model: parsing, validation, and derived indexes."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from core.model import Building, ModelError
from tests.core.fixtures import minimal_building, mutated_building, rectangle


def test_from_dict_parses_entities_and_indexes() -> None:
    building = Building.from_dict(minimal_building())
    assert building.meta.id == "test-building"
    assert building.meta.units == "m"
    assert len(building.floors) == 2
    assert len(building.spaces) == 6
    assert len(building.openings) == 5
    assert len(building.connectors) == 1
    assert len(building.assets) == 1

    lobby = building.spaces["F0-S001"]
    assert lobby.type == "room"
    assert lobby.room_type == "lobby"
    assert lobby.ref == "0.01"
    assert lobby.polygon == ((0.0, 0.0), (8.0, 0.0), (8.0, 6.0), (0.0, 6.0))

    entrance = building.openings["F0-O0001"]
    assert entrance.space_ids == ("outside", "F0-S001")
    assert entrance.kind == "entrance"
    assert entrance.position == (4.0, 0.0)

    stairs = building.connectors["V01"]
    assert stairs.kind == "stairs"
    assert stairs.step_free is False

    printer = building.assets["A00001"]
    assert printer.footprint is not None
    assert printer.footprint.width_m == 0.6
    assert printer.position == (15.0, 5.0)

    assert building.spaces_by_floor["F0"] == ("F0-S001", "F0-S002", "F0-S003", "F0-S004")
    assert building.openings_by_space["F0-S002"] == ["F0-O0002", "F0-O0003", "F0-O0004"]
    assert building.entrances == ("F0-O0001",)
    assert building.entrance_into("F0-O0001") == "F0-S001"
    assert building.assets_by_type["printer"] == ["A00001"]
    assert building.assets_by_space["F0-S003"] == ["A00001"]
    assert building.level("F1") == 1
    assert [floor.id for floor in building.floors_sorted()] == ["F0", "F1"]


def test_load_from_directory(tmp_path: Path) -> None:
    directory = tmp_path / "test-building"
    directory.mkdir()
    (directory / "building.json").write_text(json.dumps(minimal_building()), encoding="utf-8")
    assert Building.load(directory).meta.name == "Test Hall"
    assert Building.load(directory / "building.json").meta.name == "Test Hall"


def test_frozen_entities() -> None:
    building = Building.from_dict(minimal_building())
    with pytest.raises(AttributeError):
        building.spaces["F0-S001"].name = "renamed"  # type: ignore[misc]


def _with_space(building: dict, **overrides: object) -> dict:
    data = copy.deepcopy(building)
    data["spaces"][0].update(overrides)
    return data


def test_error_on_missing_top_level_key() -> None:
    data = minimal_building()
    del data["openings"]
    with pytest.raises(ModelError, match="openings"):
        Building.from_dict(data)


def test_error_on_unknown_floor_reference() -> None:
    data = _with_space(minimal_building(), floor_id="F9")
    with pytest.raises(ModelError, match="F0-S001.*F9"):
        Building.from_dict(data)


def test_error_on_unknown_space_type() -> None:
    data = _with_space(minimal_building(), type="cupboard")
    with pytest.raises(ModelError, match="unknown type"):
        Building.from_dict(data)


def test_error_on_short_polygon() -> None:
    data = _with_space(minimal_building(), polygon=[[0, 0], [1, 1]])
    with pytest.raises(ModelError, match="at least 3 points"):
        Building.from_dict(data)


def test_error_on_duplicate_ids() -> None:
    data = mutated_building(spaces=[copy.deepcopy(s) for s in minimal_building()["spaces"]])
    data["spaces"][1]["id"] = data["spaces"][0]["id"]
    with pytest.raises(ModelError, match="duplicate"):
        Building.from_dict(data)


def test_error_on_opening_with_unknown_space() -> None:
    data = copy.deepcopy(minimal_building())
    data["openings"][0]["space_ids"] = ["outside", "F0-S999"]
    with pytest.raises(ModelError, match="F0-S999"):
        Building.from_dict(data)


def test_error_on_opening_joining_only_outside() -> None:
    data = copy.deepcopy(minimal_building())
    data["openings"][0]["space_ids"] = ["outside", "outside"]
    with pytest.raises(ModelError, match="at least one real space"):
        Building.from_dict(data)


def test_error_on_zero_door_width() -> None:
    data = copy.deepcopy(minimal_building())
    data["openings"][1]["width_m"] = 0
    with pytest.raises(ModelError, match="width_m must be positive"):
        Building.from_dict(data)


def test_error_on_connector_length_mismatch() -> None:
    data = copy.deepcopy(minimal_building())
    data["vertical_connectors"][0]["space_ids"] = ["F0-S004"]
    with pytest.raises(ModelError, match="same length"):
        Building.from_dict(data)


def test_error_on_connector_stop_on_wrong_floor() -> None:
    data = copy.deepcopy(minimal_building())
    # First stop is paired with F0 but the stairwell 1.02 sits on F1.
    data["vertical_connectors"][0]["space_ids"] = ["F1-S002", "F0-S004"]
    with pytest.raises(ModelError, match="is on floor F1, not F0"):
        Building.from_dict(data)


def test_error_on_asset_in_unknown_space() -> None:
    data = copy.deepcopy(minimal_building())
    data["assets"][0]["space_id"] = "F0-S999"
    with pytest.raises(ModelError, match="F0-S999"):
        Building.from_dict(data)


def test_error_on_asset_floor_mismatch() -> None:
    data = copy.deepcopy(minimal_building())
    data["assets"][0]["floor_id"] = "F1"
    with pytest.raises(ModelError, match="does not match"):
        Building.from_dict(data)


def test_error_on_non_closed_polygon_is_accepted() -> None:
    # The format stores outlines that are not closed (first point not repeated); that is valid.
    data = _with_space(minimal_building(), polygon=rectangle(0, 0, 4, 4))
    assert len(Building.from_dict(data).spaces) == 6


def test_smoke_all_dataset_buildings_load() -> None:
    data_root = Path(__file__).resolve().parents[2] / "data"
    files = sorted(data_root.glob("*/*/building.json"))
    assert len(files) >= 260, f"expected the full dataset under {data_root}, found {len(files)}"
    for building_file in files:
        building = Building.load(building_file)
        assert building.meta.id == building_file.parent.name
        assert building.spaces
