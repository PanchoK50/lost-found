"""Run one variant on one eval set, in parallel, and log every question.

  source .envrc && uv run python -m lostfound.evals.run --variant V2 --model sonnet --effort low --set dev
  uv run python -m lostfound.evals.run --variant V1 --set dev            # free, no API
Options: --per-kind N (sample), --kinds a b, --workers 8, --max-cost 20 (stop submitting new questions once
the run has spent this many dollars), --name custom_run_name."""

import argparse
import json
import random
import threading
import time
import traceback
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from lostfound.evals.datasets import load_set
from lostfound.evals.scoring import score
from lostfound.evals.variants import VARIANTS, Outcome

RESULTS = Path("evals") / "results"
SAMPLE_SEED = 7


def sample(items: list[dict], per_kind: int | None, kinds: list[str] | None) -> list[dict]:
    items = [item for item in items if not kinds or item["kind"] in kinds]
    if per_kind is None:
        return items
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        by_kind[item["kind"]].append(item)
    rng = random.Random(SAMPLE_SEED)
    return [chosen for kind in sorted(by_kind) for chosen in rng.sample(by_kind[kind], min(per_kind, len(by_kind[kind])))]


def run(
    variant: str,
    set_name: str,
    model: str | None = None,
    effort: str | None = None,
    per_kind: int | None = None,
    kinds: list[str] | None = None,
    workers: int = 8,
    max_cost: float = 25.0,
    name: str | None = None,
    leave_one_kind_out: bool = False,
) -> Path:
    """leave_one_kind_out: answer each question with its own kind's typed tool, skill and template removed,
    as if the kind were new (a proxy for unseen Sunday questions)."""
    items = sample(load_set(set_name), per_kind, kinds)
    if leave_one_kind_out:
        factories = {kind: VARIANTS[variant](model, effort, excluded_kinds=frozenset({kind})) for kind in {i["kind"] for i in items}}
        answer = lambda item: factories[item["kind"]](item)  # noqa: E731
    else:
        answer = VARIANTS[variant](model, effort)
    suffix = "loko" if leave_one_kind_out else None
    run_name = name or "__".join(part for part in (set_name, variant, model, effort, suffix) if part)
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"{run_name}.jsonl"
    spent = 0.0
    lock = threading.Lock()
    tally: Counter = Counter()

    def one(item: dict) -> dict:
        nonlocal spent
        with lock:
            if spent >= max_cost:
                return {**_record(item, variant, set_name, model, effort), "skipped": "max_cost"}
        started = time.monotonic()
        try:
            outcome = answer(item)
            error = None
        except Exception as exception:  # noqa: BLE001 - one broken question must not stop the run
            outcome, error = Outcome(reply=""), f"{type(exception).__name__}: {exception}"
            traceback.print_exc()
        latency = time.monotonic() - started
        correct = score(item["answer"], outcome.reply) if item.get("answer") else None
        cost = outcome.cost()
        with lock:
            spent += cost
        return {
            **_record(item, variant, set_name, model, effort),
            "correct": correct,
            "reply": outcome.reply,
            "path": outcome.path,
            "tool_calls": outcome.tool_calls,
            "usage": dict(outcome.usage),
            "cost": round(cost, 5),
            "latency_s": round(latency, 2),
            "error": error,
            "notes": outcome.notes,
        }

    with path.open("w", encoding="utf-8") as log, ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, item) for item in items]
        for future in as_completed(futures):
            record = future.result()
            log.write(json.dumps(record, ensure_ascii=False) + "\n")
            log.flush()
            mark = {True: "OK ", False: "BAD", None: "-- "}[record.get("correct")]
            tally[(record["kind"], record.get("correct"))] += 1
            print(f"[{variant}] {record['id']:34s} {record['kind']:26s} {mark} ${spent:6.2f}", flush=True)
    _print_table(tally, spent)
    print(f"results: {path}")
    return path


def _record(item: dict, variant: str, set_name: str, model: str | None, effort: str | None) -> dict:
    return {
        "id": item["id"],
        "kind": item["kind"],
        "set": set_name,
        "variant": variant,
        "model": model,
        "effort": effort,
        "question": item["question"],
        "answer": item.get("answer"),
    }


def _print_table(tally: Counter, spent: float) -> None:
    kinds = sorted({kind for kind, _ in tally})
    print(f"\n{'kind':28s} correct / total")
    for kind in kinds:
        good, bad = tally[(kind, True)], tally[(kind, False)]
        print(f"  {kind:26s} {good:4d} / {good + bad}")
    good = sum(count for (_, correct), count in tally.items() if correct)
    total = sum(count for (_, correct), count in tally.items() if correct is not None)
    print(f"  {'all':26s} {good:4d} / {total}  ({good / max(total, 1):.1%})   cost ${spent:.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="lostfound.evals.run")
    parser.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    parser.add_argument("--set", default="dev")
    parser.add_argument("--model", default=None, help="opus | sonnet | haiku")
    parser.add_argument("--effort", default=None, help="low | medium | high")
    parser.add_argument("--per-kind", type=int, default=None)
    parser.add_argument("--kinds", nargs="+", default=None)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--max-cost", type=float, default=25.0)
    parser.add_argument("--name", default=None)
    parser.add_argument("--leave-one-kind-out", action="store_true")
    arguments = parser.parse_args()
    run(
        arguments.variant,
        arguments.set,
        arguments.model,
        arguments.effort,
        arguments.per_kind,
        arguments.kinds,
        arguments.workers,
        arguments.max_cost,
        arguments.name,
        arguments.leave_one_kind_out,
    )


if __name__ == "__main__":
    main()
