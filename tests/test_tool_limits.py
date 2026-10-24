"""The Claude API rejects requests with more than 20 strict tools; every design must stay under it."""

from pathlib import Path

import pytest

from lostfound.agent.tools import Toolbox
from lostfound.core.building import Building

MAX_STRICT_TOOLS = 20


@pytest.mark.parametrize("design", ["typed", "code", "hybrid", "chat"])
def test_strict_tools_within_api_limit(design):
    building = Building.load(Path(__file__).resolve().parent.parent / "data" / "dev" / "proc-factory-dev-003")
    assert sum(tool["strict"] for tool in Toolbox(building, design).definitions()) <= MAX_STRICT_TOOLS
