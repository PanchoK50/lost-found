"""The repo-root .env for the command-line runners, so a forgotten `--env-file .env` can't silently produce empty
answers. Values already in the environment win; nothing is ever printed."""

import os
import re
import sys
from pathlib import Path

ROOT_ENV = Path(__file__).resolve().parents[1] / ".env"
LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def load_env(path: Path = ROOT_ENV) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():  # utf-8-sig: a BOM must not hide the first key
        match = LINE.match(line)
        if not match or line.lstrip().startswith("#"):
            continue
        key, value = match.groups()
        if value[:1] in ("\"", "'"):
            closing = value.find(value[0], 1)
            value = value[1:closing] if closing > 0 else value[1:]  # anything after the closing quote is a comment
        elif " #" in value or "\t#" in value:
            value = re.split(r"\s#", value, maxsplit=1)[0].rstrip()
        if value:
            os.environ.setdefault(key, value)


def require_api_key() -> None:
    """Load the .env, then stop with a clear message if there is still no Claude API key."""
    load_env()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit(f"ANTHROPIC_API_KEY is not set: put it in {ROOT_ENV} (see .env.example) or export it.")
