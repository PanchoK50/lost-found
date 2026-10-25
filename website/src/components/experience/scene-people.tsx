'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { FloorPoint } from '@/lib/chat/contract';
import type { BuildingModel, FloorPose } from './scene-model';

/** People walking out during a drill: one entry per room, drawn as a few figures following the room's way out. */
export interface Evacuee { id: string; path: FloorPoint[]; startMin: number; outMin?: number; count: number; cutOff?: boolean; firefighter?: boolean; speed?: number }

const MAX_FIGURES = 320;
const PER_ROOM = 4;
const QUEUE_MIN = 0.06;  // figures from one room leave a few seconds apart
// Waiting for the exit: one behind the other on their own way out, the first this far before the door.
const QUEUE_FRONT_M = 0.6;
const QUEUE_GAP_M = 0.5;
// Walking: a small step to the side of the route, so a room's people don't walk in single file but stay off the walls.
const WALK_SIDE_M = 0.2;
// A little larger than life, so people read at building scale.
// Mii-style figures: a round head on a small rounded body (no arms), a little larger than life to read at
// building scale. Both stand on y = 0.
const FIGURE_SCALE = 1.35;
const BODY = new THREE.CapsuleGeometry(0.25, 0.5, 6, 14);
BODY.translate(0, 0.52, 0);
const HEAD = new THREE.SphereGeometry(0.29, 20, 16);
HEAD.translate(0, 1.32, 0);
const SHIRTS = ['#2f6fdf', '#e5484d', '#2f9e62', '#f5a623', '#8a4fd8', '#f26a1b', '#1aa3b8', '#d6409f'].map(c => new THREE.Color(c));
const SKIN = ['#f6d7c3', '#e8b796', '#c98e6b', '#8d5a3b', '#f1c8a2'].map(c => new THREE.Color(c));
const TRAPPED = new THREE.Color('#ff2d3d');
// Fire brigade: dark tunic, yellow helmet.
const FIREFIGHTER = new THREE.Color('#1f2a44');
const HELMET = new THREE.Color('#ffd400');
// Few states, quiet colours: grey waiting, navy moving (walking or queuing), green safe, red only when trapped.

interface Figure { path: THREE.Vector3[]; floors: string[]; lengths: number[]; total: number; queueAt: number; start: number; out: number; offset: THREE.Vector2; cutOff: boolean; exitOut: THREE.Vector3 ; shirt: THREE.Color; skin: THREE.Color; firefighter: boolean; speed?: number }

/** The polyline segment [k - 1, k] holding the point `distance` metres along it. */
function segmentAt(lengths: number[], distance: number) {
  let k = 1;
  while (k < lengths.length - 1 && lengths[k] < distance) k++;
  return k;
}

/** Seeded jitter so figures stay put between renders. */
function jitter(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Little people for evacuation drills: they wait in their rooms, react to the alarm, walk their route (down the
 * stairs too) and gather outside the exit. People the fire cuts off stay put, flashing red.
 */
export function People({ model, poses, evacuees, minute, speed, floorBase }: {
  model: BuildingModel;
  poses: Map<string, FloorPose>;
  evacuees: Evacuee[];
  /** Minutes since the start of the simulation. */
  minute: number;
  /** Walking speed, metres per minute. */
  speed: number;
  /** Height of the walkable surface of a floor (block top or slab), relative to its pose. */
  floorBase(floorId: string | null): number;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const now = useRef(minute);
  useLayoutEffect(() => { now.current = minute; }, [minute]);

  const figures = useMemo(() => {
    const out: Figure[] = [];
    const total = evacuees.reduce((sum, e) => sum + Math.min(e.count, PER_ROOM), 0);
    const share = Math.min(1, MAX_FIGURES / Math.max(total, 1));
    evacuees.forEach((evacuee, roomIndex) => {
      const n = Math.max(1, Math.round(Math.min(evacuee.count, PER_ROOM) * share));
      const points = evacuee.path.map(p => {
        const [x, z] = model.toWorld(p.position);
        return new THREE.Vector3(x, (p.floorId === null ? 0 : poses.get(p.floorId)?.y ?? 0) + floorBase(p.floorId), z);
      });
      if (!points.length) return;
      const lengths = [0];
      for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + points[i].distanceTo(points[i - 1]));
      // Outside the exit: a few metres past the last door, away from the building centre.
      const last = points.at(-1)!, before = points.at(-2) ?? last;
      const out3 = last.clone().sub(before).setY(0);
      if (out3.lengthSq() < 1e-6) out3.set(last.x, 0, last.z);
      out3.normalize().multiplyScalar(3);
      for (let i = 0; i < n; i++) {
        const seed = roomIndex * 31 + i * 7 + 1;
        out.push({
          path: points, floors: evacuee.path.map(p => p.floorId ?? ''), lengths, total: lengths.at(-1)!, start: evacuee.startMin + i * QUEUE_MIN,
          queueAt: Math.max(0, lengths.at(-1)! - QUEUE_FRONT_M - i * QUEUE_GAP_M),
          // Through the exit door once the queue lets them (spread over the room's share of the wait).
          out: evacuee.outMin !== undefined ? Math.max(evacuee.startMin, evacuee.outMin - (n - 1 - i) * QUEUE_MIN) : Infinity,
          offset: new THREE.Vector2((jitter(seed) - 0.5) * 1.6, (jitter(seed + 3) - 0.5) * 1.6), cutOff: !!evacuee.cutOff, firefighter: !!evacuee.firefighter, speed: evacuee.speed,
          exitOut: last.clone().add(out3).add(new THREE.Vector3((jitter(seed + 5) - 0.5) * 3, 0, (jitter(seed + 9) - 0.5) * 3)),
          shirt: SHIRTS[Math.floor(jitter(seed + 11) * SHIRTS.length)], skin: SKIN[Math.floor(jitter(seed + 13) * SKIN.length)],
        });
      }
    });
    return out.slice(0, MAX_FIGURES);
  }, [evacuees, model, poses, floorBase]);

  const material = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.45 }), []);
  const headMaterial = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.6 }), []);
  const heads = useRef<THREE.InstancedMesh>(null);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const position = useMemo(() => new THREE.Vector3(), []);
  const scale = useMemo(() => new THREE.Vector3(), []);
  const turn = useMemo(() => new THREE.Quaternion(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame(({ clock }) => {
    const instance = mesh.current, headInstance = heads.current;
    if (!instance || !headInstance) return;
    const t = now.current;
    figures.forEach((figure, i) => {
      let floorId = figure.floors[0];
      let color: 'waiting' | 'walking' | 'queue' | 'safe' | 'trapped' = 'waiting';
      let s = 1;
      let heading = 0;
      if (figure.cutOff) {
        position.copy(figure.path[0]);
        position.x += figure.offset.x * 0.5; position.z += figure.offset.y * 0.5; // spread round the room
        color = 'trapped';
        s = t >= figure.start ? 1 + 0.15 * Math.sin(clock.elapsedTime * 8 + i) : 1;
      } else {
        const walked = Math.max(0, t - figure.start) * (figure.speed ?? speed);
        // Until the exit lets them through they only get as far as their place in the queue.
        const stop = t < figure.out ? figure.queueAt : figure.total;
        if (walked <= 0) {
          position.copy(figure.path[0]);
          position.y += Math.abs(Math.sin(clock.elapsedTime * 1.5 + i)) * 0.05; // idle bob
          position.x += figure.offset.x * 0.5; position.z += figure.offset.y * 0.5; // spread round the room
        } else if (walked >= figure.total && t >= figure.out) {
          position.copy(figure.exitOut);
          floorId = figure.floors.at(-1)!;
          color = 'safe';
        } else if (figure.path.length < 2) {
          position.copy(figure.path[0]);
          color = 'queue';
        } else {
          // Walking, or queuing for the exit at their place on the way to it.
          const queuing = walked >= stop;
          const along = queuing ? stop : walked;
          const k = segmentAt(figure.lengths, along);
          const a = figure.path[k - 1], b = figure.path[k];
          const span = figure.lengths[k] - figure.lengths[k - 1] || 1;
          position.lerpVectors(a, b, (along - figure.lengths[k - 1]) / span);
          floorId = figure.floors[(along - figure.lengths[k - 1]) / span < 0.5 ? k - 1 : k];
          // On the stairs between two floors: only drawn when both floors are on view (lifted-away floors would make them fly).
          const other = figure.floors[k - 1] === floorId ? figure.floors[k] : figure.floors[k - 1];
          if ((poses.get(other)?.opacity ?? 0) <= 0.5) floorId = other;
          heading = Math.atan2(b.x - a.x, b.z - a.z);
          // Sideways only: the route keeps off the walls, a step across it stays inside the room.
          const side = figure.offset.x / 0.8 * WALK_SIDE_M;
          position.x += Math.cos(heading) * side; position.z -= Math.sin(heading) * side;
          if (!queuing) position.y += Math.abs(Math.sin(clock.elapsedTime * 10 + i)) * 0.08; // walking bob
          color = queuing ? 'queue' : 'walking';
        }
      }
      const shown = (poses.get(floorId)?.opacity ?? 0) > 0.5;
      scale.setScalar(shown ? s * FIGURE_SCALE : 0);
      matrix.compose(position, turn.setFromAxisAngle(up, heading), scale);
      instance.setMatrixAt(i, matrix);
      // Shirts keep their colour; trapped people flash red.
      instance.setColorAt(i, figure.firefighter ? FIREFIGHTER : color === 'trapped' && Math.sin(clock.elapsedTime * 8 + i) > 0 ? TRAPPED : figure.shirt);
      headInstance.setMatrixAt(i, matrix);
      headInstance.setColorAt(i, figure.firefighter ? HELMET : figure.skin);
    });
    for (const m of [instance, headInstance]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  });

  if (!figures.length) return null;
  return <>
    <instancedMesh key={`b${figures.length}`} ref={mesh} args={[BODY, material, figures.length]} castShadow raycast={() => null} frustumCulled={false} />
    <instancedMesh key={`h${figures.length}`} ref={heads} args={[HEAD, headMaterial, figures.length]} castShadow raycast={() => null} frustumCulled={false} />
  </>;
}
