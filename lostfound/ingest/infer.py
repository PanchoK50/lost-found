"""Infer what a plan does not say explicitly, from patterns learned on the train buildings:
- asset type from the drawn footprint (furniture comes in standard sizes, see scale.catalogue);
- room type from the room's contents and size (multinomial naive Bayes over inferred asset types).

  uv run python -m lostfound.ingest.infer        # retrain from data/train and write room_type_model.json"""

import functools
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from shapely.geometry import Point, Polygon

from lostfound.ingest import scale

MODEL_PATH = Path(__file__).with_name("room_type_model.json")
DOOR_MODEL_PATH = Path(__file__).with_name("door_width_model.json")
DEFAULT_DOOR_WIDTH_M = 0.9
PREDICTED_SPACE_TYPES = ("room", "hall")
SMOOTHING = 0.5


def asset_type(category: str, short_m: float, long_m: float) -> str:
    entry = scale.match(short_m, long_m, category)
    if entry is None:
        return f"unknown_{category}"
    return max(entry[3], key=entry[3].get)


def _area_token(area: float) -> str:
    return f"area:{min(int(math.log2(max(area, 1.0))), 12)}"


def ref_style(ref: str) -> str:
    """Shape of a room number ('1.02' -> '9.99', 'N0314' -> 'A9999', '' -> none): a cue for the building style."""
    if not ref:
        return "none"
    shape = "".join("9" if c.isdigit() else "A" if c.isalpha() else c for c in ref)
    return shape[:8]


def room_features(space_type: str, area: float, asset_types: list[str], ref: str = "") -> list[str]:
    tokens = [f"space:{space_type}", _area_token(area)]  # ref style tested: hurt accuracy (98.3% -> 97.2%)
    tokens += [f"asset:{name}" for name in asset_types]
    if not asset_types:
        tokens.append("asset:none")
    return tokens


def _quantiles(values: list[float]) -> list[float]:
    ordered = sorted(values)
    pick = lambda q: ordered[min(int(q * (len(ordered) - 1)), len(ordered) - 1)]  # noqa: E731
    return [round(pick(0.01), 2), round(pick(0.99), 2)]


def train(train_directory: Path = Path("data/train")) -> dict:
    priors: Counter = Counter()
    token_counts: dict[str, Counter] = defaultdict(Counter)
    areas: dict[str, list[float]] = defaultdict(list)
    for path in sorted(train_directory.glob("*/building.json")):
        building = json.loads(path.read_text(encoding="utf-8"))
        contents: dict[str, list[str]] = defaultdict(list)
        for asset in building["assets"]:
            footprint = asset.get("footprint") or {}
            if footprint.get("width_m") and footprint.get("depth_m"):
                short, long = sorted((footprint["width_m"], footprint["depth_m"]))
                contents[asset["space_id"]].append(asset_type(asset["category"], short, long))
        for space in building["spaces"]:
            if space["type"] not in PREDICTED_SPACE_TYPES:
                continue
            label = space["room_type"]
            priors[label] += 1
            area = Polygon(space["polygon"]).area
            areas[label].append(area)
            token_counts[label].update(room_features(space["type"], area, contents[space["id"]], space.get("ref") or ""))
    model = {
        "priors": dict(priors),
        "tokens": {label: dict(counts) for label, counts in token_counts.items()},
        "area_range": {label: _quantiles(values) for label, values in areas.items()},
    }
    MODEL_PATH.write_text(json.dumps(model), encoding="utf-8")
    return model


def _pair_key(room_types: list[str]) -> str:
    return "|".join(sorted(room_types))


def train_door_widths(train_directory: Path = Path("data/train")) -> dict:
    """Most common door width per pair of room types (doors are dots on the plan, widths are not drawn)."""
    by_pair: dict[str, Counter] = defaultdict(Counter)
    for path in sorted(train_directory.glob("*/building.json")):
        building = json.loads(path.read_text(encoding="utf-8"))
        room_types = {space["id"]: space["room_type"] for space in building["spaces"]}
        for opening in building["openings"]:
            key = _pair_key([room_types.get(space, "outside") for space in opening["space_ids"]])
            by_pair[key][round(opening["width_m"], 2)] += 1
    table = {
        key: [counts.most_common(1)[0][0], round(counts.most_common(1)[0][1] / sum(counts.values()), 3)]
        for key, counts in by_pair.items()
    }
    DOOR_MODEL_PATH.write_text(json.dumps(table, indent=0, sort_keys=True), encoding="utf-8")
    return table


@functools.cache
def door_widths() -> dict:
    if not DOOR_MODEL_PATH.exists():
        return train_door_widths()
    return json.loads(DOOR_MODEL_PATH.read_text(encoding="utf-8"))


def door_width(room_types: list[str]) -> tuple[float, float]:
    """(width, reliability): the most common width for this pair of room types and how often it holds."""
    width, purity = door_widths().get(_pair_key(room_types), (DEFAULT_DOOR_WIDTH_M, 0.0))
    return width, purity


@functools.cache
def model() -> dict:
    if not MODEL_PATH.exists():
        return train()
    return json.loads(MODEL_PATH.read_text(encoding="utf-8"))


def predict_room_type(space_type: str, area: float, asset_types: list[str], ref: str = "") -> list[tuple[str, float]]:
    """Ranked (room_type, probability)."""
    trained = model()
    vocabulary = {token for counts in trained["tokens"].values() for token in counts}
    total = sum(trained["priors"].values())
    tokens = room_features(space_type, area, asset_types, ref)
    scores = {}
    for label, prior in trained["priors"].items():
        counts = trained["tokens"][label]
        denominator = sum(counts.values()) + SMOOTHING * len(vocabulary)
        log_probability = math.log(prior / total)
        for token in tokens:
            log_probability += math.log((counts.get(token, 0) + SMOOTHING) / denominator)
        scores[label] = log_probability
    best = max(scores.values())
    weights = {label: math.exp(score - best) for label, score in scores.items()}
    norm = sum(weights.values())
    return sorted(((label, weight / norm) for label, weight in weights.items()), key=lambda item: -item[1])


def label_building(building: dict) -> None:
    """Fill asset types and room types in an assembled building (in place)."""
    contents: dict[str, list[str]] = defaultdict(list)
    for asset in building["assets"]:
        footprint = asset["footprint"]
        inferred = asset_type(asset["category"], footprint["depth_m"], footprint["width_m"])
        asset["type"] = inferred
        contents[asset["space_id"]].append(inferred)
    for space in building["spaces"]:
        if space["type"] not in PREDICTED_SPACE_TYPES:
            continue
        ranked = predict_room_type(space["type"], Polygon(space["polygon"]).area, contents[space["id"]], space.get("ref", ""))
        space["room_type"] = ranked[0][0]
        space["room_type_confidence"] = round(ranked[0][1], 3)
        space["room_type_alternatives"] = [label for label, _ in ranked[1:3]]
    room_types = {space["id"]: space["room_type"] for space in building["spaces"]}
    for opening in building["openings"]:
        width, reliability = door_width([room_types.get(space, "outside") for space in opening["space_ids"]])
        opening["width_m"] = width
        opening["width_reliability"] = reliability


def contains(space: dict, point: tuple[float, float]) -> bool:
    return Polygon(space["polygon"]).contains(Point(point))


if __name__ == "__main__":
    trained = train()
    print(f"room-type model: {len(trained['priors'])} classes -> {MODEL_PATH}")
    print(f"door-width table: {len(train_door_widths())} room-type pairs -> {DOOR_MODEL_PATH}")
