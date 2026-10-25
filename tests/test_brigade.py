"""Fire brigade edition: briefing, people and crew routes on the demo building and two others."""

from pathlib import Path

import pytest

from lostfound.core.building import Building
from lostfound.hazards import brigade

CASES = [("proc-campus-test-005", "proc-campus-test-005-F3-S025"), ("osm-way22744230", "osm-way22744230-F3-S010"),
         ("proc-factory-dev-011", "proc-factory-dev-011-F1-S006")]


@pytest.fixture(scope="module", params=CASES, ids=[c[0] for c in CASES])
def case(request):
    bid, origin = request.param
    return Building.load(next(Path("data").glob(f"*/{bid}"))), origin


def test_briefing(case):
    b, origin = case
    d = brigade.briefing(b, origin)
    assert d["facts"]["rooms_on_fire_now"] >= 1 and d["facts"]["rooms_on_fire_at_arrival"] >= d["facts"]["rooms_on_fire_now"]
    assert any(e["recommended"] for e in d["entrances"])
    assert len(d["timeline"]) == 31


def test_wheelchair_user_upstairs_cannot_self_evacuate(case):
    b, origin = case
    p = brigade.people(b, origin, 4)
    assert any(x["person"] == "Lea" and "wheelchair" in x["reason"] for x in p["cannot_self_evacuate"])


def test_crew_routes_avoid_smoky_stairs_and_check_stretcher(case):
    b, origin = case
    lea = next(x for x in brigade.people(b, origin, 4)["demo_people"] if x["person"] == "Lea")
    r = brigade.routes(b, origin, 12, [{"space_id": lea["space_id"], "label": "rescue", "min_width_m": 1.1}, {"space_id": origin, "label": "attack"}])
    rescue, attack = r["routes"]
    assert rescue["reachable"] and attack["reachable"]
    avoided = {a["connector_id"] for a in attack["avoided"]}
    assert not avoided & {c["id"] for c in b.connectors.values() if c["name"] in attack["used_stairwell"]}
    assert rescue["stretcher_ok"] == (rescue["narrowest_door"]["width_m"] >= 1.1)
    assert attack["stretcher_ok"] is None
