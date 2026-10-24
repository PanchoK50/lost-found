import type { Asset, Building, Point, Space } from '@/lib/buildings/types';
import { representativePoint } from '@/lib/buildings/graph';
import { storeyHeights } from '@/lib/buildings/geometry';

/** A door cut into one wall: from/to are fractions along the edge (docs/GEOGUESSR.md §2). */
export interface DoorGap { from: number; to: number; width: number; entrance: boolean }

/** The room outline without a repeated closing point, plus the door gaps on each of its edges. */
export function wallsWithDoors(building: Building, space: Space): { ring: Point[]; gaps: DoorGap[][] } {
  const p = space.polygon;
  const closed = p.length > 3 && p[0][0] === p.at(-1)![0] && p[0][1] === p.at(-1)![1];
  const ring = closed ? p.slice(0, -1) : p;
  const gaps = ring.map((): DoorGap[] => []);
  for (const o of building.openings) {
    if (!o.space_ids.includes(space.id)) continue;
    // Each door sits on the wall nearest to its position.
    let best = 0, bestT = 0, bestD = Infinity;
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((o.position[0] - a[0]) * dx + (o.position[1] - a[1]) * dy) / l2));
      const d = Math.hypot(a[0] + t * dx - o.position[0], a[1] + t * dy - o.position[1]);
      if (d < bestD) { bestD = d; best = i; bestT = t; }
    });
    const a = ring[best], b = ring[(best + 1) % ring.length];
    const width = Math.max(0.8, o.width_m);
    const half = width / 2 / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
    gaps[best].push({ from: Math.max(0, bestT - half), to: Math.min(1, bestT + half), width, entrance: o.kind === 'entrance' });
  }
  for (const list of gaps) list.sort((x, y) => x.from - y.from);
  return { ring, gaps };
}

// ---------- the room view (Street View for one room) ----------

export const EYE_HEIGHT_M = 1.6;
const DOOR_HEIGHT_M = 2.1;

/** A vertical wall piece in plan coordinates (metres, y up), from `bottom` to `top` metres above the floor. */
export interface WallPiece { a: Point; b: Point; bottom: number; top: number }
/** Brighter floor seen through a door: a patch just outside the gap. */
export interface Threshold { a: Point; b: Point; outward: Point; entrance: boolean }
export interface RoomBox { position: Point; width: number; depth: number; height: number; rotation: number; color: string; sign?: string }

export interface RoomView {
  eye: Point;
  height: number;
  floorColor: string;
  polygon: Point[];
  walls: WallPiece[];
  thresholds: Threshold[];
  boxes: RoomBox[];
}

/** Recognisable things get an emoji sign over them so the view is playable without text. */
const SIGNS: Record<string, string> = {
  coffee_machine: '☕', printer: '🖨️', robot_cell: '🤖', fire_extinguisher: '🧯', sofa: '🛋️', bathtub: '🛁',
  atm: '🏧', fume_hood: '🧪', vending_machine: '🍫', forklift: '🏗️',
  toilet: '🚽', sink: '🚰', fridge: '🧊', stove: '🍳', server_rack: '🗄️', projector: '📽️', whiteboard: '📋', plant: '🪴',
};

const FLOOR_COLORS: [RegExp, string][] = [
  [/kitchen|canteen|cafeteria/, '#f3e6d3'],
  [/toilet|bath|shower|wash/, '#dcebef'],
  [/server|it_|technical|electrical/, '#dfe2ea'],
  [/meeting|conference|seminar|lecture/, '#e9e2f2'],
  [/office|work/, '#e3ebf6'],
  [/production|assembly|warehouse|logistics|additive|workshop/, '#d9dcdf'],
  [/lab/, '#e2f0e6'],
  [/lobby|foyer|reception/, '#efe9df'],
];

function floorColor(roomType: string) {
  return FLOOR_COLORS.find(([pattern]) => pattern.test(roomType))?.[1] ?? '#eceef1';
}

/** Height and colour by what a thing is: tables 0.75 m, cabinets 2 m, machines 1.8 m, small things 0.4 m. */
function boxLook(asset: Asset): { height: number; color: string } {
  const t = asset.type;
  if (/cabinet|shelf|locker|rack|wardrobe|bookcase|cupboard|fridge|vending/.test(t)) return { height: 2, color: '#b7a58a' };
  if (asset.category === 'machine') return { height: 1.8, color: '#6f7f95' };
  if (/table|desk|bench|counter|station|lectern/.test(t)) return { height: 0.75, color: '#c9b392' };
  if (/chair|seat|sofa|stool/.test(t)) return { height: 0.9, color: '#8fa3bd' };
  if (/toilet|sink|dryer|extinguisher|plant|bin/.test(t)) return { height: 0.6, color: '#e3e6ea' };
  if (asset.category === 'equipment') return { height: 1.1, color: '#9aaabd' };
  return { height: 0.4, color: '#c4cad3' };
}

export function roomView(building: Building, space: Space): RoomView {
  const { ring, gaps } = wallsWithDoors(building, space);
  const height = storeyHeights(building).get(space.floor_id) ?? 3;
  const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const ccw = signedArea(ring) > 0;
  const walls: WallPiece[] = [];
  const thresholds: Threshold[] = [];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // Outward normal: right of the edge for a counter-clockwise ring.
    const outward: Point = ccw ? [(b[1] - a[1]) / len, -(b[0] - a[0]) / len] : [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    let t = 0;
    for (const g of gaps[i]) {
      if (g.from > t) walls.push({ a: lerp(a, b, t), b: lerp(a, b, g.from), bottom: 0, top: height });
      // The lintel above the door.
      if (height > DOOR_HEIGHT_M) walls.push({ a: lerp(a, b, g.from), b: lerp(a, b, g.to), bottom: DOOR_HEIGHT_M, top: height });
      thresholds.push({ a: lerp(a, b, g.from), b: lerp(a, b, g.to), outward, entrance: g.entrance });
      t = Math.max(t, g.to);
    }
    if (t < 1) walls.push({ a: lerp(a, b, t), b, bottom: 0, top: height });
  });
  const boxes = building.assets.filter(a => a.space_id === space.id).map((asset): RoomBox => {
    const look = boxLook(asset);
    return {
      position: asset.position,
      width: asset.footprint?.width_m ?? 0.6,
      depth: asset.footprint?.depth_m ?? 0.6,
      rotation: ((asset.footprint?.rotation_deg ?? 0) * Math.PI) / 180,
      height: Math.min(look.height, height - 0.2),
      color: look.color,
      sign: SIGNS[asset.type],
    };
  });
  return { eye: representativePoint(ring), height, floorColor: floorColor(space.room_type), polygon: ring, walls, thresholds, boxes };
}

function signedArea(polygon: Point[]) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}
