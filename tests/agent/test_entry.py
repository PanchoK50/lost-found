"""Tests for agent.entry: caching and per-question freshness, without any API."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import agent.entry as entry
from agent import entry as entry_module
from tests.core.fixtures import minimal_building


class StubAgent:
    """Records construction; returns a fixed reply and marks its session."""

    instances: list["StubAgent"] = []

    def __init__(self, building, geometry, client=None, model=None, effort=None, clarification="allowed") -> None:
        self.building = building
        self.geometry = geometry
        self.clarification = clarification
        self.questions: list[str] = []
        StubAgent.instances.append(self)

    def ask(self, user_text: str) -> str:
        self.questions.append(user_text)
        return f"Worked on it.\nAnswer: {41 + len(StubAgent.instances)}"


@pytest.fixture(autouse=True)
def fresh_cache():
    entry_module._CACHE.clear()
    StubAgent.instances = []
    yield


def _write_building(tmp_path: Path) -> Path:
    directory = tmp_path / "test-building"
    directory.mkdir()
    (directory / "building.json").write_text(json.dumps(minimal_building()), encoding="utf-8")
    return directory


def test_answer_uses_one_shot_agents_and_cached_geometry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = _write_building(tmp_path)
    monkeypatch.setattr(entry_module, "BuildingAgent", StubAgent)
    first = entry.answer(directory, "first question?")
    second = entry.answer(directory, "second question?")
    assert first.endswith("Answer: 42")
    assert second.endswith("Answer: 43")
    assert len(StubAgent.instances) == 2  # fresh agent per question
    assert all(instance.clarification == "forbidden" for instance in StubAgent.instances)
    assert StubAgent.instances[0].geometry is StubAgent.instances[1].geometry  # building cache
    assert StubAgent.instances[0].building is StubAgent.instances[1].building


def test_cache_distinguishes_buildings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    other = tmp_path / "other-building"
    other.mkdir()
    (other / "building.json").write_text(json.dumps(minimal_building()), encoding="utf-8")
    monkeypatch.setattr(entry_module, "BuildingAgent", StubAgent)
    entry.answer(_write_building(tmp_path), "q1")
    entry.answer(other, "q2")
    assert StubAgent.instances[0].building is not StubAgent.instances[1].building
