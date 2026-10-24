"""Compare a rebuilt building with its ground-truth building.json.

Geometry: spaces matched per floor by polygon IoU (after removing the unknown global offset), area error,
space-type / ref / room-type accuracy. Topology: doors (same pair of matched spaces), stair/lift links.
Usefulness: benchmark questions re-answered on the rebuilt building (labelled inputs mapped through the
space matching) and warm-up route lengths."""

import json
import statistics
from collections import Counter
from pathlib import Path

from shapely.geometry import Polygon
from shapely.ops import unary_union

from benchmark.score import score_reply
from lostfound.agent.format import answer_line
from lostfound.core import skills
from lostfound.core.building import Building, MapError

IOU_MATCH = 0.5
DOOR_MATCH_M = 0.5


def _offset(truth: dict, rebuilt: dict, level: int) -> tuple[float, float]:
    def floor_spaces(building):
        floor = next(f for f in building["floors"] if f["level"] == level)
        return [s for s in building["spaces"] if s["floor_id"] == floor["id"]]

    true_by_ref = {s["ref"]: s for s in floor_spaces(truth) if s.get("ref")}
    pairs = [(true_by_ref[s["ref"]], s) for s in floor_spaces(rebuilt) if s.get("ref") in true_by_ref]
    if pairs:
        dxs = [Polygon(t["polygon"]).centroid.x - Polygon(r["polygon"]).centroid.x for t, r in pairs]
        dys = [Polygon(t["polygon"]).centroid.y - Polygon(r["polygon"]).centroid.y for t, r in pairs]
        return statistics.median(dxs), statistics.median(dys)
    true_centre = unary_union([Polygon(s["polygon"]) for s in floor_spaces(truth)]).centroid
    centre = unary_union([Polygon(s["polygon"]) for s in floor_spaces(rebuilt)]).centroid
    return true_centre.x - centre.x, true_centre.y - centre.y


def match_spaces(truth: dict, rebuilt: dict) -> tuple[dict[str, str], dict]:
    """GT space id -> rebuilt space id, plus per-match stats. Each floor is matched with its own offset
    (some sources do not align their floors), and the floor registration is scored separately: a floor is
    registered correctly when its offset equals the reference floor's."""
    levels = sorted({f["level"] for f in truth["floors"]} & {f["level"] for f in rebuilt["floors"]})
    reference = 0 if 0 in levels else levels[0]
    reference_offset = _offset(truth, rebuilt, reference)
    mapping, ious, registered = {}, [], []
    for level in levels:
        dx, dy = _offset(truth, rebuilt, level)
        if level != reference:
            registered.append(abs(dx - reference_offset[0]) <= 0.3 and abs(dy - reference_offset[1]) <= 0.3)
        true_floor = next(f for f in truth["floors"] if f["level"] == level)["id"]
        floor = next(f for f in rebuilt["floors"] if f["level"] == level)["id"]
        candidates = [
            (s["id"], Polygon([(x + dx, y + dy) for x, y in s["polygon"]]).buffer(0))
            for s in rebuilt["spaces"]
            if s["floor_id"] == floor
        ]
        used: set[str] = set()
        for space in (s for s in truth["spaces"] if s["floor_id"] == true_floor):
            polygon = Polygon(space["polygon"]).buffer(0)
            best, best_iou = None, IOU_MATCH
            for candidate_id, candidate in candidates:
                if candidate_id in used or not candidate.intersects(polygon):
                    continue
                iou = candidate.intersection(polygon).area / candidate.union(polygon).area
                if iou > best_iou:
                    best, best_iou = candidate_id, iou
            if best:
                mapping[space["id"]] = best
                used.add(best)
                ious.append(best_iou)
    registration = sum(registered) / len(registered) if registered else None
    return mapping, {"mean_iou": statistics.mean(ious) if ious else 0.0, "registration": registration}


def evaluate(truth_directory: Path, rebuilt: dict) -> dict:
    truth = json.loads((truth_directory / "building.json").read_text(encoding="utf-8"))
    mapping, stats = match_spaces(truth, rebuilt)
    true_spaces = {s["id"]: s for s in truth["spaces"]}
    spaces = {s["id"]: s for s in rebuilt["spaces"]}
    matched = list(mapping.items())
    area_ok = [
        abs(Polygon(spaces[r]["polygon"]).area - Polygon(true_spaces[t]["polygon"]).area) <= 0.05 * Polygon(true_spaces[t]["polygon"]).area
        for t, r in matched
    ]
    result = {
        "spaces_true": len(true_spaces),
        "spaces_rebuilt": len(spaces),
        "space_recall": len(mapping) / max(len(true_spaces), 1),
        "space_precision": len(mapping) / max(len(spaces), 1),
        "mean_iou": round(stats["mean_iou"], 4),
        "area_within_5pct": sum(area_ok) / max(len(area_ok), 1),
        "type_accuracy": sum(spaces[r]["type"] == true_spaces[t]["type"] for t, r in matched) / max(len(matched), 1),
        "ref_accuracy": sum((spaces[r]["ref"] or "") == (true_spaces[t].get("ref") or "") for t, r in matched) / max(len(matched), 1),
        "room_type_accuracy": _room_type_accuracy(true_spaces, spaces, matched),
        "floor_registration": stats["registration"],
    }
    # doors: a true opening counts if a rebuilt opening joins the same (mapped) pair of spaces
    rebuilt_pairs = Counter(frozenset(o["space_ids"]) for o in rebuilt["openings"])
    hits = 0
    for opening in truth["openings"]:
        pair = frozenset(mapping.get(s, "outside" if s == "outside" else None) for s in opening["space_ids"])
        if None not in pair and rebuilt_pairs[pair] > 0:
            hits += 1
            rebuilt_pairs[pair] -= 1
    result["door_recall"] = hits / max(len(truth["openings"]), 1)
    result["door_precision"] = hits / max(len(rebuilt["openings"]), 1)
    # stair/lift links between consecutive stops
    true_links = {
        frozenset((mapping.get(a), mapping.get(b)))
        for c in truth["vertical_connectors"]
        for a, b in zip(c["space_ids"], c["space_ids"][1:])
    }
    rebuilt_links = {frozenset(pair) for c in rebuilt["vertical_connectors"] for pair in zip(c["space_ids"], c["space_ids"][1:])}
    result["connector_link_recall"] = (
        len({link for link in true_links if None not in link} & rebuilt_links) / len(true_links) if true_links else None
    )
    result.update(_question_parity(truth_directory, rebuilt, mapping))
    return result


def _room_type_accuracy(true_spaces: dict, spaces: dict, matched: list) -> float:
    """Room types of rooms and halls only (other space types are fixed by the drawing)."""
    pairs = [(t, r) for t, r in matched if true_spaces[t]["type"] in ("room", "hall")]
    return sum(spaces[r]["room_type"] == true_spaces[t]["room_type"] for t, r in pairs) / max(len(pairs), 1)


def _question_parity(truth_directory: Path, rebuilt: dict, mapping: dict[str, str]) -> dict:
    building = Building(rebuilt, truth_directory)
    floor_map = {}
    truth = json.loads((truth_directory / "building.json").read_text(encoding="utf-8"))
    level_of = {f["id"]: f["level"] for f in truth["floors"]}
    for floor in rebuilt["floors"]:
        for true_id, level in level_of.items():
            if level == floor["level"]:
                floor_map[true_id] = floor["id"]
    connector_map = {}
    for connector in truth["vertical_connectors"]:
        mapped = {mapping.get(s) for s in connector["space_ids"]}
        for candidate in rebuilt["vertical_connectors"]:
            if mapped & set(candidate["space_ids"]):
                connector_map[connector["id"]] = candidate["id"]
                break
    path = truth_directory / "questions.jsonl"
    outcomes: dict[str, list[bool]] = {}
    for line in path.read_text(encoding="utf-8").splitlines() if path.exists() else []:
        question = json.loads(line)
        kind, inputs = question["kind"], question.get("inputs") or {}
        mapped = {}
        for key, value in inputs.items():
            if isinstance(value, str) and value in mapping:
                mapped[key] = mapping[value]
            elif isinstance(value, str) and value in floor_map:
                mapped[key] = floor_map[value]
            elif isinstance(value, str) and value in connector_map:
                mapped[key] = connector_map[value]
            else:
                mapped[key] = value
        try:
            result = _run(building, kind, mapped)
            correct = score_reply(question["answer"], answer_line(building, kind, result))
        except (MapError, KeyError, ValueError):
            correct = False
        outcomes.setdefault(kind, []).append(correct)
    total = [value for values in outcomes.values() for value in values]
    return {
        "qa_parity": sum(total) / max(len(total), 1),
        "qa_by_kind": {kind: f"{sum(v)}/{len(v)}" for kind, v in outcomes.items()},
    }


def _run(b: Building, kind: str, i: dict) -> dict:
    match kind:
        case "largest_room" | "floor_area_total":
            return skills.SKILLS[kind](b, i["floor_id"], i["room_type"])
        case "errand":
            return skills.errand(b, i["start"], i["asset_type"], i["floor_id"], i["room_type"])
        case "shared_walls_count":
            return skills.shared_walls_count(b, i["start"])
        case "wide_delivery_count":
            return skills.wide_delivery_count(b, i["start"], i["floor_id"], i["min_width"])
        case "straight_line_3d":
            return skills.straight_line_3d(b, i["first"], i["second"])
        case "room_stacked":
            return skills.room_stacked(b, i["start"], i["direction"])
        case "step_free_reachable_count":
            return skills.step_free_reachable_count(b, i["start"], i["floor_id"], [i["closed"]])
        case "what_if_door":
            return skills.what_if_door(b, i["first"], i["second"], i["floor_id"])
    raise KeyError(kind)


def verifier_counts(truth_directory: Path, rebuilt: dict, issues: list[dict]) -> dict:
    """Per field: errors (true), flagged, flagged-and-wrong, for precision/recall of the verifier."""
    truth = json.loads((truth_directory / "building.json").read_text(encoding="utf-8"))
    mapping, _ = match_spaces(truth, rebuilt)
    true_spaces = {s["id"]: s for s in truth["spaces"]}
    spaces = {s["id"]: s for s in rebuilt["spaces"]}
    flagged = {(issue["field"], issue["id"]) for issue in issues}
    errors: set[tuple[str, str]] = set()
    for true_id, rebuilt_id in mapping.items():
        true_space, space = true_spaces[true_id], spaces[rebuilt_id]
        if true_space["type"] in ("room", "hall") and true_space["room_type"] != space["room_type"]:
            errors.add(("room_type", rebuilt_id))
        if true_space["type"] in ("room", "hall") and (true_space.get("ref") or "") != space["ref"]:
            errors.add(("ref", rebuilt_id))
    reverse = {rebuilt_id: true_id for true_id, rebuilt_id in mapping.items()}
    true_doors = {}
    for opening in truth["openings"]:
        true_doors[frozenset(opening["space_ids"])] = opening["width_m"]
    for opening in rebuilt["openings"]:
        pair = frozenset(reverse.get(s, s) for s in opening["space_ids"])
        if pair in true_doors and abs(true_doors[pair] - opening["width_m"]) > 0.05:
            errors.add(("door", opening["id"]))
    counts = {}
    for field in ("room_type", "ref", "door"):
        field_errors = {item for item in errors if item[0] == field}
        field_flags = {item for item in flagged if item[0] == field}
        counts[field] = {
            "errors": len(field_errors),
            "flagged": len(field_flags),
            "caught": len(field_errors & field_flags),
        }
    return counts
