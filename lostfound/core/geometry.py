"""Plan geometry: areas, centroids, stacking between floors and shared walls (definitions from the README)."""

import math

from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import linemerge

from lostfound.core.building import WALL_NEIGHBOUR_TYPES, Building, MapError

WALL_THICKNESS_M = 0.35
MIN_SHARED_WALL_M = 1.0


def area(building: Building, space_id: str) -> float:
    return building.polygon(space_id).area


def centroid_3d(building: Building, space_id: str) -> tuple[float, float, float]:
    centroid = building.polygon(space_id).centroid
    elevation = building.floors[building.spaces[space_id]["floor_id"]]["elevation_m"]
    return (centroid.x, centroid.y, elevation)


def distance_3d(building: Building, first: str, second: str) -> float:
    return math.dist(centroid_3d(building, first), centroid_3d(building, second))


def stacked(building: Building, space_id: str, direction: str) -> tuple[str, float]:
    """The space on the next floor up/down whose outline covers most of this room's outline.

    Returns (space_id, overlap share of this room's area)."""
    step = {"above": 1, "below": -1}[direction]
    level = building.space_level(space_id) + step
    floor = building.floor_by_level(level)
    outline = building.polygon(space_id)
    best, best_overlap = None, 0.0
    for other in building.spaces_by_floor[floor["id"]]:
        overlap = building.polygon(other["id"]).intersection(outline).area
        if overlap > best_overlap:
            best, best_overlap = other["id"], overlap
    if best is None:
        raise MapError(f"Nothing on level {level} overlaps {building.label(space_id)}.")
    return best, best_overlap / outline.area


def shared_wall_length(building: Building, first: str, second: str) -> float:
    """Length of first's outline that runs within the wall thickness of second's outline."""
    near_second = building.polygon(second).exterior.buffer(WALL_THICKNESS_M)
    return building.polygon(first).exterior.intersection(near_second).length


def shared_walls(building: Building, space_id: str) -> list[tuple[str, float]]:
    """Rooms and halls on the same floor sharing at least 1 m of wall (corridors, stairs, lifts, outdoor excluded)."""
    floor_id = building.spaces[space_id]["floor_id"]
    outline = building.polygon(space_id)
    neighbours = []
    for other in building.spaces_by_floor[floor_id]:
        if other["id"] == space_id or other["type"] not in WALL_NEIGHBOUR_TYPES:
            continue
        if building.polygon(other["id"]).distance(outline) > WALL_THICKNESS_M:
            continue
        length = shared_wall_length(building, space_id, other["id"])
        if length >= MIN_SHARED_WALL_M:
            neighbours.append((other["id"], length))
    return neighbours


def shared_wall_midpoint(building: Building, first: str, second: str) -> Point:
    """Middle of the (longest stretch of) wall the two spaces share: where a what-if door goes."""
    near_second = building.polygon(second).exterior.buffer(WALL_THICKNESS_M)
    shared = building.polygon(first).exterior.intersection(near_second)
    lines = [geometry for geometry in getattr(shared, "geoms", [shared]) if isinstance(geometry, LineString)]
    if not lines or sum(line.length for line in lines) == 0:
        raise MapError(f"{building.label(first)} and {building.label(second)} do not share a wall.")
    merged = linemerge(MultiLineString(lines)) if len(lines) > 1 else lines[0]
    if merged.geom_type == "MultiLineString":
        merged = max(merged.geoms, key=lambda line: line.length)
    return merged.interpolate(0.5, normalized=True)
