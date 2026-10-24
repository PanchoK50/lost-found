"""Scoring: the official benchmark/score.py, plus an 'unreachable' answer type for warm-up route questions."""

import re

from benchmark.score import committed_answer, score_reply

NO_ROUTE = re.compile(r"\b(no route|unreachable|not reachable|impossible|no step-free route|none)\b", re.IGNORECASE)


def score(answer: dict, reply: str) -> bool:
    if answer["type"] == "unreachable":
        text = committed_answer(reply)
        return bool(text and NO_ROUTE.search(text))
    return score_reply(answer, reply)
