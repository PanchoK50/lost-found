"""Eval sets. Every item: id, kind, set, building_dir, question, answer (score.py format), inputs (if labelled).

- train / dev / test: the benchmark questions.jsonl (iterate on train, report on dev; test has no answers).
- warmup-dev: questions_basic.jsonl on dev, kinds the benchmark never asks (locate, count, routes, tours),
  rewritten to end with an Answer instruction; a proxy for unseen Sunday kinds.
- paraphrase-dev: generated rewordings of dev questions (evals/data/paraphrase_dev.jsonl), same answers."""

import json
from pathlib import Path

DATA = Path("data")
GENERATED = Path("evals") / "data"
ROUTE_TOLERANCE = 0.01

NUMBER_SUFFIX = " Finish with a line 'Answer: <number>'."
ROOM_SUFFIX = " Finish with a line 'Answer: <room name or number>'."


def _jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def benchmark_set(split: str) -> list[dict]:
    items = []
    for path in sorted((DATA / split).glob("*/questions.jsonl")):
        for question in _jsonl(path):
            items.append(
                {
                    "id": question["id"],
                    "kind": question["kind"],
                    "set": split,
                    "building_dir": str(path.parent),
                    "question": question["question"],
                    "answer": question.get("answer"),
                    "inputs": question.get("inputs"),
                }
            )
    return items


def _number(value: float, relative: float, absolute: float) -> dict:
    return {"type": "number", "value": value, "relative_tolerance": relative, "absolute_tolerance": absolute}


def warmup_set(split: str = "dev") -> list[dict]:
    items = []
    for path in sorted((DATA / split).glob("*/questions_basic.jsonl")):
        building = json.loads((path.parent / "building.json").read_text(encoding="utf-8"))
        spaces = {space["id"]: space for space in building["spaces"]}
        for question in _jsonl(path):
            kind, answer, text = question["kind"], question["answer"], question["question"]
            if kind == "locate":
                space = spaces[answer["space_id"]]
                labels = [label for label in (space.get("ref"), space["name"]) if label]
                expected = {"type": "space", "accept": labels, "reject": []}
                text += " Which room is it in?" + ROOM_SUFFIX
            elif kind == "count":
                expected = _number(answer["count"], 0.0, 0.0)
                text += NUMBER_SUFFIX
            elif answer.get("reachable") is False:
                expected = {"type": "unreachable"}
                text += " If there is no such route, finish with a line 'Answer: no route'; otherwise finish with " \
                        "a line 'Answer: <route length in metres>'."
            else:
                expected = _number(answer["optimal_length_m"], ROUTE_TOLERANCE, ROUTE_TOLERANCE)
                text += " If there is no such route, finish with a line 'Answer: no route'; otherwise finish with " \
                        "a line 'Answer: <route length in metres>'."
            items.append(
                {
                    "id": question["id"],
                    "kind": kind,
                    "set": f"warmup-{split}",
                    "building_dir": str(path.parent),
                    "question": text,
                    "answer": expected,
                    "inputs": None,
                }
            )
    return items


def generated_set(name: str) -> list[dict]:
    path = GENERATED / f"{name}.jsonl"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing: generate it with python -m lostfound.evals.paraphrase")
    return _jsonl(path)


def load_set(name: str) -> list[dict]:
    if name in ("train", "dev", "test"):
        return benchmark_set(name)
    if name.startswith("warmup-"):
        return warmup_set(name.removeprefix("warmup-"))
    return generated_set(name.replace("-", "_"))
