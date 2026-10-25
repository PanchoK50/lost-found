"""Hard probes (lostfound/evals/hard.py): questions that need reasoning on top of the tools. Their answers were
computed from the raw plan and the kit's route model alone; here each one is recomputed with our library and through
the agent's own tools (the calls the agent would make), so both sides must agree before Claude is even asked.

The probes and the agent's score on them: `uv run --env-file .env python -m lostfound.evals.run --variant V4 --set hard-dev`."""

import itertools
import json
from pathlib import Path

import pytest
from shapely.geometry import Point

from benchmark.score import score_reply
from lostfound.agent.tools import Toolbox
from lostfound.core import geometry, reach, skills
from lostfound.core.building import ROOMISH_TYPES, Building
from lostfound.evals.scoring import score

ROOT = Path(__file__).resolve().parent.parent
PROBES = [json.loads(line) for name in ("hard_dev", "hard_test") for line in (ROOT / "evals" / "data" / f"{name}.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]


def load(item: dict) -> Building:
    return Building.load(ROOT / item["building_dir"])


def reply(value) -> str:
    return f"Computed.\nAnswer: {value}"


def check(item: dict, value) -> None:
    assert score(item["answer"], reply(value)), (item["id"], value, item["answer"])


def route_length(b: Building, start: str, destination: str, **rules) -> float | str:
    result = skills.route(b, start, destination, **rules)
    return result["length_m"] if result["reachable"] else "no route"


def test_every_kind_is_probed_on_dev_and_on_the_unseen_test_layouts():
    kinds = {"crate_route", "crate_tipped", "crate_no_route", "widest_load", "door_widened", "smoke_exit", "water_column",
             "drill_shaft", "meeting_point", "best_tour", "air_volume", "two_closures"}
    for split in ("hard-dev", "hard-test"):
        assert {item["kind"] for item in PROBES if item["set"] == split} == kinds, split
    assert all(item["inputs"] for item in PROBES)


@pytest.mark.parametrize("item", PROBES, ids=[item["id"] for item in PROBES])
def test_probe_answer_agrees_with_our_library_and_tools(item):
    b, i, kind = load(item), item["inputs"], item["kind"]
    toolbox = Toolbox(b, "hybrid")

    def tool(name: str, **arguments) -> dict:
        text, is_error = toolbox.call(name, arguments)
        assert not is_error, text
        return json.loads(text)

    if kind in ("crate_route", "crate_tipped", "crate_no_route"):
        result = tool("route", start=i["start"], destination=i["destination"], via=[], step_free=True, closed=[],
                      min_door_width_m=i["min_width"], forklift=False)
        assert score(item["answer"], result["answer_line"]), (result["answer_line"], item["answer"])
        if kind == "crate_tipped":  # lying flat, the table top would not get there: the twist matters
            assert route_length(b, i["start"], i["destination"], step_free=True, min_width=i["flat_width"]) == "no route"
        if kind == "crate_route":  # without the width rule the walk is shorter: the crate's size matters
            assert route_length(b, i["start"], i["destination"], step_free=True) < result["length_m"] - 1.0
        if kind == "crate_no_route":  # a narrower load would get there: it is the width that blocks it
            assert route_length(b, i["start"], i["destination"], step_free=True) != "no route"
    elif kind == "widest_load":
        widths = sorted({o["width_m"] for o in b.openings.values()}, reverse=True)
        fits = [w for w in widths if route_length(b, i["start"], i["destination"], step_free=True, min_width=w) != "no route"]
        check(item, fits[0])
    elif kind == "door_widened":
        floor = b.floor_name(i["floor_id"])
        before = tool("delivery_reach_count", entrance_space=i["start"], floor=floor, min_width_m=i["min_width"])
        chat = Toolbox(b, "chat")
        text, is_error = chat.call("set_door_width", {"door": i["door"], "width_m": i["new_width"]})
        assert not is_error, text
        after = json.loads(chat.call("delivery_reach_count", {"entrance_space": i["start"], "floor": floor, "min_width_m": i["min_width"]})[0])
        check(item, int(after["count"]) - int(before["count"]))
    elif kind == "smoke_exit":
        result = tool("nearest", start=i["start"], what="exit", step_free=False, closed=[i["closed_name"]])
        assert score(item["answer"], result["answer_line"]), (result["answer_line"], item["answer"])
        with b.temporarily_closed(*i["closed"]):
            check(item, reach.exit_distances(b)[i["start"]])
        assert reach.exit_distances(b)[i["start"]] < item["answer"]["value"] - 1.0  # the smoke makes it longer
    elif kind == "water_column":
        outline = b.polygon(i["space_id"])
        level = b.space_level(i["space_id"])
        hits = sum(1 for s in b.spaces.values() if b.space_level(s["id"]) < level and b.polygon(s["id"]).intersection(outline).area >= 1.0)
        check(item, hits)
    elif kind == "drill_shaft":
        centre: Point = b.polygon(i["space_id"]).centroid
        floor_id = b.spaces[i["space_id"]]["floor_id"]
        check(item, sum(1 for s in b.spaces.values() if s["floor_id"] != floor_id and b.polygon(s["id"]).contains(centre)))
    elif kind == "meeting_point":
        candidates = [s["id"] for s in b.spaces.values() if s["room_type"] == i["room_type"] and s["type"] in ROOMISH_TYPES]
        walks = [b.distances_from(person) for person in i["people"]]
        best = min(candidates, key=lambda c: sum(w.get(c, float("inf")) for w in walks))
        assert score_reply(item["answer"], reply(b.spaces[best].get("ref") or b.spaces[best]["name"]))
    elif kind == "best_tour":
        home, stops = i["home"], i["stops"]
        best = min(skills.route(b, home, home, via=list(order))["length_m"] for order in itertools.permutations(stops))
        check(item, best)
        as_listed = skills.route(b, home, home, via=stops)["length_m"]
        assert as_listed > best + 1.0  # the order the question lists is not the best one
    elif kind == "air_volume":
        space = b.spaces[i["space_id"]]
        check(item, geometry.area(b, i["space_id"]) * b.floors[space["floor_id"]]["height_m"])
    elif kind == "two_closures":
        result = tool("step_free_reach_count", entrance_space=i["start"], floor=b.floor_name(i["floor_id"]), closed=i["closed"])
        check(item, result["count"])
    else:
        raise AssertionError(f"unknown kind {kind}")
