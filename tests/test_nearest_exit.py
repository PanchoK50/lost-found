"""nearest(what='exit') is the walk out of the building: the route-model distance to the entrance door itself."""

from pathlib import Path

import pytest

from lostfound.agent.tools import Toolbox
from lostfound.core import reach
from lostfound.core.building import ROOMISH_TYPES, Building

DEV = Path(__file__).resolve().parent.parent / "data" / "dev"


@pytest.mark.parametrize("name", ["swiss-450", "proc-factory-dev-003", "proc-campus-dev-000", "osm-way27917482", "resplan-439"])
def test_nearest_exit_matches_exit_distances(name):
    building = Building.load(DEV / name)
    expected = reach.exit_distances(building)
    toolbox = Toolbox(building, "hybrid")
    for space in building.spaces.values():
        if space["type"] not in ROOMISH_TYPES:
            continue
        result = toolbox.tool_nearest(space["id"], "nearest exit", False)
        if space["id"] in expected:
            assert result["length_m"] == pytest.approx(expected[space["id"]], abs=0.01)
            assert result["answer_line"].startswith("Answer: ")
        else:
            assert result["answer_line"] == "Answer: no route"
