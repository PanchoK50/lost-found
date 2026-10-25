# Benchmark: team Lost & Found

`answers.json` in this folder is produced by one command, with no manual steps between input and output.

## Command

```sh
uv sync
# put ANTHROPIC_API_KEY in .env at the repo root (see .env.example); it is loaded automatically

# The Sunday building: its folder (with building.json) and its questions file
uv run --env-file .env python -m lostfound.run_benchmark <building_dir> <questions.json> SUBMISSION/answers.json

# The kit's test set: a folder of building folders; each question names its folder in building_id
uv run --env-file .env python -m lostfound.run_benchmark data/test data/test/questions.csv SUBMISSION/answers.json
```

Options: `--model opus|sonnet|haiku` (default `opus`, Claude Opus 5.5), `--effort low|medium|high` (default `low`),
`--workers N` (default 6), `--csv out.csv` (also write the kit's `question_id,answer` CSV),
`--details details.json` (full replies and routes).

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
3. **answers.json is filled from the tool call the reply committed to**, so a fallback the agent explored after
   its answer never replaces the answered route.

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
uv run pytest    # oracle tests: every labelled train/dev answer, warm-up routes, forklift and bay rules
```

- Dev benchmark questions: 138/138 with the official scorer (deterministic core; the Opus agent run is in `evals/results/summary.md`).
- Dev warm-up routes: 229/229 valid and optimal, with the same space sequence as the labels.
- Forklift routes on the dev factories match an independent rule checker.
