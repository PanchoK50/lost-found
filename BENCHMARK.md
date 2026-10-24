# BENCHMARK.md — how our agent is run

One command, no manual steps between input and output.

## Setup (once)

```sh
uv sync
cp .env.example .env    # then put your ANTHROPIC_API_KEY in .env
```

## Run the scored test split (writes the submission CSV)

```sh
uv run --env-file .env python -m benchmark.evaluate data/test \
    --agent agent.entry:answer --submission-csv team_lost_found.csv
```

Or via our wrapper (same run, plus a model switch):

```sh
uv run --env-file .env python -m agent.bench data/test --model opus --submission-csv team_lost_found.csv
```

- Model: default `claude-opus-5-5`; `--model sonnet` (or `AGENT_MODEL=...`) switches it.
- The Sunday building arrives in the same format: point the same command at its
  directory instead of `data/test`.

## Quality gates (deterministic, free, no API)

```sh
uv run pytest                                  # unit tests (core + agent)
uv run python -m core.validate data/dev --basic   # every dev question through the core: 407/407
uv run python -m core.validate data/train --basic # every train question: 1825/1825
uv run python -m agent.replay data/dev        # tools + answer format under the real scorer: 138/138
uv run python -m agent.replay data/train      # 517/517
```

## Try it interactively

```sh
uv run --env-file .env python -m agent data/dev/proc-factory-dev-003 --model sonnet
```

Architecture: `agent/` is the Claude tool layer (strict tools, one-shot mode for
benchmark questions); every fact comes from the deterministic `core/` package
(route model per kit 1.1.0; see `core/README.md`).
