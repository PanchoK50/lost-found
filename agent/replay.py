"""Stage-2 gate: replay every train/dev benchmark question through the TOOLS.

No LLM anywhere: each question's `inputs` drive the AgentToolkit directly (the
same methods the Claude tools call), the toolkit's answer_line becomes the
reply, and it is scored with benchmark.score.score_reply — the exact code that
grades the jury CSV. This proves the tool pipeline and the answer formatting on
all 655 questions before a single credit is spent on the model.

  uv run python -m agent.replay data/dev
  uv run python -m agent.replay data/train
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from agent.tools import AgentToolkit
from benchmark.score import score_reply
from core.geometry import Geometry
from core.model import Building


def replay_question(toolkit: AgentToolkit, question: dict) -> tuple[str, object]:
    """Returns (reply text, detail) for one question; raises on tool errors (counted as failures)."""
    kind, inputs = question["kind"], question["inputs"]
    if kind == "largest_room":
        return toolkit.largest_room(inputs["floor_id"], inputs["room_type"])["answer_line"], kind
    if kind == "floor_area_total":
        return toolkit.floor_area_total(inputs["floor_id"], inputs["room_type"])["answer_line"], kind
    if kind == "errand":
        return (
            toolkit.errand_plan(inputs["start"], inputs["asset_type"], inputs["floor_id"], inputs["room_type"])["answer_line"],
            kind,
        )
    if kind == "wide_delivery_count":
        result = toolkit.reachable_rooms(
            inputs["start"], inputs["floor_id"], step_free=True, min_door_width_m=inputs["min_width"]
        )
        return result["answer_line"], result["count"]
    if kind == "step_free_reachable_count":
        result = toolkit.reachable_rooms(
            inputs["start"], inputs["floor_id"], step_free=True, closed_elements=inputs["closed"]
        )
        return result["answer_line"], result["count"]
    if kind == "room_stacked":
        facts = toolkit.room_facts(inputs["start"])
        key = "directly_above" if inputs["direction"] == "above" else "directly_below"
        return facts["answer_line_suggestions"][key], key
    if kind == "shared_walls_count":
        facts = toolkit.room_facts(inputs["start"])
        return facts["answer_line_suggestions"]["shared_walls"], facts["shared_walls"]["count"]
    if kind == "straight_line_3d":
        return toolkit.distance_3d(inputs["first"], inputs["second"])["answer_line"], kind
    if kind == "what_if_door":
        result = toolkit.what_if_door(inputs["first"], inputs["second"], inputs["floor_id"])
        return result["answer_line"], result["improved_count"]
    raise ValueError(f"unhandled question kind {kind}")


def replay(directory: Path, kinds: list[str] | None) -> int:
    results: Counter = Counter()
    failures: list[dict] = []
    for questions_file in sorted(directory.glob("*/questions.jsonl")):
        building = Building.load(questions_file.parent)
        geometry = Geometry(building)
        for line in questions_file.open(encoding="utf-8"):
            question = json.loads(line)
            if "answer" not in question:
                continue
            if kinds and question["kind"] not in kinds:
                continue
            toolkit = AgentToolkit(building, geometry)  # fresh session per question
            try:
                reply, detail = replay_question(toolkit, question)
                ok = score_reply(question["answer"], reply)
            except Exception as error:  # noqa: BLE001 - any tool failure is a replay failure
                reply, ok, detail = f"ERROR: {error}", False, type(error).__name__
            results[(question["kind"], ok)] += 1
            if not ok:
                failures.append(
                    {
                        "id": question["id"],
                        "kind": question["kind"],
                        "reply": reply,
                        "expected": question["answer"],
                        "question": question["question"],
                    }
                )
    print(f"\n{directory}: kind                          correct / total")
    for kind in sorted({kind for kind, _ in results}):
        correct, wrong = results[(kind, True)], results[(kind, False)]
        print(f"  {kind:32s} {correct:4d} / {correct + wrong}")
    total_correct = sum(count for (_, ok), count in results.items() if ok)
    total = sum(results.values())
    print(f"  {'all':32s} {total_correct:4d} / {total}  ({total_correct / max(total, 1):.0%})")
    if failures:
        out = Path("agent_output") / "replay-failures.jsonl"
        out.parent.mkdir(exist_ok=True)
        out.write_text("\n".join(json.dumps(f, ensure_ascii=False, default=str) for f in failures), encoding="utf-8")
        print(f"failures saved to {out}")
    return 0 if not failures else 1


def main() -> None:
    parser = argparse.ArgumentParser(prog="agent.replay", description=__doc__)
    parser.add_argument("directory", type=Path, help="a split directory such as data/dev")
    parser.add_argument("--kinds", nargs="+", default=None, help="only these question kinds")
    arguments = parser.parse_args()
    sys.exit(replay(arguments.directory, arguments.kinds))


if __name__ == "__main__":
    main()
