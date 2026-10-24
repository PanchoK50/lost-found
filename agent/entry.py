"""The benchmark entry point: answer(building_directory, question_text) -> str.

One fresh one-shot agent per question — closures and what-if doors live in the
toolkit session of that conversation only, so nothing leaks between questions.
Buildings and their walking geometries are expensive and shared across the 145
test questions (40 buildings), so they are cached per process.

  uv run --env-file .env python -m benchmark.evaluate data/test \
      --agent agent.entry:answer --submission-csv team_lost_found.csv
"""

from __future__ import annotations

from pathlib import Path

from agent.agent import BuildingAgent
from core.geometry import Geometry
from core.model import Building

_CACHE: dict[Path, tuple[Building, Geometry]] = {}


def building_and_geometry(building_directory: Path) -> tuple[Building, Geometry]:
    key = Path(building_directory).resolve()
    entry = _CACHE.get(key)
    if entry is None:
        building = Building.load(key)
        entry = (building, Geometry(building))
        _CACHE[key] = entry
    return entry


def answer(building_directory: Path, question_text: str) -> str:
    building, geometry = building_and_geometry(Path(building_directory))
    agent = BuildingAgent(building, geometry, clarification="forbidden")
    return agent.ask(question_text)
