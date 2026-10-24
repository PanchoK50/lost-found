"""One command from questions to the submission CSV (see BENCHMARK.md).

  source .envrc && uv run python -m lostfound.benchmark data/test --out submissions/team_lostfound.csv

Input: a directory with building folders. Questions are read from <dir>/questions.csv
(question_id,building_id,kind,question) if present, else from every <dir>/<building>/questions.jsonl
(or questions.csv inside a single building folder). Output: question_id,answer with the full replies."""

import argparse
import csv
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from lostfound.agent.agent import AgentConfig, BuildingQA
from lostfound.evals.variants import MODELS


def load_questions(directory: Path) -> list[dict]:
    root_csv = directory / "questions.csv"
    if root_csv.exists():
        with root_csv.open(encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        return [{"id": row["question_id"], "building_dir": _building_dir(directory, row["building_id"]), "question": row["question"]} for row in rows]
    questions = []
    building_dirs = [directory] if (directory / "building.json").exists() else sorted(p for p in directory.iterdir() if (p / "building.json").exists())
    for building_dir in building_dirs:
        jsonl = building_dir / "questions.jsonl"
        if jsonl.exists():
            for line in jsonl.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    item = json.loads(line)
                    questions.append({"id": item["id"], "building_dir": building_dir, "question": item["question"]})
        elif (building_dir / "questions.csv").exists():
            with (building_dir / "questions.csv").open(encoding="utf-8") as handle:
                for row in csv.DictReader(handle):
                    questions.append({"id": row.get("question_id") or row["id"], "building_dir": building_dir, "question": row["question"]})
    return questions


def _building_dir(directory: Path, building_id: str) -> Path:
    candidate = directory / building_id
    return candidate if candidate.exists() else directory


def main() -> None:
    parser = argparse.ArgumentParser(prog="lostfound.benchmark")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--out", type=Path, default=Path("submissions") / "submission.csv")
    parser.add_argument("--design", default="rules+", help="rules+ (default) | hybrid | typed | code")
    parser.add_argument("--model", default="opus", help="opus | sonnet | haiku")
    parser.add_argument("--effort", default="low")
    parser.add_argument("--workers", type=int, default=6)
    arguments = parser.parse_args()

    questions = load_questions(arguments.directory)
    if not questions:
        sys.exit(f"No questions found under {arguments.directory}")
    qa = BuildingQA(AgentConfig(design=arguments.design, model=MODELS.get(arguments.model, arguments.model), effort=arguments.effort))
    started = time.monotonic()

    def one(item: dict) -> tuple[str, str, float, str]:
        try:
            outcome = qa.answer_question(Path(item["building_dir"]), item["question"])
            return item["id"], outcome.reply, outcome.cost(), outcome.path
        except Exception as error:  # noqa: BLE001 - keep going; an empty answer only loses this question
            print(f"[benchmark] {item['id']}: {type(error).__name__}: {error}", file=sys.stderr)
            return item["id"], "", 0.0, "error"

    with ThreadPoolExecutor(max_workers=arguments.workers) as pool:
        results = list(pool.map(one, questions))
    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    with arguments.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(("question_id", "answer"))
        writer.writerows((question_id, reply) for question_id, reply, _, _ in results)
    paths: dict[str, int] = {}
    for *_, path in results:
        paths[path] = paths.get(path, 0) + 1
    cost = sum(result[2] for result in results)
    print(
        f"{len(results)} answers -> {arguments.out}  paths {paths}  cost ${cost:.2f}  "
        f"{time.monotonic() - started:.0f} s"
    )


if __name__ == "__main__":
    main()
