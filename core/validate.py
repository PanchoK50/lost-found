"""Deterministic validation of core.queries against every question of a split.

The calibration gate: for each benchmark question the kind's query function is
called with the question's inputs and the result compared to the expected
answer (numbers with the answer's tolerances, spaces by space id). Warm-up
questions (questions_basic.jsonl, --basic) validate route lengths the same way
the starter's oracle does, including expected "no route" cases.

  uv run python -m core.validate data/dev
  uv run python -m core.validate data/train --basic
  uv run python -m core.validate data/dev --stats      # distinct inputs keys per kind

Exit code is 0 only when every checked question matches, so this works as a
regression gate. Test-split questions have no answers and are skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from core.geometry import Geometry
from core.graph import RouteConstraints, RouteError, route
from core.model import Building
from core import queries

ROUTE_TOLERANCE = 0.01
BASIC_ROUTE_KINDS = {"route", "route_step_free", "route_with_closure", "tour"}


def within(value: float, answer: dict) -> bool:
    expected = float(answer["value"])
    tolerance = max(abs(expected) * float(answer.get("relative_tolerance", 0.0)),
                    float(answer.get("absolute_tolerance", 0.0)))
    return abs(value - expected) <= tolerance


def run_benchmark_question(building: Building, geometry: Geometry, question: dict) -> tuple[bool, object]:
    kind, inputs, answer = question["kind"], question["inputs"], question["answer"]
    try:
        if kind == "largest_room":
            result = queries.largest_room(building, geometry, inputs["floor_id"], inputs["room_type"])
            return result.space_id == answer["space_id"] and within(result.area_m2, answer["area"]), result
        if kind == "floor_area_total":
            result = queries.floor_area_total(building, geometry, inputs["floor_id"], inputs["room_type"])
            return within(result, answer), result
        if kind == "errand":
            result = queries.errand(
                building, geometry, inputs["start"], inputs["asset_type"], inputs["floor_id"], inputs["room_type"]
            )
            return (
                within(result.total_m, answer)
                and result.via_id == answer.get("via")
                and result.target_id == answer.get("target"),
                result,
            )
        if kind == "wide_delivery_count":
            result = queries.wide_delivery_count(
                building, geometry, inputs["start"], inputs["floor_id"], inputs["min_width"]
            )
            return result == answer["value"], result
        if kind == "step_free_reachable_count":
            result = queries.step_free_reachable_count(
                building, geometry, inputs["start"], inputs["floor_id"], frozenset(inputs["closed"])
            )
            return result == answer["value"], result
        if kind == "room_stacked":
            result = queries.room_stacked(building, geometry, inputs["start"], inputs["direction"])
            return result.space_id == answer["space_id"], result
        if kind == "shared_walls_count":
            result = queries.shared_walls_count(building, geometry, inputs["start"])
            return result == answer["value"], result
        if kind == "straight_line_3d":
            result = queries.straight_line_3d(building, geometry, inputs["first"], inputs["second"])
            return within(result, answer), result
        if kind == "what_if_door":
            result = queries.what_if_door(
                building, geometry, inputs["first"], inputs["second"], inputs["floor_id"]
            )
            return result.improved_count == answer["value"], result
    except (queries.QueryError, RouteError) as error:
        return False, str(error)
    raise ValueError(f"unhandled question kind {kind}")


def run_basic_question(building: Building, geometry: Geometry, question: dict) -> tuple[bool, object] | None:
    kind, answer = question["kind"], question["answer"]
    if kind == "locate":
        # Locating needs name resolution from the question text: agent-layer, skip here.
        return None
    if kind == "count":
        matches = [
            asset_id
            for asset_id in building.assets
            if building.assets[asset_id].type == answer["asset_type"]
            and building.level(building.assets[asset_id].floor_id) == answer["floor_level"]
        ]
        return len(matches) == answer["count"], len(matches)
    constraints = RouteConstraints(
        step_free=(kind == "route_step_free"),
        closed=frozenset({answer["closed_element_id"]}) if "closed_element_id" in answer else frozenset(),
    )
    try:
        if kind == "tour":
            stops = answer["stops"]
            result = route(building, geometry, stops[0], stops[-1], via=stops[1:-1], constraints=constraints)
        elif kind in BASIC_ROUTE_KINDS:
            result = route(
                building, geometry, answer["from_space_id"], answer["to_space_id"], constraints=constraints
            )
        else:
            return None
        if answer.get("reachable") is False:
            return False, result
        return abs(result.length_m - answer["optimal_length_m"]) <= max(
            ROUTE_TOLERANCE * answer["optimal_length_m"], ROUTE_TOLERANCE
        ), result
    except RouteError:
        return answer.get("reachable") is False, "no route"


def load_split(directory: Path, basic: bool) -> dict[Path, list[dict]]:
    filename = "questions_basic.jsonl" if basic else "questions.jsonl"
    grouped: dict[Path, list[dict]] = {}
    for path in sorted(directory.glob(f"*/{filename}")):
        with path.open(encoding="utf-8") as handle:
            questions = [json.loads(line) for line in handle if line.strip()]
        if any("answer" in question for question in questions):
            grouped[path.parent] = questions
    return grouped


def print_stats(directory: Path) -> None:
    key_sets: dict[str, Counter] = {}
    for basic in (False, True):
        filename = "questions_basic.jsonl" if basic else "questions.jsonl"
        for path in sorted(directory.glob(f"*/{filename}")):
            for line in path.open(encoding="utf-8"):
                question = json.loads(line)
                key_sets.setdefault(question["kind"], Counter())[
                    tuple(sorted(question.get("inputs", {}).keys()))
                ] += 1
    for kind in sorted(key_sets):
        print(f"{kind}:")
        for keys, count in key_sets[kind].items():
            print(f"  {count:4d} x {list(keys)}")


def validate(directory: Path, basic: bool, kinds: list[str] | None) -> int:
    results: Counter = Counter()
    failures: list[dict] = []
    for building_directory, questions in load_split(directory, basic=False).items():
        building = Building.load(building_directory)
        geometry = Geometry(building)
        for question in questions:
            if "answer" not in question:
                continue
            if kinds and question["kind"] not in kinds:
                continue
            ok, result = run_benchmark_question(building, geometry, question)
            results[(question["kind"], ok)] += 1
            if not ok:
                failures.append(
                    {
                        "id": question["id"],
                        "kind": question["kind"],
                        "computed": repr(result),
                        "expected": question["answer"],
                        "question": question["question"],
                    }
                )
    if basic:
        for building_directory, questions in load_split(directory, basic=True).items():
            building = Building.load(building_directory)
            geometry = Geometry(building)
            for question in questions:
                if "answer" not in question:
                    continue
                outcome = run_basic_question(building, geometry, question)
                if outcome is None:
                    continue
                ok, result = outcome
                results[(question["kind"], ok)] += 1
                if not ok:
                    failures.append(
                        {"id": question["id"], "kind": question["kind"], "computed": repr(result),
                         "expected": question["answer"], "question": question["question"]}
                    )
    print(f"\n{directory}: kind                            correct / total")
    for kind in sorted({kind for kind, _ in results}):
        correct, wrong = results[(kind, True)], results[(kind, False)]
        print(f"  {kind:34s} {correct:4d} / {correct + wrong}")
    total_correct = sum(count for (_, ok), count in results.items() if ok)
    total = sum(results.values())
    print(f"  {'all':34s} {total_correct:4d} / {total}  ({total_correct / max(total, 1):.0%})")
    if failures:
        out = Path("agent_output") / "core-validation-failures.jsonl"
        out.parent.mkdir(exist_ok=True)
        out.write_text("\n".join(json.dumps(f, ensure_ascii=False, default=str) for f in failures), encoding="utf-8")
        print(f"failures saved to {out}")
    return 0 if not failures else 1


def main() -> None:
    parser = argparse.ArgumentParser(prog="core.validate", description=__doc__)
    parser.add_argument("directory", type=Path, help="a split directory such as data/dev")
    parser.add_argument("--basic", action="store_true", help="also validate warm-up questions")
    parser.add_argument("--stats", action="store_true", help="list distinct inputs keys per kind and exit")
    parser.add_argument("--kinds", nargs="+", default=None, help="only these question kinds")
    arguments = parser.parse_args()
    if arguments.stats:
        print_stats(arguments.directory)
        return
    sys.exit(validate(arguments.directory, arguments.basic, arguments.kinds))


if __name__ == "__main__":
    main()
