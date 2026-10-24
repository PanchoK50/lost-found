import functools
import json
from pathlib import Path

import pytest

from lostfound.core.building import Building

DATA = Path(__file__).resolve().parent.parent / "data"
LABELLED_SPLITS = ("train", "dev")


def load_jsonl(filename: str) -> list[tuple[Path, dict]]:
    items = []
    for split in LABELLED_SPLITS:
        for path in sorted((DATA / split).glob(f"*/{filename}")):
            items += [(path.parent, json.loads(line)) for line in path.read_text(encoding="utf-8").splitlines() if line]
    return items


@functools.cache
def building(directory: Path) -> Building:
    return Building.load(directory)


@pytest.fixture
def load_building():
    return building
