"""Sunday benchmark (challenge PDF): one building, a questions.json, an answers.json.

  uv run --env-file .env python -m lostfound.run_benchmark <building_dir> <questions.json> <answers.json> [--csv out.csv]

questions.json: a list of questions, {"questions": [...]}, or JSON lines. Each question has an `id` (or
`question_id`) and its text (`question` or `text`); optional conditions such as `step_free`, `closed`, `from`,
`to` or `min_width` are added to the text when it doesn't say them already.

answers.json: one entry per question id:
  {"<id>": {"answer": "<the Answer: line value>", "reply": "<full reply>", "kind": "route",
            "space_id": "…", "item_id": "…",                    # what was found, when the answer is a room/thing
            "route": ["<space id>", …],                          # spaces walked through, in order
            "route_nodes": ["<space id>", "<opening id>", …],    # spaces and the doors between them, in order
            "length_m": 42.17, "reachable": true}}
No schema has been published yet; the fields cover what the PDF names (found item or room, route as ordered node ids,
route length). The same replies can also be written as the challenge CSV with --csv."""

import argparse
import csv
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from benchmark.score import committed_answer
from lostfound.agent.agent import AgentConfig, BuildingQA
from lostfound.core import directions
from lostfound.core.building import Building, MapError
from lostfound.evals.variants import MODELS

DEFAULT_INSTRUCTION = "Finish with a line 'Answer: <answer>'."


def load_questions(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = [json.loads(line) for line in text.splitlines() if line.strip()]
    if isinstance(data, dict):
        data = data.get("questions") or [{"id": key, **(value if isinstance(value, dict) else {"question": value})} for key, value in data.items()]
    questions = []
    for index, item in enumerate(data, start=1):
        if isinstance(item, str):
            item = {"question": item}
        question_id = str(item.get("id") or item.get("question_id") or f"Q{index:03d}")
        body = str(item.get("question") or item.get("text") or "").strip()
        if not body:
            raise SystemExit(f"Question {question_id} has no text.")
        questions.append({"id": question_id, "question": with_conditions(body, item), "raw": item})
    return questions


def with_conditions(text: str, item: dict) -> str:
    """Spell out structured conditions the question text does not mention yet."""
    extra = []
    conditions = {**item, **(item.get("conditions") or {})}
    if conditions.get("step_free") and not re.search(r"step.?free|wheelchair|no stairs|without stairs", text, re.I):
        extra.append("The route must be step-free (no stairs or steps).")
    closed = conditions.get("closed") or conditions.get("closures")
    if closed:
        names = closed if isinstance(closed, list) else [closed]
        if not all(str(name).lower() in text.lower() for name in names):
            extra.append(f"Closed: {', '.join(map(str, names))}.")
    if conditions.get("min_width") and "wide" not in text.lower():
        extra.append(f"Every door must be at least {conditions['min_width']} m wide.")
    for key, words in (("from", "Start"), ("start", "Start"), ("to", "Destination"), ("destination", "Destination")):
        value = conditions.get(key)
        if isinstance(value, str) and value and value.lower() not in text.lower():
            extra.append(f"{words}: {value}.")
    full = " ".join([text, *extra])
    return full if "answer:" in full.lower() else f"{full} {DEFAULT_INSTRUCTION}"


def structured(building_dir: Path, result: dict | None) -> dict:
    """Found room/item and the route as ordered node ids, from the agent's last answering tool."""
    if not result:
        return {}
    building = Building.load(building_dir)
    kind = result.get("kind")
    out: dict = {"kind": kind}
    if kind in ("largest_room", "room_stacked") and result.get("space_id"):
        out["space_id"] = result["space_id"]
    if kind == "locate" and result.get("matches"):
        out["item_id"] = result["matches"][0]["asset_id"]
        out["space_id"] = result["matches"][0]["space_id"]
    stops = None
    if kind == "route":
        stops, step_free, closed = result.get("stops"), result.get("step_free", False), result.get("closed", [])
        out["reachable"] = bool(result.get("reachable"))
    elif kind == "errand" and result.get("pickup") and result.get("target"):
        stops, step_free, closed = None, result.get("step_free", False), []
        out["item_space_id"] = result["pickup"]["space_id"]
        out["space_id"] = result["target"]["space_id"]
        out["length_m"] = result.get("total_m")
        start = result.get("start")
        if start:
            stops = [start, result["pickup"]["space_id"], result["target"]["space_id"]]
    if stops and out.get("reachable", True):
        try:
            with building.temporarily_closed(*closed):
                details = directions.route_details(building, stops[0], stops[-1], step_free, stops[1:-1])
            out.update(route=[s for s in details["space_path"] if s in building.spaces], route_nodes=details["nodes"])
            out.setdefault("length_m", details["length_m"])
            out["reachable"] = True
        except MapError:
            out.update(reachable=False, route=[], route_nodes=[], length_m=None)
    elif kind == "route" and not out.get("reachable"):
        out.update(route=[], route_nodes=[], length_m=None)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(prog="lostfound.run_benchmark")
    parser.add_argument("building_dir", type=Path)
    parser.add_argument("questions", type=Path)
    parser.add_argument("answers", type=Path)
    parser.add_argument("--csv", type=Path, default=None, help="also write question_id,answer (the test-set format)")
    parser.add_argument("--model", default="opus")
    parser.add_argument("--effort", default="low")
    parser.add_argument("--workers", type=int, default=6)
    arguments = parser.parse_args()
    if not (arguments.building_dir / "building.json").exists():
        sys.exit(f"No building.json in {arguments.building_dir}")

    questions = load_questions(arguments.questions)
    qa = BuildingQA(AgentConfig(design="hybrid", model=MODELS.get(arguments.model, arguments.model), effort=arguments.effort))
    started = time.monotonic()

    def one(item: dict) -> tuple[str, dict, float]:
        try:
            outcome = qa.answer_question(arguments.building_dir, item["question"])
            entry = {"answer": committed_answer(outcome.reply) or "", "reply": outcome.reply,
                     **structured(arguments.building_dir, outcome.notes.get("result"))}
            return item["id"], entry, outcome.cost()
        except Exception as error:  # noqa: BLE001 - one failed question must not lose the others
            print(f"[run_benchmark] {item['id']}: {type(error).__name__}: {error}", file=sys.stderr)
            return item["id"], {"answer": "", "reply": "", "error": str(error)}, 0.0

    with ThreadPoolExecutor(max_workers=arguments.workers) as pool:
        results = list(pool.map(one, questions))
    answers = {question_id: entry for question_id, entry, _ in results}
    arguments.answers.parent.mkdir(parents=True, exist_ok=True)
    arguments.answers.write_text(json.dumps(answers, ensure_ascii=False, indent=1), encoding="utf-8")
    if arguments.csv:
        with arguments.csv.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(("question_id", "answer"))
            writer.writerows((question_id, entry["reply"]) for question_id, entry, _ in results)
    cost = sum(c for *_, c in results)
    print(f"{len(results)} answers -> {arguments.answers}  cost ${cost:.2f}  {time.monotonic() - started:.0f} s")


if __name__ == "__main__":
    main()
