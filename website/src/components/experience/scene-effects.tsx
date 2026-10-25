'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Point } from '@/lib/buildings/types';
import type { BuildingModel, FloorPose } from './scene-model';

/**
 * Living hazards on top of the room tints: flickering flames and rising smoke where it burns, spreading ripples
 * where water stands, sparks where the power failed. Everything is instanced, seeded per room (stable between
 * frames) and scaled with each room's current level, so it grows and fades with the timeline.
 */
type Hazard = { spaceId: string; kind: 'fire' | 'water' | 'electrical'; level: number };

const MAX = { flame: 360, smoke: 260, ripple: 260, spark: 120 };
const FLAME = new THREE.ConeGeometry(0.7, 1.4, 8, 1, true);
FLAME.translate(0, 0.7, 0);
const SMOKE = new THREE.IcosahedronGeometry(0.6, 1);
const RIPPLE = new THREE.RingGeometry(0.55, 0.7, 28);
RIPPLE.rotateX(-Math.PI / 2);
const SPARK = new THREE.OctahedronGeometry(0.16, 0);

function seeded(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function inside(polygon: Point[], [x, y]: Point) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Up to n points inside a room's outline (rejection sampling from its bounding box, seeded). */
function pointsIn(polygon: Point[], n: number, seed: number): Point[] {
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const out: Point[] = [];
  for (let i = 0; out.length < n && i < n * 12; i++) {
    const p: Point = [x0 + seeded(seed + i * 2) * (x1 - x0), y0 + seeded(seed + i * 2 + 1) * (y1 - y0)];
    if (inside(polygon, p)) out.push(p);
  }
  return out;
}

interface Emitter { spaceId: string; floorId: string; x: number; z: number; phase: number; size: number }

export function HazardEffects({ model, poses, hazards, floorBase }: {
  model: BuildingModel;
  poses: Map<string, FloorPose>;
  hazards: Hazard[];
  floorBase(floorId: string): number;
}) {
  // Emitters depend only on which rooms are affected (not on the level), so they don't jump while it plays.
  const roomsKey = useMemo(() => hazards.filter(h => h.level > 0.15).map(h => `${h.kind}:${h.spaceId}`).sort().join('|'), [hazards]);
  const emitters = useMemo(() => {
    const out: Record<Hazard['kind'], Emitter[]> = { fire: [], water: [], electrical: [] };
    if (!roomsKey) return out;
    for (const entry of roomsKey.split('|')) {
      const [kind, spaceId] = entry.split(':') as [Hazard['kind'], string];
      const m = model.spaces.get(spaceId);
      if (!m) continue;
      const area = m.area;
      const n = kind === 'fire' ? Math.min(14, Math.max(3, Math.round(area / 5))) : kind === 'water' ? Math.min(6, Math.max(1, Math.round(area / 14))) : Math.min(3, Math.max(1, Math.round(area / 30)));
      const seed = [...spaceId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 100000;
      pointsIn(m.space.polygon, n, seed).forEach((p, i) => {
        const [x, z] = model.toWorld(p, m.space.floor_id);
        out[kind].push({ spaceId, floorId: m.space.floor_id, x, z, phase: seeded(seed + i * 17) * Math.PI * 2, size: 0.7 + seeded(seed + i * 5) * 0.6 });
      });
    }
    return out;
  }, [roomsKey, model]);

  const level = useMemo(() => new Map(hazards.map(h => [`${h.kind}:${h.spaceId}`, h.level])), [hazards]);
  const levelRef = useRef(level);
  useLayoutEffect(() => { levelRef.current = level; }, [level]);

  const flames = useRef<THREE.InstancedMesh>(null), glow = useRef<THREE.InstancedMesh>(null);
  const smoke = useRef<THREE.InstancedMesh>(null), ripples = useRef<THREE.InstancedMesh>(null), sparks = useRef<THREE.InstancedMesh>(null);
  const flameMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ff4d12', transparent: true, opacity: 0.85, blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffb21f', transparent: true, opacity: 0.9, blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }), []);
  const smokeMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#4a4f57', transparent: true, opacity: 0.32, depthWrite: false, roughness: 1 }), []);
  const rippleMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#bfe1ff', transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }), []);
  const sparkMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#fff1a6', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  const m = useMemo(() => new THREE.Matrix4(), []), q = useMemo(() => new THREE.Quaternion(), []), s = useMemo(() => new THREE.Vector3(), []), p = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const lv = levelRef.current;
    const shown = (e: Emitter) => (poses.get(e.floorId)?.opacity ?? 0) > 0.5;
    const base = (e: Emitter) => (poses.get(e.floorId)?.y ?? 0) + floorBase(e.floorId);
    const hide = (mesh: THREE.InstancedMesh, i: number) => { m.makeScale(0, 0, 0); mesh.setMatrixAt(i, m); };

    if (flames.current && glow.current && smoke.current) {
      let si = 0;
      emitters.fire.slice(0, MAX.flame).forEach((e, i) => {
        const l = lv.get(`fire:${e.spaceId}`) ?? 0;
        if (!shown(e) || l < 0.1) { hide(flames.current!, i); hide(glow.current!, i); return; }
        // Flicker: height and width breathe out of phase; flames grow with the fire's level.
        const k = e.size * (0.45 + 0.75 * l);
        const fl = 1 + 0.35 * Math.sin(t * 9 + e.phase) + 0.2 * Math.sin(t * 23 + e.phase * 2);
        q.setFromAxisAngle(p.set(0, 1, 0), t * 0.8 + e.phase);
        m.compose(p.set(e.x, base(e), e.z), q, s.set(k * (1 - 0.12 * fl), k * fl * 1.5, k * (1 - 0.12 * fl)));
        flames.current!.setMatrixAt(i, m);
        m.compose(p.set(e.x, base(e), e.z), q, s.set(k * 0.55, k * fl * 0.9, k * 0.55));
        glow.current!.setMatrixAt(i, m);
        // Two smoke puffs per flame, rising and swelling, looping every few seconds.
        for (let j = 0; j < 2 && si < MAX.smoke; j++, si++) {
          const cycle = ((t * 0.28 + e.phase / 6.28 + j * 0.5) % 1);
          const r = k * (0.5 + cycle * 1.6);
          m.compose(p.set(e.x + Math.sin(e.phase + cycle * 3) * 0.6, base(e) + 1.6 + cycle * 6, e.z + Math.cos(e.phase + cycle * 2) * 0.6), q.identity(), s.set(r, r, r));
          smoke.current!.setMatrixAt(si, m);
        }
      });
      for (let i = emitters.fire.length; i < MAX.flame; i++) { hide(flames.current, i); hide(glow.current, i); }
      for (let i = si; i < MAX.smoke; i++) hide(smoke.current, i);
      flames.current.instanceMatrix.needsUpdate = glow.current.instanceMatrix.needsUpdate = smoke.current.instanceMatrix.needsUpdate = true;
      smokeMat.opacity = 0.2 + 0.05 * Math.sin(t * 1.3);
    }

    if (ripples.current) {
      emitters.water.slice(0, MAX.ripple).forEach((e, i) => {
        const l = lv.get(`water:${e.spaceId}`) ?? 0;
        if (!shown(e) || l < 0.1) { hide(ripples.current!, i); return; }
        // Rings spread out from the spot and start again: water moving on the floor.
        const cycle = (t * 0.45 + e.phase / 6.28) % 1;
        const r = (0.6 + cycle * 3.2) * e.size * (0.6 + 0.6 * l);
        m.compose(p.set(e.x, base(e) + 0.09, e.z), q.identity(), s.set(r, 1, r));
        ripples.current!.setMatrixAt(i, m);
      });
      for (let i = emitters.water.length; i < MAX.ripple; i++) hide(ripples.current, i);
      ripples.current.instanceMatrix.needsUpdate = true;
      rippleMat.opacity = 0.55;
    }

    if (sparks.current) {
      let i = 0;
      for (const e of emitters.electrical) {
        const l = lv.get(`electrical:${e.spaceId}`) ?? 0;
        for (let j = 0; j < 4 && i < MAX.spark; j++, i++) {
          // Short bursts: a spark is only visible for a fraction of its cycle.
          const cycle = (t * 1.7 + e.phase + j * 0.37) % 1;
          if (!shown(e) || l < 0.3 || cycle > 0.22) { hide(sparks.current, i); continue; }
          const k = 1 - cycle / 0.22;
          m.compose(p.set(e.x + Math.sin(e.phase * 7 + j) * 0.8 * cycle * 4, base(e) + 1.2 + cycle * 3, e.z + Math.cos(e.phase * 5 + j) * 0.8 * cycle * 4), q.identity(), s.set(k, k, k));
          sparks.current.setMatrixAt(i, m);
        }
      }
      for (; i < MAX.spark; i++) hide(sparks.current, i);
      sparks.current.instanceMatrix.needsUpdate = true;
    }
  });

  if (!roomsKey) return null;
  return <>
    <instancedMesh ref={flames} args={[FLAME, flameMat, MAX.flame]} frustumCulled={false} raycast={() => null} renderOrder={6} />
    <instancedMesh ref={glow} args={[FLAME, glowMat, MAX.flame]} frustumCulled={false} raycast={() => null} renderOrder={7} />
    <instancedMesh ref={smoke} args={[SMOKE, smokeMat, MAX.smoke]} frustumCulled={false} raycast={() => null} renderOrder={8} />
    <instancedMesh ref={ripples} args={[RIPPLE, rippleMat, MAX.ripple]} frustumCulled={false} raycast={() => null} renderOrder={5} />
    <instancedMesh ref={sparks} args={[SPARK, sparkMat, MAX.spark]} frustumCulled={false} raycast={() => null} renderOrder={9} />
  </>;
}
