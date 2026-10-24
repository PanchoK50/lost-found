#!/bin/zsh
set -u
source .envrc
for model in haiku sonnet opus; do
  for v in V2 V3 V4; do
    uv run python -m lostfound.evals.run --variant $v --model $model --effort low --set dev --workers 8 --max-cost 15 > evals/logs/dev__${v}__${model}__low.log 2>&1
    tail -1 evals/logs/dev__${v}__${model}__low.log
    grep "  all" evals/logs/dev__${v}__${model}__low.log
  done
done
uv run python -m lostfound.evals.run --variant V0 --set dev --per-kind 3 --workers 4 --max-cost 10 > evals/logs/dev__V0.log 2>&1
grep "  all" evals/logs/dev__V0.log
