"""Drawing scale (SVG points per metre) from furniture: plans carry no scale bar, but furniture comes in standard
sizes. We search for the scale at which the most drawn rectangles match a catalogue of real footprints
(learned once from the train buildings), then refine it on the matched rectangles."""

import functools
import json
import math
import statistics
from collections import Counter
from pathlib import Path

CATALOGUE_PATH = Path(__file__).with_name("furniture_catalogue.json")
MIN_EXAMPLES = 5
TOLERANCE = 0.015
SEARCH_RANGE = (1.0, 60.0)
SEARCH_STEPS = 6000


def build_catalogue(train_directory: Path = Path("data/train")) -> dict:
    """{category: [[short_side_m, long_side_m, count], ...]} from train assets (run once, file is committed)."""
    counts: Counter = Counter()
    for path in train_directory.glob("*/building.json"):
        for asset in json.loads(path.read_text(encoding="utf-8"))["assets"]:
            footprint = asset.get("footprint") or {}
            if footprint.get("width_m") and footprint.get("depth_m"):
                short, long = sorted((round(footprint["width_m"], 2), round(footprint["depth_m"], 2)))
                counts[(asset["category"], short, long)] += 1
    catalogue: dict[str, list] = {}
    for (category, short, long), count in counts.items():
        if count >= MIN_EXAMPLES:
            catalogue.setdefault(category, []).append([short, long, count])
    CATALOGUE_PATH.write_text(json.dumps(catalogue, indent=1), encoding="utf-8")
    return catalogue


@functools.cache
def catalogue() -> dict:
    if not CATALOGUE_PATH.exists():
        return build_catalogue()
    return json.loads(CATALOGUE_PATH.read_text(encoding="utf-8"))


def rectangle_sides(points: list[tuple[float, float]]) -> tuple[float, float]:
    first, second = math.dist(points[0], points[1]), math.dist(points[1], points[2])
    return (min(first, second), max(first, second))


def _match(short: float, long: float, category: str) -> list | None:
    for entry in catalogue().get(category, []):
        if abs(short - entry[0]) <= TOLERANCE * entry[0] + 0.005 and abs(long - entry[1]) <= TOLERANCE * entry[1] + 0.005:
            return entry
    return None


def estimate(assets: list[dict]) -> tuple[float | None, float]:
    """(points per metre, confidence 0..1) from a floor's drawn assets."""
    rectangles = [(asset["category"], *rectangle_sides(asset["points"])) for asset in assets if len(asset["points"]) == 4]
    if len(rectangles) < 3:
        return None, 0.0
    low, high = SEARCH_RANGE
    best_scale, best_score = None, 0
    for step in range(SEARCH_STEPS):
        scale = math.exp(math.log(low) + (math.log(high) - math.log(low)) * step / (SEARCH_STEPS - 1))
        score = sum(1 for category, short, long in rectangles if _match(short / scale, long / scale, category))
        if score > best_score:
            best_scale, best_score = scale, score
    if best_scale is None:
        return None, 0.0
    # Refine: the scale implied by each matched rectangle, combined by median.
    implied = []
    for category, short, long in rectangles:
        entry = _match(short / best_scale, long / best_scale, category)
        if entry:
            implied += [short / entry[0], long / entry[1]]
    refined = statistics.median(implied)
    return refined, best_score / len(rectangles)
