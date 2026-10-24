"""CLI wrapper around benchmark.evaluate with a --model flag.

  uv run --env-file .env python -m agent.bench data/dev --model sonnet --per-kind 2
  uv run --env-file .env python -m agent.bench data/test --submission-csv team_lost_found.csv
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(prog="agent.bench", description=__doc__)
    parser.add_argument("directory", type=Path, help="a split directory such as data/dev")
    parser.add_argument("--model", default=None, help="opus, sonnet, or a full model id (default: opus)")
    parser.add_argument("--effort", default=None, help="reasoning effort: low, medium, high (default: medium)")
    parser.add_argument("--per-kind", type=int, default=None, help="sample this many questions per kind")
    parser.add_argument("--kinds", nargs="+", default=None, help="only these question kinds")
    parser.add_argument("--name", default="results", help="file name for the saved replies")
    parser.add_argument("--submission-csv", type=Path, default=None, help="also write question_id,answer CSV")
    arguments = parser.parse_args()

    from agent.agent import resolve_effort, resolve_model

    os.environ["AGENT_MODEL"] = resolve_model(arguments.model)
    os.environ["AGENT_EFFORT"] = resolve_effort(arguments.effort)

    from benchmark.evaluate import run

    run(
        arguments.directory,
        arguments.per_kind,
        "agent.entry:answer",
        arguments.name,
        arguments.submission_csv,
        arguments.kinds,
    )


if __name__ == "__main__":
    main()
