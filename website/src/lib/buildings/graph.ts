import type { Building, Opening, Point } from './types';

/**
 * TypeScript port of the challenge kit's route model (starter_agent/building_map.py, README section 3):
 * one node per space at shapely's representative point, one node per opening, entrances meet at "outside",
 * stairs 12 m per floor and lifts 15 m + 6 m per floor between consecutive stops.
 */
export const OUTSIDE = 'outside';
const DOOR = 'door:';

export interface GraphOptions {
  stepFree?: boolean;
  /** Skip openings narrower than this (wide loads). */
  minWidth?: number;
  /** Opening, connector or space ids that can't be used. */
  closed?: Iterable<string>;
  /** Hypothetical openings, e.g. a what-if door. */
  extraOpenings?: Opening[];
}

type Edge = { to: string; cost: number; via: string };
export type Graph = Map<string, Edge[]>;

/** Port of GEOS InteriorPointArea (what shapely's representative_point uses) for simple polygons. */
export function representativePoint(polygon: Point[]): Point {
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of polygon) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const centre = (minY + maxY) / 2;
  let lo = minY, hi = maxY;
  for (const [, y] of polygon) {
    if (y <= centre) { if (y > lo) lo = y; } else if (y < hi) hi = y;
  }
  const scanY = (lo + hi) / 2;
  const xs: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    if (y1 === y2 || scanY < Math.min(y1, y2) || scanY > Math.max(y1, y2)) continue;
    xs.push(x1 + ((scanY - y1) * (x2 - x1)) / (y2 - y1));
  }
  xs.sort((a, b) => a - b);
  let best: Point = polygon[0], width = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > width) { width = xs[i + 1] - xs[i]; best = [(xs[i] + xs[i + 1]) / 2, scanY]; }
  }
  return best;
}

export function buildGraph(building: Building, options: GraphOptions = {}): Graph {
  const closed = new Set(options.closed ?? []);
  const graph: Graph = new Map();
  const add = (a: string, b: string, cost: number, via: string) => {
    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    graph.get(a)!.push({ to: b, cost, via });
    graph.get(b)!.push({ to: a, cost, via });
  };
  const anchors = new Map<string, Point>();
  for (const space of building.spaces) if (!closed.has(space.id)) anchors.set(space.id, representativePoint(space.polygon));
  for (const opening of [...building.openings, ...(options.extraOpenings ?? [])]) {
    if (closed.has(opening.id) || (options.stepFree && !opening.step_free) || (options.minWidth && opening.width_m < options.minWidth)) continue;
    const door = DOOR + opening.id;
    for (const spaceId of opening.space_ids) {
      if (spaceId === OUTSIDE) add(OUTSIDE, door, 0, opening.id);
      else if (anchors.has(spaceId)) add(spaceId, door, dist(anchors.get(spaceId)!, opening.position), opening.id);
    }
  }
  const levels = new Map(building.floors.map(floor => [floor.id, floor.level]));
  for (const connector of building.vertical_connectors) {
    if (closed.has(connector.id) || (options.stepFree && !connector.step_free)) continue;
    const stops = connector.floor_ids.map((floorId, i) => ({ level: levels.get(floorId) ?? 0, spaceId: connector.space_ids[i] })).sort((a, b) => a.level - b.level);
    for (let i = 0; i + 1 < stops.length; i++) {
      const [low, high] = [stops[i], stops[i + 1]];
      if (!anchors.has(low.spaceId) || !anchors.has(high.spaceId)) continue;
      const span = Math.abs(high.level - low.level);
      add(low.spaceId, high.spaceId, connector.kind === 'lift' ? 15 + 6 * span : 12 * span, connector.id);
    }
  }
  return graph;
}

/** Dijkstra from one or more sources; returns distances and the predecessor of each node. */
export function shortestPaths(graph: Graph, sources: string[]) {
  const dist = new Map<string, number>(sources.map(s => [s, 0]));
  const prev = new Map<string, { node: string; via: string }>();
  const heap = new MinHeap();
  sources.forEach(s => heap.push(0, s));
  while (heap.size) {
    const [d, node] = heap.pop()!;
    if (d > (dist.get(node) ?? Infinity)) continue;
    for (const edge of graph.get(node) ?? []) {
      const next = d + edge.cost;
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next);
        prev.set(edge.to, { node, via: edge.via });
        heap.push(next, edge.to);
      }
    }
  }
  return { dist, prev };
}

/** Node path from a source to `target` (spaces and door nodes), or undefined if unreachable. */
export function pathTo(prev: Map<string, { node: string; via: string }>, sources: string[], target: string) {
  const path = [target];
  let node = target;
  while (!sources.includes(node)) {
    const step = prev.get(node);
    if (!step) return undefined;
    node = step.node;
    path.unshift(node);
  }
  return path;
}

export const isDoorNode = (node: string) => node.startsWith(DOOR);
export const doorOf = (node: string) => node.slice(DOOR.length);

function dist(a: Point, b: Point) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

class MinHeap {
  private items: [number, string][] = [];
  get size() { return this.items.length; }
  push(priority: number, value: string) {
    const items = this.items;
    items.push([priority, value]);
    for (let i = items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < items.length && items[l][0] < items[m][0]) m = l;
        if (r < items.length && items[r][0] < items[m][0]) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}
