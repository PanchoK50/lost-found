"""Standard values for what plans don't show: storey heights by kind of building, the scale of plans without
furniture, and the floor-height correction the agent can make by conversation."""

import json
from pathlib import Path

import pytest

from lostfound.agent.tools import Toolbox
from lostfound.core.building import Building
from lostfound.core.edits import apply_edits
from lostfound.ingest import raster, storeys
from lostfound.ingest import scale as scale_module
from lostfound.ingest.assemble import assemble
from lostfound.ingest.verify import verify

DEV = Path(__file__).resolve().parent.parent / "data" / "dev"


@pytest.mark.parametrize("building", ["proc-factory-dev-003", "proc-campus-dev-000", "swiss-1689"])
def test_imported_storeys_match_the_kit(building, tmp_path):
    """Built from the SVG plans, every floor gets the kit's elevation and height for that kind of building."""
    rebuilt = assemble(DEV / building)
    truth = {f["level"]: f for f in json.loads((DEV / building / "building.json").read_text())["floors"]}
    for floor in rebuilt["floors"]:
        assert floor["elevation_m"] == pytest.approx(truth[floor["level"]]["elevation_m"]), floor
        assert floor["height_m"] == pytest.approx(truth[floor["level"]]["height_m"]), floor
    issues = [i for i in verify(rebuilt) if i["field"] == "storey"]
    assert len(issues) == 1 and issues[0]["severity"] == "medium" and issues[0]["question"]


def _floors(*rows):
    return {"floors": [{"id": f"F{level}", "level": level, "name": "", "elevation_m": elevation, "height_m": height}
                       for level, elevation, height in rows], "spaces": [], "openings": [], "assets": [], "vertical_connectors": []}


def test_floor_height_moves_the_floors_above():
    data, _ = apply_edits(_floors((-1, -3.0, 3.0), (0, 0.0, 3.0), (1, 3.0, 3.0), (2, 6.0, 3.0)),
                          [{"action": "set_floor_height", "floor_id": "F1", "height_m": 4.0}])
    assert [(f["elevation_m"], f["height_m"]) for f in data["floors"]] == [(-3.0, 3.0), (0.0, 3.0), (3.0, 4.0), (7.0, 3.0)]


def test_factory_hall_reaching_through_the_floor_above_moves_nothing():
    data, _ = apply_edits(_floors((0, 0.0, 8.0), (1, 3.5, 3.5)), [{"action": "set_floor_height", "floor_id": "F0", "height_m": 9.0}])
    assert [(f["elevation_m"], f["height_m"]) for f in data["floors"]] == [(0.0, 9.0), (3.5, 3.5)]


def test_basement_grows_downwards():
    data, _ = apply_edits(_floors((-2, -6.0, 3.0), (-1, -3.0, 3.0), (0, 0.0, 3.0)),
                          [{"action": "set_floor_height", "floor_id": "F-1", "height_m": 4.0}])
    assert [(f["elevation_m"], f["height_m"]) for f in data["floors"]] == [(-7.0, 3.0), (-4.0, 4.0), (0.0, 3.0)]


def test_agent_sets_every_floor_height(tmp_path):
    rebuilt = assemble(DEV / "swiss-1689")
    (tmp_path / "building.json").write_text(json.dumps(rebuilt))
    toolbox = Toolbox(Building.load(tmp_path), "chat")
    text, is_error = toolbox.call("set_floor_height", {"floor": "all", "height_m": 2.8})
    assert not is_error, text
    floors = sorted(toolbox.building.floors.values(), key=lambda f: f["level"])
    assert [f["height_m"] for f in floors] == [2.8] * len(floors)
    assert [f["elevation_m"] for f in floors] == pytest.approx([f["level"] * 2.8 for f in floors])
    assert [e["action"] for e in toolbox.edits] == ["set_floor_height"] * len(floors)
    replayed, _ = apply_edits(rebuilt, toolbox.edits)  # the saved edits rebuild the same stack
    assert [f["elevation_m"] for f in sorted(replayed["floors"], key=lambda f: f["level"])] == [f["elevation_m"] for f in floors]
    _, is_error = toolbox.call("set_floor_height", {"floor": "all", "height_m": 0.5})
    assert is_error


def test_storey_style():
    def building(*spaces):
        return {"spaces": [{"type": t, "room_type": r, "polygon": [[0, 0], [a, 0], [a, 1], [0, 1]]} for t, r, a in spaces]}

    assert storeys.style(building(("hall", "production_zone", 50))) == "factory"
    assert storeys.style(building(("hall", "lobby", 200))) == "factory"  # a big drawn hall
    assert storeys.style(building(("room", "lecture_hall", 80), ("hall", "lobby", 30))) == "campus"
    assert storeys.style(building(("room", "bedroom", 12))) == "standard"


@pytest.mark.parametrize("building", ["proc-factory-dev-003", "proc-campus-dev-000", "swiss-1689", "resplan-439"])
def test_scale_of_plain_png_plans(building):
    """No furniture on the plain plans: the typical room size of that kind of building gives the scale."""
    from shapely.geometry import Polygon

    drawing = raster.parse(DEV / building / "floor_0_plain.png")
    estimate = scale_module.estimate_from_rooms([drawing])
    truth = json.loads((DEV / building / "building.json").read_text())
    floor = next(f["id"] for f in truth["floors"] if f["level"] == 0)
    true_area = sum(Polygon(s["polygon"]).area for s in truth["spaces"] if s["floor_id"] == floor)
    true_scale = (sum(Polygon(s["points"]).area for s in drawing.spaces) / true_area) ** 0.5
    assert estimate == pytest.approx(true_scale, rel=0.15)
