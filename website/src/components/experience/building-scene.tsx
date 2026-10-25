'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { CameraControls, Line } from '@react-three/drei';
import type { Line2 } from 'three-stdlib';
import type { Building } from '@/lib/buildings/types';
import type { FloorPoint, SceneDirective, Tone } from '@/lib/chat/contract';
import { blockHeight, buildModel, focusBox, layoutFloors, type BuildingModel, type FloorModel, type FloorPose } from './scene-model';
import type { WorldState } from '@/lib/world/types';
import { hazardMeta, type HazardKind } from '@/lib/hazards/types';
import { worldAnchors } from '@/components/world/world-anchors';
import { People } from './scene-people';
import { DetailedAssets, Doors, FLOOR_TEXTURES, SLAB, buildFloorDetail, floorTexture, useAssetModels, useTextures, wallHeight, type FloorTexture, type SceneStyle } from './scene-detail';

/**
 * Synera-style model: white, studio-lit blocks on a cool light ground. Orange marks the answer,
 * light blue the reference room; routes use Synera's blue → violet → pink → coral path gradient.
 */
const palette = {
  background: '#f4f5f7',
  room: '#ffffff',
  hall: '#fafbfc',
  corridor: '#eceff4',
  core: '#dbe2ec',
  edge: '#a3adbc',
  asset: '#c9d0db',
  primary: '#f26a1b',
  primaryEdge: '#8d3201',
  secondary: '#8fcbff',
  muted: '#e4edf9',
  warning: '#e5484d',
  ink: '#002478',
  stop: '#8a3fc4',
};
/** Synera path gradient, sampled from their stage imagery. */
const routeGradient = ['#2f55d4', '#8a3fc4', '#e04f9a', '#f26b4f'].map(c => new THREE.Color(c));
const lift: Record<Tone, number> = { primary: 1, secondary: 0.2, muted: 0.1 };

/** Pixels covered by UI on each side; the camera frames the model in the remaining area. */
export interface SceneInsets { top: number; left: number; bottom: number; right?: number }

interface Props {
  building: Building;
  directive: SceneDirective;
  insets: SceneInsets;
  onFocusFloor(floorId: string): void;
  /** People and pins from the shared world; they stay when the answer changes (docs/MULTIPLAYER.md §11). */
  world?: WorldState;
  onPin?(pinId: string): void;
  /** A person on the map was tapped. */
  onPerson?(playerId: string): void;
  /** Offered on a tapped room: walk there from where the player is. */
  onRoute?(spaceId: string): void;
  /** "I'm here": set this room as the player's location (picked by hand; there is no GPS indoors). */
  onSetLocation?(spaceId: string): void;
  /** The room the player said they are in, if any. */
  myRoom?: string;
  /** "Simulate here" on a tapped room: what if a fire, a leak or a power fault starts in it? */
  onSimulate?(spaceId: string, hazard: HazardKind): void;
}

/** A DOM label pinned to a world position; positions are projected every frame without re-rendering. */
export interface Anchor {
  key: string;
  position: [number, number, number];
  content: ReactNode;
  /** `above`: a callout that floats over its point with a tail, so the point itself stays visible. */
  placement?: 'above' | 'center';
  /** Anchors in a group are spread out so they never overlap (e.g. floor tags 3 m apart). */
  group?: 'floors' | 'counts';
  /** Higher wins when callouts collide: the loser flips below its point, or hides if it still overlaps. */
  priority?: number;
}

export default function BuildingScene({ building, directive, insets, onFocusFloor, world, onPin, onPerson, onRoute, onSetLocation, myRoom, onSimulate }: Props) {
  const model = useMemo(() => buildModel(building), [building]);
  const poses = useMemo(() => layoutFloors(model, directive.focus), [model, directive.focus]);
  const litAssets = useMemo(() => new Set(directive.assets ?? []), [directive.assets]);
  const hazards = useMemo(() => {
    const map = new Map<string, { kind: HazardKind; level: number }[]>();
    for (const h of directive.hazards ?? []) if (h.level > 0.02) map.set(h.spaceId, [...(map.get(h.spaceId) ?? []), { kind: h.kind, level: h.level }]);
    return map;
  }, [directive.hazards]);
  const overview = directive.focus.mode === 'building';
  // Hazard levels change every frame while a simulation plays: they must not reset labels, routes or the tapped room.
  const directiveKey = useMemo(() => JSON.stringify({ ...directive, hazards: undefined, minute: undefined, evacuees: undefined }), [directive]);
  const [hovered, setHovered] = useState<string | null>(null);
  // A tapped room keeps its tip (with "Route here") until the answer changes or the user taps elsewhere.
  const [selected, setSelected] = useState<{ id: string; directive: string } | null>(null);
  const picked = selected && selected.directive === directiveKey && !overview ? selected.id : null;
  // The answer's rooms keep their colours; a tapped room is tinted light blue instead of being covered by a label.
  const tones = useMemo(() => {
    const map = new Map((directive.highlights ?? []).map(h => [h.spaceId, h.tone]));
    if (picked && !map.has(picked)) map.set(picked, 'secondary');
    return map;
  }, [directive.highlights, picked]);
  const anchors = useMemo(() => [
    ...answerAnchors(model, poses, directive),
    ...(hovered && !overview && hovered !== picked ? hoverAnchor(model, poses, hovered) : []),
  ], [model, poses, directive, overview, hovered, picked]);
  const persistent = useMemo(() => world ? worldAnchors(model, poses, directive.focus, world, { onPin, onPerson, onFocusFloor }) : [], [model, poses, directive.focus, world, onPin, onPerson, onFocusFloor]);
  const projected = useMemo(() => [...anchors, ...persistent], [anchors, persistent]);
  const routePaths = useMemo(() => (directive.routes ?? []).map(r => (r.points ?? []).filter(p => shown(poses, p.floorId)).map(p => worldAt(model, poses, p, ROUTE_HEIGHT))), [directive.routes, model, poses]);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const register = useCallback((key: string) => (el: HTMLDivElement | null) => {
    if (el) elements.current.set(key, el); else elements.current.delete(key);
  }, []);
  const inspect = useCallback((id: string | null) => { setHovered(id); document.body.style.cursor = id ? 'help' : ''; }, []);
  const select = useCallback((id: string) => setSelected({ id, directive: directiveKey }), [directiveKey]);
  // Esc first leaves a zoomed-in room (back to its floor) before the page's own Esc handling.
  useEffect(() => {
    if (!picked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      setSelected(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [picked]);
  // Phones get a lighter GPU budget: lower pixel ratio and smaller shadow maps.
  const coarse = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  // Like a map/satellite switch: plain blocks or the detailed model with walls, floors and furniture. Remembered per browser.
  const [style, setStyle] = useState<SceneStyle>(() => (localStorage.getItem(STYLE_KEY) === 'detailed' ? 'detailed' : 'blocks'));
  const chooseStyle = (next: SceneStyle) => { setStyle(next); localStorage.setItem(STYLE_KEY, next); };
  const detailed = style === 'detailed';
  const textures = useTextures(detailed);
  const models = useAssetModels(useMemo(() => building.assets.map(asset => asset.type), [building]), detailed);
  // Where people stand on a floor: on the slab (detailed) or on the block tops (blocks).
  const floorBase = useCallback((floorId: string) => {
    const f = model.floors.find(floor => floor.floor.id === floorId);
    const pose = poses.get(floorId);
    return detailed ? SLAB : f && pose ? blockHeight(f.storey, pose.flat) : 0;
  }, [model, poses, detailed]);

  return (
    <div className="scene-root">
      <Canvas shadows="percentage" dpr={coarse ? [1, 1.5] : [1, 2]} onPointerMissed={() => { inspect(null); setSelected(null); }} camera={{ fov: 32, near: 0.5, far: 4000, position: [120, 110, 160] }} gl={{ antialias: true }}>
        <color attach="background" args={[palette.background]} />
        <fog attach="fog" args={[palette.background, 400, 1400]} />
        {/* Bright, soft studio light so the model reads white, like Synera's renders. */}
        <ambientLight intensity={0.55} />
        <hemisphereLight args={['#ffffff', '#e8edf4', 1.7]} />
        <directionalLight position={[60, 120, 40]} intensity={1.25} castShadow shadow-mapSize={coarse ? [1024, 1024] : [2048, 2048]} shadow-camera-left={-150} shadow-camera-right={150} shadow-camera-top={150} shadow-camera-bottom={-150} shadow-camera-far={500} />
        <CameraRig model={model} poses={poses} directive={directive} insets={insets} room={picked} />
        {model.floors.map(floor => (
          <FloorView key={floor.floor.id} model={floor} toWorld={model.toWorld} pose={poses.get(floor.floor.id)!} tones={tones} litAssets={litAssets} overview={overview} style={style} textures={textures} models={models} hazards={hazards} onPick={onFocusFloor} onInspect={inspect} onSelect={select} />
        ))}
        <Ground y={(model.floors[0]?.floor.elevation_m ?? 0) - 0.02} />
        {directive.evacuees && <People model={model} poses={poses} evacuees={directive.evacuees} minute={directive.minute ?? 0} speed={directive.walkMPerMin ?? 60} floorBase={floorBase} />}
        <Overlays key={directiveKey} model={model} poses={poses} directive={directive} />
        {directive.focus.mode === 'floor' && directive.focus.around && (
          <Cursor key={`cursor-${directiveKey}`} position={worldAt(model, poses, { floorId: directive.focus.floorId, position: directive.focus.around }, 1.7)} />
        )}
        <Projector anchors={projected} elements={elements} topInset={insets.top} paths={routePaths} />
      </Canvas>
      <div className="scene-anchors" key={directiveKey}>
        {anchors.map(anchor => <div key={anchor.key} ref={register(anchor.key)} className="scene-anchor">{anchor.content}</div>)}
      </div>
      <div className="scene-anchors">
        {persistent.map(anchor => <div key={anchor.key} ref={register(anchor.key)} className={`scene-anchor${anchor.placement === 'above' ? ' scene-anchor--above' : ''}`}>{anchor.content}</div>)}
      </div>
      {picked && <RoomCard model={model} spaceId={picked} style={{ left: insets.left + 12, top: insets.top + 84 }} onRoute={onRoute} onSetLocation={onSetLocation} myRoom={myRoom} onSimulate={onSimulate} onClose={() => setSelected(null)} />}
      <div className="scene-style" role="group" aria-label="Map style" style={{ left: insets.left + 12, top: insets.top + 12 }}>
        {(['blocks', 'detailed'] as const).map(option => (
          <button type="button" key={option} className={`scene-style-option scene-style-option--${option}`} aria-pressed={style === option} onClick={() => chooseStyle(option)}>
            <span className="scene-style-preview" aria-hidden />
            {option === 'blocks' ? 'Blocks' : 'Detailed'}
          </button>
        ))}
      </div>
    </div>
  );
}

const STYLE_KEY = 'lf-scene-style';
const FLOOR_TAG_GAP_PX = 30;
const EDGE_MARGIN_PX = 14;
const TAIL_PX = 12;

type Rect = { l: number; t: number; r: number; b: number };
type Side = 'above' | 'below' | 'right' | 'left' | 'center';

/** Does a screen segment cross a rectangle (with a few pixels of padding)? */
function segmentHitsRect([x1, y1, x2, y2]: [number, number, number, number], r: Rect, pad = 4) {
  const l = r.l - pad, t = r.t - pad, rr = r.r + pad, b = r.b + pad;
  const inside = (x: number, y: number) => x >= l && x <= rr && y >= t && y <= b;
  if (inside(x1, y1) || inside(x2, y2)) return true;
  const cross = (ax: number, ay: number, bx: number, by: number) => {
    const d = (x2 - x1) * (by - ay) - (y2 - y1) * (bx - ax);
    if (!d) return false;
    const u = ((ax - x1) * (by - ay) - (ay - y1) * (bx - ax)) / d, w = ((ax - x1) * (y2 - y1) - (ay - y1) * (x2 - x1)) / d;
    return u >= 0 && u <= 1 && w >= 0 && w <= 1;
  };
  return cross(l, t, rr, t) || cross(rr, t, rr, b) || cross(rr, b, l, b) || cross(l, b, l, t);
}
const overlaps = (a: Rect, b: Rect) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

function Projector({ anchors, elements, topInset, paths }: { anchors: Anchor[]; elements: RefObject<Map<string, HTMLDivElement>>; topInset: number; paths: [number, number, number][][] }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const placed: { anchor: Anchor; el: HTMLDivElement; x: number; y: number; visible: boolean }[] = [];
    for (const anchor of anchors) {
      const el = elements.current.get(anchor.key);
      if (!el) continue;
      const p = v.set(...anchor.position).project(camera);
      placed.push({ anchor, el, x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height, visible: p.z < 1 });
    }
    // Floor tags (and the world's per-floor counts): one evenly spaced column in floor order, centred where the floors are, clear of the floor rail.
    for (const group of ['floors', 'counts'] as const) {
      const floors = placed.filter(a => a.anchor.group === group);
      if (floors.length > 1) {
        const order = [...floors].sort((a, b) => b.y - a.y); // lowest floor (largest y) first
        const column = Math.min(Math.max(...floors.map(a => a.x)), size.width - 160);
        const mean = floors.reduce((sum, a) => sum + a.y, 0) / floors.length;
        const spread = Math.max(FLOOR_TAG_GAP_PX, (order[0].y - order.at(-1)!.y) / (order.length - 1));
        order.forEach((a, i) => { a.x = column; a.y = mean + ((order.length - 1) / 2 - i) * spread; });
      }
    }
    // Route polylines on screen: labels must not cover the path, e.g. where it leaves the start room.
    const segments: [number, number, number, number][] = [];
    for (const path of paths) {
      let prev: [number, number] | undefined;
      for (const point of path) {
        const p = v.set(...point).project(camera);
        const cur: [number, number] = [((p.x + 1) / 2) * size.width, ((1 - p.y) / 2) * size.height];
        if (prev && p.z < 1) segments.push([prev[0], prev[1], cur[0], cur[1]]);
        prev = cur;
      }
    }
    // Callouts: highest priority first; each takes the first side (above, below, right, left) that is free.
    const taken: Rect[] = [];
    const callouts = placed.filter(a => a.anchor.group !== 'floors').sort((a, b) => (b.anchor.priority ?? 1) - (a.anchor.priority ?? 1));
    for (const item of [...placed.filter(a => a.anchor.group === 'floors'), ...callouts]) {
      const { anchor, el, x, y, visible } = item;
      const w = el.offsetWidth, h = el.offsetHeight, half = w / 2;
      const clampX = (cx: number) => THREE.MathUtils.clamp(cx, half + EDGE_MARGIN_PX, Math.max(half + EDGE_MARGIN_PX, size.width - half - EDGE_MARGIN_PX));
      const place = (s: Side): { rect: Rect; cx: number; cy: number } => {
        if (s === 'right') return { cx: x + TAIL_PX + half, cy: y, rect: { l: x + TAIL_PX, r: x + TAIL_PX + w, t: y - h / 2, b: y + h / 2 } };
        if (s === 'left') return { cx: x - TAIL_PX - half, cy: y, rect: { l: x - TAIL_PX - w, r: x - TAIL_PX, t: y - h / 2, b: y + h / 2 } };
        const cx = clampX(x);
        if (s === 'above') return { cx, cy: y - TAIL_PX - h / 2, rect: { l: cx - half, r: cx + half, t: y - h - TAIL_PX, b: y - TAIL_PX } };
        if (s === 'below') return { cx, cy: y + TAIL_PX + h / 2, rect: { l: cx - half, r: cx + half, t: y + TAIL_PX, b: y + h + TAIL_PX } };
        return { cx, cy: y, rect: { l: cx - half, r: cx + half, t: y - h / 2, b: y + h / 2 } };
      };
      const free = (r: Rect) => r.t >= topInset + 4 && r.l >= 4 && r.r <= size.width - 4 && !taken.some(t => overlaps(t, r)) && !segments.some(seg => segmentHitsRect(seg, r));
      let side: Side = anchor.placement === 'above' ? 'above' : 'center';
      let show = visible;
      if (show && side === 'above') {
        const sides = ['above', 'below', 'right', 'left'] as const;
        const onScreen = (r: Rect) => r.t >= topInset + 4 && r.b <= size.height - 4 && r.l >= 4 && r.r <= size.width - 4;
        const choice = sides.find(s => free(place(s).rect));
        if (choice) side = choice;
        // Route stops and the answer always stay: first avoid other labels (even if touching the line), then just stay on screen.
        else if ((anchor.priority ?? 1) >= 2.5) side = sides.find(s => onScreen(place(s).rect) && !taken.some(t => overlaps(t, place(s).rect))) ?? sides.find(s => onScreen(place(s).rect)) ?? 'above';
        else show = false;
      }
      const { rect, cx, cy } = place(side);
      if (show) taken.push(rect);
      el.dataset.side = side;
      el.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
      // The tail keeps pointing at the real spot when the label is pushed back on screen.
      el.style.setProperty('--tail-shift', `${x - cx}px`);
      el.style.visibility = show ? 'visible' : 'hidden';
    }
  });
  return null;
}

/** `room`: a tapped room; the camera flies in close enough to see what is inside, and back out when it is cleared. */
function CameraRig({ model, poses, directive, insets, room }: { model: BuildingModel; poses: Map<string, FloorPose>; directive: SceneDirective; insets: SceneInsets; room?: string | null }) {
  const controls = useRef<CameraControls>(null);
  const { size, camera } = useThree();
  // Frame the answer: the spaces it names or counts and its reference room, not the background candidates.
  const frame = useMemo(() => directive.frameSpaces ?? (directive.frameAll ? [] : (directive.highlights ?? []).filter(h => h.tone !== 'muted').map(h => h.spaceId)), [directive.highlights, directive.frameAll, directive.frameSpaces]);
  const routePoints = useMemo(() => (directive.frameAll ? [] : [...(directive.routes ?? []).flatMap(r => r.points ?? []), ...(directive.links ?? []).flatMap(l => [l.from, l.to])]), [directive.routes, directive.links, directive.frameAll]);
  const focusKey = JSON.stringify([directive.focus, frame, routePoints.length, room]);
  const first = useRef(true);
  useEffect(() => {
    const c = controls.current;
    if (!c || !(camera instanceof THREE.PerspectiveCamera)) return;
    const box = (room && roomBox(model, poses, room)) || focusBox(model, poses, directive.focus, frame, routePoints);
    const centre = box.getCenter(new THREE.Vector3());
    const extent = box.getSize(new THREE.Vector3());
    const radius = Math.max(4, 0.5 * Math.hypot(extent.x, extent.z, directive.focus.mode === 'floor' ? 0 : extent.y));
    // Fit the bounding sphere into the part of the viewport not covered by the chat UI.
    const right = insets.right ?? 0;
    const freeW = Math.max(0.2, (size.width - insets.left - right) / size.width);
    const freeH = Math.max(0.15, (size.height - insets.top - insets.bottom) / size.height);
    const vfov = THREE.MathUtils.degToRad(camera.fov) * freeH;
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect) * freeW;
    const distance = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * (directive.focus.mode === 'building' ? 0.56 : directive.focus.mode === 'xray' ? 0.6 : 0.72);
    const polar = room ? 0.32 : directive.focus.mode === 'floor' ? 0.5 : directive.focus.mode === 'stack' ? 1.1 : directive.focus.mode === 'xray' ? 0.9 : 0.95;
    const azimuth = first.current ? Math.PI / 5 : c.azimuthAngle;
    const offset = new THREE.Vector3().setFromSphericalCoords(distance, polar, azimuth);
    const smooth = !first.current;
    first.current = false;
    c.setLookAt(centre.x + offset.x, centre.y + offset.y, centre.z + offset.z, centre.x, centre.y, centre.z, smooth);
    // Shift the picture into the free area. Focal offset is in screen axes (Y down): move the camera left/down.
    const worldPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / size.height;
    c.setFocalOffset(-((insets.left - right) / 2) * worldPerPx, ((insets.bottom - insets.top) / 2) * worldPerPx, 0, smooth);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-frame only when the focus or the free area changes
  }, [focusKey, insets.top, insets.left, insets.bottom, insets.right, size.width, size.height]);
  return <CameraControls ref={controls} makeDefault smoothTime={0.85} minDistance={4} maxDistance={1500} maxPolarAngle={Math.PI / 2 - 0.08} />;
}

/** A room and a little of its surroundings, at least 9 m across so small rooms keep some context. */
function roomBox(model: BuildingModel, poses: Map<string, FloorPose>, spaceId: string) {
  const m = model.spaces.get(spaceId);
  if (!m) return null;
  m.geometry.computeBoundingBox();
  const b = m.geometry.boundingBox!.clone().translate(new THREE.Vector3(0, poses.get(m.space.floor_id)?.y ?? 0, 0));
  const c = b.getCenter(new THREE.Vector3());
  const half = Math.max(b.max.x - b.min.x, b.max.z - b.min.z, 9) / 2 + 1;
  return new THREE.Box3(new THREE.Vector3(c.x - half, b.min.y, c.z - half), new THREE.Vector3(c.x + half, b.min.y + 1, c.z + half));
}

function damp(current: number, target: number, delta: number, lambda = 4) {
  return THREE.MathUtils.damp(current, target, lambda, delta);
}

type FloorMaterials = Record<'room' | 'hall' | 'corridor' | 'core' | Tone | 'asset' | 'wall', THREE.MeshStandardMaterial> & { edge: THREE.LineBasicMaterial; floors: Record<FloorTexture, THREE.MeshStandardMaterial> };

interface FloorViewProps {
  model: FloorModel;
  toWorld: BuildingModel['toWorld'];
  pose: FloorPose;
  tones: Map<string, Tone>;
  /** Assets whose boxes turn orange (the answer to "where is …"). */
  litAssets: Set<string>;
  overview: boolean;
  style: SceneStyle;
  textures: ReturnType<typeof useTextures>;
  models: ReturnType<typeof useAssetModels>;
  /** Spaces on fire, flooded or without power, with their level right now. */
  hazards: Map<string, { kind: HazardKind; level: number }[]>;
  onPick(floorId: string): void;
  /** Show a room's name and area: hover with a mouse, tap on touch. */
  onInspect(spaceId: string | null): void;
  /** A tap on a room of the shown floor. */
  onSelect(spaceId: string): void;
}

function FloorView({ model, toWorld, pose, tones, litAssets, overview, style, textures, models, hazards, onPick, onInspect, onSelect }: FloorViewProps) {
  const group = useRef<THREE.Group>(null);
  const blocks = useRef<THREE.Group>(null);
  const walls = useRef<THREE.Mesh>(null);
  const doors = useRef<THREE.Group>(null);
  const furniture = useRef<THREE.Group>(null);
  const hazardLayer = useRef<THREE.Group>(null);
  const edges = useRef<THREE.LineSegments>(null);
  const detailed = style === 'detailed';
  const raised = useRef<Record<Tone, THREE.Group | null>>({ primary: null, secondary: null, muted: null });
  const state = useRef({ opacity: pose.opacity, flat: pose.flat, y: pose.y });
  const materials = useMemo((): FloorMaterials => {
    const surface = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    return {
      room: surface(palette.room), hall: surface(palette.hall), corridor: surface(palette.corridor), core: surface(palette.core),
      primary: surface(palette.primary), secondary: surface(palette.secondary), muted: surface(palette.muted), asset: surface(palette.asset),
      wall: Object.assign(surface('#ffffff'), { vertexColors: true }),
      edge: new THREE.LineBasicMaterial({ color: palette.edge, transparent: true }),
      floors: Object.fromEntries(FLOOR_TEXTURES.map(name => [name, surface('#ffffff')])) as Record<FloorTexture, THREE.MeshStandardMaterial>,
    };
  }, []);
  useEffect(() => () => { const { floors, ...rest } = materials; [...Object.values(rest), ...Object.values(floors)].forEach(m => m.dispose()); }, [materials]);
  // Textures arrive in the background; plain surfaces until then.
  useEffect(() => {
    const assign = (material: THREE.MeshStandardMaterial, texture: THREE.Texture | undefined) => {
      if (material.map === (texture ?? null)) return;
      material.map = texture ?? null;
      material.needsUpdate = true;
    };
    for (const name of FLOOR_TEXTURES) assign(materials.floors[name], textures.get(name));
    assign(materials.wall, textures.get('plaster'));
  }, [materials, textures]);
  const detail = useMemo(() => buildFloorDetail(model, toWorld), [model, toWorld]);
  useEffect(() => () => detail.walls.dispose(), [detail]);
  const assets = useMemo(() => buildAssets(model, toWorld), [model, toWorld]);
  useEffect(() => { if (assets) colorAssets(assets, model, litAssets); }, [assets, model, litAssets]);

  useFrame((_, delta) => {
    const s = state.current;
    s.opacity = damp(s.opacity, pose.opacity, delta, 5);
    s.flat = damp(s.flat, pose.flat, delta, 3.5);
    s.y = damp(s.y, pose.y, delta, 3.5);
    if (!group.current || !blocks.current) return;
    group.current.position.y = s.y;
    group.current.visible = s.opacity > 0.01;
    // Detailed: rooms are thin slabs (highlights a little thicker) with walls standing on them.
    const top = detailed ? SLAB : blockHeight(model.storey, s.flat);
    blocks.current.scale.y = top;
    for (const tone of ['primary', 'secondary', 'muted'] as const) {
      const g = raised.current[tone];
      if (g) g.scale.y = detailed ? SLAB + 0.03 + lift[tone] * 0.05 : blockHeight(model.storey, s.flat, lift[tone]);
    }
    if (walls.current) {
      walls.current.visible = detailed;
      walls.current.position.y = SLAB;
      walls.current.scale.y = wallHeight(model.storey, s.flat);
    }
    if (edges.current) edges.current.visible = !detailed;
    if (doors.current) {
      // Blocks: doors only on an opened floor (on the block tops); detailed: wherever the floor is shown.
      doors.current.visible = s.opacity > 0.5 && (detailed || s.flat > 0.3);
      doors.current.position.y = detailed ? SLAB + 0.03 + lift.primary * 0.05 : top + 0.01;
    }
    if (hazardLayer.current) {
      // Just over the floor's top (slabs or blocks), so the tint reads from above and from the side.
      hazardLayer.current.scale.y = (detailed ? SLAB + 0.04 + lift.primary * 0.05 : blockHeight(model.storey, s.flat, lift.primary)) + 0.06;
      hazardLayer.current.visible = s.opacity > 0.3;
    }
    if (furniture.current) {
      furniture.current.visible = detailed && s.opacity > 0.5;
      furniture.current.position.y = SLAB;
    }
    applyFade(materials, assets, s, overview, blockHeight(model.storey, s.flat, lift.secondary) + 0.02);
  });

  const plain = model.spaces.filter(m => !tones.has(m.space.id));
  const tap = (id: string) => (event: ThreeEvent<MouseEvent>) => {
    if (overview) { event.stopPropagation(); onPick(model.floor.id); return; }
    if (pose.interactive) { event.stopPropagation(); onSelect(id); }
  };
  const hover = (id: string | null) => (event: ThreeEvent<PointerEvent>) => {
    if (!pose.interactive || overview || event.pointerType !== 'mouse') return;
    event.stopPropagation();
    onInspect(id);
  };

  return (
    <group ref={group} position-y={pose.y}>
      <group ref={blocks} scale-y={blockHeight(model.storey, pose.flat)}>
        {plain.map(m => (
          <mesh key={m.space.id} geometry={m.geometry} material={detailed ? floorMaterial(materials, m.space) : materials[surfaceFor(m.space.type)]} castShadow receiveShadow onClick={tap(m.space.id)} onPointerOver={hover(m.space.id)} onPointerOut={hover(null)} />
        ))}
        <lineSegments ref={edges} geometry={model.edges} material={materials.edge} renderOrder={1} />
      </group>
      <mesh ref={walls} geometry={detail.walls} material={materials.wall} visible={detailed} castShadow receiveShadow raycast={() => null} />
      <group ref={doors}><Doors doors={detail.doors} /></group>
      <group ref={hazardLayer}>
        {model.spaces.flatMap(m => (hazards.get(m.space.id) ?? []).map(h => (
          <mesh key={`${m.space.id}-${h.kind}`} geometry={m.geometry} material={hazardMaterial(h.kind, h.level)} renderOrder={3} raycast={() => null} scale-y={h.kind === 'electrical' ? 1.02 : 1} />
        )))}
      </group>
      {detailed && <group ref={furniture}><DetailedAssets floor={model} toWorld={toWorld} models={models} litAssets={litAssets} /></group>}
      {(['primary', 'secondary', 'muted'] as const).map(tone => (
        <group key={tone} ref={g => { raised.current[tone] = g; }} scale-y={blockHeight(model.storey, pose.flat, lift[tone])}>
          {model.spaces.filter(m => tones.get(m.space.id) === tone).map(m => (
            <mesh key={m.space.id} geometry={m.geometry} material={materials[tone]} castShadow receiveShadow onClick={tap(m.space.id)} onPointerOver={hover(m.space.id)} onPointerOut={hover(null)}>
              <lineSegments renderOrder={2}><edgesGeometry args={[m.geometry, 30]} /><lineBasicMaterial color={tone === 'primary' ? palette.primaryEdge : palette.edge} transparent opacity={0.9} /></lineSegments>
            </mesh>
          ))}
        </group>
      ))}
      {assets && !detailed && <primitive object={assets} />}
    </group>
  );
}

const HAZARD_STEPS = 8;
const hazardMaterials = new Map<string, THREE.MeshBasicMaterial>();
/** Shared translucent tints per hazard and level step (fire red, water blue, power yellow). */
function hazardMaterial(kind: HazardKind, level: number) {
  const step = Math.max(1, Math.min(HAZARD_STEPS, Math.round(level * HAZARD_STEPS)));
  const key = `${kind}-${step}`;
  let material = hazardMaterials.get(key);
  if (!material) {
    // A power cut is a light wash, so water and fire stay readable where they overlap.
    const [base, range] = kind === 'electrical' ? [0.08, 0.22] : [0.35, 0.55];
    material = new THREE.MeshBasicMaterial({ color: hazardMeta[kind].color, transparent: true, opacity: base + range * (step / HAZARD_STEPS), depthWrite: false, toneMapped: false });
    hazardMaterials.set(key, material);
  }
  return material;
}

/** Per-frame fade of a floor's shared materials (three.js objects are mutated imperatively). */
function applyFade(materials: FloorMaterials, assets: THREE.InstancedMesh | null, s: { opacity: number; flat: number }, overview: boolean, assetBase: number) {
  const ghost = s.opacity < 0.6;
  for (const material of [...(['room', 'hall', 'corridor', 'core', 'primary', 'secondary', 'muted', 'wall'] as const).map(key => materials[key]), ...Object.values(materials.floors)]) {
    material.opacity = s.opacity * (overview ? 0.94 : 1);
    material.depthWrite = !ghost;
  }
  materials.edge.opacity = Math.min(1, s.opacity * 1.6) * 0.85;
  materials.asset.opacity = s.opacity * s.flat;
  if (assets) {
    assets.visible = s.flat > 0.3 && s.opacity > 0.5;
    // Items stand on top of the room blocks (plain, muted or light blue); only raised orange rooms rise above them.
    assets.position.y = assetBase;
  }
}

/** Detailed style: the room's floor finish (carpet, epoxy, tiles…) where there is one. */
function floorMaterial(materials: FloorMaterials, space: Building['spaces'][number]) {
  const texture = floorTexture(space);
  return texture ? materials.floors[texture] : materials[surfaceFor(space.type)];
}

function surfaceFor(type: string): 'room' | 'hall' | 'corridor' | 'core' {
  if (type === 'corridor' || type === 'outdoor') return 'corridor';
  if (type === 'stair' || type === 'lift') return 'core';
  if (type === 'hall') return 'hall';
  return 'room';
}

const assetHeight: Record<string, number> = { furniture: 0.75, fixture: 0.9, machine: 1.6, equipment: 1.1 };

/** One instanced mesh per floor: a small box per asset footprint. */
function buildAssets(model: FloorModel, toWorld: BuildingModel['toWorld']) {
  if (!model.assets.length) return null;
  // White base material: each instance gets its own colour (grey, or orange when it's the answer).
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, transparent: true }), model.assets.length);
  const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  model.assets.forEach((asset, i) => {
    const h = assetHeight[asset.category] ?? 0.8;
    const [x, z] = toWorld(asset.position);
    q.setFromAxisAngle(up, THREE.MathUtils.degToRad(asset.footprint?.rotation_deg ?? 0));
    matrix.compose(new THREE.Vector3(x, h / 2, z), q, new THREE.Vector3(asset.footprint?.width_m ?? 0.6, h, asset.footprint?.depth_m ?? 0.6));
    mesh.setMatrixAt(i, matrix);
  });
  mesh.castShadow = true;
  mesh.raycast = () => {};
  colorAssets(mesh, model, new Set());
  return mesh;
}

const assetGrey = new THREE.Color(palette.asset), assetLit = new THREE.Color(palette.primary);

/** Per-instance colours; three.js objects are updated imperatively. */
function colorAssets(mesh: THREE.InstancedMesh, model: FloorModel, lit: Set<string>) {
  model.assets.forEach((asset, i) => mesh.setColorAt(i, lit.has(asset.id) ? assetLit : assetGrey));
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function Ground({ y }: { y: number }) {
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={y} receiveShadow>
      <planeGeometry args={[3000, 3000]} />
      <shadowMaterial transparent opacity={0.08} />
    </mesh>
  );
}

/** Overlays only belong on floors that are actually shown (not ghosted or lifted away). */
function shown(poses: Map<string, FloorPose>, floorId: string) {
  return (poses.get(floorId)?.opacity ?? 0) > 0.5;
}

/** Right-angle corner for a 3D link: below the higher end, at the lower end's height. */
function linkCorner(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  const [low, high] = a[1] <= b[1] ? [a, b] : [b, a];
  return [high[0], low[1], high[2]];
}

function worldAt(model: BuildingModel, poses: Map<string, FloorPose>, point: FloorPoint, above: number): [number, number, number] {
  const [x, z] = model.toWorld(point.position);
  return [x, (poses.get(point.floorId)?.y ?? 0) + above, z];
}

function answerAnchors(model: BuildingModel, poses: Map<string, FloorPose>, directive: SceneDirective): Anchor[] {
  const floorOf = new Map(model.floors.map(f => [f.floor.id, f]));
  const anchors: Anchor[] = [];
  // Route stops are labelled at the exact point the route starts or ends, right above its marker.
  const routeEnds = new Map<string, FloorPoint>();
  for (const route of directive.routes ?? []) {
    const pts = route.points ?? [], path = route.spacePath ?? [];
    if (pts.length && path.length) { if (!routeEnds.has(path[0])) routeEnds.set(path[0], pts[0]); routeEnds.set(path.at(-1)!, pts.at(-1)!); }
  }
  for (const h of directive.highlights ?? []) {
    const m = model.spaces.get(h.spaceId);
    const f = m && floorOf.get(m.space.floor_id);
    if (!h.label || !m || !f || !shown(poses, f.floor.id)) continue;
    const pose = poses.get(f.floor.id)!;
    const end = routeEnds.get(h.spaceId);
    const position: [number, number, number] = end ? worldAt(model, poses, end, ROUTE_HEIGHT) : [m.centre[0], pose.y + blockHeight(f.storey, pose.flat, lift[h.tone]) + 0.4, m.centre[1]];
    anchors.push({ key: `hl-${h.spaceId}`, position, placement: 'above', priority: h.tone === 'primary' ? 3 : end ? 2.5 : 2, content: <div className={`scene-label scene-label--${h.tone}`}>{h.label}</div> });
  }
  const markers = (directive.markers ?? []).filter(marker => shown(poses, marker.floorId) && marker.tone !== 'muted' && marker.label);
  if (markers.length <= 8) markers.forEach((marker, i) => anchors.push({ key: `mk-${i}`, position: worldAt(model, poses, marker, 2.9), placement: 'above', priority: marker.tone === 'primary' ? 3 : 2, content: <div className={`scene-label ${marker.tone === 'primary' ? 'scene-label--primary' : 'scene-label--marker'}`}>{marker.label}</div> }));
  (directive.links ?? []).forEach((link, i) => {
    if (!shown(poses, link.from.floorId) || !shown(poses, link.to.floorId)) return;
    const a = worldAt(model, poses, link.from, 1.2), b = worldAt(model, poses, link.to, 1.2);
    if (link.label) anchors.push({ key: `ln-${i}`, position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.6, (a[2] + b[2]) / 2], placement: 'above', priority: 3.5, content: <div className="scene-label scene-label--primary">{link.label}</div> });
  });
  (directive.closed ?? []).flatMap(id => model.anchors.get(id) ?? []).filter(point => shown(poses, point.floorId)).forEach((point, i) => anchors.push({ key: `cl-${i}`, position: worldAt(model, poses, point, 2), placement: 'above', priority: 1.5, content: <div className="scene-label scene-label--closed">Closed</div> }));
  return anchors;
}

/** Hover: the room's name and area. */
function hoverAnchor(model: BuildingModel, poses: Map<string, FloorPose>, spaceId: string): Anchor[] {
  const m = model.spaces.get(spaceId);
  const f = m && model.floors.find(floor => floor.floor.id === m.space.floor_id);
  if (!m || !f) return [];
  const pose = poses.get(f.floor.id)!;
  return [{ key: `hv-${spaceId}`, placement: 'above', priority: 4, position: [m.centre[0], pose.y + blockHeight(f.storey, pose.flat) + 0.6, m.centre[1]], content: (
    <div className="scene-tip"><strong>{m.space.name}</strong><span>{m.area.toFixed(1)} m²</span></div>
  ) }];
}

/** What is inside a room: "4 desks · 2 office chairs · …". */
function roomContents(model: BuildingModel, spaceId: string) {
  const m = model.spaces.get(spaceId);
  const f = m && model.floors.find(floor => floor.floor.id === m.space.floor_id);
  const counts = new Map<string, number>();
  for (const asset of f?.assets ?? []) if (asset.space_id === spaceId) counts.set(asset.type, (counts.get(asset.type) ?? 0) + 1);
  const contents = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = contents.slice(0, 6).map(([type, n]) => `${n} ${type.replaceAll('_', ' ')}${n > 1 ? (/(s|sh|ch|x)$/.test(type) ? 'es' : 's') : ''}`);
  if (contents.length > 6) shown.push(`+${contents.length - 6} more`);
  return shown;
}

/** Details of the tapped room, docked in the corner instead of floating over the model. */
function RoomCard({ model, spaceId, style, onRoute, onSetLocation, myRoom, onSimulate, onClose }: {
  model: BuildingModel; spaceId: string; style: React.CSSProperties;
  onRoute?: (spaceId: string) => void; onSetLocation?: (spaceId: string) => void; myRoom?: string;
  onSimulate?: (spaceId: string, hazard: HazardKind) => void; onClose(): void;
}) {
  const m = model.spaces.get(spaceId);
  if (!m) return null;
  const contents = roomContents(model, spaceId);
  const here = myRoom === spaceId;
  return (
    <aside className="room-card" style={style} aria-label={m.space.name}>
      <button type="button" className="room-card-close" onClick={onClose} aria-label="Close (Esc)">×</button>
      <strong>{m.space.name}</strong>
      <span className="room-card-meta">{m.area.toFixed(1)} m²{m.space.room_type ? ` · ${m.space.room_type.replaceAll('_', ' ')}` : ''}</span>
      <span className="room-card-contents">{contents.length ? contents.join(' · ') : 'Nothing inside'}</span>
      {(onRoute || onSetLocation) && (
        <div className="room-card-actions">
          {onRoute && !here && <button type="button" onClick={() => onRoute(spaceId)}>Route here</button>}
          {onSetLocation && (here ? <span className="scene-tip-here">📍 You are here</span> : <button type="button" onClick={() => onSetLocation(spaceId)}>I&apos;m here</button>)}
        </div>
      )}
      {onSimulate && (
        <div className="room-card-simulate" role="group" aria-label="Simulate here">
          <span>Simulate here</span>
          {(['fire', 'water', 'electrical'] as const).map(kind => (
            <button type="button" key={kind} className={`hazard-chip hazard-chip--${kind}`} onClick={() => onSimulate(spaceId, kind)}>{hazardMeta[kind].icon} {kind === 'electrical' ? 'Power' : hazardMeta[kind].label.split(' ')[0]}</button>
          ))}
        </div>
      )}
    </aside>
  );
}

/** Routes, link lines and markers, positioned against the target floor poses. */
function Overlays({ model, poses, directive }: { model: BuildingModel; poses: Map<string, FloorPose>; directive: SceneDirective }) {
  const at = (point: FloorPoint, above: number) => worldAt(model, poses, point, above);
  const visible = (points: FloorPoint[]) => points.every(point => shown(poses, point.floorId));
  return <>
    {(directive.markers ?? []).filter(marker => shown(poses, marker.floorId)).map((marker, i) => marker.tone === 'muted' ? (
      <mesh key={i} position={at(marker, 1.15)}><cylinderGeometry args={[0.45, 0.45, 0.12, 20]} /><meshStandardMaterial color={palette.warning} /></mesh>
    ) : (
      <group key={i} position={at(marker, 0)}>
        <mesh position-y={2.4} castShadow><sphereGeometry args={[0.45, 20, 20]} /><meshStandardMaterial color={marker.tone === 'primary' ? palette.primary : palette.ink} /></mesh>
        <mesh position-y={1.2}><cylinderGeometry args={[0.06, 0.06, 2.4, 8]} /><meshStandardMaterial color={palette.ink} /></mesh>
      </group>
    ))}
    {(directive.routes ?? []).map(route => (route.points ?? []).filter(p => shown(poses, p.floorId))).filter(points => points.length >= 2).map((points, i) => <RouteLine key={i} points={points.map(p => at(p, ROUTE_HEIGHT))} />)}
    {(directive.routes ?? []).map((route, i, all) => {
      const pts = route.points ?? [];
      const first = pts[0], last = pts.at(-1);
      return <group key={`ends-${i}`}>
        {i === 0 && first && shown(poses, first.floorId) && <RouteEnd kind="origin" position={at(first, ROUTE_HEIGHT)} />}
        {last && shown(poses, last.floorId) && <RouteEnd kind={i === all.length - 1 ? 'destination' : 'stop'} position={at(last, ROUTE_HEIGHT)} />}
      </group>;
    })}
    {(directive.links ?? []).filter(link => visible([link.from, link.to])).map((link, i) => {
      const a = at(link.from, 1.2), b = at(link.to, 1.2);
      const corner = linkCorner(a, b);
      return <group key={i}>
        <RouteLine points={[a, b]} />
        {link.breakdown && <Line points={[a[1] <= b[1] ? a : b, corner, a[1] <= b[1] ? b : a]} color={palette.edge} lineWidth={1.5} dashed dashSize={0.5} gapSize={0.4} transparent opacity={0.9} depthTest={false} renderOrder={4} />}
        {[a, b].map((p, j) => <mesh key={j} position={p}><sphereGeometry args={[0.5, 20, 20]} /><meshStandardMaterial color={palette.ink} /></mesh>)}
      </group>;
    })}
  </>;
}

const ROUTE_HEIGHT = 1.6;

/** Route ends, styled like the directions panel: hollow ring = start, orange ring = destination. Constant size on screen. */
function RouteEnd({ kind, position }: { kind: 'origin' | 'stop' | 'destination'; position: [number, number, number] }) {
  const group = useRef<THREE.Group>(null);
  const at = useMemo(() => new THREE.Vector3(...position), [position]);
  useFrame(({ camera, size }) => {
    if (!group.current || !(camera instanceof THREE.PerspectiveCamera)) return;
    // World size of ~14 px at this distance.
    const perPx = (2 * camera.position.distanceTo(at) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / size.height;
    group.current.scale.setScalar(perPx * 14);
  });
  // Ring nodes as in Synera's imagery: navy = you, violet = a stop, orange = the destination (with a dot).
  const [ring, centre, centreSize] = kind === 'origin' ? [palette.ink, '#ffffff', 0.5] : kind === 'stop' ? [palette.stop, '#ffffff', 0.5] : [palette.primary, '#ffffff', 0.5];
  // Transparent so they render in the same pass as the (transparent) room blocks, after them.
  const disc = (radius: number, color: string, order: number) => (
    <mesh renderOrder={order}><circleGeometry args={[radius, 40]} /><meshBasicMaterial color={color} transparent depthTest={false} depthWrite={false} /></mesh>
  );
  return (
    <group ref={group} position={position} rotation-x={-Math.PI / 2}>
      {disc(1.12, '#ffffff', 8)}
      {disc(0.92, ring, 9)}
      {disc(centreSize, centre, 10)}
      {kind === 'destination' && disc(0.24, palette.primary, 11)}
    </group>
  );
}

function gradientAt(t: number): [number, number, number] {
  const x = THREE.MathUtils.clamp(t, 0, 1) * (routeGradient.length - 1);
  const i = Math.min(Math.floor(x), routeGradient.length - 2);
  const c = routeGradient[i].clone().lerp(routeGradient[i + 1], x - i);
  return [c.r, c.g, c.b];
}

/** Pulsing ring that marks where a route step happens. */
function Cursor({ position }: { position: [number, number, number] }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ring.current) return;
    const t = (clock.elapsedTime % 1.4) / 1.4;
    ring.current.scale.setScalar(0.6 + t * 1.6);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 1 - t;
  });
  return (
    <group position={position}>
      <mesh rotation-x={-Math.PI / 2} renderOrder={7}><circleGeometry args={[0.55, 32]} /><meshBasicMaterial color={palette.ink} transparent depthTest={false} depthWrite={false} /></mesh>
      <mesh ref={ring} rotation-x={-Math.PI / 2} renderOrder={7}><ringGeometry args={[0.7, 0.95, 40]} /><meshBasicMaterial color="#004fab" transparent depthTest={false} /></mesh>
    </group>
  );
}

function RouteLine({ points }: { points: [number, number, number][] }) {
  const line = useRef<Line2>(null);
  const walker = useRef<THREE.Mesh>(null);
  const curve = useMemo(() => {
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < points.length - 1; i++) path.add(new THREE.LineCurve3(new THREE.Vector3(...points[i]), new THREE.Vector3(...points[i + 1])));
    return path;
  }, [points]);
  // Colour each point by how far along the route it is (start blue, end coral).
  const colors = useMemo(() => {
    const total = curve.getLength() || 1;
    const out: [number, number, number][] = [];
    for (let i = 0, walked = 0; i < points.length; i++) {
      if (i > 0) walked += new THREE.Vector3(...points[i]).distanceTo(new THREE.Vector3(...points[i - 1]));
      out.push(gradientAt(walked / total));
    }
    return out;
  }, [curve, points]);
  const clock = useRef(0);
  useFrame((_, delta) => {
    clock.current += delta;
    const reveal = THREE.MathUtils.clamp((clock.current - 0.9) / 0.6, 0, 1);
    if (line.current) {
      line.current.material.opacity = reveal;
    }
    if (walker.current && curve.curves.length) {
      walker.current.visible = reveal > 0.5;
      walker.current.position.copy(curve.getPointAt((clock.current * 0.12) % 1));
    }
  });
  if (points.length < 2) return null;
  return <>
    {/* Solid gradient path, as in Synera's imagery; the moving dot shows the direction. */}
    <Line ref={line} points={points} vertexColors={colors} color="#ffffff" lineWidth={5} transparent opacity={0} depthTest={false} renderOrder={5} />
    <mesh ref={walker} renderOrder={6}><sphereGeometry args={[0.6, 24, 24]} /><meshBasicMaterial color="#ffffff" depthTest={false} /></mesh>
  </>;
}
