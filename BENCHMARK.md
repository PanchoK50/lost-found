# Benchmark run

## Sunday building (challenge PDF format)

```sh
uv run --env-file .env python -m lostfound.run_benchmark <building_dir> <questions.json> <answers.json> [--csv answers.csv]
```

- `<building_dir>` holds the new `building.json`.
- `questions.json` is a list of `{id, question}` (also `{"questions": [...]}` or JSON lines). Optional structured
  conditions (`step_free`, `closed`, `from`, `to`, `min_width`) are added to the text.
- `answers.json` has one entry per question id: `answer` (the value of the `Answer:` line), `reply` (full text), `kind`,
  the found `space_id` / `item_id`, the `route` as ordered space ids, `route_nodes` (spaces and the doors between them,
  in order) and `length_m` (`reachable: false` when there is no route). The organisers have not published a schema
  yet; see `lostfound/run_benchmark.py` to adapt the field names in one place.

## Test set (CSV)

One command, no manual steps between input and output:

```sh
uv sync
# put ANTHROPIC_API_KEY in .env (see .env.example)
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

The default design is `hybrid`. Every question goes to the Claude agent, and nothing in it is specific to any building:

1. **Room resolution in code.** Room mentions in the question are resolved to space ids deterministically (names, room numbers, floor qualifiers, umlauts), and passed to Claude as hints, with ambiguities flagged.
2. **Typed tools (main path).** Claude picks one tool per question kind (areas, errands, deliveries, reachability, stacking, shared walls, 3D distance, what-if doors, routes, assets) and fills in its arguments. The tool computes the answer with our geometry library (`lostfound/core`) and returns a ready-made `Answer:` line. These are the same skills that reproduce every labelled train and dev answer in `tests/`.
3. **`run_python` (fallback).** For a question no tool covers, Claude writes a short Python snippet against the same verified library. It runs locally in a separate process with a timeout.
4. **A formatter guarantees the `Answer:` line.** If the reply lacks one, the last tool's answer line is appended.

No template matching is used for answers. The template parser (`lostfound/agent/rules.py`) is kept only as the no-LLM baseline in the evals.

Options:

| Option | Values | Default |
|---|---|---|
| `--design` | `hybrid`, `typed`, `code` | `hybrid` |
| `--model` | `opus`, `sonnet`, `haiku` | `opus` |
| `--effort` | `low`, `medium`, `high` | `low` |
| `--workers` | number of parallel workers | 6 |

## Evaluating on dev

```sh
uv run pytest                                                        # oracle tests: 655 benchmark + 2,130 warm-up answers
uv run python -m lostfound.evals.run --variant V4 --model opus --effort low --set dev   # the default design on dev
uv run python -m lostfound.evals.report --set dev                    # per-kind tables in evals/results/summary.md
```
