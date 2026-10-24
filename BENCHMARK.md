# Benchmark run

One command, no manual steps between input and output:

```sh
uv sync
source .envrc            # exports ANTHROPIC_API_KEY (only needed when a question falls through to Claude)
uv run python -m lostfound.benchmark <questions-directory> --out submissions/<name>.csv
```

Examples:

```sh
uv run python -m lostfound.benchmark data/test --out submissions/team_lostfound.csv      # 145 test questions
uv run python -m lostfound.benchmark data/sunday --out submissions/sunday.csv            # the Sunday building
```

**Input.** A directory of building folders, each with a `building.json`. Questions are read from the first of these that exists:

1. `<dir>/questions.csv`, with columns `question_id,building_id,kind,question`;
2. every `<dir>/<building>/questions.jsonl`;
3. a single building folder with its own `questions.jsonl` or `questions.csv`.

**Output.** A CSV with the columns `question_id,answer`. Each answer is the agent's full reply and ends with the `Answer:` line that `benchmark/score.py` grades.

## What runs

The default design is `rules+`, and nothing in it is specific to any building:

1. **Deterministic path.** A template parser recognises the known question phrasings and resolves room, floor and type mentions in code. Our geometry library (`lostfound/core`) then computes the answer. These are the same skills that reproduce all 655 labelled train and dev answers in `tests/test_skills_oracle.py`. No API call is made.
2. **Claude path.** Any question the parser does not recognise, such as a new phrasing or a new kind, goes to the hybrid Claude agent. It has typed tools for each skill, plus `run_python` over the same verified library. A deterministic formatter guarantees the `Answer:` line.

Options:

| Option | Values | Default |
|---|---|---|
| `--design` | `rules+`, `hybrid`, `typed`, `code` | `rules+` |
| `--model` | `opus`, `sonnet`, `haiku` | `opus` |
| `--effort` | `low`, `medium`, `high` | `low` |
| `--workers` | number of parallel workers | 6 |

## Evaluating on dev

```sh
uv run pytest                                                        # oracle tests: 655 benchmark + 2,130 warm-up answers
uv run python -m lostfound.evals.run --variant V5 --set dev          # the default design on dev questions
uv run python -m lostfound.evals.report --set dev                    # per-kind tables in evals/results/summary.md
```
