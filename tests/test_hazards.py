"""Hazard model on real dataset buildings: water runs down, fire follows doors, evacuation avoids the fire."""

from pathlib import Path

import pytest

from lostfound.core.building import Building
from lostfound.hazards import evacuation, impact, playbooks, readiness, spread
from lostfound.hazards.model import sensors

DEV = sorted(Path("data/dev").iterdir())[:6]


@pytest.fixture(scope="module", params=[d.name for d in DEV])
def building(request) -> Building:
    return Building.load(Path("data/dev") / request.param)


def upper_room(building: Building) -> str | None:
    lowest = min(building.floors_by_level)
    return next((s["id"] for s in building.spaces.values() if s["type"] == "room" and building.space_level(s["id"]) > lowest
                 and spread._structure(building)["below"][s["id"]]), None)


def test_water_reaches_room_below(building):
    origin = upper_room(building)
    if origin is None:
        pytest.skip("single-storey building")
    result = spread.simulate(building, "water", origin)
    below = {e["space_id"] for e in result["spaces"] if e["via"] == "below"}
    assert below, "water should reach the floor below"
    assert all(building.space_level(s) < building.space_level(origin) for s in below)
    assert not any(e["via"] == "stairs" and building.space_level(e["space_id"]) > building.space_level(origin) for e in result["spaces"])


def test_fire_spreads_over_time_and_starts_at_origin(building):
    origin = next(s["id"] for s in building.spaces.values() if s["type"] == "room")
    result = spread.simulate(building, "fire", origin, minutes=20)
    assert result["spaces"][0]["space_id"] == origin and result["spaces"][0]["arrival_min"] == 0
    early, late = spread.affected_at(result, 2, min_level=0.1), spread.affected_at(result, 20, min_level=0.1)
    assert early <= late and origin in early
    for entry in result["spaces"]:
        assert 0 < entry["peak"] <= 1 and 0 <= entry["arrival_min"] <= 20
        if entry["via"] == "door":
            doors = spread._structure(building)["doors"][entry["from"]]
            assert any(other == entry["space_id"] for other, _ in doors)


def test_evacuation_avoids_fire(building):
    origin = max((s for s in building.spaces.values() if s["type"] == "room"), key=lambda s: building.polygon(s["id"]).area)["id"]
    result = spread.simulate(building, "fire", origin)
    plan = evacuation.evacuate(building, result, at_min=6)
    blocked = set(plan["blocked"])
    assert origin in blocked
    for route in plan["routes"]:
        assert not blocked & set(route["space_path"])
    assert not building.closed, "temporary closures must be undone"


def test_electrical_fault_takes_out_a_circuit(building):
    origin = next(s["id"] for s in building.spaces.values() if s["type"] == "room")
    result = spread.simulate(building, "electrical", origin)
    circuit = spread.circuits(building)[origin]
    assert {e["space_id"] for e in result["spaces"]} <= set(spread.circuit_spaces(building, circuit)) | {origin}


def test_impact_and_playbook(building):
    origin = upper_room(building) or next(s["id"] for s in building.spaces.values() if s["type"] == "room")
    for hazard in ("fire", "water", "electrical"):
        result = spread.simulate(building, hazard, origin)
        summary = impact.impact(building, result)
        assert summary["rooms"][0]["relation"] == "origin"
        actions = playbooks.plan(building, summary, evacuation.evacuate(building, result) if hazard == "fire" else None)
        assert actions and all(a["timeline"] for a in actions)
        if hazard == "fire":
            assert any(a["contact"] and a["contact"]["phone"] == "112" for a in actions)


def test_readiness_and_sensors(building):
    report = readiness.readiness(building)
    assert 0 <= report["score"] <= 100
    for finding in report["findings"]:
        assert set(finding["space_ids"]) <= set(building.spaces)
    assert any(s["kind"] == "smoke" for s in sensors(building))
