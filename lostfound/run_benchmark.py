"""Sunday benchmark (challenge PDF): one building, a questions.json, an answers.json.

  uv run --env-file .env python -m lostfound.run_benchmark <building_dir> <questions.json> <answers.json> [--csv out.csv]
  uv run --env-file .env python -m lostfound.run_benchmark data/test data/test/questions.csv SUBMISSION/answers.json

<building_dir> is one building folder (with building.json), or a folder of building folders; then each question
names its folder in `building_id` (as in the kit's test/questions.csv).

questions: a list of questions, {"questions": [...]}, JSON lines, or a CSV with a header. Each question has an `id`
(or `question_id`) and its text (`question` or `text`); optional conditions such as `step_free`, `closed`, `from`,
`to`, `min_width` or `forklift` (also `vehicle: "forklift"`) are added to the text when it doesn't say them already.

answers.json: one entry per question id:
  {"<id>": {"answer": "<the Answer: line value>", "reply": "<full reply>", "kind": "route",
            "space_id": "…", "item_id": "…",                    # what was found, when the answer is a room/thing
            "route": ["<space id>", …],                          # spaces walked through, in order
            "route_nodes": ["<space id>", "<opening id>", …],    # spaces, doors, stairs and lifts, in order
            "element_path": ["<opening or connector id>", …],    # as in the dataset: doors and stairs/lifts only
            "length_m": 42.17, "reachable": true}}
When no route exists under the rules: "answer": "no route", "reachable": false, "route": [], "length_m": null.
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
from lostfound.env import require_api_key
from lostfound.evals.variants import MODELS

DEFAULT_INSTRUCTION = "Finish with a line 'Answer: <answer>'."
TEXT_KEYS = ("question", "text", "prompt", "query", "q", "message")


def load_questions(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8-sig").strip()
    if path.suffix.lower() == ".csv":
        data = list(csv.DictReader(text.splitlines()))
    else:
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
        body = str(next((item[key] for key in TEXT_KEYS if item.get(key)), "")).strip()
        if not body:
            # One malformed entry must not stop the run: it gets an empty answer and a warning.
            print(f"[run_benchmark] {question_id}: no question text (looked for {', '.join(TEXT_KEYS)})", file=sys.stderr)
        questions.append({"id": question_id, "question": with_conditions(body, item) if body else "", "raw": item})
    return questions


def building_folder(root: Path, item: dict) -> Path:
    """The question's building: the root itself when it holds building.json, else root/<building_id>."""
    if (root / "building.json").exists():
        return root
    building_id = str(item.get("building_id") or item.get("building") or "").strip()
    if building_id and (root / building_id / "building.json").exists():
        return root / building_id
    raise MapError(f"No building.json for building '{building_id}' under {root}")


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
    width = conditions.get("min_width") or conditions.get("min_width_m")
    if width and "wide" not in text.lower():
        extra.append(f"Every door must be at least {width} m wide.")
    vehicle = str(conditions.get("vehicle") or conditions.get("mode") or "").lower()
    if (conditions.get("forklift") is True or "forklift" in vehicle) and not re.search(r"forklift|fork.?lift|stapler", text, re.I):
        extra.append("The route is for a forklift.")
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
    no_route = {"reachable": False, "route": [], "route_nodes": [], "element_path": [], "length_m": None}
    if result.get("reachable") is False:  # a route, nearest or errand that has no route under the rules
        out.update(no_route)
        return out
    stops, step_free, closed, min_width, forklift = None, result.get("step_free", False), [], None, False
    if kind == "route":
        stops, closed = result.get("stops"), result.get("closed") or []
        min_width, forklift = result.get("min_width_m"), bool(result.get("forklift"))
    elif kind == "errand" and result.get("pickup") and result.get("target"):
        out["item_space_id"] = result["pickup"]["space_id"]
        out["space_id"] = result["target"]["space_id"]
        out["length_m"] = result.get("total_m")
        start = result.get("start")
        if start:
            stops = [start, result["pickup"]["space_id"], result["target"]["space_id"]]
    if stops and len(stops) >= 2:
        try:
            with building.temporarily_closed(*closed):
                details = directions.route_details(building, stops[0], stops[-1], step_free, stops[1:-1], min_width, forklift)
                nodes = with_connectors(building, details["nodes"], step_free)
            out.update(route=[s for s in details["space_path"] if s in building.spaces], route_nodes=nodes,
                       element_path=[n for n in nodes if n not in building.spaces])
            out.setdefault("length_m", details["length_m"])
            out["reachable"] = True
        except MapError:
            out.update(no_route)
    return out


def with_connectors(building: Building, nodes: list[str], step_free: bool = False) -> list[str]:
    """Insert the stair or lift between consecutive spaces on different floors, as in the dataset's element_path
    (one entry per flight: a stair walked over two floors appears twice)."""
    out: list[str] = []
    for node in nodes:
        previous = out[-1] if out else None
        if previous in building.spaces and node in building.spaces and building.spaces[previous]["floor_id"] != building.spaces[node]["floor_id"]:
            # The one the router used: open, step-free when asked, and cheapest under the route model.
            candidates = [c for c in building.connectors.values() if previous in c["space_ids"] and node in c["space_ids"]
                          and c["id"] not in building.closed and (c["step_free"] or not step_free)]
            rise = abs(building.floors[building.spaces[previous]["floor_id"]]["elevation_m"] - building.floors[building.spaces[node]["floor_id"]]["elevation_m"])
            cost = lambda c: 15.0 + rise if c["kind"] == "lift" else 2.0 * rise  # noqa: E731
            connector = min(candidates, key=cost)["id"] if candidates else None
            if connector:
                out.append(connector)
        out.append(node)
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
    single = (arguments.building_dir / "building.json").exists()
    if not single and not any(arguments.building_dir.glob("*/building.json")):
        sys.exit(f"No building.json in {arguments.building_dir} or its subfolders")
    questions = load_questions(arguments.questions)
    if not questions:
        sys.exit(f"No questions in {arguments.questions}")
    require_api_key()
    qa = BuildingQA(AgentConfig(design="hybrid", model=MODELS.get(arguments.model, arguments.model), effort=arguments.effort))
    started = time.monotonic()

    def one(item: dict) -> tuple[str, dict, float]:
        if not item["question"].strip():
            return item["id"], {"answer": "", "reply": "", "error": "no question text"}, 0.0
        try:
            building_dir = building_folder(arguments.building_dir, item["raw"])
            outcome = qa.answer_question(building_dir, item["question"])
        except Exception as error:  # noqa: BLE001 - one failed question must not lose the others
            print(f"[run_benchmark] {item['id']}: {type(error).__name__}: {error}", file=sys.stderr)
            return item["id"], {"answer": "", "reply": "", "error": str(error)}, 0.0
        entry = {"answer": committed_answer(outcome.reply) or "", "reply": outcome.reply}
        try:
            entry.update(structured(building_dir, outcome.notes.get("result")))
        except Exception as error:  # noqa: BLE001 - keep the answer even if the route details fail
            entry["structured_error"] = str(error)
        return item["id"], entry, outcome.cost()

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
