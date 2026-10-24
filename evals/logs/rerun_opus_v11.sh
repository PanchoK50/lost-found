#!/bin/zsh
set -u
source .envrc
uv run python -m lostfound.evals.run --variant V4 --model opus --effort low --set dev --workers 8 --max-cost 4 > evals/logs/v11_dev_V4.log 2>&1; grep "  all" evals/logs/v11_dev_V4.log
uv run python -m lostfound.evals.run --variant V5 --model opus --effort low --set paraphrase-dev --workers 8 --max-cost 6 > evals/logs/v11_para_V5.log 2>&1; grep "  all" evals/logs/v11_para_V5.log
uv run python -m lostfound.evals.run --variant V4 --model opus --effort low --set warmup-dev --workers 8 --max-cost 8 > evals/logs/v11_warmup_V4.log 2>&1; grep "  all" evals/logs/v11_warmup_V4.log
uv run python -m lostfound.evals.run --variant V4 --model opus --effort low --set dev --leave-one-kind-out --workers 8 --max-cost 8 > evals/logs/v11_loko_V4.log 2>&1; grep "  all" evals/logs/v11_loko_V4.log
