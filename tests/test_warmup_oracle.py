"""Warm-up answers (questions_basic.jsonl): locate, count, routes with step-free and closures, tours."""

import pytest

from lostfound.core import skills
from tests.conftest import building, load_jsonl

QUESTIONS = load_jsonl("questions_basic.jsonl")
ROUTE_TOLERANCE = 0.01


def close_enough(value: float, expected: float) -> bool:
    return abs(value - expected) <= max(ROUTE_TOLERANCE * expected, ROUTE_TOLERANCE)


@pytest.mark.parametrize("item", QUESTIONS, ids=[question["id"] for _, question in QUESTIONS])
def test_warmup_matches_label(item):
    directory, question = item
    b = building(directory)
    answer, kind = question["answer"], question["kind"]
    if kind == "locate":
        asset_type = b.assets[answer["asset_id"]]["type"]
        found = [match["asset_id"] for match in skills.locate(b, asset_type)["matches"]]
        assert answer["asset_id"] in found
        return
    if kind == "count":
        floor_id = b.floor_by_level(answer["floor_level"])["id"]
        assert skills.count_assets(b, answer["asset_type"], floor_id)["count"] == answer["count"]
        return
    if kind == "tour":
        stops = answer["stops"]
        result = skills.route(b, stops[0], stops[-1], via=stops[1:-1])
    else:
        result = skills.route(
            b,
            answer.get("from_space_id") or question["answer"]["from_space_id"],
            answer["to_space_id"],
            step_free=kind == "route_step_free",
            closed=[answer["closed_element_id"]] if "closed_element_id" in answer else None,
        )
    if answer.get("reachable") is False:
        assert result["reachable"] is False
    else:
        assert result["reachable"], result
        assert close_enough(result["length_m"], answer["optimal_length_m"]), (result["length_m"], answer)
