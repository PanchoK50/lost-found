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
