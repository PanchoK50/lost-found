import type { Building, Point, Space } from './types';
import { MinHeap, OUTSIDE, representativePoint } from './graph';

/**
 * Walking model from the challenge partner's route check:
 * - distance is walked inside each space from door to door, about 15 cm off the walls, around corners;
 * - stairs cost 2 m per metre climbed, a lift 15 m plus 1 m per metre of height;
 * - furniture is ignored; a route to an item ends in the space that holds it.
 * Rules: without stairs (lifts, ramps and doors only), forklift (aisles and openings ≥ 3 m, no stairs or lifts),
 * closed elements avoided, production bays are destinations only (never passed through).
 * The scored output is the ordered list of spaces; this module finds, measures and draws such routes.
 */

export const CLEARANCE_M = 0.15;
const FORKLIFT_MIN_WIDTH_M = 3;
/** Factory bays: you may drive into one to deliver, but not through one as a shortcut. */
const BAY_TYPES = new Set(['production_zone', 'assembly_zone', 'additive_zone', 'warehouse_zone', 'logistics_zone']);

export interface WalkRules {
  stepFree?: boolean;
  forklift?: boolean;
  /** Opening, connector or space ids that can't be used. */
  closed?: Iterable<string>;
}

export interface WalkLeg {
  spacePath: string[];
  /** Polyline through the building, floor by floor. */
  points: { floorId: string; position: Point }[];
  length: number;
}

type Node = string; // `${spaceId}|${portal}`: portal is an opening id, '@' (start/end point) or '^' (stair/lift point)
interface Edge { to: Node; cost: number; points: Point[]; via?: string }

// ---------- geometry inside one space ----------

function signedArea(polygon: Point[]) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function inside([x, y]: Point, polygon: Point[]) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function crosses(a: Point, b: Point, c: Point, d: Point) {
  const o = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  const eps = 1e-9;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

const len = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Precomputed per space: outline, inward-offset reflex corners and which corners see each other. */
class Room {
  readonly polygon: Point[];
  readonly corners: Point[];
  private readonly seen: boolean[][];
  private readonly ccw: boolean;

  constructor(polygon: Point[]) {
    const closedRing = polygon.length > 3 && polygon[0][0] === polygon.at(-1)![0] && polygon[0][1] === polygon.at(-1)![1];
    this.polygon = closedRing ? polygon.slice(0, -1) : polygon;
    this.ccw = signedArea(this.polygon) > 0;
    // Shortest paths inside a polygon only bend at reflex corners; keep them 15 cm off both walls.
    this.corners = [];
    const n = this.polygon.length;
    for (let i = 0; i < n; i++) {
      const prev = this.polygon[(i - 1 + n) % n], v = this.polygon[i], next = this.polygon[(i + 1) % n];
      const turn = (v[0] - prev[0]) * (next[1] - v[1]) - (v[1] - prev[1]) * (next[0] - v[0]);
      if (this.ccw ? turn >= 0 : turn <= 0) continue; // convex corner
      const n1 = this.inward(prev, v), n2 = this.inward(v, next);
      const bx = n1[0] + n2[0], by = n1[1] + n2[1], bl = Math.hypot(bx, by) || 1;
      const cos = Math.max(0.25, (bx * n1[0] + by * n1[1]) / bl);
      const p: Point = [v[0] + (bx / bl) * (CLEARANCE_M / cos), v[1] + (by / bl) * (CLEARANCE_M / cos)];
      if (inside(p, this.polygon)) this.corners.push(p);
    }
    this.seen = this.corners.map(a => this.corners.map(b => this.visible(a, b)));
  }

  private inward(p: Point, q: Point): Point {
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
    return this.ccw ? [-dy / l, dx / l] : [dy / l, -dx / l];
  }

  visible(a: Point, b: Point) {
    const n = this.polygon.length;
    for (let i = 0; i < n; i++) if (crosses(a, b, this.polygon[i], this.polygon[(i + 1) % n])) return false;
    return inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], this.polygon);
  }

  /** Where a door at `position` is entered from this side: the closest wall point, moved 15 cm into the room. */
  entry(position: Point): Point {
    let best: Point = position, bestD = Infinity, normal: Point = [0, 0];
    const n = this.polygon.length;
    for (let i = 0; i < n; i++) {
      const p = this.polygon[i], q = this.polygon[(i + 1) % n];
      const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((position[0] - p[0]) * dx + (position[1] - p[1]) * dy) / l2));
      const c: Point = [p[0] + t * dx, p[1] + t * dy];
      const d = len(c, position);
      if (d < bestD) { bestD = d; best = c; normal = this.inward(p, q); }
    }
    const e: Point = [best[0] + normal[0] * CLEARANCE_M, best[1] + normal[1] * CLEARANCE_M];
    return inside(e, this.polygon) ? e : best;
  }

  /** Shortest walk from a to b inside the room, as a polyline. */
  path(a: Point, b: Point): { points: Point[]; length: number } {
    if (this.visible(a, b)) return { points: [a, b], length: len(a, b) };
    const k = this.corners.length;
    const fromA = this.corners.map(c => this.visible(a, c));
    const toB = this.corners.map(c => this.visible(c, b));
    // Dijkstra over corners: index k is b.
    const dist = new Array<number>(k + 1).fill(Infinity), prev = new Array<number>(k + 1).fill(-1), done = new Array<boolean>(k + 1).fill(false);
    for (let i = 0; i < k; i++) if (fromA[i]) dist[i] = len(a, this.corners[i]);
    while (true) {
      let u = -1;
      for (let i = 0; i <= k; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === k) break;
      done[u] = true;
      for (let v = 0; v < k; v++) if (!done[v] && this.seen[u][v] && dist[u] + len(this.corners[u], this.corners[v]) < dist[v]) { dist[v] = dist[u] + len(this.corners[u], this.corners[v]); prev[v] = u; }
      if (toB[u] && dist[u] + len(this.corners[u], b) < dist[k]) { dist[k] = dist[u] + len(this.corners[u], b); prev[k] = u; }
    }
    if (dist[k] === Infinity) return { points: [a, b], length: len(a, b) }; // degenerate outline: fall back to a straight line
    const points: Point[] = [b];
    for (let u = prev[k]; u >= 0; u = prev[u]) points.unshift(this.corners[u]);
    points.unshift(a);
    return { points, length: dist[k] };
  }
}

// ---------- the walk graph ----------

export class WalkGraph {
  private readonly edges = new Map<Node, Edge[]>();
  private readonly spaceOf = new Map<Node, string>();
  private readonly floorOf: Map<string, string>;

  constructor(readonly building: Building, rules: WalkRules = {}) {
    const closed = new Set(rules.closed ?? []);
    const spaces = new Map(building.spaces.filter(s => !closed.has(s.id)).map(s => [s.id, s]));
    this.floorOf = new Map(building.spaces.map(s => [s.id, s.floor_id]));
    const rooms = new Map<string, Room>();
    const room = (s: Space) => { let r = rooms.get(s.id); if (!r) { r = new Room(s.polygon); rooms.set(s.id, r); } return r; };
    const ports = new Map<string, { node: Node; at: Point }[]>(); // per space: its door entries and special points

    const usable = building.openings.filter(o =>
      !closed.has(o.id) && o.space_ids.every(id => id === OUTSIDE || spaces.has(id)) &&
      !(rules.stepFree && !o.step_free) && !(rules.forklift && o.width_m < FORKLIFT_MIN_WIDTH_M));
    // A route may leave through one entrance and come back in through another (the kit's "outside" node).
    // Unlike the kit, walking outside isn't free: it costs the straight line between the two entrances.
    const entrances = usable.filter(o => o.space_ids.includes(OUTSIDE));
    for (const o of entrances) {
      const s = spaces.get(o.space_ids.find(id => id !== OUTSIDE)!)!;
      const e = room(s).entry(o.position);
      const inner = `${s.id}|${o.id}`, outer = `${OUTSIDE}|${o.id}`;
      this.link(inner, outer, 0, [e], o.id);
      this.spaceOf.set(inner, s.id);
      this.spaceOf.set(outer, OUTSIDE);
      ports.set(s.id, [...(ports.get(s.id) ?? []), { node: inner, at: e }]);
    }
    entrances.forEach((a, i) => entrances.slice(i + 1).forEach(b => this.link(`${OUTSIDE}|${a.id}`, `${OUTSIDE}|${b.id}`, len(a.position, b.position), [])));
    for (const o of usable.filter(o => !o.space_ids.includes(OUTSIDE))) {
      const [a, b] = o.space_ids.map(id => spaces.get(id)!);
      const ea = room(a).entry(o.position), eb = room(b).entry(o.position);
      const na = `${a.id}|${o.id}`, nb = `${b.id}|${o.id}`;
      this.link(na, nb, len(ea, eb), [ea, eb], o.id);
      for (const [s, node, at] of [[a, na, ea], [b, nb, eb]] as const) {
        this.spaceOf.set(node, s.id);
        ports.set(s.id, [...(ports.get(s.id) ?? []), { node, at }]);
      }
    }

    // Stairs and lifts: ridden from a point in their space, between consecutive stops.
    const elevation = new Map(building.floors.map(f => [f.id, f.elevation_m]));
    if (!rules.forklift) for (const c of building.vertical_connectors) {
      if (closed.has(c.id) || (rules.stepFree && (!c.step_free || c.kind === 'stairs'))) continue;
      const stops = c.space_ids.map((id, i) => ({ id, z: elevation.get(c.floor_ids[i]) ?? 0 })).filter(s => spaces.has(s.id)).sort((x, y) => x.z - y.z);
      for (let i = 0; i + 1 < stops.length; i++) {
        const climb = Math.abs(stops[i + 1].z - stops[i].z);
        const cost = c.kind === 'lift' ? 15 + climb : 2 * climb;
        const [lo, hi] = [stops[i], stops[i + 1]].map(s => ({ node: `${s.id}|^`, at: representativePoint(spaces.get(s.id)!.polygon), id: s.id }));
        this.link(lo.node, hi.node, cost, [], c.id);
        for (const s of [lo, hi]) if (!this.spaceOf.has(s.node)) { this.spaceOf.set(s.node, s.id); ports.set(s.id, [...(ports.get(s.id) ?? []), { node: s.node, at: s.at }]); }
      }
    }

    // Walking inside each space between its doors (and stair/lift point). Bays: only in or out, never through.
    for (const [id, list] of ports) {
      const s = spaces.get(id)!;
      const bay = s.type === 'hall' && BAY_TYPES.has(s.room_type);
      const r = room(s);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        if (bay) break;
        const walk = r.path(list[i].at, list[j].at);
        this.link(list[i].node, list[j].node, walk.length, walk.points);
      }
      // '@' is where a route starts or ends in this space; it is never passed through (see search()).
      const at = representativePoint(s.polygon);
      const start = `${id}|@`;
      this.spaceOf.set(start, id);
      for (const p of list) { const walk = r.path(at, p.at); this.link(start, p.node, walk.length, walk.points); }
    }
  }

  private link(a: Node, b: Node, cost: number, points: Point[], via?: string) {
    if (!this.edges.has(a)) this.edges.set(a, []);
    if (!this.edges.has(b)) this.edges.set(b, []);
    this.edges.get(a)!.push({ to: b, cost, points, via });
    this.edges.get(b)!.push({ to: a, cost, points: [...points].reverse(), via });
  }

  /**
   * Shortest walk from the start point of one space. `allowed(node, stepIndex)` can restrict the search
   * (used to measure a given space sequence). Start/end points ('@') are never expanded except the source.
   */
  private search(from: string, accept?: (space: string, index: number, next: string) => number | undefined) {
    const source = `${from}|@`;
    const key = (n: Node, i: number) => `${n}#${i}`;
    const dist = new Map<string, number>([[key(source, 0), 0]]);
    const prev = new Map<string, { key: string; edge: Edge }>();
    const queue = new MinHeap();
    queue.push(0, key(source, 0));
    while (queue.size) {
      const [d, k] = queue.pop()!;
      if (d > (dist.get(k) ?? Infinity)) continue;
      const cut = k.lastIndexOf('#');
      const node = k.slice(0, cut), index = Number(k.slice(cut + 1));
      if (node.endsWith('|@') && node !== source) continue;
      for (const edge of this.edges.get(node) ?? []) {
        const space = this.spaceOf.get(node)!, next = this.spaceOf.get(edge.to)!;
        const nextIndex = accept ? accept(space, index, next) : 0;
        if (nextIndex === undefined) continue;
        const nextKey = key(edge.to, nextIndex), nd = d + edge.cost;
        if (nd < (dist.get(nextKey) ?? Infinity)) { dist.set(nextKey, nd); prev.set(nextKey, { key: k, edge }); queue.push(nd, nextKey); }
      }
    }
    return { dist, prev, key };
  }

  private leg(from: string, to: string, found: ReturnType<WalkGraph['search']>, index = 0): WalkLeg | undefined {
    const end = found.key(`${to}|@`, index);
    const length = found.dist.get(end);
    if (length === undefined) return undefined;
    const steps: Edge[] = [];
    for (let k = end; found.prev.has(k); k = found.prev.get(k)!.key) steps.unshift(found.prev.get(k)!.edge);
    const spacePath = [from];
    const points: WalkLeg['points'] = [];
    let current = from;
    for (const edge of steps) {
      const next = this.spaceOf.get(edge.to)!;
      if (edge.points.length) {
        // Door crossings belong to the space entered; walks inside a space to that space.
        const floor = this.floorOf.get(edge.via ? next : current) ?? this.floorOf.get(current)!;
        for (const p of edge.points) points.push({ floorId: floor, position: p });
      }
      if (next !== spacePath.at(-1)) spacePath.push(next);
      current = next;
    }
    return { spacePath, points, length };
  }

  /** Best route between the start points of two spaces, or undefined if the rules allow none. */
  route(from: string, to: string): WalkLeg | undefined {
    if (from === to) return { spacePath: [from], points: [], length: 0 };
    return this.leg(from, to, this.search(from));
  }

  /** Walking distance from one space to every space's start point (for "nearest room with …"). */
  distancesFrom(from: string): Map<string, number> {
    const { dist } = this.search(from);
    const out = new Map<string, number>([[from, 0]]);
    for (const [k, d] of dist) if (k.endsWith('|@#0')) out.set(k.slice(0, -4), d);
    return out;
  }

  /**
   * Measure a given ordered list of spaces the way the route check does. Returns undefined if a step
   * doesn't go through a real door, opening, stair or lift that the rules allow.
   */
  measure(spacePath: string[]): WalkLeg | undefined {
    if (spacePath.length < 2) return spacePath.length ? { spacePath, points: [], length: 0 } : undefined;
    const last = spacePath.length - 1;
    const found = this.search(spacePath[0], (space, index, next) => {
      if (next === spacePath[index]) return index;
      if (index < last && next === spacePath[index + 1]) return index + 1;
      return undefined;
    });
    const leg = this.leg(spacePath[0], spacePath[last], found, last);
    return leg && { ...leg, spacePath };
  }
}
