"""The template parser recovers the labelled inputs from the question text (train + dev)."""

import pytest

from lostfound.agent import rules
from lostfound.core.resolve import Resolver
from tests.conftest import building, load_jsonl

QUESTIONS = load_jsonl("questions.jsonl")

def expected_inputs(question: dict) -> dict:
    kind, inputs = question["kind"], dict(question["inputs"])
    if kind in ("shared_walls_count", "room_stacked"):
        inputs["space_id"] = inputs.pop("start")
    if kind == "step_free_reachable_count":
        inputs["closed"] = [inputs["closed"]]
    if kind == "what_if_door":
        inputs.pop("door_floor_id")
    if kind == "errand":
        inputs["step_free"] = False
    return inputs


@pytest.mark.parametrize("item", QUESTIONS, ids=[question["id"] for _, question in QUESTIONS])
def test_parser_recovers_inputs(item):
    directory, question = item
    parsed = rules.parse(building(directory), question["question"])
    assert parsed is not None, question["question"]
    assert parsed.kind == question["kind"]
    expected = expected_inputs(question)
    if parsed.inputs != expected:
        # Duplicate room names on one floor (OSM): the text cannot tell them apart. Accept only if the
        # resolver flags the ambiguity and the labelled room is among the candidates.
        resolver = Resolver(building(directory))
        differing = [key for key in expected if parsed.inputs.get(key) != expected[key]]
        for key in differing:
            mention = next(m for m in resolver.mentions(question["question"]) if expected[key] in m["space_ids"])
            assert len(mention["space_ids"]) > 1, (key, question["question"])
        pytest.xfail(f"ambiguous room name in {question['id']}")
