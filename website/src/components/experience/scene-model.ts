import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Asset, Building, Floor, Point, Space } from '@/lib/buildings/types';
import { bounds, polygonArea, polygonCentroid, storeyHeights } from '@/lib/buildings/geometry';
import type { FloorPoint, SceneFocus } from '@/lib/chat/contract';

/**
 * World space: building X → world X, building Y → world −Z, elevation → world Y.
 * Everything is centred on the building footprint so the camera orbits the middle.
 */
export interface SpaceModel { space: Space; area: number; centre: [number, number]; geometry: THREE.BufferGeometry }
export interface FloorModel {
  floor: Floor;
  storey: number;
  spaces: SpaceModel[];
  assets: Asset[];
  /** Merged unit-height outline of every space, scaled with the blocks. */
  edges: THREE.BufferGeometry;
  box: { minX: number; maxX: number; minZ: number; maxZ: number };
}
export interface BuildingModel {
  floors: FloorModel[];
  spaces: Map<string, SpaceModel>;
  toWorld(point: Point): [number, number];
  /** Building-space anchor points for openings and vertical connectors, used to mark closures. */
  anchors: Map<string, FloorPoint[]>;
  box: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function buildModel(building: Building): BuildingModel {
  const all = bounds(building.spaces.flatMap(space => space.polygon));
  const cx = (all.minX + all.maxX) / 2, cy = (all.minY + all.maxY) / 2;
  const toWorld = ([x, y]: Point): [number, number] => [x - cx, -(y - cy)];
  const heights = storeyHeights(building);
  const spaces = new Map<string, SpaceModel>();
  const floors = [...building.floors].sort((a, b) => a.level - b.level).map(floor => {
    const floorSpaces = building.spaces.filter(space => space.floor_id === floor.id && space.polygon.length >= 3).map(space => {
      const model: SpaceModel = { space, area: polygonArea(space.polygon), centre: toWorld(polygonCentroid(space.polygon)), geometry: extrude(space.polygon, cx, cy) };
      spaces.set(space.id, model);
      return model;
    });
    const edgeParts = floorSpaces.map(model => new THREE.EdgesGeometry(model.geometry, 30));
    const edges = edgeParts.length ? mergeGeometries(edgeParts) ?? new THREE.BufferGeometry() : new THREE.BufferGeometry();
    edgeParts.forEach(part => part.dispose());
    const b = bounds(floorSpaces.flatMap(model => model.space.polygon.map(toWorld)));
    return {
      floor,
      storey: heights.get(floor.id) ?? 3,
      spaces: floorSpaces,
      assets: building.assets.filter(asset => asset.floor_id === floor.id),
      edges,
      box: { minX: b.minX, maxX: b.maxX, minZ: b.minY, maxZ: b.maxY },
    };
  });
  const anchors = new Map<string, FloorPoint[]>(building.openings.map(o => [o.id, [{ floorId: o.floor_id, position: o.position }]]));
  for (const connector of building.vertical_connectors) {
    anchors.set(connector.id, connector.space_ids.flatMap(id => {
      const m = spaces.get(id);
      return m ? [{ floorId: m.space.floor_id, position: polygonCentroid(m.space.polygon) }] : [];
    }));
  }
  return { floors, spaces, toWorld, anchors, box: { minX: all.minX - cx, maxX: all.maxX - cx, minZ: -(all.maxY - cy), maxZ: -(all.minY - cy) } };
}

/** Unit-height prism; scale Y to set the wall height. */
function extrude(polygon: Point[], cx: number, cy: number) {
  const points = polygon.at(-1)![0] === polygon[0][0] && polygon.at(-1)![1] === polygon[0][1] ? polygon.slice(0, -1) : polygon;
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** Where each floor sits and how it looks for a given focus. */
export interface FloorPose { y: number; opacity: number; flat: number; interactive: boolean }

export function layoutFloors(model: BuildingModel, focus: SceneFocus): Map<string, FloorPose> {
  const poses = new Map<string, FloorPose>();
  const elevation = (floor: Floor) => floor.elevation_m;
  if (focus.mode === 'building') {
    for (const f of model.floors) poses.set(f.floor.id, { y: elevation(f.floor), opacity: 1, flat: 0, interactive: true });
    return poses;
  }
  if (focus.mode === 'floor') {
    const target = model.floors.find(f => f.floor.id === focus.floorId);
    const level = target?.floor.level ?? 0;
    for (const f of model.floors) {
      const above = f.floor.level > level;
      const isTarget = f.floor.id === focus.floorId;
      poses.set(f.floor.id, {
        y: elevation(f.floor) + (above ? 40 + (f.floor.level - level) * 6 : 0),
        opacity: isTarget ? 1 : above ? 0 : 0.14,
        flat: isTarget ? 1 : 0,
        interactive: isTarget,
      });
    }
    return poses;
  }
  // Stack: pull the chosen floors apart, hide the rest.
  const chosen = model.floors.filter(f => focus.floorIds.includes(f.floor.id));
  const base = chosen[0]?.floor.elevation_m ?? 0;
  const span = Math.max(model.box.maxX - model.box.minX, model.box.maxZ - model.box.minZ);
  const gap = Math.max(10, Math.min(span * 0.5, 40));
  for (const f of model.floors) {
    const index = chosen.indexOf(f);
    const lowest = chosen[0]?.floor.level ?? 0;
    poses.set(f.floor.id, index >= 0
      ? { y: base + index * gap, opacity: 1, flat: 1, interactive: true }
      : { y: base + (f.floor.level - lowest) * gap + (f.floor.level > lowest ? 40 : -10), opacity: 0, flat: 1, interactive: false });
  }
  return poses;
}

/** Block height for a floor at a given flatness (0 = full storey, 1 = 2.5D cut). */
export function blockHeight(storey: number, flat: number, lift = 0) {
  const full = storey * (0.9 + lift * 0.05);
  const cut = 1 + lift * 1.4;
  return full + (cut - full) * flat;
}

/**
 * World box the camera should frame. On a single floor, `frame` (the answer's spaces) narrows the view to
 * those spaces, but never tighter than 45% of the floor or 30 m, so the surroundings stay readable.
 */
export function focusBox(model: BuildingModel, poses: Map<string, FloorPose>, focus: SceneFocus, frame: string[] = []) {
  if (focus.mode === 'floor') {
    const floor = model.floors.find(f => f.floor.id === focus.floorId);
    const spaces = frame.map(id => model.spaces.get(id)).filter(m => m && m.space.floor_id === focus.floorId);
    if (floor && spaces.length) {
      const y = poses.get(floor.floor.id)!.y;
      const box = new THREE.Box3();
      for (const m of spaces) {
        m!.geometry.computeBoundingBox();
        box.union(m!.geometry.boundingBox!.clone().translate(new THREE.Vector3(0, y, 0)));
      }
      const centre = box.getCenter(new THREE.Vector3());
      const span = Math.max(floor.box.maxX - floor.box.minX, floor.box.maxZ - floor.box.minZ);
      const half = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, span * 0.45, 30) / 2;
      return new THREE.Box3(new THREE.Vector3(centre.x - half, y, centre.z - half), new THREE.Vector3(centre.x + half, y + 1, centre.z + half));
    }
  }
  const box = new THREE.Box3();
  const visible = model.floors.filter(f => focus.mode === 'building' || (poses.get(f.floor.id)?.opacity ?? 0) > 0.5);
  for (const f of visible.length ? visible : model.floors) {
    const pose = poses.get(f.floor.id)!;
    box.expandByPoint(new THREE.Vector3(f.box.minX, pose.y, f.box.minZ));
    box.expandByPoint(new THREE.Vector3(f.box.maxX, pose.y + blockHeight(f.storey, pose.flat), f.box.maxZ));
  }
  return box;
}
