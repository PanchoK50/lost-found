'use client';

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { CameraControls, type CameraControlsImpl } from '@react-three/drei';
import type { Asset, Building, Floor, Point, Space } from '@/lib/buildings/types';
import {
  ASSET_COLORS, FLOOR_MATERIALS, assetElevation, assetHeight, buildFloorGeometry, planBounds, polygonArea, polygonCentroid, spaceHighlightGeometry, toWorld,
  type FloorGeometry,
} from '@/lib/buildings/geometry';

export type Selection = { kind: 'space' | 'asset'; id: string } | null;
export interface Layers { assets: boolean; labels: boolean; connectors: boolean; accessibility: boolean }
export interface SceneProps {
  building: Building;
  /** Floor textures available under /art/textures/. */
  textures: string[];
  /** Asset types with a model under /art/models/. */
  models: string[];
  activeLevel: number | 'all';
  explode: number;
  wallHeight: number;
  layers: Layers;
  viewMode: '3d' | 'plan';
  selection: Selection;
  hoverId: string | null;
  focusToken: number;
  onSelect: (selection: Selection) => void;
  onHover: (hover: { kind: 'space' | 'asset'; id: string } | null, x: number, y: number) => void;
  /** Overlay element (same size as the canvas) that room labels and pins are drawn into. */
  labelLayer: HTMLDivElement | null;
}

const GHOST_OPACITY = 0.08;
const ACCENT = '#c6ec4a';

export default function Scene(props: SceneProps) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ alpha: true }} camera={{ fov: 40, near: 0.5, far: 4000, position: [40, 40, 40] }} onPointerMissed={() => props.onSelect(null)}>
      <SceneContent {...props} />
    </Canvas>
  );
}

function SceneContent({ building, textures, models: modelTypes, activeLevel, explode, wallHeight, layers, viewMode, selection, hoverId, focusToken, onSelect, onHover, labelLayer }: SceneProps) {
  const controls = useRef<CameraControlsImpl>(null);
  const camera = useThree(state => state.camera) as THREE.PerspectiveCamera;
  const aspect = useThree(state => state.size.width / Math.max(state.size.height, 1));
  const bounds = useMemo(() => planBounds(building), [building]);
  const floors = useMemo(() => [...building.floors].sort((a, b) => a.level - b.level), [building]);
  const spaceById = useMemo(() => new Map(building.spaces.map(space => [space.id, space])), [building]);
  const assetById = useMemo(() => new Map(building.assets.map(asset => [asset.id, asset])), [building]);
  const floorById = useMemo(() => new Map(building.floors.map(floor => [floor.id, floor])), [building]);
  const floorY = (floor: Floor) => floor.elevation_m * explode;
  const floorTextures = useFloorTextures(textures);
  const assetModels = useAssetModels(modelTypes, building);

  const visibility = (floor: Floor): 'full' | 'ghost' | 'hidden' =>
    activeLevel === 'all' || floor.level === activeLevel ? 'full' : floor.level < activeLevel ? 'ghost' : 'hidden';

  // Frame the building (or the active floor) whenever the view changes.
  const span = Math.max(bounds.width, bounds.depth, 10);
  // (camera-controls' fitToBox snaps the angle to 90° steps, so frame by hand.)
  useEffect(() => {
    const cc = controls.current;
    if (!cc) return;
    const active = activeLevel === 'all' ? null : floors.find(floor => floor.level === activeLevel);
    const ys = active ? [floorY(active)] : floors.map(floorY);
    const top = Math.max(...ys) + (active ? wallHeight : 3), bottom = Math.min(...ys);
    const radius = 0.5 * Math.hypot(bounds.width, bounds.depth, top - bottom);
    const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
    const horizontal = Math.atan(Math.tan(vertical) * aspect);
    const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 0.92;
    const polar = viewMode === 'plan' ? 0.0001 : Math.PI * 0.27;
    const azimuth = viewMode === 'plan' ? 0 : Math.PI * 0.2;
    const target = new THREE.Vector3(0, (top + bottom) / 2, 0);
    const offset = new THREE.Vector3().setFromSphericalCoords(distance, polar, azimuth);
    void cc.setLookAt(target.x + offset.x, target.y + offset.y, target.z + offset.z, target.x, target.y, target.z, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, activeLevel, viewMode, explode, focusToken]);

  // Fly to the current selection.
  useEffect(() => {
    const camera = controls.current;
    if (!camera || !selection) return;
    const item = selection.kind === 'space' ? spaceById.get(selection.id) : assetById.get(selection.id);
    if (!item) return;
    const floor = floorById.get(item.floor_id);
    if (!floor) return;
    const point: Point = 'polygon' in item ? polygonCentroid(item.polygon) : item.position;
    const [x, z] = toWorld(point, bounds.center);
    const size = 'polygon' in item ? Math.sqrt(polygonArea(item.polygon)) : 2;
    void camera.moveTo(x, floorY(floor), z, true);
    void camera.dollyTo(Math.min(Math.max(size * 3.2, 9), span * 1.5), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const shadowExtent = span * 0.75;
  return (
    <>
      <fog attach="fog" args={['#eef1e8', span * 2.5, span * 6]} />
      <hemisphereLight args={['#ffffff', '#cbd2bf', 1.6]} />
      <directionalLight
        // Overhead light in plan view: slanted wall shadows read as volumes when seen from straight above.
        castShadow={viewMode === '3d'} position={viewMode === '3d' ? [span * 0.4, span * 0.9, span * 0.5] : [0.01, span, 0.01]} intensity={1.6}
        shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.04}
        shadow-camera-left={-shadowExtent} shadow-camera-right={shadowExtent} shadow-camera-top={shadowExtent} shadow-camera-bottom={-shadowExtent}
        shadow-camera-near={1} shadow-camera-far={span * 4}
      />
      <CameraControls ref={controls} makeDefault smoothTime={0.35} maxPolarAngle={Math.PI * 0.49} minDistance={2} maxDistance={span * 5} />
      <Ground y={Math.min(...floors.map(floorY)) - 0.2} size={span * 8} span={span} />

      {floors.map(floor => {
        const mode = visibility(floor);
        if (mode === 'hidden') return null;
        return (
          <group key={floor.id} position={[0, floorY(floor), 0]}>
            <FloorMeshes building={building} floor={floor} floorTextures={floorTextures} center={bounds.center} ghost={mode === 'ghost'} wallHeight={Math.min(wallHeight, floor.height_m)} accessibility={layers.accessibility} onSelect={onSelect} onHover={onHover} />
            {mode === 'full' && layers.assets && <FloorAssets building={building} floor={floor} center={bounds.center} models={assetModels} onSelect={onSelect} onHover={onHover} />}

          </group>
        );
      })}

      {floors.map(floor => layers.labels && activeLevel !== 'all' && visibility(floor) === 'full' && (
        <FloorLabels key={floor.id} building={building} floor={floor} center={bounds.center} y={floorY(floor)} layer={labelLayer} />
      ))}
      {layers.connectors && <Connectors building={building} center={bounds.center} floorY={floorY} visible={floor => visibility(floor) !== 'hidden'} />}
      <Highlight item={selection ? (selection.kind === 'space' ? spaceById.get(selection.id) : assetById.get(selection.id)) : undefined} floorById={floorById} center={bounds.center} floorY={floorY} color={ACCENT} strong layer={labelLayer} />
      {hoverId && hoverId !== selection?.id && <Highlight item={spaceById.get(hoverId) ?? assetById.get(hoverId)} floorById={floorById} center={bounds.center} floorY={floorY} color="#ffffff" />}
    </>
  );
}

// Dot grid on the ground: anti-aliased dots in world space that fade out away from the building.
const DOT_VERTEX = `
  varying vec2 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const DOT_FRAGMENT = `
  uniform float uSpacing;
  uniform float uRadius;
  uniform float uFadeStart;
  uniform float uFadeEnd;
  uniform vec3 uColor;
  varying vec2 vWorld;
  void main() {
    vec2 cell = vWorld / uSpacing;
    vec2 offset = fract(cell) - 0.5;
    float distance = length(offset) * uSpacing;
    // Keep dots about 1.5 px wide whatever the zoom, but never bigger than uRadius.
    float pixel = length(fwidth(vWorld));
    float radius = min(uRadius, 1.5 * pixel);
    float dot = 1.0 - smoothstep(radius - pixel, radius + pixel, distance);
    // Every fifth dot is a little stronger, like a drafting grid.
    vec2 major = abs(mod(floor(cell + 0.5), 5.0));
    float strength = (major.x < 0.5 && major.y < 0.5) ? 0.5 : 0.3;
    float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(vWorld));
    gl_FragColor = vec4(uColor, dot * strength * fade);
  }
`;

function Ground({ y, size, span }: { y: number; size: number; span: number }) {
  const spacing = Math.max(1, Math.round(span / 45));
  const uniforms = useMemo(() => ({
    uSpacing: { value: spacing },
    uRadius: { value: spacing * 0.08 },
    uFadeStart: { value: span * 0.55 },
    uFadeEnd: { value: span * 2.2 },
    uColor: { value: new THREE.Color('#5d6b55') },
  }), [spacing, span]);
  return (
    <group position-y={y}>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.01} raycast={() => null}>
        <planeGeometry args={[size, size]} />
        <shaderMaterial vertexShader={DOT_VERTEX} fragmentShader={DOT_FRAGMENT} uniforms={uniforms} transparent depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} receiveShadow raycast={() => null}>
        <planeGeometry args={[size, size]} />
        <shadowMaterial transparent opacity={0.12} />
      </mesh>
    </group>
  );
}

type PickHandlers = Pick<SceneProps, 'onSelect' | 'onHover'>;

type FloorTextures = Map<string, THREE.Texture>;

const WALL_TEXTURE = { name: 'plaster', size: 2.5 };

/** Loads the generated floor and wall textures in the background; surfaces render plain until they arrive. */
function useFloorTextures(available: string[]): FloorTextures {
  const [loaded, setLoaded] = useState<FloorTextures>(() => new Map());
  const key = available.join(',');
  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    const textures: THREE.Texture[] = [];
    for (const { name, size } of [...FLOOR_MATERIALS, WALL_TEXTURE]) {
      if (!available.includes(name)) continue;
      loader.load(`/art/textures/${name}.jpg`, texture => {
        textures.push(texture);
        if (cancelled) return texture.dispose();
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(1 / size, 1 / size);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
        setLoaded(current => new Map(current).set(name, texture));
      });
    }
    return () => { cancelled = true; textures.forEach(texture => texture.dispose()); setLoaded(new Map()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return loaded;
}

const FloorMeshes = memo(function FloorMeshes({ building, floor, floorTextures, center, ghost, wallHeight, accessibility, onSelect, onHover }: { building: Building; floor: Floor; floorTextures: FloorTextures; center: Point; ghost: boolean; wallHeight: number; accessibility: boolean } & PickHandlers) {
  const geometry: FloorGeometry = useMemo(() => buildFloorGeometry(
    building.spaces.filter(space => space.floor_id === floor.id),
    building.openings.filter(opening => opening.floor_id === floor.id),
    center,
  ), [building, floor, center]);
  useEffect(() => () => { geometry.slab.dispose(); geometry.walls.dispose(); }, [geometry]);
  // One material per floor material, indexed by the slab's draw groups.
  const slabMaterials = useMemo(() => FLOOR_MATERIALS.map(({ name }) => new THREE.MeshStandardMaterial({
    vertexColors: true, map: floorTextures.get(name) ?? null, roughness: 0.9,
    transparent: ghost, opacity: ghost ? GHOST_OPACITY : 1, depthWrite: !ghost,
  })), [floorTextures, ghost]);
  useEffect(() => () => slabMaterials.forEach(material => material.dispose()), [slabMaterials]);

  const spaceAt = (event: ThreeEvent<PointerEvent | MouseEvent>): Space | undefined =>
    event.faceIndex == null ? undefined : geometry.spaces[geometry.triangleSpace[event.faceIndex]];

  return (
    <group>
      <mesh
        geometry={geometry.slab} material={slabMaterials} receiveShadow={!ghost}
        raycast={ghost ? () => null : undefined}
        onClick={event => { event.stopPropagation(); const space = spaceAt(event); if (space) onSelect({ kind: 'space', id: space.id }); }}
        onPointerMove={event => { event.stopPropagation(); const space = spaceAt(event); onHover(space ? { kind: 'space', id: space.id } : null, event.nativeEvent.clientX, event.nativeEvent.clientY); }}
        onPointerOut={event => onHover(null, event.nativeEvent.clientX, event.nativeEvent.clientY)}
      />
      <mesh geometry={geometry.walls} scale-y={ghost ? 0.15 : wallHeight} castShadow={!ghost} receiveShadow={!ghost} raycast={() => null}>
        <meshStandardMaterial key={floorTextures.has(WALL_TEXTURE.name) ? 'textured' : 'plain'} color="#ffffff" map={floorTextures.get(WALL_TEXTURE.name) ?? null} roughness={0.8} transparent={ghost} opacity={ghost ? GHOST_OPACITY : 1} depthWrite={!ghost} />
      </mesh>
      {!ghost && <Doors doors={geometry.doors} accessibility={accessibility} />}
    </group>
  );
});

/** Door thresholds: a quiet stone strip normally, colored by accessibility when that layer is on. */
const THRESHOLD_COLOR = '#d6d0c2';
function Doors({ doors, accessibility }: { doors: FloorGeometry['doors']; accessibility: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4(), color = new THREE.Color(), rotation = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    doors.forEach((door, i) => {
      // Plan angle θ maps to a rotation of θ about +Y because plan y becomes world -z.
      matrix.compose(new THREE.Vector3(door.x, 0.03, door.z), rotation.setFromAxisAngle(up, door.angle), new THREE.Vector3(Math.max(door.width, 0.6), 1, 1));
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, color.set(accessibility ? door.color : THRESHOLD_COLOR));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [doors, accessibility]);
  if (!doors.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, doors.length]} raycast={() => null}>
      <boxGeometry args={[1, 0.03, 0.18]} />
      {accessibility ? <meshBasicMaterial key="access" toneMapped={false} /> : <meshStandardMaterial key="plain" roughness={0.9} />}
    </instancedMesh>
  );
}

type AssetModel = { parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[]; size: THREE.Vector3 };
type AssetModels = Map<string, AssetModel>;

/** Loads /art/models/<type>.glb for the asset types in this building, normalised to stand on y = 0 centred on the origin. */
function useAssetModels(available: string[], building: Building): AssetModels {
  const [models, setModels] = useState<AssetModels>(() => new Map());
  const wanted = useMemo(() => [...new Set(building.assets.map(asset => asset.type))].filter(type => available.includes(type)).sort().join(','), [available, building]);
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const loaded: AssetModel[] = [];
    let loader: GLTFLoader | undefined;
    // Models are meshopt-compressed by tools/art (gltf-transform optimize), so the loader needs the decoder.
    void Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
    ]).then(([{ GLTFLoader }, { MeshoptDecoder }]) => {
      loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      for (const type of wanted.split(',')) {
        loader.load(`/art/models/${type}.glb`, gltf => {
          gltf.scene.updateMatrixWorld(true);
          const parts: AssetModel['parts'] = [];
          gltf.scene.traverse(object => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
            const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
            // Matte, like the rest of the art: TRELLIS bakes some metalness, which renders dark without an environment map.
            material.metalness = 0;
            material.metalnessMap = null;
            material.roughness = Math.max(material.roughness ?? 1, 0.6);
            // TRELLIS bakes the input image's shading into the base color, so models come out darker than the art; lift them.
            material.color.multiplyScalar(MODEL_BRIGHTNESS);
            material.needsUpdate = true;
            parts.push({ geometry, material });
          });
          if (!parts.length) return;
          const box = new THREE.Box3();
          for (const part of parts) { part.geometry.computeBoundingBox(); box.union(part.geometry.boundingBox!); }
          const center = box.getCenter(new THREE.Vector3());
          for (const part of parts) part.geometry.translate(-center.x, -box.min.y, -center.z);
          const model = { parts, size: box.getSize(new THREE.Vector3()) };
          loaded.push(model);
          if (cancelled) return;
          setModels(current => new Map(current).set(type, model));
        }, undefined, () => { /* missing or broken model: keep the box */ });
      }
    });
    return () => {
      cancelled = true;
      for (const model of loaded) for (const part of model.parts) { part.geometry.dispose(); part.material.dispose(); }
      setModels(new Map());
    };
  }, [wanted]);
  return models;
}

const UP = new THREE.Vector3(0, 1, 0);
const MODEL_BRIGHTNESS = 1.6;
/** TRELLIS models face the opposite way to the dataset's footprint rotation (all inputs share one camera angle, so this is global). */
const MODEL_YAW_OFFSET = Math.PI;
/** Per-type corrections on top of that, for types the dataset orients the other way round. */
const MODEL_YAW_FIXES: Record<string, number> = { lecture_seating_row: Math.PI };

/** Box standing on the floor, sized to the footprint and a per-type height. */
function boxMatrix(asset: Asset, floor: Floor, center: Point, matrix: THREE.Matrix4) {
  const height = Math.min(assetHeight(asset), floor.height_m - 0.2);
  const [x, z] = toWorld(asset.position, center);
  const footprint = asset.footprint ?? { width_m: 0.6, depth_m: 0.6, rotation_deg: 0 };
  const rotation = new THREE.Quaternion().setFromAxisAngle(UP, (footprint.rotation_deg * Math.PI) / 180);
  const base = assetElevation(asset, floor.height_m, height);
  return matrix.compose(new THREE.Vector3(x, base + height / 2, z), rotation, new THREE.Vector3(Math.max(footprint.width_m, 0.15), height, Math.max(footprint.depth_m, 0.15)));
}

/** Model scaled uniformly to fit the footprint, turned 90° if its long side doesn't match the footprint's. */
function modelMatrix(asset: Asset, floor: Floor, center: Point, size: THREE.Vector3, matrix: THREE.Matrix4) {
  const [x, z] = toWorld(asset.position, center);
  const footprint = asset.footprint ?? { width_m: 0.6, depth_m: 0.6, rotation_deg: 0 };
  const swap = (size.x >= size.z) !== (footprint.width_m >= footprint.depth_m);
  const [sx, sz] = swap ? [size.z, size.x] : [size.x, size.z];
  const scale = Math.min(footprint.width_m / Math.max(sx, 1e-3), footprint.depth_m / Math.max(sz, 1e-3), (floor.height_m - 0.2) / Math.max(size.y, 1e-3));
  const angle = (footprint.rotation_deg * Math.PI) / 180 + (swap ? Math.PI / 2 : 0) + MODEL_YAW_OFFSET + (MODEL_YAW_FIXES[asset.type] ?? 0);
  const base = assetElevation(asset, floor.height_m, size.y * scale);
  return matrix.compose(new THREE.Vector3(x, base, z), new THREE.Quaternion().setFromAxisAngle(UP, angle), new THREE.Vector3(scale, scale, scale));
}

const FloorAssets = memo(function FloorAssets({ building, floor, center, models, onSelect, onHover }: { building: Building; floor: Floor; center: Point; models: AssetModels } & PickHandlers) {
  const assets = useMemo(() => building.assets.filter(asset => asset.floor_id === floor.id), [building, floor]);
  const byType = useMemo(() => {
    const groups = new Map<string, Asset[]>();
    for (const asset of assets) if (models.has(asset.type)) groups.set(asset.type, [...(groups.get(asset.type) ?? []), asset]);
    return groups;
  }, [assets, models]);
  const boxes = useMemo(() => assets.filter(asset => !models.has(asset.type)), [assets, models]);
  const handlers = { onSelect, onHover };
  return (
    <>
      {boxes.length > 0 && (
        <AssetInstances assets={boxes} matrixFor={(asset, matrix) => boxMatrix(asset, floor, center, matrix)} colorFor={asset => ASSET_COLORS[asset.category] ?? '#999999'} {...handlers}>
          <boxGeometry />
          <meshStandardMaterial roughness={0.6} />
        </AssetInstances>
      )}
      {[...byType].map(([type, items]) => {
        const model = models.get(type)!;
        return model.parts.map((part, i) => (
          <AssetInstances key={`${type}-${i}`} assets={items} geometry={part.geometry} material={part.material} matrixFor={(asset, matrix) => modelMatrix(asset, floor, center, model.size, matrix)} {...handlers} />
        ));
      })}
    </>
  );
});

function AssetInstances({ assets, matrixFor, colorFor, geometry, material, children, onSelect, onHover }: {
  assets: Asset[];
  matrixFor: (asset: Asset, matrix: THREE.Matrix4) => THREE.Matrix4;
  colorFor?: (asset: Asset) => string;
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material;
  children?: React.ReactNode;
} & PickHandlers) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4(), color = new THREE.Color();
    assets.forEach((asset, i) => {
      mesh.setMatrixAt(i, matrixFor(asset, matrix));
      if (colorFor) mesh.setColorAt(i, color.set(colorFor(asset)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  });
  const assetAt = (event: ThreeEvent<PointerEvent | MouseEvent>): Asset | undefined => event.instanceId == null ? undefined : assets[event.instanceId];
  return (
    <instancedMesh
      key={assets.length} ref={ref} args={[geometry, material, assets.length]} castShadow receiveShadow
      onClick={event => { event.stopPropagation(); const asset = assetAt(event); if (asset) onSelect({ kind: 'asset', id: asset.id }); }}
      onPointerMove={event => { event.stopPropagation(); const asset = assetAt(event); onHover(asset ? { kind: 'asset', id: asset.id } : null, event.nativeEvent.clientX, event.nativeEvent.clientY); }}
      onPointerOut={event => onHover(null, event.nativeEvent.clientX, event.nativeEvent.clientY)}
    >
      {children}
    </instancedMesh>
  );
}

type ScreenLabel = { position: THREE.Vector3; className: string; lines: { tag: 'b' | 'span'; text: string }[] };

/**
 * Plain DOM labels in an overlay layer, moved every frame by projecting their 3D point to the screen.
 * (drei's <Html> creates a React root per label, and unmounting those mid-render crashes under React 19.)
 */
function useScreenLabels(layer: HTMLDivElement | null, labels: ScreenLabel[]) {
  const elements = useRef<HTMLDivElement[]>([]);
  useEffect(() => {
    if (!layer) return;
    const created = labels.map(label => {
      const element = document.createElement('div');
      element.className = label.className;
      for (const line of label.lines) element.appendChild(document.createElement(line.tag)).textContent = line.text;
      layer.appendChild(element);
      return element;
    });
    elements.current = created;
    return () => { created.forEach(element => element.remove()); elements.current = []; };
  }, [layer, labels]);
  const projected = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    elements.current.forEach((element, i) => {
      projected.copy(labels[i].position).project(camera);
      const visible = projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05;
      element.style.display = visible ? '' : 'none';
      if (visible) element.style.transform = `translate(${((projected.x + 1) / 2) * size.width}px, ${((1 - projected.y) / 2) * size.height}px) translate(-50%, -50%)`;
    });
  });
}

const MAX_LABELS = 70;
function FloorLabels({ building, floor, center, y, layer }: { building: Building; floor: Floor; center: Point; y: number; layer: HTMLDivElement | null }) {
  const labels = useMemo<ScreenLabel[]>(() => building.spaces
    .filter(space => space.floor_id === floor.id && space.type !== 'corridor')
    .map(space => ({ space, area: polygonArea(space.polygon) }))
    .filter(({ area }) => area >= 5)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_LABELS)
    .map(({ space, area }) => {
      const [x, z] = toWorld(polygonCentroid(space.polygon), center);
      const lines: ScreenLabel['lines'] = [{ tag: 'b', text: space.ref || space.name }];
      if (space.ref && space.ref !== space.name && area > 40) lines.push({ tag: 'span', text: space.name });
      return { position: new THREE.Vector3(x, y + 0.3, z), className: 'room-label', lines };
    }), [building, floor, center, y]);
  useScreenLabels(layer, labels);
  return null;
}

function Pin({ x, y, z, layer }: { x: number; y: number; z: number; layer: HTMLDivElement | null }) {
  const labels = useMemo<ScreenLabel[]>(() => [{ position: new THREE.Vector3(x, y, z), className: 'pin', lines: [{ tag: 'span', text: '◆' }] }], [x, y, z]);
  useScreenLabels(layer, labels);
  return null;
}

function Connectors({ building, center, floorY, visible }: { building: Building; center: Point; floorY: (floor: Floor) => number; visible: (floor: Floor) => boolean }) {
  const floorById = new Map(building.floors.map(floor => [floor.id, floor]));
  const spaceById = new Map(building.spaces.map(space => [space.id, space]));
  return (
    <>
      {building.vertical_connectors.map(connector => {
        const stops = connector.space_ids
          .map((id, i) => ({ space: spaceById.get(id), floor: floorById.get(connector.floor_ids[i]) }))
          .filter((stop): stop is { space: Space; floor: Floor } => !!stop.space && !!stop.floor && visible(stop.floor))
          .map(({ space, floor }) => { const [x, z] = toWorld(polygonCentroid(space.polygon), center); return new THREE.Vector3(x, floorY(floor), z); })
          .sort((a, b) => a.y - b.y);
        const color = connector.kind === 'lift' ? '#3d8ae0' : '#e59a2b';
        return stops.slice(1).map((top, i) => {
          const bottom = stops[i];
          const length = bottom.distanceTo(top);
          if (length < 0.1) return null;
          const mid = bottom.clone().add(top).multiplyScalar(0.5);
          const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(bottom).normalize());
          return (
            <mesh key={`${connector.id}-${i}`} position={mid} quaternion={quaternion} raycast={() => null}>
              <cylinderGeometry args={[0.12, 0.12, length, 10]} />
              <meshBasicMaterial color={color} transparent opacity={0.75} toneMapped={false} />
            </mesh>
          );
        });
      })}
    </>
  );
}

function Highlight({ item, floorById, center, floorY, color, strong, layer = null }: { item: Space | Asset | undefined; floorById: Map<string, Floor>; center: Point; floorY: (floor: Floor) => number; color: string; strong?: boolean; layer?: HTMLDivElement | null }) {
  const geometry = useMemo(() => (item && 'polygon' in item ? spaceHighlightGeometry(item, center) : null), [item, center]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  const floor = item ? floorById.get(item.floor_id) : undefined;
  if (!item || !floor) return null;
  const y = floorY(floor);
  if (geometry) {
    return (
      <mesh geometry={geometry} position-y={y + 0.03} raycast={() => null}>
        <meshBasicMaterial color={color} transparent opacity={strong ? 0.85 : 0.45} depthWrite={false} toneMapped={false} />
      </mesh>
    );
  }
  const asset = item as Asset;
  const [x, z] = toWorld(asset.position, center);
  return (
    <group position={[x, y, z]}>
      <mesh position-y={0.04} rotation-x={-Math.PI / 2} raycast={() => null}>
        <ringGeometry args={[0.7, 0.95, 40]} />
        <meshBasicMaterial color={strong ? '#7aa21a' : color} transparent opacity={0.9} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {strong && <Pin x={x} y={y + assetHeight(asset) + 0.6} z={z} layer={layer} />}
    </group>
  );
}
