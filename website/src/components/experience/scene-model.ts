import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Asset, Building, Floor, Opening, Point, Space } from '@/lib/buildings/types';
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
  openings: Opening[];
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
      openings: building.openings.filter(opening => opening.floor_id === floor.id),
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
        // One floor at a time: the others are hidden, so walls and furniture below don't show through.
        opacity: isTarget ? 1 : 0,
        flat: isTarget ? 1 : 0,
        interactive: isTarget,
      });
    }
    return poses;
  }
  const chosen = model.floors.filter(f => focus.floorIds.includes(f.floor.id));
  if (focus.spacing === 'true') {
    // Real heights: the chosen floors stay where they are; upper ones turn see-through so lower ones show.
    for (const f of model.floors) {
      const index = chosen.indexOf(f);
      poses.set(f.floor.id, index < 0
        ? { y: elevation(f.floor) + (f.floor.level > (chosen.at(-1)?.floor.level ?? 0) ? 40 : 0), opacity: 0, flat: 1, interactive: false }
        : { y: elevation(f.floor), opacity: index === 0 ? 1 : 0.55, flat: 1, interactive: index === 0 });
    }
    return poses;
  }
  // Stack: pull the chosen floors apart, hide the rest.
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
 * World box the camera should frame. With an answer (`frame` = its spaces, `points` = its route), the camera
 * frames the answer rather than whole floors, never tighter than `minSize` metres across.
 */
export function focusBox(model: BuildingModel, poses: Map<string, FloorPose>, focus: SceneFocus, frame: string[] = [], points: FloorPoint[] = []) {
  if (focus.mode === 'floor' && focus.around) {
    // A single point, e.g. a route step: frame about 18 m around it.
    const [x, z] = model.toWorld(focus.around);
    const y = poses.get(focus.floorId)?.y ?? 0;
    return new THREE.Box3(new THREE.Vector3(x - 9, y, z - 9), new THREE.Vector3(x + 9, y + 1, z + 9));
  }
  const onView = (floorId: string) => (focus.mode === 'floor' ? floorId === focus.floorId : focus.mode === 'stack' && focus.floorIds.includes(floorId));
  const box = new THREE.Box3();
  for (const id of frame) {
    const m = model.spaces.get(id);
    if (!m || !onView(m.space.floor_id)) continue;
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!.clone().translate(new THREE.Vector3(0, poses.get(m.space.floor_id)?.y ?? 0, 0)));
  }
  for (const p of points) {
    if (!onView(p.floorId)) continue;
    const [x, z] = model.toWorld(p.position);
    box.expandByPoint(new THREE.Vector3(x, poses.get(p.floorId)?.y ?? 0, z));
  }
  if (focus.mode !== 'building' && !box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    let minSize = 26; // routes and stacks: close enough to follow the path
    if (focus.mode === 'floor' && !points.length) {
      // Rooms on one floor: keep enough of the floor around them to read where they are.
      const floor = model.floors.find(f => f.floor.id === focus.floorId)!;
      minSize = Math.max(floor.box.maxX - floor.box.minX, floor.box.maxZ - floor.box.minZ) * 0.45;
    }
    const half = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, minSize, 30 * (points.length ? 0.8 : 1)) / 2;
    const floorsOnView = model.floors.filter(f => onView(f.floor.id));
    const top = Math.max(box.max.y, ...floorsOnView.map(f => (poses.get(f.floor.id)?.y ?? 0) + 1));
    return new THREE.Box3(new THREE.Vector3(c.x - half, box.min.y, c.z - half), new THREE.Vector3(c.x + half, top, c.z + half));
  }
  const all = new THREE.Box3();
  const visible = model.floors.filter(f => focus.mode === 'building' || (poses.get(f.floor.id)?.opacity ?? 0) > 0.5);
  for (const f of visible.length ? visible : model.floors) {
    const pose = poses.get(f.floor.id)!;
    all.expandByPoint(new THREE.Vector3(f.box.minX, pose.y, f.box.minZ));
    all.expandByPoint(new THREE.Vector3(f.box.maxX, pose.y + blockHeight(f.storey, pose.flat), f.box.maxZ));
  }
  return all;
}
