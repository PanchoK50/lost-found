import type { Building, Floor, Point } from './types';

/** Shoelace area in m². */
export function polygonArea(polygon: Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Area-weighted centroid; falls back to the vertex mean for degenerate polygons. */
export function polygonCentroid(polygon: Point[]): Point {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-9) return [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon([x, y]: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bounds(points: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Usable storey height: the gap to the next floor up, or the floor's own height for the top floor. */
export function storeyHeights(building: Building): Map<string, number> {
  const sorted = [...building.floors].sort((a, b) => a.elevation_m - b.elevation_m);
  return new Map(sorted.map((floor: Floor, i) => {
    const next = sorted[i + 1];
    const gap = next ? next.elevation_m - floor.elevation_m : floor.height_m;
    return [floor.id, Math.max(2.5, Math.min(floor.height_m, gap || floor.height_m))];
  }));
}

function closestOnSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): Point {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return [ax + t * dx, ay + t * dy];
}

function closestOnOutline(point: Point, polygon: Point[]): { point: Point; distance: number } {
  let best: Point = polygon[0], distance = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const c = closestOnSegment(point, polygon[i], polygon[(i + 1) % polygon.length]);
    const d = Math.hypot(c[0] - point[0], c[1] - point[1]);
    if (d < distance) { distance = d; best = c; }
  }
  return { point: best, distance };
}

/**
 * How much of `a`'s outline runs within `tolerance` of `b`'s outline (walls have thickness),
 * plus the middle of the longest such run. Sampled every ~5 cm.
 */
export function sharedWall(a: Point[], b: Point[], tolerance = 0.35) {
  const ba = bounds(a), bb = bounds(b);
  if (ba.minX > bb.maxX + tolerance || bb.minX > ba.maxX + tolerance || ba.minY > bb.maxY + tolerance || bb.minY > ba.maxY + tolerance) return { length: 0, middle: undefined };
  let length = 0;
  const runs: { length: number; points: Point[] }[] = [];
  let run: { length: number; points: Point[] } | undefined;
  let startsAtFirstSample = false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    const edge = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const pieces = Math.max(1, Math.ceil(edge / 0.05));
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces;
      const sample: Point = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
      const near = closestOnOutline(sample, b).distance <= tolerance;
      if (i === 0 && k === 0) startsAtFirstSample = near;
      if (near) {
        length += edge / pieces;
        if (!run) { run = { length: 0, points: [] }; runs.push(run); }
        run.length += edge / pieces;
        run.points.push(sample);
      } else run = undefined;
    }
  }
  // The outline is a loop: a run still open at the end continues into a run that started at the first sample.
  if (runs.length > 1 && run && startsAtFirstSample) {
    const first = runs.shift()!;
    run.length += first.length;
    run.points.push(...first.points);
  }
  const longest = runs.sort((x, y) => y.length - x.length)[0];
  let middle: Point | undefined;
  if (longest) {
    const onA = longest.points[Math.floor(longest.points.length / 2)];
    const onB = closestOnOutline(onA, b).point;
    middle = [(onA[0] + onB[0]) / 2, (onA[1] + onB[1]) / 2];
  }
  return { length, middle };
}
