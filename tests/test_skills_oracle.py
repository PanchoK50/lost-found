"""Every labelled benchmark answer (train + dev), computed from the question's structured inputs and scored with
the official scorer. This pins the geometry definitions and the answer formatting; it does not test parsing."""

import pytest

from benchmark.score import score_reply
from lostfound.agent.format import answer_line
from lostfound.core import skills
from tests.conftest import building, load_jsonl

QUESTIONS = load_jsonl("questions.jsonl")


def run_skill(directory, question) -> tuple:
    b = building(directory)
    kind, inputs = question["kind"], question["inputs"]
    match kind:
        case "largest_room" | "floor_area_total":
            result = skills.SKILLS[kind](b, inputs["floor_id"], inputs["room_type"])
        case "errand":
            result = skills.errand(b, inputs["start"], inputs["asset_type"], inputs["floor_id"], inputs["room_type"])
        case "shared_walls_count":
            result = skills.shared_walls_count(b, inputs["start"])
        case "wide_delivery_count":
            result = skills.wide_delivery_count(b, inputs["start"], inputs["floor_id"], inputs["min_width"])
        case "straight_line_3d":
            result = skills.straight_line_3d(b, inputs["first"], inputs["second"])
        case "room_stacked":
            result = skills.room_stacked(b, inputs["start"], inputs["direction"])
        case "step_free_reachable_count":
            result = skills.step_free_reachable_count(b, inputs["start"], inputs["floor_id"], [inputs["closed"]])
        case "what_if_door":
            result = skills.what_if_door(b, inputs["first"], inputs["second"], inputs["floor_id"])
        case _:
            raise AssertionError(f"unknown kind {kind}")
    return b, result


@pytest.mark.parametrize("item", QUESTIONS, ids=[question["id"] for _, question in QUESTIONS])
def test_skill_matches_label(item):
    directory, question = item
    b, result = run_skill(directory, question)
    reply = f"Computed from the plan.\n{answer_line(b, question['kind'], result)}"
    assert score_reply(question["answer"], reply), (reply, question["answer"])
