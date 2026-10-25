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
    """{category: [[short_side_m, long_side_m, count, {asset_type: count}], ...]} from train assets
    (run once; the file is committed)."""
    counts: Counter = Counter()
    types: dict[tuple, Counter] = {}
    for path in train_directory.glob("*/building.json"):
        for asset in json.loads(path.read_text(encoding="utf-8"))["assets"]:
            footprint = asset.get("footprint") or {}
            if footprint.get("width_m") and footprint.get("depth_m"):
                short, long = sorted((round(footprint["width_m"], 2), round(footprint["depth_m"], 2)))
                key = (asset["category"], short, long)
                counts[key] += 1
                types.setdefault(key, Counter())[asset["type"]] += 1
    catalogue: dict[str, list] = {}
    for key, count in sorted(counts.items(), key=lambda item: -item[1]):
        if count >= MIN_EXAMPLES:
            category, short, long = key
            catalogue.setdefault(category, []).append([short, long, count, dict(types[key].most_common(5))])
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


def match(short: float, long: float, category: str) -> list | None:
    """The catalogue entry (most common first) a footprint in metres matches, if any."""
    return _match(short, long, category)


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


# Without furniture: plans have a typical room size, which depends on the kind of building, and the kind can be
# told from the drawing alone (median over the train buildings of each building's median ground-floor 'room'):
# - a drawn hall at least FACTORY_HALL_RATIO times the median room: a factory with production halls (21.8 m²);
# - any other drawn hall (lobbies, as in campus buildings): 30.0 m²;
# - no halls (homes, small offices): 12.2 m².
FACTORY_HALL_RATIO = 5.0
TYPICAL_ROOM_M2 = {"factory": 21.8, "hall": 30.0, "plain": 12.2}
LAST_RESORT_POINTS_PER_METRE = 10.0


def estimate_from_rooms(drawings: list) -> float | None:
    """Points per metre that make the plans' median room the typical size for that kind of building (for plans
    with no furniture, where nothing else gives the scale)."""
    from shapely.geometry import Polygon

    def areas(kind: str) -> list[float]:
        found = [Polygon(space["points"]).area for drawing in drawings for space in drawing.spaces if space["type"] == kind]
        return [area for area in found if area > 0]

    rooms, halls = areas("room"), areas("hall")
    if not rooms:
        return None
    median = statistics.median(rooms)
    kind = "plain" if not halls else "factory" if max(halls) >= FACTORY_HALL_RATIO * median else "hall"
    return math.sqrt(median / TYPICAL_ROOM_M2[kind])


RASTER_PIXEL_TOLERANCE = 1.2   # a drawn side is accurate to about one pixel
RASTER_MIN_EXAMPLES = 40       # only common furniture sizes: rare ones match anything at some scale
RASTER_MIN_LONG_PX = 6


def estimate_raster(assets: list[dict]) -> tuple[float | None, float]:
    """Scale for raster plans, where sides are only known to about a pixel: every common catalogue size votes
    for the scale it implies, weighted by the rectangle's size (big furniture pins the scale down), and the
    densest weighted cluster of votes wins; then the weighted median inside it."""
    rectangles = [rectangle_sides(asset["points"]) + (asset["category"],) for asset in assets if len(asset["points"]) == 4]
    rectangles = [r for r in rectangles if r[1] >= RASTER_MIN_LONG_PX and r[0] >= 2]
    if len(rectangles) < 3:
        return None, 0.0
    votes: list[tuple[float, float, float]] = []  # (log scale, log half-width, weight)
    for short, long, category in rectangles:
        for entry in catalogue().get(category, []):
            if entry[2] < RASTER_MIN_EXAMPLES:
                continue
            s_short, s_long = short / entry[0], long / entry[1]
            if abs(math.log(s_short / s_long)) > math.log(1 + 2 * RASTER_PIXEL_TOLERANCE / max(short, 1)):
                continue
            implied = math.sqrt(s_short * s_long)
            if not SEARCH_RANGE[0] <= implied <= SEARCH_RANGE[1]:
                continue
            width = RASTER_PIXEL_TOLERANCE / long
            votes.append((math.log(implied), width, long * math.log1p(entry[2])))
    if not votes:
        return None, 0.0
    low, high = math.log(SEARCH_RANGE[0]), math.log(SEARCH_RANGE[1])
    best, best_score = None, 0.0
    for step in range(SEARCH_STEPS):
        x = low + (high - low) * step / (SEARCH_STEPS - 1)
        score = sum(weight for centre, width, weight in votes if abs(centre - x) <= width)
        if score > best_score:
            best, best_score = x, score
    inside = sorted((centre, weight) for centre, width, weight in votes if abs(centre - best) <= width)
    total = sum(weight for _, weight in inside)
    running = 0.0
    for centre, weight in inside:
        running += weight
        if running >= total / 2:
            matched = len({id(v) for v in inside})
            return math.exp(centre), min(1.0, matched / len(rectangles))
    return math.exp(best), 0.0
