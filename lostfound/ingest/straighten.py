"""Straighten raster-traced room outlines into a structured plan: straight walls, right angles, and
neighbouring rooms that meet on one shared wall line.

The PNG pipeline traces every room from its pixel region, so a straight wall comes out as a chain of short,
slightly crooked segments. `straighten_floor` rewrites one floor's polygons (metres, y up) in place:

1. Grid angles: a length-weighted histogram of edge angles modulo 90 degrees. The peak is the floor's grid
   (plans may be rotated); secondary peaks cover wings at another angle. Each angle is then refined by a
   least-squares fit of the long walls (a plan rotated by a few degrees traces as exactly horizontal runs).
2. Per polygon, in its grid frame: drop jaggies (edges shorter than SHORT_EDGE_M), classify each edge as
   horizontal, vertical or diagonal, and merge runs of edges into lines. Two parallel lines in a row get a
   perpendicular step; corners are line intersections. Diagonal walls stay diagonal.
3. Per floor: parallel lines of different rooms that overlap along the wall and lie within SNAP_M snap to one
   shared line (rooms facing each other across a gap wider than FACING_GAP_M keep the wall between them);
   the polygons are rebuilt from the snapped lines.
4. Where straightening pushed a room into its neighbour (a noisy trace), the overlap goes back to the room
   whose trace covered it.

All lengths are tuned for plans of about REFERENCE_PIXEL_M per pixel; pass pixel_m for coarser plans.
Every result is validated (valid ring, area change, distance to the trace) and keeps the trace's orientation. A polygon that fails, or whose
outline is mostly not on a grid (curves, irregular shapes), keeps its original geometry.
SVG plans are exact and must not go through this."""

import itertools
import math
from collections import Counter

from shapely.geometry import LinearRing, Polygon
from shapely.strtree import STRtree

SIMPLIFY_M = 0.1             # Douglas-Peucker tolerance on the trace (one to two pixels)
SHORT_EDGE_M = 0.25          # edges shorter than this are jaggies
ANGLE_TOL_DEG = 12.0         # an edge within this of the grid is aligned ...
ALIGN_DRIFT_M = 0.2          # ... if it also drifts less than this across the grid over its length
MERGE_M = 0.15               # parallel aligned edges closer than this are one wall
DIAG_MIN_M = 0.5             # a diagonal shorter than this is a cut corner of the trace, not a wall
BUMP_MAX_M = 1.0             # a shorter slanted edge within ALIGN_DRIFT_M across the grid is the flank of a bump
DIAG_MERGE_DEG = 6.0         # consecutive diagonal edges within this angle are one wall
JOIN_MAX_M = 0.6             # a corner farther than this from the trace is joined by projection instead
SNAP_M = 0.18                # floor-wide: parallel lines closer than this become one shared line ...
SNAP_REACH_M = -0.2          # ... when their extents along the wall overlap by at least 0.2 m
SNAP_GAP_M = 0.10            # a gap wider than this between sorted line values always separates two walls
FACING_GAP_M = 0.06          # facing walls of two rooms further apart than this have a real wall between them
MIN_ALIGNED_FRACTION = 0.5   # less of the outline on the grid than this: keep the original (curves)
MAX_AREA_CHANGE = 0.08       # relative area change allowed ...
MAX_AREA_CHANGE_M2 = 0.25    # ... or this much absolute change (small rooms)
MAX_HAUSDORFF_M = 0.5        # the straightened outline stays this close to the trace
SECONDARY_PEAK = 0.2         # a second grid angle needs this share of the main peak's weight
SECONDARY_SEPARATION_DEG = 6.0
OVERLAP_M2 = 0.01            # straightened neighbours overlapping more than this are separated again
STEP_WEIGHT = 1e-3           # inserted steps follow the walls around them in the snapping
REFERENCE_PIXEL_M = 0.07     # the lengths above are tuned for plans at about this resolution; coarser plans
                             # scale them up with their pixel size (see straighten_floor's pixel_m)
FIT_MIN_M = 1.0              # angle refinement: walls at least this long vote ...
FIT_SEGMENT_TAN = 0.18       # ... with their traced pieces within ~10 degrees of the wall (not the corners)
FIT_SUPPORT_DEG = 0.3        # the correction is taken only if this close to it ...
FIT_MIN_SUPPORT = 0.5        # ... lies at least this share of the voting wall length
FIT_MIN_SHIFT_DEG = 0.3      # smaller corrections are noise
FIT_MIN_TOTAL_M = 20.0       # fewer voting walls than this (a floor of one or two rooms): no correction
MIN_EDGE_M = 0.004           # vertices closer than this (after the overlap repair) are merged


# ---------------------------------------------------------------- geometry helpers

def _rotate(points, angle):
    c, s = math.cos(angle), math.sin(angle)
    return [(x * c - y * s, x * s + y * c) for x, y in points]


def _ring(points):
    """Open ring without repeated closing point or consecutive duplicates."""
    out = []
    for p in points:
        p = (float(p[0]), float(p[1]))
        if not out or math.dist(out[-1], p) > 1e-9:
            out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) <= 1e-9:
        out.pop()
    return out


def _edges(points):
    n = len(points)
    return [(points[i], points[(i + 1) % n]) for i in range(n)]


def _deviation(dx, dy):
    """Angle (deg, 0..180) of an edge, and its deviation from horizontal and from vertical."""
    angle = math.degrees(math.atan2(dy, dx)) % 180.0
    return angle, min(angle, 180.0 - angle), abs(angle - 90.0)


# ---------------------------------------------------------------- grid angles

def grid_angles(polygons: list[list[tuple[float, float]]]) -> list[float]:
    """Grid angles (degrees, 0..90) of a floor, main first: length-weighted histogram of edge angles mod 90."""
    bins = [0.0] * 180  # half-degree bins
    for points in polygons:
        for (x0, y0), (x1, y1) in _edges(points):
            length = math.hypot(x1 - x0, y1 - y0)
            if length < SHORT_EDGE_M:
                continue
            angle = math.degrees(math.atan2(y1 - y0, x1 - x0)) % 90.0
            bins[int(angle * 2) % 180] += length
    if not any(bins):
        return [0.0]
    window = 4  # +-2 degrees, circular
    smooth = [sum(bins[(i + k) % 180] for k in range(-window, window + 1)) for i in range(180)]
    peaks = []
    for i in sorted(range(180), key=lambda i: (-smooth[i], i)):
        if smooth[i] <= 0 or (peaks and smooth[i] < SECONDARY_PEAK * smooth[peaks[0]]):
            break
        if all(_angle_gap(i / 2, j / 2) >= SECONDARY_SEPARATION_DEG for j in peaks):
            peaks.append(i)
        if len(peaks) >= 3:
            break
    return [_refine(polygons, (i + 0.5) / 2) for i in peaks]


def _angle_gap(a, b):
    d = abs(a - b) % 90.0
    return min(d, 90.0 - d)


def _refine(polygons, guess):
    """Length-weighted circular mean (period 90) of edge angles within 3 degrees of the guess."""
    sx = sy = 0.0
    for points in polygons:
        for (x0, y0), (x1, y1) in _edges(points):
            length = math.hypot(x1 - x0, y1 - y0)
            if length < SHORT_EDGE_M:
                continue
            angle = math.degrees(math.atan2(y1 - y0, x1 - x0)) % 90.0
            if _angle_gap(angle, guess) <= 3.0:
                sx += length * math.cos(math.radians(4 * angle))
                sy += length * math.sin(math.radians(4 * angle))
    if sx == sy == 0.0:
        return guess % 90.0
    angle = (math.degrees(math.atan2(sy, sx)) / 4.0) % 90.0
    if _angle_gap(angle, 0.0) < 0.05:
        return 0.0
    return angle


def _fit_angle(rings, angle):
    """Refine a grid angle by fitting the traced walls. A pixel trace of a plan rotated by a few degrees is a
    staircase of runs that are exactly horizontal or vertical, so the edge histogram is pulled towards 0
    degrees. Here every long wall (Douglas-Peucker chord within 4 degrees of the grid) fits its own direction
    by least squares over its traced pieces; the length-weighted median of these corrections is applied when
    enough of the walls agree on it (too few or disagreeing walls: the histogram angle stays)."""
    theta = math.radians(angle)
    votes, total = [], 0.0
    for ring in rings:
        if len(ring) < 3:
            continue
        points = _rotate(ring, -theta)
        keep = _douglas_peucker(points, SIMPLIFY_M)
        n = len(points)
        for t, i in enumerate(keep):
            j = keep[t + 1] if t + 1 < len(keep) else keep[0] + n
            trace = [points[k % n] for k in range(i, j + 1)]
            dx, dy = trace[-1][0] - trace[0][0], trace[-1][1] - trace[0][1]
            length = math.hypot(dx, dy)
            if length < FIT_MIN_M:
                continue
            _, dev_h, dev_v = _deviation(dx, dy)
            if min(dev_h, dev_v) > 4.0:
                continue
            along = 0 if dev_h <= dev_v else 1  # regress the across coordinate on the along coordinate
            sw = sa = sc = saa = sac = 0.0
            for p, q in itertools.pairwise(trace):
                w = abs(q[along] - p[along])
                if w <= 0 or abs(q[1 - along] - p[1 - along]) > FIT_SEGMENT_TAN * w:
                    continue  # jaggies across the wall and the cut corners at its ends
                a, c = (p[along] + q[along]) / 2, (p[1 - along] + q[1 - along]) / 2
                sw, sa, sc, saa, sac = sw + w, sa + w * a, sc + w * c, saa + w * a * a, sac + w * a * c
            if sw <= 0 or saa - sa * sa / sw <= 1e-9:
                continue
            correction = math.degrees(math.atan((sac - sa * sc / sw) / (saa - sa * sa / sw)))
            votes.append((correction if along == 0 else -correction, length))
            total += length
    if total < FIT_MIN_TOTAL_M:
        return angle
    votes.sort()
    running, median = 0.0, votes[-1][0]
    for correction, length in votes:
        running += length
        if running >= total / 2:
            median = correction
            break
    support = sum(length for correction, length in votes if abs(correction - median) <= FIT_SUPPORT_DEG) / total
    if abs(median) < FIT_MIN_SHIFT_DEG or support < FIT_MIN_SUPPORT:
        return angle
    refined = (angle + median) % 90.0
    return 0.0 if _angle_gap(refined, 0.0) < 0.05 else refined


def _aligned_fraction(points, angle_deg):
    rotated = _rotate(points, -math.radians(angle_deg))
    aligned = total = 0.0
    for (x0, y0), (x1, y1) in _edges(rotated):
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        if length < SHORT_EDGE_M:
            continue
        total += length
        _, dev_h, dev_v = _deviation(dx, dy)
        if min(dev_h, dev_v) <= ANGLE_TOL_DEG:
            aligned += length
    return aligned / total if total else 0.0


# ---------------------------------------------------------------- simplification

def _douglas_peucker(points, tolerance):
    """Indices of the vertices of a closed ring kept by Douglas-Peucker."""
    n = len(points)
    if n <= 3:
        return list(range(n))
    far = max(range(n), key=lambda k: math.dist(points[0], points[k]))
    keep = {0, far}
    stack = [(0, far), (far, n)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        a, b = points[i], points[j % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        norm = math.hypot(dx, dy)
        best, best_distance = None, tolerance
        for k in range(i + 1, j):
            p = points[k]
            if norm > 1e-12:
                distance = abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / norm
            else:
                distance = math.dist(p, a)
            if distance > best_distance:
                best, best_distance = k, distance
        if best is not None:
            keep.add(best)
            stack += [(i, best), (best, j)]
    return sorted(keep)


# ---------------------------------------------------------------- lines

class _Edge:
    """A simplified edge p0 -> p1 and the traced points it replaces (p0 ... p1), in the grid frame."""

    __slots__ = ("p0", "p1", "trace", "kind", "length")

    def __init__(self, trace):
        self.trace = trace
        self.p0, self.p1 = trace[0], trace[-1]
        self.kind, self.length = _classify(self.p0, self.p1)
        if self.kind in ("D", "S") and self.length >= SHORT_EDGE_M and (len(trace) > 2 or self.length < BUMP_MAX_M):
            # A chord across the grid may still trace an aligned wall with a small bump or step in it:
            # the traced points stay within a narrow band along one axis. A short slanted edge within that
            # band is the flank of a bump (pixel noise), not a diagonal wall.
            xs, ys = [p[0] for p in trace], [p[1] for p in trace]
            if max(ys) - min(ys) <= ALIGN_DRIFT_M and max(xs) - min(xs) >= SHORT_EDGE_M:
                self.kind = "H"
            elif max(xs) - min(xs) <= ALIGN_DRIFT_M and max(ys) - min(ys) >= SHORT_EDGE_M:
                self.kind = "V"

    def axis_value(self, kind):
        """Coordinate of an aligned edge: mean over the traced pieces, weighted by their length along the
        wall (pieces across the wall, the jaggies, do not count)."""
        axis = 0 if kind == "H" else 1  # H: weight by |dx|, value is y; V: weight by |dy|, value is x
        total = value = 0.0
        for a, b in zip(self.trace, self.trace[1:]):
            weight = abs(b[axis] - a[axis])
            total += weight
            value += weight * (a[1 - axis] + b[1 - axis]) / 2
        if total <= 1e-12:
            return (self.p0[1 - axis] + self.p1[1 - axis]) / 2
        return value / total

    def angle(self):
        return math.atan2(self.p1[1] - self.p0[1], self.p1[0] - self.p0[0])

    def samples(self):
        return [(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), math.dist(a, b)) for a, b in zip(self.trace, self.trace[1:])]


class _Line:
    """A wall line in the grid frame: n . p = d, with n = (0, 1) for 'H', (1, 0) for 'V', any unit for 'D'."""

    __slots__ = ("kind", "nx", "ny", "d", "weight", "sum", "chords", "samples", "ends", "side", "heading")

    def __init__(self, kind, nx=0.0, ny=0.0, d=0.0, weight=0.0):
        self.kind, self.nx, self.ny, self.d, self.weight = kind, nx, ny, d, weight
        self.sum = d * weight
        self.chords, self.samples = [], []  # diagonals: (angle, length) of the edges, (midpoint, length) of the trace
        self.ends = []  # end points of the traced edges on this line (its extent along the wall)
        self.side = 0  # +1 / -1: the room lies on the +n / -n side of the line; 0 for inserted steps
        self.heading = (0.0, 0.0)  # direction of the first traced edge

    @classmethod
    def axis(cls, kind, value, weight):
        return cls(kind, *((0.0, 1.0) if kind == "H" else (1.0, 0.0)), value, weight)

    @classmethod
    def of(cls, edge):
        if edge.kind in ("H", "V"):
            line = cls.axis(edge.kind, edge.axis_value(edge.kind), edge.length)
        else:
            line = cls("D")
            line.add_diagonal(edge)
        line.ends = [edge.p0, edge.p1]
        line.heading = (edge.p1[0] - edge.p0[0], edge.p1[1] - edge.p0[1])
        return line

    def extent(self, ux, uy):
        values = [x * ux + y * uy for x, y in self.ends]
        return min(values), max(values)

    def add(self, edge):
        self.ends += [edge.p0, edge.p1]
        if self.kind == "D":
            self.add_diagonal(edge)
            return
        self.sum += edge.axis_value(self.kind) * edge.length
        self.weight += edge.length
        self.d = self.sum / self.weight

    def add_diagonal(self, edge):
        self.chords.append((edge.angle(), edge.length))
        self.samples += edge.samples()
        # direction: length-weighted mean of the doubled chord angles; offset: weighted mean over the trace
        cx = sum(math.cos(2 * a) * w for a, w in self.chords)
        cy = sum(math.sin(2 * a) * w for a, w in self.chords)
        direction = math.atan2(cy, cx) / 2
        self.nx, self.ny = -math.sin(direction), math.cos(direction)
        self.weight = sum(w for _, w in self.chords)
        total = sum(w for _, w in self.samples)
        self.d = sum((m[0] * self.nx + m[1] * self.ny) * w for m, w in self.samples) / total

    def distance(self, p):
        return abs(p[0] * self.nx + p[1] * self.ny - self.d)

    def project(self, p):
        t = p[0] * self.nx + p[1] * self.ny - self.d
        return (p[0] - t * self.nx, p[1] - t * self.ny)


def _direction_deg(line):
    return math.degrees(math.atan2(line.nx, -line.ny)) % 180.0


def _classify(p0, p1):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < SHORT_EDGE_M:
        return "S", length
    _, dev_h, dev_v = _deviation(dx, dy)
    if dev_h <= ANGLE_TOL_DEG and length * math.sin(math.radians(dev_h)) <= ALIGN_DRIFT_M:
        return "H", length
    if dev_v <= ANGLE_TOL_DEG and length * math.sin(math.radians(dev_v)) <= ALIGN_DRIFT_M:
        return "V", length
    return ("D" if length >= DIAG_MIN_M else "S"), length


def _can_merge(line, edge):
    if line.kind != edge.kind:
        return False
    if edge.kind in ("H", "V"):
        return abs(edge.axis_value(edge.kind) - line.d) <= MERGE_M
    gap = abs(math.degrees(edge.angle()) % 180.0 - _direction_deg(line)) % 180.0
    mid = ((edge.p0[0] + edge.p1[0]) / 2, (edge.p0[1] + edge.p1[1]) / 2)
    return min(gap, 180.0 - gap) <= DIAG_MERGE_DEG and line.distance(mid) <= MERGE_M


def _lines(points):
    """Wall lines of a traced ring (grid frame) and the junction points between consecutive lines, or None."""
    keep = _douglas_peucker(points, SIMPLIFY_M)
    n = len(points)
    edges = [_Edge([points[k % n] for k in range(i, (keep[(t + 1) % len(keep)] if t + 1 < len(keep) else keep[0] + n) + 1)])
             for t, i in enumerate(keep)]
    m = len(edges)
    # Rotate so that a jaggy chain does not wrap around the end of the list.
    start = next((k for k in range(m) if edges[k].kind != "S" and edges[k - 1].kind != "S"), None)
    if start is None:
        start = next((k + 1 for k in range(m) if edges[k].kind != "S"), None)
        if start is None:
            return None
    edges = edges[start % m:] + edges[:start % m]
    # Collapse each straight chain of jaggies into one edge; keep corners and small features as jaggies.
    merged, i = [], 0
    while i < m:
        if edges[i].kind != "S":
            merged.append(edges[i])
            i += 1
            continue
        j = i
        while j < m and edges[j].kind == "S":
            j += 1
        chain = _Edge([p for e in edges[i:j] for p in e.trace[:-1]] + [edges[j - 1].p1])
        if chain.kind != "S":
            chord = _Line("D")
            chord.add_diagonal(_Edge([chain.p0, chain.p1]))
            if all(chord.distance(e.p1) <= SIMPLIFY_M for e in edges[i:j - 1]):
                merged.append(chain)
                i = j
                continue
        merged += edges[i:j]
        i = j
    long_edges = [e for e in merged if e.kind != "S"]
    if len(long_edges) < 3:
        return None
    # Start at a long edge that cannot continue the previous long edge's line.
    first = next((k for k, e in enumerate(long_edges) if not _can_merge(_Line.of(long_edges[k - 1]), e)), None)
    if first is None:
        return None
    first = merged.index(long_edges[first])
    merged = merged[first:] + merged[:first]
    lines, junctions = [], []
    current, last_end = None, None
    for edge in merged:
        if edge.kind == "S":
            continue
        if current is not None and _can_merge(current, edge):
            current.add(edge)
        else:
            if current is not None:
                lines.append(current)
                junctions.append(((last_end[0] + edge.p0[0]) / 2, (last_end[1] + edge.p0[1]) / 2))
            current = _Line.of(edge)
        last_end = edge.p1
    lines.append(current)
    p0 = merged[0].p0
    junctions.append(((last_end[0] + p0[0]) / 2, (last_end[1] + p0[1]) / 2))
    if len(lines) < 3:
        return None
    # Parallel axis lines in a row (a step in the wall): insert the perpendicular step.
    out_lines, out_junctions = [], []
    for k, line in enumerate(lines):
        nxt, junction = lines[(k + 1) % len(lines)], junctions[k]
        out_lines.append(line)
        if line.kind == nxt.kind and line.kind in ("H", "V"):
            step_kind = "V" if line.kind == "H" else "H"
            step = _Line.axis(step_kind, junction[0] if step_kind == "V" else junction[1], STEP_WEIGHT)
            step.ends = [junction]
            out_lines.append(step)
            out_junctions += [junction, junction]
        else:
            out_junctions.append(junction)
    # Which side of each line the room is on: left of the walking direction on a counter-clockwise ring.
    area2 = sum(a[0] * b[1] - b[0] * a[1] for a, b in _edges(points))
    for line in out_lines:
        if line.weight > STEP_WEIGHT:
            hx, hy = line.heading
            inside = (-hy, hx) if area2 > 0 else (hy, -hx)
            line.side = 1 if inside[0] * line.nx + inside[1] * line.ny > 0 else -1
    return out_lines, out_junctions


def _corner(a, b, junction):
    """Vertices joining line a to line b near the junction."""
    det = a.nx * b.ny - a.ny * b.nx
    if abs(det) > math.sin(math.radians(5)):
        x = (a.d * b.ny - a.ny * b.d) / det
        y = (a.nx * b.d - a.d * b.nx) / det
        if math.dist((x, y), junction) <= JOIN_MAX_M:
            return [(x, y)]
    pa, pb = a.project(junction), b.project(junction)
    return [pa] if math.dist(pa, pb) < 1e-6 else [pa, pb]


def _build(lines, junctions, values):
    vertices = []
    for k, line in enumerate(lines):
        nxt = lines[(k + 1) % len(lines)]
        vertices += _corner(_snapped(line, values), _snapped(nxt, values), junctions[k])
    return _clean(vertices)


def _snapped(line, values):
    value = values.get(id(line))
    return line if value is None else _Line(line.kind, *value)


def _clean(vertices):
    """Drop duplicate vertices and collinear (or spike) vertices until stable."""
    points = _ring(vertices)
    changed = True
    while changed and len(points) >= 3:
        changed = False
        for i in range(len(points)):
            a, b, c = points[i - 1], points[i], points[(i + 1) % len(points)]
            if math.dist(a, b) < 1e-4:
                del points[i]
                changed = True
                break
            cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
            scale = max(math.dist(a, b) * math.dist(b, c), 1e-12)
            if abs(cross) / scale < 1e-6:
                del points[i]
                changed = True
                break
    return points


def _rounded(points):
    """Millimetre coordinates (as written to building.json), without the duplicates rounding can make."""
    out = []
    for x, y in points:
        p = [round(x, 3), round(y, 3)]
        if not out or p != out[-1]:
            out.append(p)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def _acceptable(original: Polygon, points) -> str | None:
    """None if the straightened ring is acceptable, else the reason it is not."""
    if len(points) < 3:
        return "too_few_vertices"
    polygon = Polygon(points)
    if not polygon.is_valid or polygon.area <= 0:
        return "invalid"
    change = abs(polygon.area - original.area)
    if change > MAX_AREA_CHANGE * original.area and change > MAX_AREA_CHANGE_M2:
        return "area_change"
    if LinearRing(points).hausdorff_distance(original.exterior) > MAX_HAUSDORFF_M:
        return "hausdorff"
    return None


# ---------------------------------------------------------------- floor-wide snapping

def _cluster(items):
    """items: (value, weight, lo, hi, side, key) of parallel lines (value across the wall, lo..hi along it,
    side of the room). Lines join when their extents along the wall overlap and their values are close:
    - same side (rooms in a row): within SNAP_M;
    - facing each other with a gap between them (a wall): within FACING_GAP_M, else the wall stays;
    - facing and overlapping (the rooms interpenetrate): within SNAP_M.
    A joined group wider than SNAP_M is split at its largest gap. Returns {key: shared value}."""
    items = sorted(items)
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, (value, _, lo, hi, side, _) in enumerate(items):
        for j in range(i + 1, len(items)):
            other = items[j]
            gap = other[0] - value
            if gap > SNAP_M:
                break
            if not (other[2] <= hi + SNAP_REACH_M and lo <= other[3] + SNAP_REACH_M):
                continue
            # i below j: i's room below (side -1) and j's room above (side +1) leaves a gap between them
            if side == -1 and other[4] == 1 and gap > FACING_GAP_M:
                continue
            parent[find(j)] = find(i)
    components: dict[int, list] = {}
    for i, item in enumerate(items):
        components.setdefault(find(i), []).append(item)
    result = {}
    stack = list(components.values())
    while stack:
        group = stack.pop()
        if len(group) > 1:
            gaps = [group[k + 1][0] - group[k][0] for k in range(len(group) - 1)]
            cut = max(range(len(gaps)), key=lambda k: gaps[k])
            if group[-1][0] - group[0][0] > SNAP_M or gaps[cut] > SNAP_GAP_M:
                stack += [group[:cut + 1], group[cut + 1:]]
                continue
        weight = sum(item[1] for item in group)
        value = sum(item[0] * item[1] for item in group) / weight if weight > 0 else group[0][0]
        for item in group:
            result[item[5]] = value
    return result


def _snap_weight(line):
    """Every wall line counts once, so a shared wall lands midway between the two rooms' traces (a long
    corridor wall does not drag a small room's wall); inserted steps only follow."""
    return STEP_WEIGHT if line.weight <= STEP_WEIGHT else 1.0


def _snap(all_lines):
    """Snap the lines of one grid frame to shared wall lines. Returns {id(line): (nx, ny, d)}."""
    values = {}
    for kind, normal, along in (("H", (0.0, 1.0), (1.0, 0.0)), ("V", (1.0, 0.0), (0.0, 1.0))):
        items = [(line.d, _snap_weight(line), *line.extent(*along), line.side, id(line)) for line in all_lines if line.kind == kind]
        for key, value in _cluster(items).items():
            values[key] = (*normal, value)
    diagonals = sorted((line for line in all_lines if line.kind == "D"), key=_direction_deg)
    # Diagonals: group by direction (within DIAG_MERGE_DEG / 2), then snap offsets along the common normal.
    groups = []
    for line in diagonals:
        angle = _direction_deg(line)
        if groups and abs(angle - groups[-1][0]) <= DIAG_MERGE_DEG / 2:
            groups[-1][1].append(line)
        else:
            groups.append((angle, [line]))
    if len(groups) > 1 and (groups[0][0] + 180.0 - groups[-1][0]) <= DIAG_MERGE_DEG / 2:
        groups[0][1].extend(groups.pop()[1])
    for _, members in groups:
        cx = sum(math.cos(2 * math.atan2(l.ny, l.nx)) * l.weight for l in members)
        cy = sum(math.sin(2 * math.atan2(l.ny, l.nx)) * l.weight for l in members)
        theta = math.atan2(cy, cx) / 2
        nx, ny = math.cos(theta), math.sin(theta)
        items, signs = [], {}
        for line in members:
            signs[id(line)] = 1.0 if line.nx * nx + line.ny * ny >= 0 else -1.0
            foot = (line.nx * line.d, line.ny * line.d)
            items.append((foot[0] * nx + foot[1] * ny, _snap_weight(line), *line.extent(ny, -nx), line.side * signs[id(line)], id(line)))
        for key, value in _cluster(items).items():
            sign = signs[key]
            values[key] = (sign * nx, sign * ny, sign * value)
    return values


# ---------------------------------------------------------------- overlaps

def _resolve_overlaps(spaces, originals, changed) -> int:
    """Straightening each room on its own can push it into a neighbour where the traced wall was not a clean
    line. The traces themselves do not overlap, so an overlap goes to the room whose trace covers more of it
    and is cut from the other one (if the cut room stays acceptable)."""
    polygons = [Polygon(space["polygon"]) if len(_ring(space["polygon"])) >= 3 else Polygon() for space in spaces]
    tree = STRtree(polygons)
    resolved = 0
    for i in sorted(changed):
        for j in sorted(int(k) for k in tree.query(polygons[i])):
            if j == i or (j in changed and j < i) or originals[j] is None or originals[i] is None:
                continue
            a, b = polygons[i], polygons[j]
            if not a.is_valid or not b.is_valid:
                continue
            overlap = a.intersection(b)
            if overlap.area <= OVERLAP_M2:
                continue
            keep_i = originals[i].intersection(overlap).area >= originals[j].intersection(overlap).area
            loser = j if keep_i else i
            cut = polygons[loser].difference(overlap)
            if cut.geom_type == "MultiPolygon":
                cut = max(cut.geoms, key=lambda g: g.area)
            if cut.geom_type != "Polygon" or cut.is_empty:
                continue
            points = _rounded(_clean(_ring(cut.exterior.coords)))
            if _acceptable(originals[loser], points) is not None or Polygon(points).intersection(polygons[i if loser == j else j]).area > OVERLAP_M2:
                continue
            spaces[loser]["polygon"] = points
            polygons[loser] = Polygon(points)
            resolved += 1
    return resolved


# ---------------------------------------------------------------- entry point

def straighten_floor(spaces: list[dict], pixel_m: float | None = None) -> dict:
    """Straighten the polygons of one floor in place (metres, y up, open rings). Returns a report.

    pixel_m is the size of one pixel of the traced plan in metres (1 / points_per_metre of a raster drawing).
    The lengths at the top of this module are tuned for plans of about REFERENCE_PIXEL_M per pixel; a coarser
    plan is straightened at its own scale (every length grows with the pixel), else the pixel staircase of
    its trace would count as walls. Finer plans and pixel_m=None use the lengths as they are."""
    before = [[list(p) for p in space["polygon"]] for space in spaces]
    factor = max(1.0, pixel_m / REFERENCE_PIXEL_M) if pixel_m else 1.0
    if factor == 1.0:
        report = _straighten(spaces)
    else:
        scaled = [{"polygon": [[x / factor, y / factor] for x, y in polygon]} for polygon in before]
        unchanged = [[list(p) for p in space["polygon"]] for space in scaled]
        report = _straighten(scaled)
        for space, new, old in zip(spaces, scaled, unchanged):
            if new["polygon"] != old:
                space["polygon"] = _rounded([(x * factor, y * factor) for x, y in new["polygon"]])
    report["pixel_m"] = round(pixel_m, 4) if pixel_m else None
    report["length_scale"] = round(factor, 3)
    reverted = Counter()
    for space, old in zip(spaces, before):
        if space["polygon"] == old:
            continue
        tidy = _tidy(space["polygon"], old)
        if tidy is None:
            space["polygon"] = old
            reverted["rounding"] += 1
        else:
            space["polygon"] = tidy
    if reverted:
        report["changed"] -= sum(reverted.values())
        report["kept"] += sum(reverted.values())
        for reason, count in reverted.items():
            report["kept_reasons"][reason] = report["kept_reasons"].get(reason, 0) + count
    report["vertices_after"] = sum(len(space["polygon"]) for space in spaces)
    return report


def _tidy(points, original):
    """Final form of a straightened ring: no vertices closer than MIN_EDGE_M (the overlap repair and the
    millimetre rounding can leave them; shifting the floor later could collapse them), the original's
    orientation, still valid. None if it cannot be made valid."""
    points = _rounded(_clean(_ring(points)))
    merged = True
    while merged and len(points) > 3:
        merged = False
        for i in range(len(points)):
            if math.dist(points[i - 1], points[i]) < MIN_EDGE_M:
                del points[i]
                merged = True
                break
    points = _rounded(_clean(points))
    if len(points) < 3:
        return None
    polygon = Polygon(points)
    if not polygon.is_valid or polygon.area <= 0:
        return None
    ring = _ring(original)
    if len(ring) >= 3 and LinearRing(points).is_ccw != LinearRing(ring).is_ccw:
        points = points[::-1]
    return points


def _straighten(spaces: list[dict]) -> dict:
    rings = [_ring(space["polygon"]) for space in spaces]
    originals = [Polygon(ring).buffer(0) if len(ring) >= 3 else None for ring in rings]
    originals = [p if p is not None and p.geom_type == "Polygon" and not p.is_empty else None for p in originals]
    pre = []
    for original in originals:
        if original is None:
            pre.append(None)
            continue
        simple = original.simplify(SIMPLIFY_M, preserve_topology=True)
        pre.append(_ring(simple.exterior.coords) if simple.geom_type == "Polygon" else None)
    # Grid angles from the trace itself where it has long edges (simplification slants walls slightly).
    long_weight = sum(math.dist(a, b) for r in rings for a, b in _edges(r) if math.dist(a, b) >= SHORT_EDGE_M)
    perimeter = sum(math.dist(a, b) for r in rings for a, b in _edges(r))
    angles = []
    for angle in grid_angles(rings if long_weight >= 0.3 * perimeter else [p for p in pre if p]):
        angle = _fit_angle(rings, angle)
        if all(_angle_gap(angle, other) >= SECONDARY_SEPARATION_DEG for other in angles):
            angles.append(angle)
    report = {
        "angle_deg": round(angles[0], 2),
        "grid_angles_deg": [round(a, 2) for a in angles],
        "polygons": len(spaces),
        "changed": 0,
        "kept": 0,
        "kept_reasons": Counter(),
        "snap_reverted": 0,
        "vertices_before": sum(len(r) for r in rings),
        "vertices_after": 0,
    }

    # Per polygon: lines in the grid frame that fits it best.
    plans = {}  # index -> (angle, lines, junctions, straightened points in grid frame)
    for index, points in enumerate(pre):
        if not points:
            report["kept_reasons"]["degenerate"] += 1
            continue
        fractions = [_aligned_fraction(points, a) for a in angles]
        best = 0 if fractions[0] >= 0.9 * max(fractions) else max(range(len(angles)), key=lambda k: fractions[k])
        if fractions[best] < MIN_ALIGNED_FRACTION:
            report["kept_reasons"]["irregular"] += 1
            continue
        angle = angles[best]
        theta = math.radians(angle)
        built = _lines(_rotate(rings[index], -theta))
        if built is None:
            report["kept_reasons"]["too_few_lines"] += 1
            continue
        lines, junctions = built
        local = _build(lines, junctions, {})
        reason = _acceptable(originals[index], _rotate(local, theta))
        if reason:
            report["kept_reasons"][reason] += 1
            continue
        plans[index] = (best, lines, junctions, local)

    # Per floor and grid frame: snap the lines of all polygons, rebuild, re-validate.
    for frame in range(len(angles)):
        members = [index for index, plan in plans.items() if plan[0] == frame]
        values = _snap([line for index in members for line in plans[index][1]])
        theta = math.radians(angles[frame])
        for index in members:
            _, lines, junctions, local = plans[index]
            snapped = _rounded(_rotate(_build(lines, junctions, values), theta))
            if _acceptable(originals[index], snapped) is None:
                spaces[index]["polygon"] = snapped
            else:
                unsnapped = _rounded(_rotate(local, theta))  # snapping broke it: the unsnapped straight version
                if _acceptable(originals[index], unsnapped) is not None:
                    report["kept_reasons"]["rounding"] += 1
                    continue
                spaces[index]["polygon"] = unsnapped
                report["snap_reverted"] += 1
            report["changed"] += 1
    report["overlaps_resolved"] = _resolve_overlaps(spaces, originals, changed={i for i in plans})
    report["kept"] = len(spaces) - report["changed"]
    report["vertices_after"] = sum(len(space["polygon"]) for space in spaces)
    report["kept_reasons"] = dict(report["kept_reasons"])
    return report
