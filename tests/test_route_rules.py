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
from lostfound.core.vehicles import BAY_ROOM_TYPES
from lostfound.env import load_env
from lostfound.run_benchmark import structured, with_conditions

DEV = Path(__file__).resolve().parent.parent / "data" / "dev"
FACTORIES = sorted(p for p in DEV.glob("proc-factory-*") if (p / "building.json").exists())
PAIRS_PER_BUILDING = 12
# The rules as the organizers state them, written out here rather than imported from the code under test.
FORKLIFT_WIDTH = 3.0
BAY_TYPES = frozenset({"production_zone", "assembly_zone", "additive_zone", "warehouse_zone", "logistics_zone"})
assert FACTORIES, f"no factory buildings under {DEV}"


def is_bay(space: dict) -> bool:
    return space["room_type"] in BAY_TYPES


def forklift_spaces(b: Building) -> list[str]:
    """Spaces with at least one opening a forklift fits through (bays, main aisles)."""
    wide = {s for o in b.openings.values() if o["width_m"] >= FORKLIFT_WIDTH for s in o["space_ids"]}
    return sorted(s for s in wide if s in b.spaces)


def reference_best(b: Building, start: str, end: str, forklift: bool) -> float | None:
    """Independent rule graph: other bays lose their centre, door-to-door walks inside bays are dropped."""
    graph = b.graph(step_free=forklift, min_width=FORKLIFT_WIDTH if forklift else None)
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
            and (not forklift or (o["width_m"] >= FORKLIFT_WIDTH and o["step_free"]))
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
    directory = DEV / request.param
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
    assert all(b.openings[n.removeprefix(DOOR_PREFIX)]["width_m"] >= FORKLIFT_WIDTH for n in graph if n.startswith(DOOR_PREFIX))


def test_bays_are_the_factory_hall_zones():
    """Every factory hall except the hall-access lobbies is a bay, and the code uses exactly those room types."""
    halls = {s["room_type"] for d in FACTORIES for s in json.loads((d / "building.json").read_text())["spaces"] if s["type"] == "hall"}
    assert halls - {"lobby"} == BAY_TYPES == BAY_ROOM_TYPES


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


# ---------- a small synthetic factory with every case the kit data lacks ----------
#
#   y 4..14   B1 bay  | B2 bay  | B3 bay (logistics)          F1: U bay, reached only by lift L
#   y 0..4    A aisle | W walkway | E aisle                     LF0/LF1: lift shaft left of A
#   y -4..0   S loading (stepped from A) | N aisle | M aisle
#
# Openings are 4 m unless noted: E-B3 exactly 3.0 m, N-W and N-M 2.99 m, A-S not step-free, lift doors 3.5 m.


def _rect(x0: float, y0: float, x1: float, y1: float) -> list[list[float]]:
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _space(space_id: str, floor: str, kind: str, room_type: str, name: str, polygon: list) -> dict:
    return {"id": space_id, "floor_id": floor, "type": kind, "room_type": room_type, "name": name, "ref": "",
            "polygon": polygon, "synthetic": True}


def _opening(opening_id: str, floor: str, a: str, b: str, x: float, y: float, width: float = 4.0, step_free: bool = True) -> dict:
    return {"id": opening_id, "floor_id": floor, "space_ids": [a, b], "kind": "opening", "position": [x, y],
            "width_m": width, "step_free": step_free, "synthetic": True}


@pytest.fixture(scope="module")
def toy(tmp_path_factory) -> tuple[Path, Building]:
    spaces = [
        _space("A", "F0", "corridor", "corridor", "Main aisle A", _rect(0, 0, 10, 4)),
        _space("W", "F0", "corridor", "corridor", "Pedestrian walkway", _rect(10, 0, 20, 4)),
        _space("E", "F0", "corridor", "corridor", "Main aisle E", _rect(20, 0, 30, 4)),
        _space("B1", "F0", "hall", "production_zone", "Production zone B1", _rect(0, 4, 10, 14)),
        _space("B2", "F0", "hall", "production_zone", "Production zone B2", _rect(10, 4, 20, 14)),
        _space("B3", "F0", "hall", "logistics_zone", "Logistics zone B3", _rect(20, 4, 30, 14)),
        _space("S", "F0", "corridor", "corridor", "Loading area S", _rect(0, -4, 10, 0)),
        _space("N", "F0", "corridor", "corridor", "Main aisle N", _rect(10, -4, 20, 0)),
        _space("M", "F0", "corridor", "corridor", "Main aisle M", _rect(20, -4, 30, 0)),
        _space("LF0", "F0", "lift", "lift", "Lift L", _rect(-2, 0, 0, 2)),
        _space("LF1", "F1", "lift", "lift", "Lift L", _rect(-2, 0, 0, 2)),
        _space("U", "F1", "hall", "production_zone", "Production zone U", _rect(0, 0, 10, 10)),
    ]
    openings = [
        _opening("A-B1", "F0", "A", "B1", 5, 4), _opening("B1-B2", "F0", "B1", "B2", 10, 9),
        _opening("B2-B3", "F0", "B2", "B3", 20, 9), _opening("A-W", "F0", "A", "W", 10, 2),
        _opening("W-B2", "F0", "W", "B2", 15, 4), _opening("W-E", "F0", "W", "E", 20, 2),
        _opening("E-B3", "F0", "E", "B3", 25, 4, width=3.0), _opening("A-S", "F0", "A", "S", 5, 0, step_free=False),
        _opening("S-N", "F0", "S", "N", 10, -2), _opening("N-W", "F0", "N", "W", 15, 0, width=2.99),
        _opening("N-M", "F0", "N", "M", 20, -2, width=2.99), _opening("M-E", "F0", "M", "E", 25, 0),
        _opening("A-LF0", "F0", "A", "LF0", 0, 1, width=3.5), _opening("LF1-U", "F1", "LF1", "U", 0, 1, width=3.5),
    ]
    data = {
        "building": {"id": "toy-factory", "name": "Toy factory", "source": "procedural", "source_ref": {}, "license": "CC0",
                     "attribution": "", "split": "dev", "units": "m"},
        "floors": [{"id": "F0", "level": 0, "name": "Ground floor", "elevation_m": 0.0, "height_m": 6.0},
                   {"id": "F1", "level": 1, "name": "Floor 1", "elevation_m": 6.0, "height_m": 6.0}],
        "spaces": spaces,
        "openings": openings,
        "vertical_connectors": [{"id": "L", "kind": "lift", "name": "Lift L", "floor_ids": ["F0", "F1"], "space_ids": ["LF0", "LF1"],
                                 "step_free": True, "synthetic": True}],
        "assets": [],
    }
    directory = tmp_path_factory.mktemp("toy-factory")
    (directory / "building.json").write_text(json.dumps(data))
    return directory, Building.load(directory)


@pytest.mark.parametrize(
    ("start", "end", "forklift_path"),
    [
        ("A", "B1", ["A", "B1"]),            # drive straight into a bay
        ("E", "B3", ["E", "B3"]),            # an opening of exactly 3.0 m is wide enough
        ("A", "B2", None),                   # only through bay B1 or the pedestrian walkway
        ("E", "B2", None),                   # only through the walkway or bay B3
        ("N", "A", None),                    # only through the stepped opening A-S or the 2.99 m opening N-W
        ("N", "S", ["N", "S"]),
        ("N", "E", None),                    # the aisle M is only behind a 2.99 m opening
        ("M", "B3", ["M", "E", "B3"]),
        ("A", "U", None),                    # upstairs only by lift
        ("B1", "B2", ["B1", "B2"]),          # from one bay straight into the next
    ],
)
def test_toy_forklift_routes(toy, start, end, forklift_path):
    directory, b = toy
    result = skills.route(b, start, end, forklift=True)
    out = structured(directory, {"kind": "route", "stops": [start, end], **result})
    if forklift_path is None:
        assert result["reachable"] is False and out["route"] == [] and out["length_m"] is None
    else:
        assert result["reachable"] and out["route"] == forklift_path
        assert result["length_m"] == pytest.approx(measure(b, forklift_path, forklift=True), abs=0.01)
    assert skills.route(b, start, end)["reachable"]  # on foot every place is reachable


def test_toy_walking_ignores_the_bay_rule_by_default(toy, monkeypatch):
    monkeypatch.delenv("LOSTFOUND_BAY_RULE", raising=False)
    _, b = toy
    graph = b.graph()
    for start, end in itertools.permutations(["A", "B1", "B2", "B3", "E", "N", "U"], 2):
        expected = round(nx.dijkstra_path_length(graph, start, end, weight="weight"), 2)
        assert skills.route(b, start, end)["length_m"] == expected


def test_toy_bay_rule_on_foot_when_switched_on(toy, monkeypatch):
    monkeypatch.setenv("LOSTFOUND_BAY_RULE", "always")
    directory, b = toy
    result = skills.route(b, "A", "B2")
    assert result["reachable"] and "B1" not in result["space_path"]  # round through the walkway instead
    tour = skills.route(b, "A", "B3", via=["B1"])  # a bay as a stop: entered, then left again
    out = structured(directory, {"kind": "route", "stops": ["A", "B1", "B3"], **tour})
    assert tour["reachable"] and out["route"][:2] == ["A", "B1"] and "B2" not in out["route"]


def test_toy_tour_through_a_bay_stop(toy):
    directory, b = toy
    tour = skills.route(b, "A", "B2", via=["B1"], forklift=True)
    out = structured(directory, {"kind": "route", "stops": ["A", "B1", "B2"], **tour})
    assert tour["reachable"] and out["route"] == ["A", "B1", "B2"]
    assert skills.route(b, "A", "B2", forklift=True)["reachable"] is False  # the same trip without stopping


def test_toy_min_door_width_through_the_tool(toy):
    directory, b = toy
    toolbox = Toolbox(b, "hybrid")
    arguments = {"start": "E", "destination": "B3", "via": [], "step_free": False, "closed": [], "forklift": False}
    toolbox.call("route", {**arguments, "min_door_width_m": 3.5})
    wide = structured(directory, toolbox.last_result)
    assert "E-B3" not in wide["element_path"] and wide["route"] == ["E", "W", "B2", "B3"]
    assert all(b.openings[o]["width_m"] >= 3.5 for o in wide["element_path"])
    toolbox.call("route", {**arguments, "min_door_width_m": 0})
    assert structured(directory, toolbox.last_result)["route"] == ["E", "B3"]


def test_toy_errand_numbers_keep_the_kit_model(toy, monkeypatch):
    """With the bay rule on for walking, an errand's number and its answers.json route stay kit-model."""
    monkeypatch.setenv("LOSTFOUND_BAY_RULE", "always")
    directory, b = toy
    walkable = ["A", "W", "E", "B1", "B2", "B3", "N", "M", "U"]
    for stops in itertools.permutations(walkable, 3):
        kit = directions.route_details(b, stops[0], stops[-1], False, [stops[1]], bays=False)
        with_bays = directions.route_details(b, stops[0], stops[-1], False, [stops[1]], bays=True)
        if kit["space_path"] != with_bays["space_path"]:
            break
    else:
        pytest.fail("no errand in the toy building where the bay rule changes the route")
    record = {"kind": "errand", "start": stops[0], "step_free": False, "total_m": kit["length_m"],
              "pickup": {"space_id": stops[1]}, "target": {"space_id": stops[2]}}
    out = structured(directory, record)
    assert out["reachable"] and out["length_m"] == kit["length_m"]
    assert out["route"] == [s for s in kit["space_path"] if s in b.spaces]


# ---------- matching the committed answer ----------


def test_result_for_tolerates_units_markdown_and_rounding(toy):
    _, b = toy
    toolbox = Toolbox(b, "hybrid")
    base = {"start": "A", "destination": "B1", "via": [], "step_free": False, "min_door_width_m": 0}
    real = json.loads(toolbox.call("route", {**base, "closed": [], "forklift": False})[0])
    toolbox.call("route", {**base, "closed": ["A-B1"], "forklift": False})          # a fallback, longer
    toolbox.call("route", {**base, "destination": "B2", "closed": [], "forklift": True})  # no route
    toolbox.call("route", {**base, "start": "N", "destination": "U", "closed": [], "forklift": False})  # explored last
    value = real["answer_line"].removeprefix("Answer:").strip()
    for committed in (value, f"{value} m", f"**{value} m**", f"{value}.", f"{float(value):.1f}"):
        chosen = toolbox.result_for(committed)
        assert chosen["stops"] == ["A", "B1"] and chosen["closed"] == [] and chosen["reachable"], committed
    for committed in ("no route", "No route exists.", "There is no forklift route."):
        assert toolbox.result_for(committed)["reachable"] is False, committed
    assert toolbox.result_for("999") is toolbox.last_result


def test_nearest_picks_the_next_target_when_one_is_closed(factory):
    """Closing the nearest toilet's doors must move the answer to the next toilet, routed under the closure."""
    directory, b = factory
    office = next(s["id"] for s in b.spaces.values() if s["room_type"] == "office")
    toilets = [s["id"] for s in b.spaces.values() if s["room_type"] == "toilet"]
    distances = b.distances_from(office)
    ranked = sorted((t for t in toilets if t in distances), key=distances.get)
    if len(ranked) < 2:
        pytest.skip("needs two reachable toilets")
    doors = [o["id"] for o in b.openings.values() if ranked[0] in o["space_ids"]]
    with b.temporarily_closed(*doors):
        after = b.distances_from(office)
    expected = min((t for t in ranked[1:] if t in after), key=after.get)
    toolbox = Toolbox(b, "hybrid")
    output = json.loads(toolbox.call("nearest", {"start": office, "what": "toilet", "step_free": False, "closed": doors})[0])
    assert output["in"] == b.label(expected)
    assert sorted(toolbox.last_result["closed"]) == sorted(doors)  # the route itself is computed under the closure
    out = structured(directory, toolbox.last_result)
    assert out["route"][-1] == expected and not set(doors) & set(out["element_path"])
    assert out["length_m"] == pytest.approx(round(after[expected], 2), abs=0.01)


def test_env_file_quotes_comments_and_bom(tmp_path, monkeypatch):
    import os

    env = tmp_path / ".env"
    env.write_text('LF_TEST_Q="sk-123" # team key\nLF_TEST_S=\'single\'\n', encoding="utf-8-sig")
    for key in ("LF_TEST_Q", "LF_TEST_S"):
        monkeypatch.delenv(key, raising=False)
    load_env(env)
    assert os.environ["LF_TEST_Q"] == "sk-123" and os.environ["LF_TEST_S"] == "single"
    for key in ("LF_TEST_Q", "LF_TEST_S"):
        monkeypatch.delenv(key)
