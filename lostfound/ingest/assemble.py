"""Assemble a building.json from per-floor drawings: metric frame, floor registration, labels, openings and
vertical connectors. Facts the drawing does not contain (room types, door widths, elevations) get explicit
priors and are listed in `ingest_report` so the agent can confirm them with the user."""

import itertools
import re
import math
import statistics
from collections import Counter
from pathlib import Path

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from lostfound.ingest import infer, svg
from lostfound.ingest import scale as scale_module

LABEL_CHAR_WIDTH_PT = 1.7  # labels are centred on the room; the SVG anchor is the text start
LABEL_BASELINE_PT = 1.6
LABEL_MAX_DISTANCE_M = 3.0
DOOR_SNAP_M = 0.6
DEFAULT_STOREY_HEIGHT_M = 3.0
REGISTRATION_TOLERANCE_M = 0.6
# Default room type per space type when nothing better is known (rooms are refined by lostfound.ingest.label).
DEFAULT_ROOM_TYPE = {
    "room": "generic_room",
    "corridor": "corridor",
    "stair": "stairwell",
    "lift": "lift",
    "hall": "lobby",
    "outdoor": "balcony",
}
# Door width priors (m) by the space types a door joins (README conventions for typical buildings).
DOOR_WIDTH_PRIORS = {"lift": 1.1, "hall": 1.6, "stair": 1.2}
DEFAULT_DOOR_WIDTH_M = 0.9
FLOOR_NAMES = {0: "Ground floor"}


def floor_name(level: int) -> str:
    if level in FLOOR_NAMES:
        return FLOOR_NAMES[level]
    return f"Basement {-level}" if level < 0 else f"Floor {level}"


def _to_metres(points: list[tuple[float, float]], points_per_metre: float) -> list[tuple[float, float]]:
    return [(x / points_per_metre, -y / points_per_metre) for x, y in points]


def _register(reference: list[dict], other: list[dict]) -> tuple[float, float, int]:
    """Translation that maps `other`'s stairs/lifts onto `reference`'s (vote over candidate pairs)."""
    def cores(spaces):
        return [(Polygon(s["polygon"]).centroid, Polygon(s["polygon"]).area, s["type"]) for s in spaces if s["type"] in ("stair", "lift")]

    reference_cores, other_cores = cores(reference), cores(other)
    best = (0.0, 0.0, 0)
    for (ref_point, ref_area, ref_type), (point, area, kind) in itertools.product(reference_cores, other_cores):
        if kind != ref_type or abs(area - ref_area) > 0.15 * ref_area:
            continue
        dx, dy = ref_point.x - point.x, ref_point.y - point.y
        votes = sum(
            1
            for p, a, k in other_cores
            if any(
                k == rk and math.dist((p.x + dx, p.y + dy), (rp.x, rp.y)) <= REGISTRATION_TOLERANCE_M
                for rp, ra, rk in reference_cores
            )
        )
        if votes > best[2]:
            best = (dx, dy, votes)
    if best[2] == 0:  # no stairs/lifts to match: align outline centroids
        ref_centre = unary_union([Polygon(s["polygon"]) for s in reference]).centroid
        centre = unary_union([Polygon(s["polygon"]) for s in other]).centroid
        return ref_centre.x - centre.x, ref_centre.y - centre.y, 0
    return best


def _shift(spaces: list[dict], dx: float, dy: float) -> None:
    for space in spaces:
        space["polygon"] = [[round(x + dx, 3), round(y + dy, 3)] for x, y in space["polygon"]]


def load_drawings(directory: Path, prefer: str = "svg") -> list[svg.Drawing]:
    """One drawing per floor: floor_<level>.svg when present (exact), else floor_<level>.png (raster)."""
    from lostfound.ingest import raster

    by_level: dict[int, svg.Drawing] = {}
    if prefer == "svg":
        for path in directory.glob("floor_*.svg"):
            if "_plain" not in path.name:
                drawing = svg.parse(path)
                by_level[drawing.level] = drawing
    for path in sorted(directory.glob("floor_*.png")):
        if "_plain" in path.name:
            continue
        level = int(re.search(r"floor_(-?\d+)", path.name).group(1))
        if level not in by_level:
            by_level[level] = raster.parse(path)
    return [by_level[level] for level in sorted(by_level)]


def assemble(directory: Path, building_id: str | None = None, name: str | None = None, prefer: str = "svg") -> dict:
    building_id = building_id or directory.name
    drawings = load_drawings(directory, prefer)
    if not drawings:
        raise FileNotFoundError(f"No floor_<level>.svg or floor_<level>.png in {directory}")
    report: dict = {"scales": {}, "registration": {}, "assumptions": []}

    estimates = {d.level: (scale_module.estimate_raster(d.assets) if getattr(d, "raster", False) else scale_module.estimate(d.assets)) for d in drawings}
    known = [value for value, _ in estimates.values() if value]
    fallback = statistics.median(known) if known else None
    floors, spaces, openings, assets = [], [], [], []
    per_floor_spaces: dict[int, list[dict]] = {}
    per_floor_shift: dict[int, tuple[float, float]] = {}

    for drawing in drawings:
        points_per_metre, confidence = estimates[drawing.level]
        if not points_per_metre:
            points_per_metre, confidence = fallback or 10.0, 0.0
            report["assumptions"].append(f"level {drawing.level}: no furniture to infer scale; used {points_per_metre:.3f} pt/m")
        report["scales"][drawing.level] = {"points_per_metre": round(points_per_metre, 4), "confidence": round(confidence, 2), "raster": getattr(drawing, "raster", False)}
        floor_id = f"{building_id}-F{drawing.level}"
        floors.append(
            {
                "id": floor_id,
                "level": drawing.level,
                "name": drawing.title.split(" — ", 1)[1] if " — " in drawing.title else floor_name(drawing.level),
                "elevation_m": round(drawing.level * DEFAULT_STOREY_HEIGHT_M, 2),
                "height_m": DEFAULT_STOREY_HEIGHT_M,
            }
        )
        floor_spaces = []
        for index, drawn in enumerate(drawing.spaces):
            floor_spaces.append(
                {
                    "id": f"{floor_id}-S{index:03d}",
                    "floor_id": floor_id,
                    "type": drawn["type"],
                    "room_type": DEFAULT_ROOM_TYPE[drawn["type"]],
                    "name": "",
                    "ref": "",
                    "polygon": [[round(x, 3), round(y, 3)] for x, y in _to_metres(drawn["points"], points_per_metre)],
                    "synthetic": False,
                    **({"label_px": drawn["anchor_px"]} if "anchor_px" in drawn else {}),
                }
            )
        _assign_labels(drawing, floor_spaces, points_per_metre)
        per_floor_spaces[drawing.level] = floor_spaces
        per_floor_shift[drawing.level] = (0.0, 0.0)
        drawing.metres = points_per_metre  # type: ignore[attr-defined]

    # Register every floor to the ground floor (or the lowest), walking outwards level by level.
    levels = sorted(per_floor_spaces)
    reference_level = 0 if 0 in per_floor_spaces else levels[0]
    order = sorted(levels, key=lambda level: abs(level - reference_level))
    registered = [reference_level]
    for level in order[1:]:
        neighbour = min(registered, key=lambda done: abs(done - level))
        registered.append(level)
        dx, dy, votes = _register(per_floor_spaces[neighbour], per_floor_spaces[level])
        _shift(per_floor_spaces[level], dx, dy)
        per_floor_shift[level] = (dx, dy)
        report["registration"][level] = {"to_level": neighbour, "shift_m": [round(dx, 3), round(dy, 3)], "matched_cores": votes}
        if votes == 0:
            report["assumptions"].append(f"level {level}: no stairs/lifts to align with level {neighbour}; aligned outlines")

    for drawing in drawings:
        floor_spaces = per_floor_spaces[drawing.level]
        spaces += floor_spaces
        dx, dy = per_floor_shift[drawing.level]
        ppm = drawing.metres  # type: ignore[attr-defined]
        openings += _openings(drawing, floor_spaces, ppm, dx, dy, f"{building_id}-F{drawing.level}")
        for index, drawn in enumerate(drawing.assets):
            polygon = Polygon([(x + dx, y + dy) for x, y in _to_metres(drawn["points"], ppm)])
            short, long = scale_module.rectangle_sides(_to_metres(drawn["points"], ppm))
            container = next((s for s in floor_spaces if Polygon(s["polygon"]).contains(polygon.centroid)), None)
            if container is None:
                continue
            first, second = _to_metres(drawn["points"][:2], ppm)
            rotation = math.degrees(math.atan2(second[1] - first[1], second[0] - first[0])) % 180
            assets.append(
                {
                    "id": f"{building_id}-A{len(assets):05d}",
                    "name": f"{drawn['category'].title()} {container['ref'] or container['id'][-4:]}-{index}",
                    "category": drawn["category"],
                    "type": f"unknown_{drawn['category']}",
                    "space_id": container["id"],
                    "floor_id": container["floor_id"],
                    "position": [round(polygon.centroid.x, 3), round(polygon.centroid.y, 3)],
                    "footprint": {"width_m": round(long, 3), "depth_m": round(short, 3), "rotation_deg": round(rotation, 1)},
                    "source": "plan",
                }
            )

    connectors = _connectors(building_id, per_floor_spaces, floors)
    if len(levels) > 1 and not connectors:
        connectors = _connectors(building_id, per_floor_spaces, floors, core_types=("corridor",))
        if connectors:
            report["assumptions"].append(
                "no stairs or lifts drawn: linked overlapping corridors between floors as stairs (please confirm)"
            )
    report["assumptions"].append("asset types inferred from footprint sizes; room types predicted from contents and size")
    report["assumptions"].append(f"door widths from priors (default {DEFAULT_DOOR_WIDTH_M} m); storey height {DEFAULT_STOREY_HEIGHT_M} m")
    title = next((d.title for d in drawings if d.title), "")
    building = {
        "building": {
            "id": building_id,
            "name": name or (title.split(" — ")[0] if title else building_id),
            "source": "plan",
            "license": "",
            "attribution": "",
            "split": "imported",
            "units": "m",
        },
        "floors": floors,
        "spaces": spaces,
        "openings": openings,
        "vertical_connectors": connectors,
        "assets": assets,
        "ingest_report": report,
    }
    infer.label_building(building)
    for space in spaces:
        space["name"] = f"{space['room_type'].replace('_', ' ').capitalize()} {space['ref']}".strip()
    names: Counter = Counter()
    for asset in assets:
        container = next(s for s in spaces if s["id"] == asset["space_id"])
        base = f"{asset['type'].replace('_', ' ').capitalize()} {container['ref'] or container['id'][-4:]}"
        names[base] += 1
        asset["name"] = f"{base}-{chr(64 + names[base])}" if names[base] <= 26 else f"{base}-{names[base]}"
    report["low_confidence_rooms"] = [
        {"id": s["id"], "ref": s["ref"], "guess": s["room_type"], "alternatives": s.get("room_type_alternatives", [])}
        for s in spaces
        if s.get("room_type_confidence", 1.0) < 0.6
    ]
    return building


def _assign_labels(drawing: svg.Drawing, floor_spaces: list[dict], points_per_metre: float) -> None:
    """Labels are centred on each room's representative point: match label centres to representative
    points, closest pairs first, one label per room."""
    anchors = [Polygon(space["polygon"]).representative_point() for space in floor_spaces]
    pairs = []
    for label_index, label in enumerate(drawing.labels):
        half_width = label["width"] / 2 if label.get("width") else LABEL_CHAR_WIDTH_PT * len(label["text"])
        centre = Point((label["x"] + half_width) / points_per_metre, -(label["y"] - LABEL_BASELINE_PT) / points_per_metre)
        for space_index, anchor in enumerate(anchors):
            distance = anchor.distance(centre)
            if distance <= LABEL_MAX_DISTANCE_M:
                pairs.append((distance, label_index, space_index))
    used_labels, used_spaces = set(), set()
    for distance, label_index, space_index in sorted(pairs):
        if label_index in used_labels or space_index in used_spaces:
            continue
        used_labels.add(label_index)
        used_spaces.add(space_index)
        floor_spaces[space_index]["ref"] = drawing.labels[label_index]["text"]
        floor_spaces[space_index]["label_distance_m"] = round(distance, 3)


def _openings(drawing, floor_spaces, points_per_metre, dx, dy, floor_id) -> list[dict]:
    polygons = [Polygon(space["polygon"]) for space in floor_spaces]
    result = []
    for index, marker in enumerate(drawing.markers):
        position = Point(marker["x"] / points_per_metre + dx, -marker["y"] / points_per_metre + dy)
        near = sorted(
            ((polygon.exterior.distance(position), i) for i, polygon in enumerate(polygons)),
        )
        near = [i for distance, i in near if distance <= DOOR_SNAP_M][:2]
        if not near:
            continue
        joined = [floor_spaces[i]["id"] for i in near]
        if len(joined) == 1:
            joined.append("outside")
        kind = marker["kind"]
        if kind == "entrance" and "outside" not in joined:
            kind = "door"
        types = {floor_spaces[i]["type"] for i in near}
        width = max((DOOR_WIDTH_PRIORS.get(t, DEFAULT_DOOR_WIDTH_M) for t in types), default=DEFAULT_DOOR_WIDTH_M)
        result.append(
            {
                "id": f"{floor_id}-O{index:04d}",
                "floor_id": floor_id,
                "space_ids": joined,
                "kind": kind,
                "position": [round(position.x, 3), round(position.y, 3)],
                "width_m": width,
                "step_free": True,
                "synthetic": False,
            }
        )
    return result


def _connectors(
    building_id: str, per_floor_spaces: dict[int, list[dict]], floors: list[dict], core_types: tuple = ("stair", "lift")
) -> list[dict]:
    """Chain stair/lift spaces that overlap on consecutive floors into vertical connectors."""
    levels = sorted(per_floor_spaces)
    chains: list[list[dict]] = []
    open_chains: dict[str, dict] = {}  # space id at the top of a chain -> chain
    for lower, upper in itertools.pairwise(levels):
        for space in per_floor_spaces[upper]:
            if space["type"] not in core_types:
                continue
            polygon = Polygon(space["polygon"])
            best, best_iou = None, 0.3
            for candidate in per_floor_spaces[lower]:
                if candidate["type"] != space["type"]:
                    continue
                other = Polygon(candidate["polygon"])
                union = polygon.union(other).area
                iou = polygon.intersection(other).area / union if union else 0
                if iou > best_iou:
                    best, best_iou = candidate, iou
            if best is None:
                continue
            chain = open_chains.pop(best["id"], None)
            if chain is None:
                chain = {"kind": space["type"], "spaces": [best]}
                chains.append(chain)
            chain["spaces"].append(space)
            open_chains[space["id"]] = chain
    connectors = []
    counters: Counter = Counter()
    for chain in chains:
        kind = "lift" if chain["kind"] == "lift" else "stairs"
        counters[kind] += 1
        connectors.append(
            {
                "id": f"{building_id}-V{len(connectors) + 1:02d}",
                "kind": kind,
                "name": f"{'Lift' if kind == 'lift' else 'Stairs'} {counters[kind]}",
                "floor_ids": [space["floor_id"] for space in chain["spaces"]],
                "space_ids": [space["id"] for space in chain["spaces"]],
                "step_free": kind == "lift",
                "synthetic": False,
            }
        )
    return connectors
