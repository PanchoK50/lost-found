"""The organizers' extra route rules (forklift, production bays as destinations, no route), checked on the dev
factories against an independent validator: it re-measures our answer's space sequence the way the scoring note
describes (each step through a real allowed opening, bays never crossed) and compares it with the best length from
a separately built rule graph."""

import itertools
import json
import random
from pathlib import Path

import networkx as nx
import pytest

from lostfound.agent.tools import Toolbox
from lostfound.core import directions, skills
from lostfound.core.building import DOOR_PREFIX, Building, NoRouteError
from lostfound.core.resolve import Resolver
from lostfound.core.vehicles import BAY_ROOM_TYPES, FORKLIFT_MIN_WIDTH_M, is_bay
from lostfound.env import load_env
from lostfound.run_benchmark import structured, with_conditions

FACTORIES = sorted(p for p in Path("data/dev").glob("proc-factory-*") if (p / "building.json").exists())
PAIRS_PER_BUILDING = 12


def forklift_spaces(b: Building) -> list[str]:
    """Spaces with at least one opening a forklift fits through (bays, main aisles)."""
    wide = {s for o in b.openings.values() if o["width_m"] >= FORKLIFT_MIN_WIDTH_M for s in o["space_ids"]}
    return sorted(s for s in wide if s in b.spaces)


def reference_best(b: Building, start: str, end: str, forklift: bool) -> float | None:
    """Independent rule graph: other bays lose their centre, door-to-door walks inside bays are dropped."""
    graph = b.graph(step_free=forklift, min_width=FORKLIFT_MIN_WIDTH_M if forklift else None)
    if forklift:
        graph.remove_edges_from([(u, v, k) for u, v, k, d in graph.edges(keys=True, data=True) if "via" in d])
    for space_id, space in b.spaces.items():
        if not is_bay(space) or space_id not in graph:
            continue
        graph.remove_edges_from(
            [(u, v, k) for u, v, k, d in graph.edges(keys=True, data=True) if d.get("space") == space_id and space_id not in (u, v)]
        )
        if space_id not in (start, end):
            graph.remove_node(space_id)
    try:
        return nx.dijkstra_path_length(graph, start, end, weight="weight")
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None


def measure(b: Building, path: list[str], forklift: bool) -> float:
    """Length of a space sequence under the route model; fails the test on any rule violation."""
    for index, space_id in enumerate(path):
        if 0 < index < len(path) - 1:
            assert not is_bay(b.spaces[space_id]), f"route passes through bay {space_id}"
    walks = {}
    for space_id in path:
        table = {}
        for first, second, length in b.space_walks(space_id):
            table[(first, second)] = table[(second, first)] = round(length, 3)
        walks[space_id] = table
    states = {path[0]: 0.0}  # node where we stand in the current space -> length so far
    for here, following in itertools.pairwise(path):
        table = walks[here]
        doors = [
            DOOR_PREFIX + o["id"]
            for o in b.openings.values()
            if set(o["space_ids"]) == {here, following}
            and (not forklift or (o["width_m"] >= FORKLIFT_MIN_WIDTH_M and o["step_free"]))
        ]
        assert doors, f"no allowed opening between {here} and {following}"

        def inside(a: str, z: str) -> float:
            if a == z:
                return 0.0
            # Bays are entered or left only at their centre (no door-to-door shortcut through them).
            if is_bay(b.spaces[here]) and a != here and z != here:
                return table.get((a, here), float("inf")) + table.get((here, z), float("inf"))
            return table.get((a, z), float("inf"))

        states = {door: min(cost + inside(at, door) for at, cost in states.items()) for door in doors}
    last = path[-1]
    return min(cost + (0.0 if at == last else walks[last].get((at, last), float("inf"))) for at, cost in states.items())


@pytest.fixture(scope="module", params=[p.name for p in FACTORIES])
def factory(request) -> tuple[Path, Building]:
    directory = Path("data/dev") / request.param
    return directory, Building.load(directory)


def sample_pairs(b: Building, seed: str) -> list[tuple[str, str]]:
    spaces = forklift_spaces(b)
    pairs = [pair for pair in itertools.permutations(spaces, 2)]
    random.Random(seed).shuffle(pairs)
    bay_pairs = [p for p in pairs if is_bay(b.spaces[p[0]]) and is_bay(b.spaces[p[1]])][: PAIRS_PER_BUILDING // 2]
    return bay_pairs + [p for p in pairs if p not in bay_pairs][: PAIRS_PER_BUILDING - len(bay_pairs)]


def test_factories_have_bays_and_wide_openings(factory):
    _, b = factory
    assert any(is_bay(s) for s in b.spaces.values())
    assert forklift_spaces(b)


def test_forklift_routes_are_valid_and_optimal(factory):
    directory, b = factory
    for start, end in sample_pairs(b, b.id):
        best = reference_best(b, start, end, forklift=True)
        result = skills.route(b, start, end, forklift=True)
        assert result["reachable"] == (best is not None), (start, end, result.get("reason"))
        out = structured(directory, {"kind": "route", "stops": [start, end], **result})
        if best is None:
            assert out["reachable"] is False and out["route"] == [] and out["length_m"] is None
            continue
        assert out["route"][0] == start and out["route"][-1] == end
        assert not [n for n in out["element_path"] if n in b.connectors], "a forklift takes no stairs or lifts"
        length = measure(b, out["route"], forklift=True)
        assert length == pytest.approx(best, abs=0.02), (start, end)
        assert result["length_m"] == pytest.approx(best, abs=0.02)


def test_walking_routes_keep_the_kit_model_by_default(factory, monkeypatch):
    """Without a vehicle the bay rule is off (LOSTFOUND_BAY_RULE unset): exactly the kit's router."""
    monkeypatch.delenv("LOSTFOUND_BAY_RULE", raising=False)
    _, b = factory
    graph = b.graph()
    for start, end in sample_pairs(b, b.id + "walk"):
        result = skills.route(b, start, end)
        assert result["length_m"] == pytest.approx(round(nx.dijkstra_path_length(graph, start, end, weight="weight"), 2), abs=1e-9)


def test_bay_rule_for_walking_when_switched_on(factory, monkeypatch):
    monkeypatch.setenv("LOSTFOUND_BAY_RULE", "always")
    directory, b = factory
    for start, end in sample_pairs(b, b.id + "always"):
        best = reference_best(b, start, end, forklift=False)
        result = skills.route(b, start, end)
        assert result["reachable"] == (best is not None)
        if best is not None:
            out = structured(directory, {"kind": "route", "stops": [start, end], **result})
            assert measure(b, out["route"], forklift=False) == pytest.approx(best, abs=0.02)


def test_a_bay_can_be_a_stop_on_a_forklift_tour(factory):
    directory, b = factory
    bays = [s for s in forklift_spaces(b) if is_bay(b.spaces[s])]
    for start, stop, end in itertools.islice(itertools.permutations(bays, 3), 20):
        legs = [reference_best(b, start, stop, True), reference_best(b, stop, end, True)]
        if None in legs:
            continue
        result = skills.route(b, start, end, via=[stop], forklift=True)
        assert result["reachable"], result.get("reason")
        assert result["length_m"] == pytest.approx(sum(legs), abs=0.02)
        out = structured(directory, {"kind": "route", "stops": [start, stop, end], **result})
        assert stop in out["route"]
        # Re-measure leg by leg: the bay in the middle is a stop, so each leg is checked on its own.
        split = out["route"].index(stop)
        assert measure(b, out["route"][: split + 1], True) + measure(b, out["route"][split:], True) == pytest.approx(sum(legs), abs=0.02)
        return
    pytest.skip("no bay triple with forklift routes")


def test_forklift_cannot_use_offices_stairs_or_lifts(factory):
    _, b = factory
    office = next(s["id"] for s in b.spaces.values() if s["room_type"] == "office")
    bay = next(s for s in forklift_spaces(b) if is_bay(b.spaces[s]))
    result = skills.route(b, bay, office, forklift=True)
    assert result["reachable"] is False and "forklift" in result["reason"]
    with pytest.raises(NoRouteError):
        directions.route_details(b, bay, office, forklift=True)
    graph = b.route_graph(forklift=True, source=bay)
    assert not [d for *_, d in graph.edges(data=True) if "via" in d]
    assert all(b.openings[n.removeprefix(DOOR_PREFIX)]["width_m"] >= FORKLIFT_MIN_WIDTH_M for n in graph if n.startswith(DOOR_PREFIX))


def test_bay_types_exist_in_the_data():
    seen = {s["room_type"] for d in FACTORIES for s in json.loads((d / "building.json").read_text())["spaces"]}
    assert BAY_ROOM_TYPES <= seen


# ---------- agent bookkeeping and answers.json ----------


def test_answers_json_follows_the_committed_route(factory):
    """The agent may route twice (e.g. a fallback with an extra closure); answers.json keeps the one it answered."""
    directory, b = factory
    for start, end in sample_pairs(b, b.id + "tool"):
        path = skills.route(b, start, end)["space_path"]
        middle = [s for s in path[1:-1] if s in b.spaces]
        if not middle:
            continue
        fallback = skills.route(b, start, end, closed=[middle[0]])
        if fallback["reachable"] and fallback["length_m"] == skills.route(b, start, end)["length_m"]:
            continue
        toolbox = Toolbox(b, "hybrid")
        arguments = {"start": start, "destination": end, "via": [], "step_free": False, "min_door_width_m": 0, "forklift": False}
        first_line = json.loads(toolbox.call("route", {**arguments, "closed": []})[0])["answer_line"]
        toolbox.call("route", {**arguments, "closed": [middle[0]]})
        assert toolbox.last_result["closed"] == [middle[0]]
        chosen = toolbox.result_for(first_line.removeprefix("Answer:").strip())
        assert chosen["stops"] == [start, end] and chosen["closed"] == []
        out = structured(directory, chosen)
        assert out["reachable"] and out["route"] == [s for s in path if s in b.spaces]
        assert toolbox.result_for(None) is toolbox.last_result
        assert toolbox.result_for("12345.6") is toolbox.last_result
        return
    pytest.skip("no pair with a closable middle space")


def test_no_route_answers(factory):
    directory, b = factory
    toolbox = Toolbox(b, "hybrid")
    office = next(s["id"] for s in b.spaces.values() if s["room_type"] == "office")
    bay = next(s for s in forklift_spaces(b) if is_bay(b.spaces[s]))
    text, is_error = toolbox.call("route", {"start": bay, "destination": office, "via": [], "step_free": False, "closed": [],
                                            "min_door_width_m": 0, "forklift": True})
    assert not is_error and json.loads(text)["answer_line"] == "Answer: no route"
    out = structured(directory, toolbox.result_for("no route"))
    assert out == {"kind": "route", "reachable": False, "route": [], "route_nodes": [], "element_path": [], "length_m": None}


def test_errand_without_a_route_is_a_no_route_answer(factory):
    directory, b = factory
    toolbox = Toolbox(b, "hybrid")
    lobby = next(s for s in b.spaces.values() if s["room_type"] == "lobby")
    asset_type = next(a["type"] for a in b.assets.values())
    floor = b.spaces[lobby["id"]]["floor_id"]
    room_type = next(s["room_type"] for s in b.spaces_by_floor[floor] if s["type"] == "room")
    with b.temporarily_closed(*[o["id"] for o in b.openings.values() if lobby["id"] in o["space_ids"]]):
        text, is_error = toolbox.call("errand_distance", {"start": lobby["id"], "asset_type": asset_type, "target_floor": floor,
                                                          "target_room_type": room_type, "can_use_stairs": True})
    assert not is_error, text
    assert json.loads(text)["answer_line"] == "Answer: no route"
    assert structured(directory, toolbox.last_result)["reachable"] is False


def test_nearest_respects_closures(factory):
    _, b = factory
    toolbox = Toolbox(b, "hybrid")
    office = next(s["id"] for s in b.spaces.values() if s["room_type"] == "office")
    doors = [o["id"] for o in b.openings.values() if office in o["space_ids"]]
    text, is_error = toolbox.call("nearest", {"start": office, "what": "toilet", "step_free": False, "closed": doors})
    assert not is_error and json.loads(text)["answer_line"] == "Answer: no route"
    assert not b.closed


# ---------- small pieces ----------


def test_forklift_condition_is_spelled_out():
    assert "forklift" in with_conditions("From Logistics zone A to Production zone B?", {"forklift": True})
    assert "forklift" in with_conditions("From A to B?", {"vehicle": "Forklift"})
    assert with_conditions("Forklift from A to B?", {"forklift": True}).count("forklift") == 0


def test_items_resolve_to_the_room_that_holds_them(factory):
    _, b = factory
    asset = next(a for a in b.assets.values() if a["category"] == "machine")
    resolution = Resolver(b).space(asset["name"])
    assert resolution.best == asset["space_id"]


def test_env_file_loading(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# comment\nLF_TEST_A=one\nexport LF_TEST_B=\"two words\"\nLF_TEST_C=three # note\nLF_TEST_EMPTY=\nLF_TEST_SET=file\n")
    for key in ("LF_TEST_A", "LF_TEST_B", "LF_TEST_C", "LF_TEST_EMPTY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("LF_TEST_SET", "shell")
    load_env(env)
    import os

    assert (os.environ["LF_TEST_A"], os.environ["LF_TEST_B"], os.environ["LF_TEST_C"]) == ("one", "two words", "three")
    assert "LF_TEST_EMPTY" not in os.environ and os.environ["LF_TEST_SET"] == "shell"
    for key in ("LF_TEST_A", "LF_TEST_B", "LF_TEST_C"):
        monkeypatch.delenv(key)
