import * as THREE from 'three';
import type { Asset, AssetCategory, Building, Opening, Point, Space } from './types';

/** Plan (x, y) in metres → world (x, -y) on the XZ plane, so north stays "up" when viewed from above. */
export function toWorld([x, y]: Point, center: Point): [number, number] {
  return [x - center[0], -(y - center[1])];
}

export function polygonArea(polygon: Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function polygonPerimeter(polygon: Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    sum += Math.hypot(x2 - x1, y2 - y1);
  }
  return sum;
}

/** Area-weighted centroid; falls back to the vertex mean for degenerate polygons. */
export function polygonCentroid(polygon: Point[]): Point {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    return [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function planBounds(building: Building) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const space of building.spaces) for (const [x, y] of space.polygon) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
  return { center: [(minX + maxX) / 2, (minY + maxY) / 2] as Point, width: maxX - minX, depth: maxY - minY };
}

// ---------- styling ----------

const ROOM_GROUPS: [string, string[]][] = [
  ['#f6c37a', ['stairwell']],
  ['#7fb3ec', ['lift']],
  ['#e8ebe1', ['corridor', 'lobby', 'hall']],
  ['#dce7f5', ['office', 'meeting_room', 'seminar_room', 'lecture_hall', 'library', 'reception']],
  ['#e7dcf3', ['lab', 'quality_lab', 'makerspace', 'server_room', 'technical_room', 'print_room']],
  ['#fadcc0', ['production_zone', 'assembly_zone', 'warehouse_zone', 'logistics_zone', 'additive_zone']],
  ['#f4ead7', ['bedroom', 'living_room', 'kitchen', 'dining_room']],
  ['#d3ecee', ['bathroom', 'toilet', 'locker_room', 'shower']],
  ['#f5e3cf', ['canteen']],
  ['#dcedc9', ['balcony', 'terrace', 'garden']],
  ['#ebe5dc', ['storage']],
];
const ROOM_COLOR = new Map(ROOM_GROUPS.flatMap(([color, types]) => types.map(type => [type, color] as const)));

export const ROOM_LEGEND: { label: string; color: string }[] = [
  { label: 'Circulation', color: '#e8ebe1' },
  { label: 'Stairs', color: '#f6c37a' },
  { label: 'Lift', color: '#7fb3ec' },
  { label: 'Office & teaching', color: '#dce7f5' },
  { label: 'Labs & technical', color: '#e7dcf3' },
  { label: 'Production & logistics', color: '#fadcc0' },
  { label: 'Living', color: '#f4ead7' },
  { label: 'Sanitary', color: '#d3ecee' },
  { label: 'Outdoor', color: '#dcedc9' },
  { label: 'Other', color: '#f7f7f2' },
];

export function roomColor(space: Space): string {
  if (space.type === 'stair') return '#f6c37a';
  if (space.type === 'lift') return '#7fb3ec';
  return ROOM_COLOR.get(space.room_type) ?? (space.type === 'corridor' || space.type === 'hall' ? '#e8ebe1' : space.type === 'outdoor' ? '#dcedc9' : '#f7f7f2');
}

export const ASSET_COLORS: Record<AssetCategory, string> = {
  furniture: '#b9a58c',
  fixture: '#7fb2b5',
  equipment: '#6576d6',
  machine: '#e2713a',
};

const ASSET_HEIGHTS: Record<string, number> = {
  desk: 0.75, office_chair: 0.9, chair: 0.85, dining_chair: 0.85, table: 0.75, meeting_table: 0.75, dining_table: 0.75,
  seminar_table: 0.75, reading_table: 0.75, canteen_table: 0.75, lab_bench: 0.9, workbench: 0.9, coffee_table: 0.45,
  bed: 0.5, single_bed: 0.5, nightstand: 0.55, sofa: 0.8, armchair: 0.8, wardrobe: 2.0, shelf: 1.9, bookshelf: 2.0,
  filing_cabinet: 1.3, tool_cabinet: 1.6, chemical_cabinet: 1.9, fume_hood: 2.2, paper_shelf: 1.8, shoe_cabinet: 1.0,
  kitchen_counter: 0.9, stove: 0.9, fridge: 1.8, dishwasher: 0.85, washing_machine: 0.85, sink: 0.9, toilet: 0.45,
  bathtub: 0.55, shower: 2.0, plant: 1.1, whiteboard: 1.9, projector_screen: 2.2, display_screen: 1.6, lectern: 1.15,
  lecture_seating_row: 0.9, vending_machine: 1.85, coffee_machine: 1.3, water_dispenser: 1.3, fire_extinguisher: 0.6,
  defibrillator: 1.4, multifunction_printer: 1.2, printer: 1.1, '3d_printer': 1.5, laser_cutter: 1.1, reception_desk: 1.1,
  serving_counter: 1.0, coat_rack: 1.8, tv_stand: 0.5, bench: 0.45, outdoor_chair: 0.85, outdoor_table: 0.75,
  pallet_rack: 4.0, high_bay_rack: 6.0, rack: 2.5, forklift: 2.2, conveyor: 1.0,
};

// ---------- floor materials ----------

/** Floor materials with generated textures in public/art/textures/<name>.jpg, and how many metres one tile covers. */
export const FLOOR_MATERIALS = [
  { name: 'plain', size: 1 },
  { name: 'epoxy', size: 6 },
  { name: 'carpet', size: 2 },
  { name: 'parquet', size: 1.6 },
  { name: 'tiles', size: 1.2 },
  { name: 'terrazzo', size: 2.5 },
  { name: 'vinyl', size: 3 },
  { name: 'concrete', size: 4 },
  { name: 'decking', size: 0.9 },
] as const;
export type FloorMaterialName = (typeof FLOOR_MATERIALS)[number]['name'];

const MATERIAL_ROOMS: [FloorMaterialName, string[]][] = [
  ['epoxy', ['production_zone', 'assembly_zone', 'warehouse_zone', 'logistics_zone', 'additive_zone']],
  ['carpet', ['office', 'meeting_room', 'seminar_room', 'lecture_hall', 'library', 'reception']],
  ['parquet', ['bedroom', 'living_room', 'dining_room']],
  ['tiles', ['bathroom', 'toilet', 'shower', 'locker_room', 'kitchen']],
  ['terrazzo', ['corridor', 'lobby', 'hall', 'canteen', 'stairwell']],
  ['vinyl', ['lab', 'quality_lab', 'makerspace', 'server_room', 'technical_room', 'print_room']],
  ['concrete', ['storage', 'lift']],
  ['decking', ['balcony', 'terrace', 'garden']],
];
const MATERIAL_BY_ROOM = new Map(MATERIAL_ROOMS.flatMap(([material, rooms]) => rooms.map(room => [room, material] as const)));

function floorMaterialIndex(space: Space): number {
  const name = MATERIAL_BY_ROOM.get(space.room_type)
    ?? (space.type === 'corridor' || space.type === 'hall' || space.type === 'stair' ? 'terrazzo' : space.type === 'outdoor' ? 'decking' : space.type === 'lift' ? 'concrete' : 'plain');
  return FLOOR_MATERIALS.findIndex(material => material.name === name);
}

export function assetHeight(asset: Asset): number {
  return ASSET_HEIGHTS[asset.type] ?? (asset.category === 'machine' ? 1.8 : asset.category === 'equipment' ? 1.2 : asset.category === 'fixture' ? 1.0 : 0.8);
}

/** Height above the floor of an asset's base: wall-mounted things hang on the wall, projectors hang from the ceiling. */
const WALL_MOUNT_HEIGHTS: Record<string, number> = { hand_dryer: 1.0, defibrillator: 1.1, electrical_panel: 0.5, projector_screen: 0.7 };
export function assetElevation(asset: Asset, floorHeight: number, height: number): number {
  if (asset.type === 'projector') return Math.max(floorHeight - 0.35 - height, 0);
  return WALL_MOUNT_HEIGHTS[asset.type] ?? 0;
}

export function humanize(value: string): string {
  const text = value.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------- floor geometry ----------

const SLAB_THICKNESS = 0.14;
const WHITE = new THREE.Color('#ffffff');
/** Walls are built at unit height; this is the nominal height in metres used for their texture mapping. */
const WALL_UV_HEIGHT = 2.5;
const WALL_THICKNESS = 0.1;
const OUTDOOR_WALL_FACTOR = 0.35;

/** `color` is the accessibility color (step-free / step / entrance), shown only when that layer is on. */
export interface DoorMarker { id: string; x: number; z: number; angle: number; width: number; color: string }

export interface FloorGeometry {
  slab: THREE.BufferGeometry;
  /** Triangle index → index into `spaces`. */
  triangleSpace: Int32Array;
  spaces: Space[];
  /** Walls built at unit height; scale the mesh in Y to set wall height. */
  walls: THREE.BufferGeometry;
  doors: DoorMarker[];
}

class Builder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  uvs: number[] = [];

  triangle(a: number[], b: number[], c: number[], color?: THREE.Color) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const v of [a, b, c]) {
      this.positions.push(v[0], v[1], v[2]);
      this.uvs.push(v[0], v[2]); // metres; textures set their own repeat
      this.normals.push(n[0] / len, n[1] / len, n[2] / len);
      if (color) this.colors.push(color.r, color.g, color.b);
    }
  }

  /** Quad a-b-c-d, wound so that its normal points along `outward`. */
  quad(a: number[], b: number[], c: number[], d: number[], outward: number[], color?: THREE.Color) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) [b, d] = [d, b];
    this.triangle(a, b, c, color);
    this.triangle(a, c, d, color);
  }

  /** `wallUv`: map vertical faces by (distance along the wall, height) instead of plan (x, z). */
  build(withColors: boolean, wallUv = false) {
    if (wallUv) {
      for (let i = 0; i < this.positions.length / 3; i++) {
        const [x, y, z] = this.positions.slice(i * 3, i * 3 + 3);
        const [nx, ny, nz] = this.normals.slice(i * 3, i * 3 + 3);
        const [u, v] = Math.abs(ny) > 0.5 ? [x, z] : Math.abs(nx) > Math.abs(nz) ? [z, y * WALL_UV_HEIGHT] : [x, y * WALL_UV_HEIGHT];
        this.uvs[i * 2] = u;
        this.uvs[i * 2 + 1] = v;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    if (withColors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }
}

function cleanRing(polygon: Point[]): Point[] {
  const ring = polygon.filter((p, i) => {
    const prev = polygon[(i + polygon.length - 1) % polygon.length];
    return Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-4;
  });
  return ring.length >= 3 ? ring : [];
}

/** Solid wall intervals along an edge of length `length`, after cutting out door gaps. */
function solidIntervals(length: number, gaps: [number, number][]): [number, number][] {
  const sorted = gaps.map(([s, e]) => [Math.max(0, s), Math.min(length, e)] as [number, number]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  let cursor = 0;
  for (const [s, e] of sorted) {
    if (s > cursor) result.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < length) result.push([cursor, length]);
  return result.filter(([s, e]) => e - s > 0.04);
}

export function buildFloorGeometry(spaces: Space[], openings: Opening[], center: Point): FloorGeometry {
  const slab = new Builder();
  const walls = new Builder();
  const triangleSpace: number[] = [];
  const color = new THREE.Color();
  const sideColor = new THREE.Color();

  const openingsBySpace = new Map<string, Opening[]>();
  for (const opening of openings) for (const id of opening.space_ids) {
    if (!openingsBySpace.has(id)) openingsBySpace.set(id, []);
    openingsBySpace.get(id)!.push(opening);
  }
  const seenEdges = new Set<string>();
  const doorAngle = new Map<string, number>();
  const key = (p: Point) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

  // Spaces are emitted grouped by floor material so the slab can use one draw group per texture.
  const order = spaces.map((space, index) => ({ index, material: floorMaterialIndex(space) })).sort((a, b) => a.material - b.material);
  const groups: { start: number; count: number; material: number }[] = [];
  order.forEach(({ index: spaceIndex, material }) => {
    const space = spaces[spaceIndex];
    const groupStart = slab.positions.length / 3;
    const ring = cleanRing(space.polygon);
    if (!ring.length) return;
    const world = ring.map(p => toWorld(p, center));
    color.set(roomColor(space));
    // Textured floors only need a hint of the room color; the texture carries the material.
    if (material !== 0) color.lerp(WHITE, 0.6);
    color.convertSRGBToLinear();
    sideColor.copy(color).multiplyScalar(0.82);

    // Top surface.
    const triangles = THREE.ShapeUtils.triangulateShape(world.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const [i, j, k] of triangles) {
      const a = [world[i][0], 0, world[i][1]], b = [world[j][0], 0, world[j][1]], c = [world[k][0], 0, world[k][1]];
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      if (ny >= 0) slab.triangle(a, b, c, color); else slab.triangle(a, c, b, color);
      triangleSpace.push(spaceIndex);
    }
    // Slab edge, so floors read as solid plates.
    const [cx, cz] = toWorld(polygonCentroid(ring), center);
    for (let i = 0; i < world.length; i++) {
      const [x1, z1] = world[i], [x2, z2] = world[(i + 1) % world.length];
      const mx = (x1 + x2) / 2 - cx, mz = (z1 + z2) / 2 - cz;
      let nx = z2 - z1, nz = -(x2 - x1);
      if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
      slab.quad([x1, 0, z1], [x2, 0, z2], [x2, -SLAB_THICKNESS, z2], [x1, -SLAB_THICKNESS, z1], [nx, 0, nz], sideColor);
      triangleSpace.push(spaceIndex, spaceIndex);
    }
    const count = slab.positions.length / 3 - groupStart;
    const last = groups.at(-1);
    if (last && last.material === material) last.count += count;
    else groups.push({ start: groupStart, count, material });

    // Walls along every edge, with gaps where doors sit.
    const height = space.type === 'outdoor' ? OUTDOOR_WALL_FACTOR : 1;
    const doors = openingsBySpace.get(space.id) ?? [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const edgeKey = [key(p), key(q)].sort().join('|');
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const length = Math.hypot(dx, dy);
      if (length < 0.05) continue;
      const ux = dx / length, uy = dy / length;
      const gaps: [number, number][] = [];
      for (const door of doors) {
        const rx = door.position[0] - p[0], ry = door.position[1] - p[1];
        const t = rx * ux + ry * uy;
        const distance = Math.abs(rx * uy - ry * ux);
        if (distance < 0.45 && t > -0.2 && t < length + 0.2) {
          gaps.push([t - door.width_m / 2, t + door.width_m / 2]);
          doorAngle.set(door.id, Math.atan2(uy, ux));
        }
      }
      for (const [s, e] of solidIntervals(length, gaps)) {
        const a = toWorld([p[0] + ux * s, p[1] + uy * s], center), b = toWorld([p[0] + ux * e, p[1] + uy * e], center);
        addWallBox(walls, a, b, height);
      }
    }
  });

  const doors: DoorMarker[] = openings.map(opening => {
    const [x, z] = toWorld(opening.position, center);
    return { id: opening.id, x, z, angle: doorAngle.get(opening.id) ?? 0, width: opening.width_m, color: opening.kind === 'entrance' ? '#2f8f5b' : opening.step_free ? '#8fbf4d' : '#e2a23a' };
  });

  const slabGeometry = slab.build(true);
  for (const group of groups) slabGeometry.addGroup(group.start, group.count, group.material);
  return { slab: slabGeometry, triangleSpace: Int32Array.from(triangleSpace), spaces, walls: walls.build(false, true), doors };
}

function addWallBox(builder: Builder, a: [number, number], b: [number, number], height: number) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  const nx = (-dz / length) * (WALL_THICKNESS / 2), nz = (dx / length) * (WALL_THICKNESS / 2);
  const c = [
    [a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz],
  ];
  const lo = (i: number) => [c[i][0], 0, c[i][1]];
  const hi = (i: number) => [c[i][0], height, c[i][1]];
  builder.quad(hi(0), hi(1), hi(2), hi(3), [0, 1, 0]);
  builder.quad(lo(0), lo(1), hi(1), hi(0), [nx, 0, nz]);
  builder.quad(lo(2), lo(3), hi(3), hi(2), [-nx, 0, -nz]);
  builder.quad(lo(1), lo(2), hi(2), hi(1), [dx, 0, dz]);
  builder.quad(lo(3), lo(0), hi(0), hi(3), [-dx, 0, -dz]);
}

/** Outline-and-fill geometry for highlighting a single space. */
export function spaceHighlightGeometry(space: Space, center: Point): THREE.BufferGeometry | null {
  const ring = cleanRing(space.polygon);
  if (!ring.length) return null;
  const shape = new THREE.Shape(ring.map(p => { const [x, z] = toWorld(p, center); return new THREE.Vector2(x, -z); }));
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}
