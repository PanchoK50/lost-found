'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { FloorPoint } from '@/lib/chat/contract';
import type { BuildingModel, FloorPose } from './scene-model';

/** People walking out during a drill: one entry per room, drawn as a few figures following the room's way out. */
export interface Evacuee { id: string; path: FloorPoint[]; startMin: number; outMin?: number; count: number; cutOff?: boolean }

const MAX_FIGURES = 320;
const PER_ROOM = 4;
const QUEUE_MIN = 0.06;  // figures from one room leave a few seconds apart
const BODY = new THREE.CapsuleGeometry(0.24, 1.05, 4, 10);
BODY.translate(0, 0.765, 0); // stand on y = 0
// Few states, quiet colours: grey waiting, navy moving (walking or queuing), green safe, red only when trapped.
const COLORS = { waiting: new THREE.Color('#9aa3b2'), walking: new THREE.Color('#002478'), queue: new THREE.Color('#002478'), safe: new THREE.Color('#2f8f5b'), trapped: new THREE.Color('#e5484d') };

interface Figure { path: THREE.Vector3[]; floors: string[]; lengths: number[]; total: number; start: number; out: number; offset: THREE.Vector2; cutOff: boolean; exitOut: THREE.Vector3 }

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
  floorBase(floorId: string): number;
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
        return new THREE.Vector3(x, (poses.get(p.floorId)?.y ?? 0) + floorBase(p.floorId), z);
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
          path: points, floors: evacuee.path.map(p => p.floorId), lengths, total: lengths.at(-1)!, start: evacuee.startMin + i * QUEUE_MIN,
          // Through the exit door once the queue lets them (spread over the room's share of the wait).
          out: evacuee.outMin !== undefined ? Math.max(evacuee.startMin, evacuee.outMin - (n - 1 - i) * QUEUE_MIN) : Infinity,
          offset: new THREE.Vector2((jitter(seed) - 0.5) * 1.6, (jitter(seed + 3) - 0.5) * 1.6), cutOff: !!evacuee.cutOff,
          exitOut: last.clone().add(out3).add(new THREE.Vector3((jitter(seed + 5) - 0.5) * 3, 0, (jitter(seed + 9) - 0.5) * 3)),
        });
      }
    });
    return out.slice(0, MAX_FIGURES);
  }, [evacuees, model, poses, floorBase]);

  const material = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.5 }), []);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const position = useMemo(() => new THREE.Vector3(), []);
  const scale = useMemo(() => new THREE.Vector3(), []);
  const turn = useMemo(() => new THREE.Quaternion(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame(({ clock }) => {
    const instance = mesh.current;
    if (!instance) return;
    const t = now.current;
    figures.forEach((figure, i) => {
      let floorId = figure.floors[0];
      let color = COLORS.waiting;
      let s = 1;
      let heading = 0;
      if (figure.cutOff) {
        position.copy(figure.path[0]);
        color = COLORS.trapped;
        s = t >= figure.start ? 1 + 0.15 * Math.sin(clock.elapsedTime * 8 + i) : 1;
      } else {
        const walked = Math.max(0, t - figure.start) * speed;
        if (walked <= 0) {
          position.copy(figure.path[0]);
          position.y += Math.abs(Math.sin(clock.elapsedTime * 1.5 + i)) * 0.05; // idle bob
        } else if (walked >= figure.total && t < figure.out) {
          // Queuing at the exit door.
          position.copy(figure.path.at(-1)!);
          floorId = figure.floors.at(-1)!;
          color = COLORS.queue;
        } else if (walked >= figure.total) {
          position.copy(figure.exitOut);
          floorId = figure.floors.at(-1)!;
          color = COLORS.safe;
        } else {
          let k = 1;
          while (k < figure.lengths.length - 1 && figure.lengths[k] < walked) k++;
          const a = figure.path[k - 1], b = figure.path[k];
          const span = figure.lengths[k] - figure.lengths[k - 1] || 1;
          position.lerpVectors(a, b, (walked - figure.lengths[k - 1]) / span);
          floorId = figure.floors[(walked - figure.lengths[k - 1]) / span < 0.5 ? k - 1 : k];
          // On the stairs between two floors: only drawn when both floors are on view (lifted-away floors would make them fly).
          const other = figure.floors[k - 1] === floorId ? figure.floors[k] : figure.floors[k - 1];
          if ((poses.get(other)?.opacity ?? 0) <= 0.5) floorId = other;
          heading = Math.atan2(b.x - a.x, b.z - a.z);
          position.y += Math.abs(Math.sin(clock.elapsedTime * 10 + i)) * 0.08; // walking bob
          color = COLORS.walking;
        }
      }
      // Spread a room's people around its route so they don't stack on one line.
      if (color !== COLORS.safe) { position.x += figure.offset.x * 0.5; position.z += figure.offset.y * 0.5; }
      const shown = (poses.get(floorId)?.opacity ?? 0) > 0.5;
      scale.setScalar(shown ? s : 0);
      matrix.compose(position, turn.setFromAxisAngle(up, heading), scale);
      instance.setMatrixAt(i, matrix);
      instance.setColorAt(i, color);
    });
    instance.instanceMatrix.needsUpdate = true;
    if (instance.instanceColor) instance.instanceColor.needsUpdate = true;
  });

  if (!figures.length) return null;
  return <instancedMesh key={figures.length} ref={mesh} args={[BODY, material, figures.length]} castShadow raycast={() => null} frustumCulled={false} />;
}
