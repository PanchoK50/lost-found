#!/bin/zsh
set -u
source .envrc
uv run python -m lostfound.evals.run --variant V5 --model opus --effort low --set paraphrase-dev --workers 8 --max-cost 8 > evals/logs/paraphrase__V5__opus.log 2>&1
grep "  all" evals/logs/paraphrase__V5__opus.log
uv run python -m lostfound.evals.run --variant V4 --model opus --effort low --set warmup-dev --workers 8 --max-cost 10 > evals/logs/warmup__V4__opus.log 2>&1
grep "  all" evals/logs/warmup__V4__opus.log
uv run python -m lostfound.evals.run --variant V4 --model opus --effort low --set dev --leave-one-kind-out --workers 8 --max-cost 6 > evals/logs/loko__V4__opus.log 2>&1
grep "  all" evals/logs/loko__V4__opus.log
