"""Summarise eval runs: accuracy per kind × run, cost, latency, and questions that flipped between two runs.

  uv run python -m lostfound.evals.report                       # all runs -> evals/results/summary.md + .csv
  uv run python -m lostfound.evals.report --set dev             # only runs on one set
  uv run python -m lostfound.evals.report --diff RUN_A RUN_B    # questions that changed"""

import argparse
import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path

RESULTS = Path("evals") / "results"


def load(run: str) -> list[dict]:
    path = RESULTS / f"{run}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def summarise(records: list[dict]) -> dict:
    scored = [record for record in records if record.get("correct") is not None]
    by_kind: dict[str, list[bool]] = defaultdict(list)
    for record in scored:
        by_kind[record["kind"]].append(record["correct"])
    latencies = sorted(record.get("latency_s", 0) for record in records if "latency_s" in record)
    cost = sum(record.get("cost", 0) for record in records)
    return {
        "n": len(scored),
        "accuracy": sum(record["correct"] for record in scored) / max(len(scored), 1),
        "by_kind": {kind: (sum(values), len(values)) for kind, values in by_kind.items()},
        "cost": cost,
        "cost_per_q": cost / max(len(records), 1),
        "p50": statistics.median(latencies) if latencies else 0.0,
        "p95": latencies[int(0.95 * (len(latencies) - 1))] if latencies else 0.0,
        "errors": sum(1 for record in records if record.get("error")),
    }


def table(set_filter: str | None) -> str:
    runs = sorted(path.stem for path in RESULTS.glob("*.jsonl"))
    if set_filter:
        runs = [run for run in runs if run.split("__")[0] == set_filter]
    summaries = {run: summarise(load(run)) for run in runs}
    summaries = {run: summary for run, summary in summaries.items() if summary["n"]}
    kinds = sorted({kind for summary in summaries.values() for kind in summary["by_kind"]})
    header = ["run", "n", "accuracy", *kinds, "$/question", "$ total", "p50 s", "p95 s", "errors"]
    rows = []
    for run, summary in summaries.items():
        cells = [run, str(summary["n"]), f"{summary['accuracy']:.1%}"]
        for kind in kinds:
            good, total = summary["by_kind"].get(kind, (0, 0))
            cells.append(f"{good}/{total}" if total else "")
        cells += [
            f"{summary['cost_per_q']:.4f}",
            f"{summary['cost']:.2f}",
            f"{summary['p50']:.1f}",
            f"{summary['p95']:.1f}",
            str(summary["errors"]),
        ]
        rows.append(cells)
    with (RESULTS / "summary.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines)


def diff(first: str, second: str) -> str:
    a = {record["id"]: record for record in load(first)}
    b = {record["id"]: record for record in load(second)}
    lines = [f"Questions that changed from {first} to {second}:"]
    for question_id in sorted(set(a) & set(b)):
        before, after = a[question_id].get("correct"), b[question_id].get("correct")
        if before != after:
            arrow = "fixed" if after else "broke"
            lines.append(f"  {arrow:6s} {question_id:34s} {b[question_id]['kind']}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(prog="lostfound.evals.report")
    parser.add_argument("--set", default=None)
    parser.add_argument("--diff", nargs=2, default=None, metavar=("RUN_A", "RUN_B"))
    arguments = parser.parse_args()
    if arguments.diff:
        print(diff(*arguments.diff))
        return
    markdown = table(arguments.set)
    (RESULTS / "summary.md").write_text(markdown + "\n", encoding="utf-8")
    print(markdown)


if __name__ == "__main__":
    main()
