#!/bin/zsh
set -u
set -a; source .env; set +a
R() { uv run python -m lostfound.evals.run --variant V4 --model opus --effort low --workers 8 "$@"; }
R --set novel-dev --max-cost 4 --name v12_novel-dev__V4 > evals/logs/v12_novel_V4.log 2>&1; grep "  all" evals/logs/v12_novel_V4.log
R --set dev --max-cost 4 --name v12_dev__V4 > evals/logs/v12_dev_V4.log 2>&1; grep "  all" evals/logs/v12_dev_V4.log
R --set paraphrase-dev --max-cost 5 --name v12_paraphrase-dev__V4 > evals/logs/v12_para_V4.log 2>&1; grep "  all" evals/logs/v12_para_V4.log
R --set warmup-dev --max-cost 6 --name v12_warmup-dev__V4 > evals/logs/v12_warmup_V4.log 2>&1; grep "  all" evals/logs/v12_warmup_V4.log
