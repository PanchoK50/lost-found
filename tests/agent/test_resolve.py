"""Tests for agent.resolve: reference resolution without any LLM."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent.resolve import ResolveError, floor_level, resolve_element, resolve_floor, resolve_space, search
from core.model import Building
from tests.core.fixtures import minimal_building


@pytest.fixture
def building() -> Building:
    return Building.from_dict(minimal_building())


def _real_building() -> Building | None:
    path = Path(__file__).resolve().parents[2] / "data/dev/proc-factory-dev-003/building.json"
    return Building.load(path) if path.exists() else None


def test_floor_level_parsing() -> None:
    assert floor_level("0") == 0
    assert floor_level("2") == 2
    assert floor_level("-1") == -1
    assert floor_level("floor 2") == 2
    assert floor_level("Floor 1") == 1
    assert floor_level("level -2") == -2
    assert floor_level("Ground floor") == 0
    assert floor_level("first floor") == 1
    assert floor_level("second floor") == 2
    assert floor_level("Basement 2") == -2
    assert floor_level("Basement") == -1
    assert floor_level("nonsense") is None


def test_resolve_floor(building: Building) -> None:
    assert resolve_floor(building, "F0") == "F0"
    assert resolve_floor(building, "0") == "F0"
    assert resolve_floor(building, "floor 1") == "F1"
    assert resolve_floor(building, "First floor") == "F1"
    assert resolve_floor(building, "ground floor") == "F0"
    assert resolve_floor(building, "Ground floor") == "F0"  # the actual floor name
    with pytest.raises(ResolveError, match="Unknown floor"):
        resolve_floor(building, "floor 5")


def test_resolve_space_by_id_ref_name_and_asset(building: Building) -> None:
    assert resolve_space(building, "F0-S003") == "F0-S003"
    assert resolve_space(building, "0.03") == "F0-S003"
    assert resolve_space(building, "Office 0.03") == "F0-S003"
    assert resolve_space(building, "office 0.03") == "F0-S003"
    assert resolve_space(building, "A00001") == "F0-S003"  # asset id -> its space
    assert resolve_space(building, "Printer 0.03-A") == "F0-S003"  # asset name


def test_resolve_space_with_floor_hint(building: Building) -> None:
    assert resolve_space(building, "Office 0.03 (Ground floor)") == "F0-S003"


def test_resolve_space_unknown_and_ambiguous() -> None:
    building = Building.from_dict(minimal_building())
    with pytest.raises(ResolveError, match="No place matches"):
        resolve_space(building, "Sauna 9.99")
    real = _real_building()
    if real is None:
        pytest.skip("dataset not present")
    # Real factories have many production zones: the bare room_type is ambiguous.
    with pytest.raises(ResolveError, match="Candidates"):
        resolve_space(real, "production zone")


def test_resolve_space_floor_level_disambiguates() -> None:
    real = _real_building()
    if real is None:
        pytest.skip("dataset not present")
    # A bare room type stays ambiguous (many candidates listed) — correct behaviour.
    with pytest.raises(ResolveError, match="Candidates"):
        resolve_space(real, "Office")
    # The floor filter narrows exact matches; a ref from the wrong floor finds nothing.
    assert resolve_space(real, "Office 0.23", floor_level=0) in real.spaces
    with pytest.raises(ResolveError):
        resolve_space(real, "Office 0.23", floor_level=1)


def test_search_matches_words_and_types(building: Building) -> None:
    results = search(building, "printer")
    assert [item["id"] for item in results] == ["A00001"]
    results = search(building, "office 0.03")
    assert {item["id"] for item in results} == {"F0-S003"}
    assert search(building, "xyzzy") == []


def test_resolve_element(building: Building) -> None:
    assert resolve_element(building, "V01") == "V01"
    assert resolve_element(building, "Staircase") == "V01"  # connector by name
    assert resolve_element(building, "F0-O0003") == "F0-O0003"
    assert resolve_element(building, "Office 0.03") == "F0-S003"
