"""Assemble a building.json from per-floor drawings: metric frame, floor registration, labels, openings and
vertical connectors. Facts the drawing does not contain (room types, door widths, elevations) get explicit
priors and are listed in `ingest_report` so the agent can confirm them with the user."""

import itertools
import math
import statistics
from collections import Counter
from pathlib import Path

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from lostfound.ingest import scale as scale_module
from lostfound.ingest import svg

LABEL_CHAR_WIDTH_PT = 1.7  # labels are centred on the room; the SVG anchor is the text start
LABEL_BASELINE_PT = 1.6
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


def assemble(directory: Path, building_id: str | None = None, name: str | None = None) -> dict:
    building_id = building_id or directory.name
    drawings = sorted((svg.parse(path) for path in directory.glob("floor_*.svg") if "_plain" not in path.name), key=lambda d: d.level)
    if not drawings:
        raise FileNotFoundError(f"No floor_<level>.svg in {directory}")
    report: dict = {"scales": {}, "registration": {}, "assumptions": []}

    estimates = {d.level: scale_module.estimate(d.assets) for d in drawings}
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
        report["scales"][drawing.level] = {"points_per_metre": round(points_per_metre, 4), "confidence": round(confidence, 2)}
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
    for space in spaces:
        if not space["name"]:
            space["name"] = f"{space['room_type'].replace('_', ' ').capitalize()} {space['ref']}".strip()
    report["assumptions"].append("room types of plain rooms are unknown until labelled (generic_room)")
    report["assumptions"].append(f"door widths from priors (default {DEFAULT_DOOR_WIDTH_M} m); storey height {DEFAULT_STOREY_HEIGHT_M} m")
    title = next((d.title for d in drawings if d.title), "")
    return {
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


def _assign_labels(drawing: svg.Drawing, floor_spaces: list[dict], points_per_metre: float) -> None:
    polygons = [Polygon(space["polygon"]) for space in floor_spaces]
    taken: set[int] = set()
    for label in drawing.labels:
        centre_pt = (label["x"] + LABEL_CHAR_WIDTH_PT * len(label["text"]), label["y"] - LABEL_BASELINE_PT)
        centre = Point(centre_pt[0] / points_per_metre, -centre_pt[1] / points_per_metre)
        inside = [i for i, polygon in enumerate(polygons) if polygon.contains(centre) and i not in taken]
        if not inside:
            free = [i for i in range(len(polygons)) if i not in taken]
            if not free:
                continue
            inside = [min(free, key=lambda i: polygons[i].distance(centre))]
        index = min(inside, key=lambda i: polygons[i].area)
        taken.add(index)
        floor_spaces[index]["ref"] = label["text"]


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


def _connectors(building_id: str, per_floor_spaces: dict[int, list[dict]], floors: list[dict]) -> list[dict]:
    """Chain stair/lift spaces that overlap on consecutive floors into vertical connectors."""
    levels = sorted(per_floor_spaces)
    chains: list[list[dict]] = []
    open_chains: dict[str, dict] = {}  # space id at the top of a chain -> chain
    for lower, upper in itertools.pairwise(levels):
        for space in per_floor_spaces[upper]:
            if space["type"] not in ("stair", "lift"):
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
