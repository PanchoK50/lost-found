"""Tests for agent.tools: the toolkit methods and their strict Claude wrappers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from anthropic.lib.tools import ToolError

from agent.resolve import ResolveError
from agent.tools import AgentToolkit, make_tools
from core.geometry import Geometry
from core.graph import RouteError
from core.model import Building
from core.queries import QueryError
from tests.core.fixtures import minimal_building, rectangle, with_lift
from tests.core.test_queries import _detour_building


@pytest.fixture
def toolkit() -> AgentToolkit:
    building = Building.from_dict(minimal_building())
    return AgentToolkit(building, Geometry(building))


def _detour_toolkit() -> AgentToolkit:
    building = _detour_building()
    return AgentToolkit(building, Geometry(building))


def test_overview_and_search(toolkit: AgentToolkit) -> None:
    overview = toolkit.building_overview()
    assert overview["floors"][0]["name"] == "Ground floor"
    assert overview["entrances"][0]["into"].startswith("Lobby")
    results = toolkit.search_building("printer")["results"]
    assert results[0]["id"] == "A00001"
    with pytest.raises(QueryError):
        toolkit.search_building("sauna")


def test_find_route_with_names_and_answer_line(toolkit: AgentToolkit) -> None:
    result = toolkit.find_route("Lobby 0.01", "Office 0.03")
    assert result["space_path"] == ["Lobby 0.01", "Corridor 0.02", "Office 0.03"]
    assert result["answer_line"] == "Answer: Lobby 0.01 -> Corridor 0.02 -> Office 0.03"
    with pytest.raises(RouteError):
        toolkit.find_route("Lobby 0.01", "Office 1.01", step_free=True)


def test_closures_flow_through_the_session(toolkit: AgentToolkit) -> None:
    toolkit.set_closed("F0-O0003")  # the office door
    with pytest.raises(RouteError):
        toolkit.find_route("Lobby 0.01", "Office 0.03")
    toolkit.set_closed("F0-O0003", closed=False)
    assert toolkit.find_route("Lobby 0.01", "Office 0.03")["length_m"] > 0


def test_add_door_requires_shared_wall(toolkit: AgentToolkit) -> None:
    with pytest.raises(QueryError, match="share no wall"):
        toolkit.add_door("Lobby 0.01", "Office 0.03")


def test_room_facts_and_suggestions(toolkit: AgentToolkit) -> None:
    facts = toolkit.room_facts("0.03")
    assert facts["area_m2"] == 100.0
    assert facts["shared_walls"]["count"] == 0  # office touches only corridor and stairwell
    assert facts["directly_above"]["id"] == "F1-S001"
    assert facts["answer_line_suggestions"]["directly_above"] == "Answer: Office 1.01"
    assert facts["answer_line_suggestions"]["shared_walls"] == "Answer: 0"


def test_largest_room_and_area_total(toolkit: AgentToolkit) -> None:
    result = toolkit.largest_room("Ground floor", "office")
    assert result["name"] == "Office 0.03"
    assert result["answer_line"] == "Answer: Office 0.03, 100.0 m²"
    total = toolkit.floor_area_total("0", "office")
    assert total["answer_line"] == "Answer: 100.0 m²"
    assert total["rooms_counted"] == 1


def test_errand_plan(toolkit: AgentToolkit) -> None:
    result = toolkit.errand_plan("Lobby 0.01", "printer", "floor 1", "office")
    assert result["answer_line"].startswith("Answer: ")
    assert result["leg_2"]["to"] == "Office 1.01"
    assert len(result["answer_line"].rsplit(" ", 2)[-2:]) == 2  # "<number> m"


def test_reachable_rooms(toolkit: AgentToolkit) -> None:
    result = toolkit.reachable_rooms("Lobby 0.01", "Ground floor", step_free=True, min_door_width_m=1.2)
    assert result["count"] == 1
    assert result["answer_line"] == "Answer: 1 rooms"
    narrow = toolkit.reachable_rooms("Lobby 0.01", "Ground floor", min_door_width_m=0.9)
    assert narrow["count"] == 2


def test_distance_3d(toolkit: AgentToolkit) -> None:
    result = toolkit.distance_3d("Office 0.03", "Office 1.01")
    assert result["distance_m"] == 3.0
    assert result["answer_line"] == "Answer: 3.0 m"


def test_what_if_door() -> None:
    toolkit = _detour_toolkit()
    result = toolkit.what_if_door("Corridor", "Room A", "Ground floor")
    assert result["improved_count"] == 1
    assert result["answer_line"] == "Answer: 1 rooms"


def test_wrapped_tools_are_strict_and_callable(toolkit: AgentToolkit) -> None:
    tools = make_tools(toolkit)
    assert len(tools) == 12
    names = {tool.name for tool in tools}
    assert {"find_route", "largest_room", "what_if_door"} <= names
    for tool in tools:
        payload = tool.to_dict()
        assert payload["strict"] is True, tool.name
        assert payload["input_schema"].get("additionalProperties") is False
    overview = json.loads(tools[0]())
    assert overview["name"] == "Test Hall"


def test_wrapped_tools_translate_errors(toolkit: AgentToolkit) -> None:
    tools = {tool.name: tool for tool in make_tools(toolkit)}
    with pytest.raises(ToolError, match="No place matches"):
        tools["find_route"](start="Sauna 9.99", destination="0.03")
    with pytest.raises(ResolveError):  # the plain toolkit raises the core error class
        toolkit.find_route("Sauna 9.99", "0.03")


def test_tools_work_on_a_real_dev_building() -> None:
    path = Path(__file__).resolve().parents[2] / "data/dev/proc-factory-dev-003/building.json"
    if not path.exists():
        pytest.skip("dataset not present")
    building = Building.from_dict(json.loads(path.read_text()))
    toolkit = AgentToolkit(building, Geometry(building))
    result = toolkit.largest_room("floor 1", "kitchen")
    assert result["area_m2"] == pytest.approx(28.0, abs=1.5)
    assert result["name"] == "Kitchen 1.14"
    route = toolkit.find_route("Office 0.30", "Office 0.46")
    assert route["length_m"] > 0
    assert route["answer_line"].startswith("Answer: Office 0.30")
