"""Shapely-derived facts about a building's polygons, cached per building.

Benchmark geometry (README section 3, kit 1.1.0): routing anchors are shapely
representative_point() of the repaired polygon, walking inside a space goes door
to door 15 cm off the walls round corners (a visibility graph over the shrunken
outline), a door lands 30 cm inside each space, room centres are centroids,
shared walls are outline stretches of at least SHARED_WALL_MIN_LENGTH_M running
within WALL_PROXIMITY_M of the neighbour's outline, stacking is maximum polygon
overlap on the adjacent floor, and 3D distances join centroids with elevations.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass

import numpy as np
import shapely
from shapely.geometry import Point, Polygon
from shapely.ops import linemerge, nearest_points

from core.model import DOOR_PREFIX, Building, Opening

SHARED_WALL_MIN_LENGTH_M = 1.0
WALL_PROXIMITY_M = 0.35

# Walking inside a space (kit 1.1.0 ruleset, mirrors starter_agent/building_map.py).
WALL_CLEARANCE_M = 0.15
DOOR_LANDING_M = 0.30
NARROW_LANDING_M = 0.05
COVER_TOLERANCE_M = 0.02
BLOCKED_DETOUR_FACTOR = 1.5  # used when no clear walk exists between two points of a space


@dataclass(frozen=True, slots=True)
class SharedWall:
    space_a: str
    space_b: str
    length_m: float
    midpoint: tuple[float, float]


Point2 = tuple[float, float]


def door_landing(polygon: Polygon, position: Point2) -> Point2:
    """Where a door at `position` lands inside the space: 30 cm in from the walls."""
    inner = polygon.buffer(-DOOR_LANDING_M)
    if inner.is_empty:
        inner = polygon.buffer(-NARROW_LANDING_M)
    if inner.is_empty:
        point = polygon.representative_point()
        return (point.x, point.y)
    if inner.contains(Point(position)):
        return (position[0], position[1])
    landing = nearest_points(inner, Point(position))[0]
    return (landing.x, landing.y)


def visibility_matrix(allowed: Polygon, nodes: list[Point2]) -> np.ndarray:
    """Straight-line lengths between nodes that see each other inside `allowed`, infinite where blocked."""
    coordinates = np.asarray(nodes, dtype=float)
    straight = np.hypot(*(coordinates[:, None, :] - coordinates[None, :, :]).transpose(2, 0, 1))
    first, second = np.triu_indices(len(nodes), k=1)
    shapely.prepare(allowed)
    clear = shapely.covers(
        allowed, shapely.linestrings(np.stack([coordinates[first], coordinates[second]], axis=1))
    )
    usable = clear | (straight[first, second] == 0)
    matrix = np.full(straight.shape, np.inf)
    np.fill_diagonal(matrix, 0.0)
    matrix[first[usable], second[usable]] = straight[first, second][usable]
    matrix[second[usable], first[usable]] = straight[first, second][usable]
    return matrix


def shortest_lengths(matrix: np.ndarray) -> np.ndarray:
    """All-pairs shortest path lengths (Floyd-Warshall)."""
    for middle in range(len(matrix)):
        matrix = np.minimum(matrix, matrix[:, middle, None] + matrix[None, middle, :])
    return matrix


def walking_lengths(polygon: Polygon, points: list[Point2]) -> dict[tuple[int, int], float]:
    """Shortest walks between points inside a space, 15 cm off the walls and round its corners: a
    visibility graph over the points and the corners of the walkable area."""
    walkable = polygon.buffer(-WALL_CLEARANCE_M)
    if walkable.is_empty or walkable.geom_type != "Polygon":
        walkable = polygon
    allowed = walkable.buffer(COVER_TOLERANCE_M)
    corners = [
        corner for ring in [walkable.exterior, *walkable.interiors] for corner in list(ring.coords)[:-1]
    ]
    walks = shortest_lengths(visibility_matrix(allowed, list(points) + corners))
    lengths = {}
    for source in range(len(points)):
        for target in range(len(points)):
            walk = float(walks[source, target])
            fallback = math.dist(points[source], points[target]) * BLOCKED_DETOUR_FACTOR
            lengths[(source, target)] = walk if math.isfinite(walk) else fallback
    return lengths


class Geometry:
    """Lazy per-building cache for every polygon-derived value."""

    def __init__(self, building: Building) -> None:
        self._building = building
        self._polygons: dict[str, Polygon] = {}
        self._anchors: dict[str, tuple[float, float]] = {}
        self._centroids: dict[str, tuple[float, float]] = {}
        self._min_widths: dict[str, float] = {}
        self._shared_walls: dict[str, dict[frozenset[str], SharedWall]] = {}
        self._space_walks: dict[tuple[str, tuple[str, ...]], list[tuple[str, str, float]]] = {}

    # ---------- single-space geometry ----------

    def polygon(self, space_id: str) -> Polygon:
        polygon = self._polygons.get(space_id)
        if polygon is None:
            polygon = Polygon(self._building.spaces[space_id].polygon)
            if not polygon.is_valid:
                polygon = polygon.buffer(0)
            self._polygons[space_id] = polygon
        return polygon

    def area_m2(self, space_id: str) -> float:
        return self.polygon(space_id).area

    def centroid(self, space_id: str) -> tuple[float, float]:
        point = self._centroids.get(space_id)
        if point is None:
            centre = self.polygon(space_id).centroid
            point = (centre.x, centre.y)
            self._centroids[space_id] = point
        return point

    def anchor(self, space_id: str) -> tuple[float, float]:
        """Routing anchor: shapely representative_point(), as in the reference model."""
        point = self._anchors.get(space_id)
        if point is None:
            representative = self.polygon(space_id).representative_point()
            point = (representative.x, representative.y)
            self._anchors[space_id] = point
        return point

    def min_width_m(self, space_id: str) -> float:
        """Smallest side of the minimum rotated rectangle around the polygon.

        A proxy for the narrowest passage: exact for rectangular aisles and
        corridors (the dataset's aisles are 12+ m, office corridors exactly
        2.0 m), an upper bound for L-shaped rooms.
        """
        width = self._min_widths.get(space_id)
        if width is None:
            rotated = self.polygon(space_id).minimum_rotated_rectangle
            corners = list(rotated.exterior.coords)
            sides = [math.dist(corners[i], corners[i + 1]) for i in range(len(corners) - 1)]
            width = min(sides) if sides else math.inf
            self._min_widths[space_id] = width
        return width

    def distance_3d(self, space_a: str, space_b: str) -> float:
        (ax, ay), (bx, by) = self.centroid(space_a), self.centroid(space_b)
        elevation_a = self._building.floors[self._building.spaces[space_a].floor_id].elevation_m
        elevation_b = self._building.floors[self._building.spaces[space_b].floor_id].elevation_m
        return math.dist((ax, ay, elevation_a), (bx, by, elevation_b))

    # ---------- walking inside a space ----------

    def space_walks(
        self, space_id: str, extra_openings: tuple[Opening, ...] = ()
    ) -> list[tuple[str, str, float]]:
        """Walking lengths between the space's centre point and each of its doors, and between its doors.

        Nodes are the space id (its centre point) and one "door:<opening id>" per opening, including
        entrances and hypothetical doors. Cached per (space, set of extra opening ids), so what-if
        doors recompute only the two spaces they join.
        """
        extras = tuple(sorted(o.id for o in extra_openings if space_id in o.space_ids))
        key = (space_id, extras)
        cached = self._space_walks.get(key)
        if cached is not None:
            return cached
        polygon = self.polygon(space_id)
        members: list[tuple[str, Point2, float]] = [(space_id, self.anchor(space_id), 0.0)]
        openings = [
            opening
            for opening in self._building.openings.values()
            if space_id in opening.space_ids
        ] + [opening for opening in extra_openings if space_id in opening.space_ids]
        for opening in openings:
            position = opening.position
            landing = door_landing(polygon, position)
            members.append((DOOR_PREFIX + opening.id, landing, math.dist(landing, position)))
        lengths = walking_lengths(polygon, [landing for _, landing, _ in members])
        walks = [
            (
                members[first][0],
                members[second][0],
                lengths[(first, second)] + members[first][2] + members[second][2],
            )
            for first, second in itertools.combinations(range(len(members)), 2)
        ]
        self._space_walks[key] = walks
        return walks

    # ---------- stacking ----------

    def space_above(self, space_id: str) -> str | None:
        return self._stacked_neighbour(space_id, +1)

    def space_below(self, space_id: str) -> str | None:
        return self._stacked_neighbour(space_id, -1)

    def _stacked_neighbour(self, space_id: str, level_step: int) -> str | None:
        floor_id = self._building.spaces[space_id].floor_id
        level = self._building.level(floor_id) + level_step
        neighbour_floor = self._building.floor_at_level(level)
        if neighbour_floor is None:
            return None
        polygon = self.polygon(space_id)
        best_id: str | None = None
        best_overlap = 0.0
        for candidate_id in self._building.spaces_by_floor[neighbour_floor.id]:
            overlap = polygon.intersection(self.polygon(candidate_id)).area
            if overlap > best_overlap:
                best_overlap = overlap
                best_id = candidate_id
        return best_id if best_overlap > 0 else None

    # ---------- wall adjacency ----------

    def shared_walls(self, floor_id: str) -> dict[frozenset[str], SharedWall]:
        """All wall-sharing space pairs on one floor, keyed by frozenset({a, b}).

        Two spaces share a wall when at least SHARED_WALL_MIN_LENGTH_M of one
        outline runs within WALL_PROXIMITY_M of the other outline (walls have
        thickness). The midpoint is the middle of the longest shared stretch —
        the position where a what-if door is placed.
        """
        walls = self._shared_walls.get(floor_id)
        if walls is not None:
            return walls
        walls = {}
        space_ids = self._building.spaces_by_floor[floor_id]
        polygons = {space_id: self.polygon(space_id) for space_id in space_ids}
        envelopes = {space_id: polygon.bounds for space_id, polygon in polygons.items()}
        for index, space_a in enumerate(space_ids):
            bounds_a = envelopes[space_a]
            for space_b in space_ids[index + 1 :]:
                bounds_b = envelopes[space_b]
                # Cheap prefilter: bounding boxes farther apart than the proximity cannot touch.
                if (
                    bounds_a[0] - bounds_b[2] > WALL_PROXIMITY_M
                    or bounds_b[0] - bounds_a[2] > WALL_PROXIMITY_M
                    or bounds_a[1] - bounds_b[3] > WALL_PROXIMITY_M
                    or bounds_b[1] - bounds_a[3] > WALL_PROXIMITY_M
                ):
                    continue
                wall = self._wall_between(space_a, space_b, polygons[space_a], polygons[space_b])
                if wall is not None:
                    walls[frozenset((space_a, space_b))] = wall
        self._shared_walls[floor_id] = walls
        return walls

    def wall_between(self, space_a: str, space_b: str) -> SharedWall | None:
        floor_a = self._building.spaces[space_a].floor_id
        floor_b = self._building.spaces[space_b].floor_id
        if floor_a != floor_b:
            return None
        return self.shared_walls(floor_a).get(frozenset((space_a, space_b)))

    def _wall_between(
        self, space_a: str, space_b: str, polygon_a: Polygon, polygon_b: Polygon
    ) -> SharedWall | None:
        stretch_a = polygon_a.exterior.intersection(polygon_b.exterior.buffer(WALL_PROXIMITY_M))
        stretch_b = polygon_b.exterior.intersection(polygon_a.exterior.buffer(WALL_PROXIMITY_M))
        best: LineString | None = None
        length = 0.0
        for stretch in (stretch_a, stretch_b):
            if stretch.is_empty:
                continue
            candidates = [stretch] if stretch.geom_type == "LineString" else list(stretch.geoms)
            for line in candidates:
                if line.geom_type != "LineString" or line.length > length:
                    if line.geom_type == "LineString":
                        best = line
                        length = line.length
        if best is None or length < SHARED_WALL_MIN_LENGTH_M:
            return None
        merged = linemerge(best) if best.geom_type != "LineString" else best
        middle = merged.interpolate(0.5, normalized=True)
        return SharedWall(
            space_a=space_a,
            space_b=space_b,
            length_m=length,
            midpoint=(middle.x, middle.y),
        )
