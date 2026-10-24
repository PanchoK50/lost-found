"""Generate reworded versions of dev questions (same meaning, same answer) to test robustness to phrasings
the template parser has never seen, like the Sunday building may bring.

  source .envrc && uv run python -m lostfound.evals.paraphrase --set dev --per-question 2
Writes evals/data/paraphrase_dev.jsonl (items keep the original answer; ids get a -P<n> suffix)."""

import argparse
import json
from concurrent.futures import ThreadPoolExecutor

import anthropic

from lostfound.evals.datasets import GENERATED, load_set

MODEL = "claude-sonnet-5-5"
STYLES = {
    "casual": "a casual, conversational message from a colleague, different sentence structure and word order",
    "terse": "a terse, telegraphic request with as few words as possible",
    "typo": "a hurried message with a few typos and lowercase in the ordinary words (keep room names and numbers exact)",
    "formal": "a formal facilities-management request, with the constraints stated in a different order",
}
PROMPT = """Rewrite this question about a building {count} times, once in each style below. Keep the meaning \
exactly: the same rooms (copy room names, room numbers and floor qualifiers such as "(Floor 2)" exactly), the same \
floor, the same room/asset type, the same numbers and constraints (widths, step-free, closures, above/below, \
"at least 1 m" rules). Do not add or drop any condition. Always end with this exact final sentence: \
"{instruction}"

Styles:
{styles}

Question:
{question}"""

SCHEMA = {
    "type": "object",
    "properties": {
        "rewrites": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"style": {"type": "string"}, "question": {"type": "string"}},
                "required": ["style", "question"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["rewrites"],
    "additionalProperties": False,
}


def split_instruction(question: str) -> tuple[str, str]:
    marker = question.rfind("Finish with a line")
    return (question[:marker].strip(), question[marker:].strip()) if marker >= 0 else (question, "")


def rewrite(client: anthropic.Anthropic, item: dict, styles: list[str]) -> list[dict]:
    body, instruction = split_instruction(item["question"])
    response = client.messages.create(
        model=MODEL,
        max_tokens=4000,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[
            {
                "role": "user",
                "content": PROMPT.format(
                    count=len(styles),
                    instruction=instruction,
                    styles="\n".join(f"- {style}: {STYLES[style]}" for style in styles),
                    question=body,
                ),
            }
        ],
    )
    text = next(block.text for block in response.content if block.type == "text")
    rewrites = json.loads(text)["rewrites"]
    items = []
    for number, rewritten in enumerate(rewrites[: len(styles)], start=1):
        question = rewritten["question"].strip()
        if instruction and instruction not in question:
            question = f"{question} {instruction}"
        items.append({**item, "id": f"{item['id']}-P{number}", "question": question, "set": "paraphrase", "style": rewritten["style"]})
    return items


def main() -> None:
    parser = argparse.ArgumentParser(prog="lostfound.evals.paraphrase")
    parser.add_argument("--set", default="dev")
    parser.add_argument("--per-question", type=int, default=2)
    parser.add_argument("--workers", type=int, default=8)
    arguments = parser.parse_args()
    client = anthropic.Anthropic()
    items = load_set(arguments.set)
    style_names = list(STYLES)

    def job(pair: tuple[int, dict]) -> list[dict]:
        index, item = pair
        styles = [style_names[(index + offset) % len(style_names)] for offset in range(arguments.per_question)]
        try:
            return rewrite(client, item, styles)
        except Exception as error:  # noqa: BLE001
            print(f"{item['id']}: {error}")
            return []

    with ThreadPoolExecutor(max_workers=arguments.workers) as pool:
        results = [row for rows in pool.map(job, enumerate(items)) for row in rows]
    GENERATED.mkdir(parents=True, exist_ok=True)
    path = GENERATED / f"paraphrase_{arguments.set}.jsonl"
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in results), encoding="utf-8")
    print(f"{len(results)} rewrites -> {path}")


if __name__ == "__main__":
    main()
