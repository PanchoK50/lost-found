"""Tests for agent.agent: model resolution, prompt modes, session isolation."""

from __future__ import annotations

import pytest

from agent.agent import (
    DEFAULT_MODEL,
    BuildingAgent,
    resolve_effort,
    resolve_model,
)
from core.geometry import Geometry
from core.model import Building
from tests.core.fixtures import minimal_building


@pytest.fixture
def building() -> Building:
    return Building.from_dict(minimal_building())


def test_model_resolution_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    assert resolve_model() == DEFAULT_MODEL
    assert resolve_model("sonnet") == "claude-sonnet-5-5"
    assert resolve_model("Opus") == "claude-opus-5-5"
    assert resolve_model("claude-haiku-5-5") == "claude-haiku-5-5"
    monkeypatch.setenv("AGENT_MODEL", "claude-sonnet-5-5")
    assert resolve_model() == "claude-sonnet-5-5"
    assert resolve_model("opus") == "claude-opus-5-5"  # parameter beats env
    monkeypatch.setenv("AGENT_EFFORT", "high")
    assert resolve_effort() == "high"
    assert resolve_effort("low") == "low"


def test_prompt_modes_and_cache_marker(building: Building) -> None:
    geometry = Geometry(building)
    chat = BuildingAgent(building, geometry, clarification="allowed")
    one_shot = BuildingAgent(building, geometry, clarification="forbidden")
    chat_prompt = chat.system[0]["text"]
    one_shot_prompt = one_shot.system[0]["text"]
    assert chat.system[0]["cache_control"] == {"type": "ephemeral"}
    assert "ask one short question" in chat_prompt
    assert "never ask back" not in chat_prompt
    assert "never ask back" in one_shot_prompt
    assert "ask one short question" not in one_shot_prompt
    for prompt in (chat_prompt, one_shot_prompt):
        assert "Answer:" in prompt
        assert "exactly one number" in prompt
        assert "Test Hall" in prompt  # the overview is embedded


def test_invalid_clarification_mode_rejected(building: Building) -> None:
    with pytest.raises(ValueError, match="clarification"):
        BuildingAgent(building, Geometry(building), clarification="sometimes")


def test_sessions_are_isolated_per_agent(building: Building) -> None:
    geometry = Geometry(building)
    first = BuildingAgent(building, geometry)
    second = BuildingAgent(building, geometry)
    first.toolkit.set_closed("F0-O0003")
    assert "F0-O0003" in first.toolkit.session["closed"]
    assert not second.toolkit.session["closed"]
