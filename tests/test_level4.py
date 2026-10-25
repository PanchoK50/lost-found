"""Level 4 readiness: after the code freeze the organizers run our BENCHMARK.md command on a building nobody has
seen, in the kit format, with questions like the kit's. Nothing here needs labels for that building or an API key:

- disguised buildings: labelled dev buildings with new ids (kit-style and opaque), moved and turned in the plane and
  with every list reordered must give the labelled answers, so no answer depends on a particular building;
- the unlabelled test buildings (layouts train never shows: bigger halls, L-shaped wings, basements, more cores):
  routes, step-free routes, closures and tours against the kit's own route model, errands against a brute force;
- the test questions: every one is understood by the template parser and the submitted answers agree with it;
- the runner: every questions format, several buildings in one run, and the organizers' answers.json format;
- routes across two buildings: the journey length is the indoor walks plus the walk across, and the shortest one."""

import copy
import csv
import functools
import hashlib
import itertools
import json
import math
import sys
from pathlib import Path

import networkx as nx
import pytest

from benchmark.score import committed_answer, score_reply
from lostfound import run_benchmark
from lostfound.agent import rules
from lostfound.agent.format import answer_line
from lostfound.agent.tools import Toolbox
from lostfound.core import reach, skills
from lostfound.core.building import ROOMISH_TYPES, Building
from lostfound.core.campus import Campus, CampusMember
from lostfound.evals.variants import Outcome
from starter_agent.building_map import DOOR_PREFIX, OUTSIDE, BuildingMap, MapError

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TEST_BUILDINGS = sorted(path.parent.name for path in (DATA / "test").glob("*/building.json"))
ROUTE_TOLERANCE = 0.01  # the kit's warm-up tolerance (1 %, at least 1 cm)

# One labelled dev building per source, small enough to rebuild in seconds.
DISGUISED = ["proc-factory-dev-003", "proc-campus-dev-000", "osm-way27326387", "osm-way360544293", "swiss-1689", "resplan-439"]


def close_enough(value: float, expected: float) -> bool:
    return abs(value - expected) <= max(ROUTE_TOLERANCE * abs(expected), ROUTE_TOLERANCE)


def jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()] if path.exists() else []


# ---------- disguised buildings ----------

OFFSET = (517.25, -313.5)


def turn(point: list[float]) -> list[float]:
    """Half a turn about the origin, then a shift: lengths, areas and the kit's room anchors carry over exactly."""
    return [round(OFFSET[0] - point[0], 6), round(OFFSET[1] - point[1], 6)]


def disguise(data: dict, style: str) -> tuple[dict, dict[str, str]]:
    """The same building as the Sunday one might arrive: other ids, other coordinates, other list order.

    style "kit": the kit's id scheme under a new building id; "opaque": ids without any structure."""
    old_id = data["building"]["id"]
    ids = [old_id] + [item["id"] for key in ("floors", "spaces", "openings", "vertical_connectors", "assets") for item in data[key]]
    if style == "kit":
        mapping = {old: old.replace(old_id, "sunday-0001", 1) for old in ids}
    else:
        mapping = {old: "x" + hashlib.sha1(old.encode()).hexdigest()[:12] for old in ids}
    assert len(set(mapping.values())) == len(mapping)
    m = lambda value: mapping.get(value, value)  # noqa: E731 - "outside" stays "outside"
    new = copy.deepcopy(data)
    new["building"]["id"] = m(old_id)
    new["building"]["name"] = "Werk Sonntag 99"
    for floor in new["floors"]:
        floor["id"] = m(floor["id"])
    for space in new["spaces"]:
        space.update(id=m(space["id"]), floor_id=m(space["floor_id"]), polygon=[turn(p) for p in space["polygon"]])
    for opening in new["openings"]:
        opening.update(id=m(opening["id"]), floor_id=m(opening["floor_id"]), space_ids=[m(s) for s in opening["space_ids"]],
                       position=turn(opening["position"]))
    for connector in new["vertical_connectors"]:
        connector.update(id=m(connector["id"]), floor_ids=[m(f) for f in connector["floor_ids"]], space_ids=[m(s) for s in connector["space_ids"]])
    for asset in new["assets"]:
        asset.update(id=m(asset["id"]), space_id=m(asset["space_id"]), floor_id=m(asset["floor_id"]), position=turn(asset["position"]))
    for key in ("floors", "spaces", "openings", "vertical_connectors", "assets"):
        new[key].reverse()
    return new, mapping


@functools.cache
def disguised(building_id: str, style: str, root: Path) -> tuple[Building, dict[str, str]]:
    data, mapping = disguise(json.loads((DATA / "dev" / building_id / "building.json").read_text(encoding="utf-8")), style)
    folder = root / f"{building_id}-{style}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "building.json").write_text(json.dumps(data), encoding="utf-8")
    return Building.load(folder), mapping


@pytest.fixture(scope="module")
def disguise_root(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("sunday")


def remap(value, mapping: dict[str, str]):
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [remap(item, mapping) for item in value]
    if isinstance(value, dict):
        return {key: remap(item, mapping) for key, item in value.items()}
    return value


@pytest.mark.parametrize("style", ["kit", "opaque"])
@pytest.mark.parametrize("building_id", DISGUISED)
def test_benchmark_questions_on_a_disguised_building(building_id, style, disguise_root):
    """Each labelled benchmark question, read from its text and answered on the disguised copy, still scores."""
    building, mapping = disguised(building_id, style, disguise_root)
    original = Building.load(DATA / "dev" / building_id)
    questions = jsonl(DATA / "dev" / building_id / "questions.jsonl")
    assert questions
    for question in questions:
        parsed = rules.parse(building, question["question"])
        assert parsed is not None, (question["id"], question["question"])
        reference = rules.parse(original, question["question"])
        assert parsed.kind == reference.kind and parsed.inputs == remap(reference.inputs, mapping), question["id"]
        reply = answer_line(building, parsed.kind, rules.solve(building, parsed))
        assert score_reply(question["answer"], reply), (question["id"], reply, question["answer"])


@pytest.mark.parametrize("style", ["kit", "opaque"])
@pytest.mark.parametrize("building_id", DISGUISED)
def test_warmup_answers_on_a_disguised_building(building_id, style, disguise_root):
    """Locate, count, routes (step-free, with a closure) and tours give the labelled answers on the disguised copy."""
    building, mapping = disguised(building_id, style, disguise_root)
    questions = jsonl(DATA / "dev" / building_id / "questions_basic.jsonl")
    assert questions
    for question in questions:
        answer, kind = remap(question["answer"], mapping), question["kind"]
        if kind == "locate":
            asset_type = building.assets[answer["asset_id"]]["type"]
            assert answer["asset_id"] in [match["asset_id"] for match in skills.locate(building, asset_type)["matches"]]
            continue
        if kind == "count":
            floor_id = building.floor_by_level(answer["floor_level"])["id"]
            assert skills.count_assets(building, answer["asset_type"], floor_id)["count"] == answer["count"], question["id"]
            continue
        if kind == "tour":
            stops = answer["stops"]
            result = skills.route(building, stops[0], stops[-1], via=stops[1:-1])
        else:
            result = skills.route(building, answer["from_space_id"], answer["to_space_id"], step_free=kind == "route_step_free",
                                  closed=[answer["closed_element_id"]] if "closed_element_id" in answer else None)
        if answer.get("reachable") is False:
            assert result["reachable"] is False, question["id"]
            continue
        assert result["reachable"], (question["id"], result)
        assert close_enough(result["length_m"], answer["optimal_length_m"]), (question["id"], result["length_m"], answer["optimal_length_m"])
        if "space_path" in answer:
            assert result["space_path"] == answer["space_path"], question["id"]


# ---------- unseen layouts: the test buildings against the kit's route model ----------


@functools.cache
def unseen_building(building_id: str) -> Building:
    return Building.load(DATA / "test" / building_id)


@functools.cache
def kit_map(building_id: str) -> BuildingMap:
    """The kit's own reference implementation, loaded separately from ours."""
    return BuildingMap.load(DATA / "test" / building_id)


def rooms(building: Building) -> list[str]:
    return sorted(space["id"] for space in building.spaces.values() if space["type"] in ROOMISH_TYPES)


def sample(items: list[str], count: int, salt: str) -> list[str]:
    """A fixed, spread-out choice (no randomness): the same items every run."""
    ranked = sorted(items, key=lambda item: hashlib.sha1(f"{salt}:{item}".encode()).hexdigest())
    return ranked[:count]


def kit_length(building_id: str, stops: list[str], step_free: bool = False, closed: tuple[str, ...] = ()) -> float | None:
    kit = kit_map(building_id)
    kit.closed = set(closed)
    try:
        return kit.route(stops[0], stops[-1], step_free, via=stops[1:-1]).length_m
    except MapError:
        return None
    finally:
        kit.closed = set()


def cross_floor_pairs(building: Building, salt: str, count: int) -> list[tuple[str, str]]:
    """Pairs on different floors first (they use stairs and lifts), then any pairs."""
    candidates = rooms(building)
    pairs = [(a, b) for a, b in itertools.combinations(sample(candidates, 12, salt), 2) if a != b]
    pairs.sort(key=lambda pair: (building.spaces[pair[0]]["floor_id"] == building.spaces[pair[1]]["floor_id"],
                                 hashlib.sha1(f"{salt}{pair}".encode()).hexdigest()))
    return pairs[:count]


@pytest.mark.parametrize("building_id", TEST_BUILDINGS)
def test_routes_match_the_kit_model_on_unseen_layouts(building_id):
    """Plain and step-free routes, and routes with a lift, stair or door closed, equal the kit's own router."""
    building = unseen_building(building_id)
    for start, destination in cross_floor_pairs(building, "route", 6):
        for step_free in (False, True):
            ours = skills.route(building, start, destination, step_free=step_free)
            expected = kit_length(building_id, [start, destination], step_free)
            if expected is None:
                assert ours["reachable"] is False, (start, destination, step_free)
            else:
                assert ours["reachable"] and close_enough(ours["length_m"], expected), (start, destination, step_free, ours, expected)
    closable = sorted(building.connectors) + sample(sorted(building.openings), 3, "door")
    for element, (start, destination) in zip(closable, itertools.cycle(cross_floor_pairs(building, "closed", 4) or [None])):
        if start is None:
            break
        ours = skills.route(building, start, destination, closed=[element])
        expected = kit_length(building_id, [start, destination], closed=(element,))
        assert building.closed == set(), "a closure must not outlive its question"
        if expected is None:
            assert ours["reachable"] is False, (element, start, destination)
        else:
            assert ours["reachable"] and close_enough(ours["length_m"], expected), (element, start, destination, ours, expected)


@pytest.mark.parametrize("building_id", TEST_BUILDINGS)
def test_tours_are_the_sum_of_their_legs(building_id):
    """A tour visits the stops in the given order; its length is the sum of the shortest legs, step-free or not."""
    building = unseen_building(building_id)
    candidates = sample(rooms(building), 8, "tour")
    if len(candidates) < 3:
        pytest.skip("fewer than three rooms")
    for stops in (candidates[:3], candidates[3:7] if len(candidates) >= 7 else candidates[:4][::-1]):
        for step_free in (False, True):
            ours = skills.route(building, stops[0], stops[-1], step_free=step_free, via=stops[1:-1])
            legs = [kit_length(building_id, list(pair), step_free) for pair in itertools.pairwise(stops)]
            if None in legs:
                assert ours["reachable"] is False, (stops, step_free)
                continue
            assert ours["reachable"], (stops, step_free, ours)
            assert close_enough(ours["length_m"], sum(legs)), (stops, step_free, ours["length_m"], legs)
            path = ours["space_path"]
            positions = [path.index(stops[0])]
            for stop in stops[1:]:  # the stops appear in order along the path
                positions.append(path.index(stop, positions[-1]))
            assert path[0] == stops[0] and path[-1] == stops[-1]


@pytest.mark.parametrize("building_id", TEST_BUILDINGS)
def test_errands_pick_the_nearest_pickup_and_the_largest_room(building_id):
    """Errand = shortest walk to the nearest room holding the item, then on to the largest room of a type.
    Recomputed here by brute force over every room that holds one, with the kit's router."""
    building = unseen_building(building_id)
    asset_types = sample(sorted({asset["type"] for asset in building.assets.values()}), 3, "asset")
    targets = []
    for floor_id in sorted(building.floors):
        by_type: dict[str, list[str]] = {}
        for space in building.spaces_by_floor[floor_id]:
            if space["type"] in ROOMISH_TYPES:
                by_type.setdefault(space["room_type"], []).append(space["id"])
        targets += [(floor_id, room_type) for room_type, ids in sorted(by_type.items()) if len(ids) >= 2][:1]
    if not asset_types or not targets:
        pytest.skip("no item or no room type with two rooms")
    for start, asset_type, (floor_id, room_type), step_free in zip(
        sample(rooms(building), 3, "start"), asset_types, itertools.cycle(targets), (False, True, False)
    ):
        holders = sorted({asset["space_id"] for asset in building.assets.values() if asset["type"] == asset_type})
        first_legs = {holder: kit_length(building_id, [start, holder], step_free) for holder in holders}
        first_legs = {holder: length for holder, length in first_legs.items() if length is not None}
        target = skills.largest_room(building, floor_id, room_type)["space_id"]
        assert target == max(building.rooms_on_floor(floor_id, room_type), key=lambda s: building.polygon(s["id"]).area)["id"]
        try:
            ours = skills.errand(building, start, asset_type, floor_id, room_type, step_free)
        except MapError:
            assert not first_legs or kit_length(building_id, [min(first_legs, key=first_legs.get), target], step_free) is None
            continue
        best = min(first_legs.values())
        assert close_enough(ours["first_leg_m"], best), (start, asset_type, ours, first_legs)
        second = kit_length(building_id, [ours["pickup"]["space_id"], target], step_free)
        assert second is not None and close_enough(ours["second_leg_m"], second)
        assert close_enough(ours["total_m"], best + second), (ours["total_m"], best, second)
        assert ours["target"]["space_id"] == target


# ---------- the test questions and the submitted answers ----------


@functools.cache
def kit_test_questions() -> list[dict]:
    return list(csv.DictReader((DATA / "test" / "questions.csv").read_text(encoding="utf-8-sig").splitlines()))


def test_every_test_question_is_understood_and_answered():
    """The template parser reads all 145 test questions (room names, basements, floor names of unseen layouts)
    and computes an answer for each; a question it can't read would fall to Claude alone."""
    failures = []
    for row in kit_test_questions():
        building = unseen_building(row["building_id"])
        parsed = rules.parse(building, row["question"])
        if parsed is None or parsed.kind != row["kind"]:
            failures.append((row["question_id"], parsed and parsed.kind))
            continue
        assert committed_answer(answer_line(building, parsed.kind, rules.solve(building, parsed)))
    assert not failures, failures


def test_submission_has_the_organizers_format():
    """SUBMISSION/ holds exactly BENCHMARK.md and answers.json; answers.json is a list of {question_id, answer},
    one per test question, in question order, each with an Answer: line."""
    assert sorted(path.name for path in (ROOT / "SUBMISSION").iterdir()) == ["BENCHMARK.md", "answers.json"]
    answers = json.loads((ROOT / "SUBMISSION" / "answers.json").read_text(encoding="utf-8"))
    assert isinstance(answers, list)
    assert [entry["question_id"] for entry in answers] == [row["question_id"] for row in kit_test_questions()]
    for entry in answers:
        assert set(entry) == {"question_id", "answer"}, entry
        assert isinstance(entry["answer"], str) and committed_answer(entry["answer"]), entry


def test_submitted_answers_agree_with_the_computed_ones():
    """The agent's committed answers equal what the deterministic path computes from the same question text."""
    submitted = {entry["question_id"]: committed_answer(entry["answer"]) for entry in json.loads((ROOT / "SUBMISSION" / "answers.json").read_text(encoding="utf-8"))}
    differences = []
    for row in kit_test_questions():
        building = unseen_building(row["building_id"])
        parsed = rules.parse(building, row["question"])
        computed = committed_answer(answer_line(building, parsed.kind, rules.solve(building, parsed)))
        if computed != submitted[row["question_id"]]:
            differences.append((row["question_id"], submitted[row["question_id"]], computed))
    assert not differences, differences


# ---------- the runner: input formats, several buildings, answers.json ----------


class EchoQA:
    """Stands in for Claude: answers with the building it was given, so the test sees which building was used."""

    def __init__(self, *args, **kwargs) -> None:
        self.seen: list[tuple[str, str]] = []

    def answer_question(self, building_directory: Path, question: str) -> Outcome:
        if "explode" in question:
            raise RuntimeError("model unavailable")
        return Outcome(reply=f"Looked it up in {building_directory.name}.\nAnswer: {building_directory.name} | {question.split('?')[0]}?")


def run(monkeypatch, tmp_path: Path, building_dir: Path, questions: Path, *extra: str) -> list[dict]:
    monkeypatch.setattr(run_benchmark, "BuildingQA", EchoQA)
    monkeypatch.setattr(run_benchmark, "require_api_key", lambda: None)
    output = tmp_path / "out" / "answers.json"
    monkeypatch.setattr(sys, "argv", ["run_benchmark", str(building_dir), str(questions), str(output), "--workers", "2", *extra])
    run_benchmark.main()
    return json.loads(output.read_text(encoding="utf-8"))


@pytest.fixture
def two_buildings(tmp_path) -> Path:
    """A Sunday-style folder with two buildings, as data/test is laid out."""
    root = tmp_path / "sunday"
    for building_id in ("proc-factory-dev-003", "swiss-1689"):
        (root / building_id).mkdir(parents=True)
        (root / building_id / "building.json").write_text((DATA / "dev" / building_id / "building.json").read_text(encoding="utf-8"), encoding="utf-8")
    return root


def test_runner_sends_each_question_to_its_building(monkeypatch, tmp_path, two_buildings):
    questions = tmp_path / "questions.csv"
    questions.write_text(
        "question_id,building_id,kind,question\n"
        "S-1,swiss-1689,route,Where is the kitchen?\n"
        "S-2,proc-factory-dev-003,route,\"Where is the forklift, please?\"\n"
        "S-3,no-such-building,route,Where am I?\n"
        "S-4,swiss-1689,route,Which room is largest?\n",
        encoding="utf-8",
    )
    answers = run(monkeypatch, tmp_path, two_buildings, questions, "--details", str(tmp_path / "details.json"), "--csv", str(tmp_path / "a.csv"))
    assert [entry["question_id"] for entry in answers] == ["S-1", "S-2", "S-3", "S-4"]
    assert all(set(entry) == {"question_id", "answer"} for entry in answers)
    assert answers[0]["answer"] == "Answer: swiss-1689 | Where is the kitchen?"
    assert answers[1]["answer"].startswith("Answer: proc-factory-dev-003 | Where is the forklift, please?")
    assert answers[2]["answer"] == ""  # an unknown building loses only its own question
    assert answers[3]["answer"].startswith("Answer: swiss-1689")
    details = json.loads((tmp_path / "details.json").read_text(encoding="utf-8"))
    assert details["S-1"]["reply"].startswith("Looked it up in swiss-1689") and "error" in details["S-3"]
    rows = list(csv.DictReader((tmp_path / "a.csv").read_text(encoding="utf-8").splitlines()))
    assert [row["question_id"] for row in rows] == ["S-1", "S-2", "S-3", "S-4"]


@pytest.mark.parametrize("layout", ["list", "wrapped", "jsonl", "mapping", "question_id", "text_key"])
def test_runner_reads_every_questions_format(monkeypatch, tmp_path, layout):
    building = DATA / "dev" / "swiss-1689"
    items = [{"id": "Q-a", "question": "Where is the kitchen?"}, {"id": "Q-b", "question": "How big is the bathroom?"}]
    path = tmp_path / ("questions.jsonl" if layout == "jsonl" else "questions.json")
    content = {
        "list": json.dumps(items),
        "wrapped": json.dumps({"questions": items}),
        "jsonl": "\n".join(json.dumps(item) for item in items),
        "mapping": json.dumps({item["id"]: item["question"] for item in items}),
        "question_id": json.dumps([{"question_id": item["id"], "question": item["question"]} for item in items]),
        "text_key": json.dumps([{"id": item["id"], "text": item["question"]} for item in items]),
    }[layout]
    path.write_text("﻿" + content if layout == "list" else content, encoding="utf-8")  # a BOM must not matter
    answers = run(monkeypatch, tmp_path, building, path)
    assert answers == [
        {"question_id": "Q-a", "answer": "Answer: swiss-1689 | Where is the kitchen?"},
        {"question_id": "Q-b", "answer": "Answer: swiss-1689 | How big is the bathroom?"},
    ]


def test_runner_keeps_going_when_one_question_fails(monkeypatch, tmp_path):
    path = tmp_path / "questions.json"
    path.write_text(json.dumps([{"id": "1", "question": "explode now?"}, {"id": "2", "question": "Where is the kitchen?"}, {"id": "3"}]))
    answers = run(monkeypatch, tmp_path, DATA / "dev" / "swiss-1689", path)
    assert [entry["answer"] for entry in answers] == ["", "Answer: swiss-1689 | Where is the kitchen?", ""]


def test_submission_entries_carry_the_answer_line():
    entries = run_benchmark.submission([("a", {"answer": "42.17", "reply": "x\nAnswer: 42.17"}), ("b", {"answer": "", "reply": ""}),
                                        ("c", {"answer": "no route", "reply": "Answer: no route"})])
    assert entries == [{"question_id": "a", "answer": "Answer: 42.17"}, {"question_id": "b", "answer": ""},
                       {"question_id": "c", "answer": "Answer: no route"}]
    assert score_reply({"type": "number", "value": 42.0, "relative_tolerance": 0.01, "absolute_tolerance": 1.0}, entries[0]["answer"])


# ---------- across buildings: the journey length ----------


def site(first: str, second: str, offset: tuple[float, float]) -> tuple[Campus, Building, Building]:
    a, b = Building.load(DATA / "dev" / first), Building.load(DATA / "dev" / second)
    return Campus([CampusMember(a, (0.0, 0.0), "here"), CampusMember(b, offset, "assumed")]), a, b


def entrances(building: Building) -> list[dict]:
    return [opening for opening in building.openings.values() if OUTSIDE in opening["space_ids"]]


def brute_force_journey(a: Building, b: Building, offset: tuple[float, float], start: str, destination: str) -> tuple[float, tuple[str, str]]:
    """Every exit of A with every entrance of B: walk to the exit door, across, and from the entrance door on.
    Indoors this is the kit's route model (door nodes), outdoors the straight line between the doors."""
    from_start = a.distances_from(start)
    best = (math.inf, ("", ""))
    for exit_door in entrances(a):
        for entry_door in entrances(b):
            inside_a = from_start.get(DOOR_PREFIX + exit_door["id"])
            inside_b = b.distances_from(destination).get(DOOR_PREFIX + entry_door["id"])
            if inside_a is None or inside_b is None:
                continue
            across = math.dist(exit_door["position"], (entry_door["position"][0] + offset[0], entry_door["position"][1] + offset[1]))
            best = min(best, (inside_a + across + inside_b, (exit_door["id"], entry_door["id"])))
    return best


JOURNEYS = [("proc-campus-dev-000", "proc-factory-dev-003", (150.0, 40.0)), ("swiss-1689", "proc-campus-dev-001", (-60.0, 90.0))]


@pytest.mark.parametrize(("first", "second", "offset"), JOURNEYS)
def test_journey_between_buildings_is_indoor_plus_outdoor(first, second, offset):
    """The reported length is the sum of its legs, and each indoor leg is a real route in its building."""
    campus, a, b = site(first, second, offset)
    for start, destination in zip(sample(rooms(a), 3, "from"), sample(rooms(b), 3, "to")):
        journey = campus.cross_route((a.id, start), (b.id, destination))
        assert [leg["kind"] for leg in journey["legs"]] == ["indoor", "outdoor", "indoor"]
        assert journey["length_m"] == pytest.approx(sum(leg["length_m"] for leg in journey["legs"]), abs=0.1)
        first_leg, last_leg = journey["legs"][0], journey["legs"][2]  # the drawn indoor routes start and end right
        assert first_leg["route"]["space_path"][0] == start and last_leg["route"]["space_path"][-1] == destination
        assert all(space in a.spaces for space in first_leg["route"]["space_path"])
        assert all(space in b.spaces for space in last_leg["route"]["space_path"])
        outdoor = journey["legs"][1]
        door_a, door_b = a.openings[outdoor["from"]["opening_id"]], b.openings[outdoor["to"]["opening_id"]]
        across = math.dist(door_a["position"], (door_b["position"][0] + offset[0], door_b["position"][1] + offset[1]))
        assert outdoor["length_m"] == pytest.approx(across, abs=0.1)


def journey_total(a: Building, b: Building, offset: tuple[float, float], start: str, destination: str, pair: tuple[str, str]) -> float:
    exit_door, entry_door = a.openings[pair[0]], b.openings[pair[1]]
    across = math.dist(exit_door["position"], (entry_door["position"][0] + offset[0], entry_door["position"][1] + offset[1]))
    return a.distances_from(start)[DOOR_PREFIX + pair[0]] + across + b.distances_from(destination)[DOOR_PREFIX + pair[1]]


@pytest.mark.parametrize(("first", "second", "offset"), JOURNEYS)
def test_journey_between_buildings_takes_the_best_exit_and_entrance(first, second, offset):
    """No other exit and entrance pair gives a shorter walk (all entrances of these buildings are on the ground
    floor, so the penalty for entrances on other levels plays no part)."""
    campus, a, b = site(first, second, offset)
    assert all(building.level(o["floor_id"]) == 0 for building in (a, b) for o in entrances(building))
    for start, destination in zip(sample(rooms(a), 3, "from"), sample(rooms(b), 3, "to")):
        journey = campus.cross_route((a.id, start), (b.id, destination))
        best, pair = brute_force_journey(a, b, offset, start, destination)
        chosen = (journey["legs"][1]["from"]["opening_id"], journey["legs"][1]["to"]["opening_id"])
        assert journey_total(a, b, offset, start, destination, chosen) == pytest.approx(best, abs=0.01), (chosen, pair)


@pytest.mark.parametrize(("first", "second", "offset"), JOURNEYS)
def test_journey_length_is_the_walk_through_the_doors(first, second, offset):
    """The reported length is the walk to the exit door, across, and from the entrance door to the destination
    (not to and from the centre of the entrance space, which was 1 to 10 m off on these sites)."""
    campus, a, b = site(first, second, offset)
    for start, destination in zip(sample(rooms(a), 3, "from"), sample(rooms(b), 3, "to")):
        journey = campus.cross_route((a.id, start), (b.id, destination))
        best, _ = brute_force_journey(a, b, offset, start, destination)
        assert close_enough(journey["length_m"], best), (start, destination, journey["length_m"], best)


# ---------- plans that skip a level ----------

GAPS = [("dev", "osm-way27326387", 0, "below", -2), ("train", "osm-way58216509", 0, "above", 2)]


@pytest.mark.parametrize(("split", "building_id", "level", "direction", "expected_level"), GAPS)
def test_stacking_takes_the_next_floor_that_exists(split, building_id, level, direction, expected_level):
    """Levels -2, 0, 1 (or 0, 2): the room below a ground-floor room is on -2 (above: on 2), the space there that
    covers most of its outline, by brute force; asking past the last floor is a clear error, not a crash."""
    building = Building.load(DATA / split / building_id)
    asked = [space["id"] for space in building.spaces.values() if building.space_level(space["id"]) == level and space["type"] == "room"]
    answered = 0
    for space_id in asked:
        outline = building.polygon(space_id)
        overlaps = {other["id"]: building.polygon(other["id"]).intersection(outline).area
                    for other in building.spaces_by_floor[building.floor_by_level(expected_level)["id"]]}
        if max(overlaps.values(), default=0.0) <= 0:
            with pytest.raises(MapError):
                skills.room_stacked(building, space_id, direction)
            continue
        result = skills.room_stacked(building, space_id, direction)
        assert building.space_level(result["space_id"]) == expected_level
        assert overlaps[result["space_id"]] == pytest.approx(max(overlaps.values()))
        answered += 1
    assert answered, "no room on that floor lies under/over the next floor"
    top = max(building.floors_by_level)
    roof = next(space["id"] for space in building.spaces.values() if building.space_level(space["id"]) == top)
    with pytest.raises(MapError, match="No floor above"):
        skills.room_stacked(building, roof, "above")


# ---------- several buildings in one plan ----------
# In the kit, "several buildings" are parts of one building.json: wings or houses joined by corridors, bridges or
# walkways where the plan has them, and otherwise only outside. Routes never go round the outside, so between parts
# that only meet outside the expected answer is reachable: false (233 warm-up labels say so).


def parts(building: Building) -> list[set[str]]:
    """The building's parts with at least three rooms each, as the kit's own graph joins them."""
    graph = kit_map_of(building).graph(step_free=False)
    found = []
    for component in nx.connected_components(graph):
        spaces = {node for node in component if node in building.spaces}
        if sum(building.spaces[s]["type"] in ROOMISH_TYPES for s in spaces) >= 3:
            found.append(spaces)
    return sorted(found, key=lambda part: min(part))


def kit_map_of(building: Building) -> BuildingMap:
    return BuildingMap.load(Path(building.directory))


MULTI_PART = [("dev", name) for name in ("osm-way360544293", "swiss-1689", "swiss-2211")] + [
    ("test", name) for name in ("osm-way50299584", "osm-way50300147", "swiss-100", "swiss-1195", "swiss-6128")
]


@pytest.mark.parametrize(("split", "building_id"), MULTI_PART)
def test_no_route_between_parts_that_only_meet_outside(split, building_id):
    """Between two parts: no route (also step-free and as a tour), the tool answers 'no route', and reach counts
    from one part never include rooms of another."""
    building = Building.load(DATA / split / building_id)
    found = parts(building)
    assert len(found) >= 2, "the building should consist of several parts"
    for here, there in itertools.combinations(found, 2):
        start = min(s for s in here if building.spaces[s]["type"] in ROOMISH_TYPES)
        goal = min(s for s in there if building.spaces[s]["type"] in ROOMISH_TYPES)
        for step_free in (False, True):
            assert skills.route(building, start, goal, step_free=step_free)["reachable"] is False
        middle = max(s for s in here if building.spaces[s]["type"] in ROOMISH_TYPES and s != start)
        assert skills.route(building, start, goal, via=[middle])["reachable"] is False  # a tour that ends in the other part
        text, is_error = Toolbox(building, "hybrid").call(
            "route", {"start": start, "destination": goal, "via": [], "step_free": False, "closed": [], "min_door_width_m": 0, "forklift": False})
        assert not is_error and json.loads(text)["answer_line"] == "Answer: no route", text
        assert not reach.reachable_spaces(building, start, step_free=False) & there
    for part in found:  # inside one part, routes work as usual
        inside = sorted(s for s in part if building.spaces[s]["type"] in ROOMISH_TYPES)
        assert skills.route(building, inside[0], inside[-1])["reachable"]


def test_the_benchmark_agent_never_routes_between_separate_buildings():
    """Routing between separate building files needs placement data the kit format doesn't have, so the batch
    agent that answers the benchmark has no cross-building tool; only the chat with a catalogue does."""
    building = Building.load(DATA / "dev" / "proc-factory-dev-003")
    for design in ("typed", "code", "hybrid"):
        assert "cross_route" not in {tool["name"] for tool in Toolbox(building, design).definitions()}
