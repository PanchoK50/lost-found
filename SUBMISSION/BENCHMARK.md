# Benchmark: team Lost & Found

`answers.json` in this folder is produced by one command, with no manual steps between input and output. It holds
the answers to the kit's 145 test questions (`data/test/questions.csv`), from Claude Opus 5.5 (`claude-opus-5-5`)
at effort low. A fresh rerun on the final code gave the same 145 answers.

## Command

```sh
uv sync
# put ANTHROPIC_API_KEY in .env at the repo root (see .env.example); it is loaded automatically

# The secret building: its folder (with building.json) and its questions file (JSON, JSON lines or CSV)
uv run --env-file .env python -m lostfound.run_benchmark <building_dir> <questions_file> answers.json

# The kit's test set: a folder of building folders; each question names its folder in building_id
uv run --env-file .env python -m lostfound.run_benchmark data/test data/test/questions.csv SUBMISSION/answers.json
```

Options: `--model opus|sonnet|haiku` (default `opus`, Claude Opus 5.5), `--effort low|medium|high` (default `low`),
`--workers N` (default 6), `--csv out.csv` (also write the kit's `question_id,answer` CSV),
`--details details.json` (full replies and routes).

Needs Python 3.12+ and [uv](https://docs.astral.sh/uv/). The 145 test questions take about 1.5 minutes with 6
workers and cost about $2 with Claude Opus 5.5 (`claude-opus-5-5`). If the key is missing, the run stops at once with
a clear message. A question that fails gets an empty answer; the other questions are not affected.

## Input

- `<building_dir>`: one building folder with `building.json` in the kit format, or a folder of building folders.
- Questions: a JSON list of `{id, question}`, `{"questions": [...]}`, JSON lines, or a CSV with a header
  (`question_id,building_id,kind,question` as in the kit). Optional structured conditions (`step_free`, `closed`,
  `from`, `to`, `min_width`, `forklift` or `vehicle: "forklift"`) are added to the question text.

## Output: `answers.json`

A list with one entry per question, in question order, as the organizers specified:

```json
[
 {"question_id": "osm-way363805324-H01", "answer": "Answer: 1.02, 162.33 m²"},
 {"question_id": "osm-way363805324-H02", "answer": "Answer: 54.77"}
]
```

- `answer` is the last `Answer:` line of the agent's reply, which is what the kit's `benchmark/score.py` grades.
- When no route exists under the rules, the answer is `"Answer: no route"`.
- `--details details.json` also writes the full reply per question, plus the found `space_id` / `item_id`, the
  `route` as ordered space ids, `route_nodes` / `element_path` (doors, stairs and lifts in order), `length_m` and
  `reachable`. Keep that file outside `SUBMISSION/`.

## How it works

1. **Rooms resolved in code.** Room, floor, room-type and asset mentions are matched to ids deterministically
   (names, room numbers, floor qualifiers, umlauts) and passed to Claude as hints, with ambiguities flagged.
2. **Claude picks a typed tool** (route, nearest, find, count, area, errand, deliveries, reachability, stacking,
   shared walls, 3D distance, what-if door) and fills in its arguments. Every number and route is computed in code
   (`lostfound/core`); the tool returns a ready-made `Answer:` line. For questions no tool covers, Claude runs a
   short Python snippet against the same library.
3. **The answer is the reply's last `Answer:` line**, copied from the tool result. With `--details`, the route and
   other details come from the tool call that the reply's answer belongs to. A fallback the agent tried after
   answering never replaces it.

Nothing is specific to any building; the same code runs on every building in the kit format.

## Route rules

The route model is the kit's `starter_agent/building_map.py`, unchanged: walking door to door 15 cm off the walls
and round corners, stairs 2 m per metre climbed, a lift 15 m plus 1 m per metre, no way round the outside. On top:

| Rule | How we apply it |
|---|---|
| Without stairs | step-free: lifts, ramps and step-free doors only |
| Closed or blocked areas | the closed lifts, stairs, doors or spaces are removed |
| Forklift | openings at least 3 m wide, no steps, stairs or lifts, no pedestrian walkways |
| Production bays are destinations | forklift routes may start or end in a bay (the `*_zone` halls) or stop in one on a tour, but never pass through one |
| No route under the rules | the reply says so and ends with `Answer: no route` |

By default the bay rule applies to forklift routes; `LOSTFOUND_BAY_RULE=always` applies it to walking routes too.

## Checks

```sh
uv run pytest    # over 6,400 tests, no API key needed
```

- **Dev benchmark questions:** 138/138 with the official scorer, both for the deterministic core and for the Opus
  agent (`evals/results/summary.md`).
- **Train benchmark questions:** 515/517. The two misses name a room ("Büro") that several rooms on that floor share.
- **Dev warm-up routes:** 229/229 valid and optimal, with the same space sequence as the labels.
- **Unseen buildings** (`tests/test_level4.py`):
  - disguised copies of dev buildings (new ids, moved and turned, lists reordered) give the labelled answers;
  - on all 40 test buildings, routes, step-free routes, closures, tours and errands match the kit's router and a
    brute force;
  - each part of a multi-part building cannot be reached from another part, because there is no way round the
    outside;
  - every test question is parsed, and all 145 submitted answers agree with the deterministic path.
- **Independent reference** (`tests/test_reference_geometry.py`): the geometry and reach rules are reimplemented
  from the kit README, and they agree with ours on every train, dev and test building.
- **Forklift routes** on the dev and test factories match an independent rule checker.
