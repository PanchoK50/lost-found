'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Asset, Opening, Point, Space } from '@/lib/buildings/types';
import type { BuildingModel, FloorModel } from './scene-model';

/** "Blocks": white massing model. "Detailed": textured floors, walls with door gaps and the generated 3D furniture. */
export type SceneStyle = 'blocks' | 'detailed';

/** Detailed style: floors become thin slabs with walls on top; walls drop from storey height to a cut when a floor is opened. */
export const SLAB = 0.12;
export function wallHeight(storey: number, flat: number) {
  const full = storey * 0.92, cut = 2.1;
  return full + (cut - full) * flat;
}

// ---------- floor and wall textures (public/art/textures) ----------

/** Texture name and how many metres one tile covers. */
const TEXTURES = { epoxy: 6, carpet: 2, parquet: 1.6, tiles: 1.2, terrazzo: 2.5, plaster: 2.5 } as const;
export type TextureName = keyof typeof TEXTURES;
export const FLOOR_TEXTURES = ['epoxy', 'carpet', 'parquet', 'tiles', 'terrazzo'] as const satisfies readonly TextureName[];
export type FloorTexture = (typeof FLOOR_TEXTURES)[number];

const TEXTURE_ROOMS: [FloorTexture, string[]][] = [
  ['epoxy', ['production_zone', 'assembly_zone', 'warehouse_zone', 'logistics_zone', 'additive_zone', 'storage', 'technical_room', 'makerspace']],
  ['carpet', ['office', 'meeting_room', 'seminar_room', 'lecture_hall', 'library', 'reception']],
  ['parquet', ['bedroom', 'living_room', 'dining_room']],
  ['tiles', ['bathroom', 'toilet', 'shower', 'locker_room', 'kitchen', 'lab', 'quality_lab', 'server_room']],
  ['terrazzo', ['corridor', 'lobby', 'hall', 'canteen', 'stairwell']],
];
const TEXTURE_BY_ROOM = new Map(TEXTURE_ROOMS.flatMap(([texture, rooms]) => rooms.map(room => [room, texture] as const)));

/** Floor finish for a space; undefined keeps the plain block colour (outdoor, lifts, unknown room types). */
export function floorTexture(space: Space): FloorTexture | undefined {
  return TEXTURE_BY_ROOM.get(space.room_type) ?? (space.type === 'corridor' || space.type === 'hall' || space.type === 'stair' ? 'terrazzo' : undefined);
}

const textureCache = new Map<TextureName, Promise<THREE.Texture | null>>();
function loadTexture(name: TextureName) {
  let promise = textureCache.get(name);
  if (!promise) {
    promise = new Promise(resolve => new THREE.TextureLoader().load(`/art/textures/${name}.jpg`, texture => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(1 / TEXTURES[name], 1 / TEXTURES[name]);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      resolve(texture);
    }, undefined, () => resolve(null)));
    textureCache.set(name, promise);
  }
  return promise;
}

/** Loads the textures once per page (shared by every floor); surfaces render plain until they arrive. */
export function useTextures(enabled: boolean) {
  const [textures, setTextures] = useState<Map<TextureName, THREE.Texture>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    for (const name of Object.keys(TEXTURES) as TextureName[]) {
      void loadTexture(name).then(texture => { if (texture && !cancelled) setTextures(current => current.get(name) === texture ? current : new Map(current).set(name, texture)); });
    }
    return () => { cancelled = true; };
  }, [enabled]);
  return textures;
}

// ---------- walls and doors ----------

const WALL_THICKNESS = 0.24;
/** Wall tops are drawn dark so the plan reads like a crisp architectural drawing; sides stay light. */
const WALL_TOP = new THREE.Color('#5b6577').convertSRGBToLinear(), WALL_SIDE = new THREE.Color('#ffffff');
const WALL_UV_HEIGHT = 2.5;
const OUTDOOR_WALL_FACTOR = 0.35;

export interface DoorMarker { id: string; x: number; z: number; angle: number; width: number; color: string }
export interface FloorDetail {
  /** Unit-height walls with gaps at the doors; scale Y to set their height. */
  walls: THREE.BufferGeometry;
  doors: DoorMarker[];
}

export const doorColors = { entrance: '#2f8f5b', door: '#4b6fae', opening: '#9fb4d6', step: '#e2a23a' };

class Builder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];

  triangle(a: number[], b: number[], c: number[]) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const color = Math.abs(n[1] / len) > 0.5 ? WALL_TOP : WALL_SIDE;
    for (const v of [a, b, c]) { this.positions.push(v[0], v[1], v[2]); this.normals.push(n[0] / len, n[1] / len, n[2] / len); this.colors.push(color.r, color.g, color.b); }
  }

  /** Quad a-b-c-d, wound so that its normal points along `outward`. */
  quad(a: number[], b: number[], c: number[], d: number[], outward: number[]) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) [b, d] = [d, b];
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  /** Vertical faces get (distance along the wall, height) UVs in metres, tops get plan (x, z). */
  build() {
    const uvs: number[] = [];
    for (let i = 0; i < this.positions.length / 3; i++) {
      const [x, y, z] = this.positions.slice(i * 3, i * 3 + 3);
      const [nx, ny, nz] = this.normals.slice(i * 3, i * 3 + 3);
      uvs.push(...(Math.abs(ny) > 0.5 ? [x, z] : Math.abs(nx) > Math.abs(nz) ? [z, y * WALL_UV_HEIGHT] : [x, y * WALL_UV_HEIGHT]));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingSphere();
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

function addWallBox(builder: Builder, a: [number, number], b: [number, number], height: number) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  const nx = (-dz / length) * (WALL_THICKNESS / 2), nz = (dx / length) * (WALL_THICKNESS / 2);
  const c = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
  const lo = (i: number) => [c[i][0], 0, c[i][1]];
  const hi = (i: number) => [c[i][0], height, c[i][1]];
  builder.quad(hi(0), hi(1), hi(2), hi(3), [0, 1, 0]);
  builder.quad(lo(0), lo(1), hi(1), hi(0), [nx, 0, nz]);
  builder.quad(lo(2), lo(3), hi(3), hi(2), [-nx, 0, -nz]);
  builder.quad(lo(1), lo(2), hi(2), hi(1), [dx, 0, dz]);
  builder.quad(lo(3), lo(0), hi(0), hi(3), [-dx, 0, -dz]);
}

/** Walls along every space outline (shared edges once), with gaps where the doors sit, plus door markers along the wall. */
export function buildFloorDetail(floor: FloorModel, toWorld: BuildingModel['toWorld']): FloorDetail {
  const walls = new Builder();
  const bySpace = new Map<string, Opening[]>();
  for (const opening of floor.openings) for (const id of opening.space_ids) bySpace.set(id, [...(bySpace.get(id) ?? []), opening]);
  const seen = new Set<string>();
  const angle = new Map<string, number>();
  const key = (p: Point) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  for (const { space } of floor.spaces) {
    const ring = cleanRing(space.polygon);
    const height = space.type === 'outdoor' ? OUTDOOR_WALL_FACTOR : 1;
    const doors = bySpace.get(space.id) ?? [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const edge = [key(p), key(q)].sort().join('|');
      if (seen.has(edge)) continue;
      seen.add(edge);
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const length = Math.hypot(dx, dy);
      if (length < 0.05) continue;
      const ux = dx / length, uy = dy / length;
      const gaps: [number, number][] = [];
      for (const door of doors) {
        const rx = door.position[0] - p[0], ry = door.position[1] - p[1];
        const t = rx * ux + ry * uy;
        if (Math.abs(rx * uy - ry * ux) < 0.45 && t > -0.2 && t < length + 0.2) {
          gaps.push([t - door.width_m / 2, t + door.width_m / 2]);
          // Plan angle θ is a rotation of θ about +Y in the world, because plan y becomes world −z.
          angle.set(door.id, Math.atan2(uy, ux));
        }
      }
      for (const [s, e] of solidIntervals(length, gaps)) {
        addWallBox(walls, toWorld([p[0] + ux * s, p[1] + uy * s]), toWorld([p[0] + ux * e, p[1] + uy * e]), height);
      }
    }
  }
  const doors = floor.openings.map(opening => {
    const [x, z] = toWorld(opening.position);
    const color = opening.kind === 'entrance' ? doorColors.entrance : !opening.step_free ? doorColors.step : opening.kind === 'opening' ? doorColors.opening : doorColors.door;
    return { id: opening.id, x, z, angle: angle.get(opening.id) ?? 0, width: opening.width_m, color };
  });
  return { walls: walls.build(), doors };
}

/** Door thresholds: a coloured strip across the wall, green for entrances, amber where there is a step. */
export function Doors({ doors }: { doors: DoorMarker[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4(), color = new THREE.Color(), rotation = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    doors.forEach((door, i) => {
      matrix.compose(new THREE.Vector3(door.x, 0.02, door.z), rotation.setFromAxisAngle(up, door.angle), new THREE.Vector3(Math.max(door.width, 0.6), 1, 1));
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, color.set(door.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [doors]);
  if (!doors.length) return null;
  return (
    <instancedMesh key={doors.length} ref={ref} args={[undefined, undefined, doors.length]} raycast={() => null} renderOrder={3}>
      <boxGeometry args={[1, 0.05, 0.4]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

// ---------- 3D furniture (public/art/models/<type>.glb) ----------

type AssetModel = { parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[]; size: THREE.Vector3 };

const MODEL_BRIGHTNESS = 1.6;
/** The generated models face the opposite way to the dataset's footprint rotation (all share one camera angle). */
const MODEL_YAW_OFFSET = Math.PI;
const MODEL_YAW_FIXES: Record<string, number> = { lecture_seating_row: Math.PI };

const modelCache = new Map<string, Promise<AssetModel | null>>();
let loaderPromise: Promise<import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader> | undefined;

function loadModel(type: string): Promise<AssetModel | null> {
  let promise = modelCache.get(type);
  if (promise) return promise;
  // Models are meshopt-compressed, so the loader needs the decoder.
  loaderPromise ??= Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ]).then(([{ GLTFLoader }, { MeshoptDecoder }]) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder));
  promise = loaderPromise.then(loader => new Promise<AssetModel | null>(resolve => loader.load(`/art/models/${type}.glb`, gltf => {
    gltf.scene.updateMatrixWorld(true);
    const parts: AssetModel['parts'] = [];
    gltf.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const material = ((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial).clone();
      // Matte like the rest of the scene; the generator bakes metalness and dark shading into the colours.
      material.metalness = 0;
      material.metalnessMap = null;
      material.roughness = Math.max(material.roughness ?? 1, 0.6);
      material.color.multiplyScalar(MODEL_BRIGHTNESS);
      parts.push({ geometry, material });
    });
    if (!parts.length) return resolve(null);
    const box = new THREE.Box3();
    for (const part of parts) { part.geometry.computeBoundingBox(); box.union(part.geometry.boundingBox!); }
    const centre = box.getCenter(new THREE.Vector3());
    for (const part of parts) part.geometry.translate(-centre.x, -box.min.y, -centre.z);
    resolve({ parts, size: box.getSize(new THREE.Vector3()) });
  }, undefined, () => resolve(null)))); // no model for this type: it stays a box
  modelCache.set(type, promise);
  return promise;
}

/** Loaded models for the given asset types, shared by every floor and building on the page. */
export function useAssetModels(types: string[], enabled: boolean) {
  const [models, setModels] = useState<Map<string, AssetModel>>(() => new Map());
  const wanted = [...new Set(types)].sort().join(',');
  useEffect(() => {
    if (!enabled || !wanted) return;
    let cancelled = false;
    for (const type of wanted.split(',')) {
      void loadModel(type).then(model => { if (model && !cancelled) setModels(current => current.get(type) === model ? current : new Map(current).set(type, model)); });
    }
    return () => { cancelled = true; };
  }, [wanted, enabled]);
  return models;
}

const UP = new THREE.Vector3(0, 1, 0);
const ASSET_HEIGHTS: Record<string, number> = {
  desk: 0.75, office_chair: 0.9, chair: 0.85, table: 0.75, meeting_table: 0.75, lab_bench: 0.9, workbench: 0.9, bed: 0.5,
  sofa: 0.8, wardrobe: 2.0, shelf: 1.9, bookshelf: 2.0, filing_cabinet: 1.3, tool_cabinet: 1.6, fume_hood: 2.2, fridge: 1.8,
  toilet: 0.45, sink: 0.9, shower: 2.0, plant: 1.1, whiteboard: 1.9, vending_machine: 1.85, pallet_rack: 4.0, high_bay_rack: 6.0,
  rack: 2.5, forklift: 2.2, conveyor: 1.0,
};
const CATEGORY_HEIGHTS: Record<string, number> = { furniture: 0.75, fixture: 0.9, machine: 1.6, equipment: 1.1 };
const WALL_MOUNT: Record<string, number> = { hand_dryer: 1.0, defibrillator: 1.1, electrical_panel: 0.5, projector_screen: 0.7 };

function boxMatrix(asset: Asset, storey: number, toWorld: BuildingModel['toWorld'], matrix: THREE.Matrix4) {
  const height = Math.min(ASSET_HEIGHTS[asset.type] ?? CATEGORY_HEIGHTS[asset.category] ?? 0.8, storey - 0.2);
  const [x, z] = toWorld(asset.position);
  const f = asset.footprint ?? { width_m: 0.6, depth_m: 0.6, rotation_deg: 0 };
  const base = WALL_MOUNT[asset.type] ?? 0;
  return matrix.compose(new THREE.Vector3(x, base + height / 2, z), new THREE.Quaternion().setFromAxisAngle(UP, THREE.MathUtils.degToRad(f.rotation_deg)), new THREE.Vector3(Math.max(f.width_m, 0.15), height, Math.max(f.depth_m, 0.15)));
}

/** Model scaled uniformly to fit the footprint, turned 90° if its long side doesn't match the footprint's. */
function modelMatrix(asset: Asset, storey: number, toWorld: BuildingModel['toWorld'], size: THREE.Vector3, matrix: THREE.Matrix4) {
  const [x, z] = toWorld(asset.position);
  const f = asset.footprint ?? { width_m: 0.6, depth_m: 0.6, rotation_deg: 0 };
  const swap = (size.x >= size.z) !== (f.width_m >= f.depth_m);
  const [sx, sz] = swap ? [size.z, size.x] : [size.x, size.z];
  const scale = Math.min(f.width_m / Math.max(sx, 1e-3), f.depth_m / Math.max(sz, 1e-3), (storey - 0.2) / Math.max(size.y, 1e-3));
  const yaw = THREE.MathUtils.degToRad(f.rotation_deg) + (swap ? Math.PI / 2 : 0) + MODEL_YAW_OFFSET + (MODEL_YAW_FIXES[asset.type] ?? 0);
  const base = asset.type === 'projector' ? Math.max(storey - 0.35 - size.y * scale, 0) : WALL_MOUNT[asset.type] ?? 0;
  return matrix.compose(new THREE.Vector3(x, base, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(scale, scale, scale));
}

const boxGrey = new THREE.Color('#c9d0db'), modelWhite = new THREE.Color('#ffffff'), lit = new THREE.Color('#f26a1b');

/** A floor's furniture as 3D models where one exists, boxes otherwise; the answer's items turn orange. */
export function DetailedAssets({ floor, toWorld, models, litAssets }: { floor: FloorModel; toWorld: BuildingModel['toWorld']; models: Map<string, AssetModel>; litAssets: Set<string> }) {
  const byType = useMemo(() => {
    const groups = new Map<string, Asset[]>();
    for (const asset of floor.assets) if (models.has(asset.type)) groups.set(asset.type, [...(groups.get(asset.type) ?? []), asset]);
    return groups;
  }, [floor.assets, models]);
  const boxes = useMemo(() => floor.assets.filter(asset => !models.has(asset.type)), [floor.assets, models]);
  return <>
    {boxes.length > 0 && (
      <Instances assets={boxes} litAssets={litAssets} base={boxGrey} matrixFor={(asset, m) => boxMatrix(asset, floor.storey, toWorld, m)}>
        <boxGeometry />
        <meshStandardMaterial roughness={0.8} />
      </Instances>
    )}
    {[...byType].flatMap(([type, items]) => {
      const model = models.get(type)!;
      return model.parts.map((part, i) => (
        <Instances key={`${type}-${i}`} assets={items} litAssets={litAssets} base={modelWhite} geometry={part.geometry} material={part.material} matrixFor={(asset, m) => modelMatrix(asset, floor.storey, toWorld, model.size, m)} />
      ));
    })}
  </>;
}

function Instances({ assets, litAssets, base, matrixFor, geometry, material, children }: {
  assets: Asset[];
  litAssets: Set<string>;
  base: THREE.Color;
  matrixFor: (asset: Asset, matrix: THREE.Matrix4) => THREE.Matrix4;
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material;
  children?: React.ReactNode;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    assets.forEach((asset, i) => {
      mesh.setMatrixAt(i, matrixFor(asset, matrix));
      mesh.setColorAt(i, litAssets.has(asset.id) ? lit : base);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  });
  return (
    <instancedMesh key={assets.length} ref={ref} args={[geometry, material, assets.length]} castShadow receiveShadow raycast={() => null}>
      {children}
    </instancedMesh>
  );
}
