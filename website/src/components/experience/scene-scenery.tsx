'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Sky, Stars } from '@react-three/drei';

/**
 * Surroundings so the building sits somewhere: sky with a sun (or a night sky in an emergency), grass, a paved
 * apron, two streets with lane markings along the building, and trees. Everything is placed from the building's
 * own footprint box, so it works for any building; nothing is drawn inside the footprint.
 */
export function Scenery({ box, y, night }: { box: { minX: number; maxX: number; minZ: number; maxZ: number }; y: number; night: boolean }) {
  const layout = useMemo(() => buildLayout(box), [box]);
  const c = night ? NIGHT : DAY;
  return (
    <group position-y={y}>
      {night
        ? <Stars radius={900} depth={60} count={1800} factor={5} saturation={0} fade speed={0.4} />
        : <Sky distance={3000} sunPosition={[220, 160, 120]} turbidity={6} rayleigh={1.2} mieCoefficient={0.004} mieDirectionalG={0.85} />}
      <mesh rotation-x={-Math.PI / 2} position-y={-0.06} receiveShadow>
        <planeGeometry args={[3000, 3000]} />
        <meshStandardMaterial color={c.grass} roughness={1} />
      </mesh>
      <Flat rect={layout.apron} color={c.apron} lift={-0.04} />
      {layout.roads.map((road, i) => <Flat key={i} rect={road} color={c.road} lift={-0.03} />)}
      {layout.walks.map((walk, i) => <Flat key={`w${i}`} rect={walk} color={c.walk} lift={-0.025} />)}
      <Dashes dashes={layout.dashes} color={c.line} />
      <Trees trees={layout.trees} trunk={c.trunk} crowns={c.crowns} />
    </group>
  );
}

const DAY = { grass: '#bfcca6', apron: '#e4e0d6', road: '#8a8e95', walk: '#d6d2c8', line: '#f4f1ea', trunk: '#7a5a3c', crowns: ['#6f9a52', '#5f8c47', '#7fa95e', '#58824a'] };
const NIGHT = { grass: '#121a24', apron: '#1c2430', road: '#0d1118', walk: '#1a212c', line: '#4a5568', trunk: '#2a2420', crowns: ['#1d2b23', '#18251f', '#22322a', '#1a2a22'] };

type Rect = { x0: number; x1: number; z0: number; z1: number };

function Flat({ rect, color, lift }: { rect: Rect; color: string; lift: number }) {
  return (
    <mesh rotation-x={-Math.PI / 2} position={[(rect.x0 + rect.x1) / 2, lift, (rect.z0 + rect.z1) / 2]} receiveShadow>
      <planeGeometry args={[rect.x1 - rect.x0, rect.z1 - rect.z0]} />
      <meshStandardMaterial color={color} roughness={0.95} />
    </mesh>
  );
}

function seeded(seed: number) {
  const x = Math.sin(seed * 91.17 + 7.3) * 43758.5453;
  return x - Math.floor(x);
}

function buildLayout(box: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  const margin = 6, roadGap = 10, roadWidth = 9, walkWidth = 2.5, reach = 70;
  const apron: Rect = { x0: box.minX - margin, x1: box.maxX + margin, z0: box.minZ - margin, z1: box.maxZ + margin };
  // Two streets: along the front (+z) and the right side (+x), running past the building in both directions.
  const front: Rect = { x0: box.minX - reach, x1: box.maxX + reach, z0: box.maxZ + roadGap, z1: box.maxZ + roadGap + roadWidth };
  const side: Rect = { x0: box.maxX + roadGap, x1: box.maxX + roadGap + roadWidth, z0: box.minZ - reach, z1: box.maxZ + reach };
  const walks: Rect[] = [
    { x0: front.x0, x1: front.x1, z0: front.z0 - walkWidth, z1: front.z0 },
    { x0: side.x0 - walkWidth, x1: side.x0, z0: side.z0, z1: side.z1 },
  ];
  const dashes: { x: number; z: number; angle: number }[] = [];
  for (let x = front.x0 + 2; x < front.x1; x += 6) dashes.push({ x, z: (front.z0 + front.z1) / 2, angle: 0 });
  for (let z = side.z0 + 2; z < side.z1; z += 6) dashes.push({ x: (side.x0 + side.x1) / 2, z, angle: Math.PI / 2 });
  const blocked = [apron, front, side, ...walks].map(r => ({ x0: r.x0 - 2.5, x1: r.x1 + 2.5, z0: r.z0 - 2.5, z1: r.z1 + 2.5 }));
  const inside = (r: Rect, x: number, z: number) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
  const trees: { x: number; z: number; size: number; crown: number }[] = [];
  // Street trees along both sidewalks, then a looser scatter in the surroundings.
  for (let x = front.x0 + 4; x < front.x1; x += 11) trees.push({ x, z: front.z0 - walkWidth - 3, size: 0.9 + seeded(x) * 0.3, crown: Math.floor(seeded(x + 1) * 4) });
  for (let z = side.z0 + 4; z < side.z1; z += 11) trees.push({ x: side.x0 - walkWidth - 3, z, size: 0.9 + seeded(z) * 0.3, crown: Math.floor(seeded(z + 2) * 4) });
  for (let i = 0; trees.length < 220 && i < 1600; i++) {
    const x = box.minX - reach + seeded(i * 3 + 1) * (box.maxX - box.minX + 2 * reach);
    const z = box.minZ - reach + seeded(i * 3 + 2) * (box.maxZ - box.minZ + 2 * reach);
    if (blocked.some(r => inside(r, x, z))) continue;
    if (trees.some(t => Math.hypot(t.x - x, t.z - z) < 5)) continue;
    trees.push({ x, z, size: 0.75 + seeded(i * 3 + 3) * 0.6, crown: Math.floor(seeded(i * 7) * 4) });
  }
  return { apron, roads: [front, side], walks, dashes, trees: trees.filter(t => !blocked.slice(0, 1).some(r => inside(r, t.x, t.z))) };
}

function Dashes({ dashes, color }: { dashes: { x: number; z: number; angle: number }[]; color: string }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(1, 1, 1);
    dashes.forEach((d, i) => mesh.setMatrixAt(i, m.compose(new THREE.Vector3(d.x, -0.02, d.z), q.setFromAxisAngle(up, d.angle), s)));
    mesh.instanceMatrix.needsUpdate = true;
  }, [dashes]);
  return (
    <instancedMesh key={dashes.length} ref={ref} args={[undefined, undefined, dashes.length]} raycast={() => null}>
      <boxGeometry args={[2.6, 0.01, 0.25]} />
      <meshBasicMaterial color={color} />
    </instancedMesh>
  );
}

const TRUNK = new THREE.CylinderGeometry(0.22, 0.3, 2.2, 7);
TRUNK.translate(0, 1.1, 0);
const CROWN = new THREE.IcosahedronGeometry(2.3, 1);
CROWN.translate(0, 3.8, 0);

function Trees({ trees, trunk, crowns }: { trees: { x: number; z: number; size: number; crown: number }[]; trunk: string; crowns: string[] }) {
  const trunks = useRef<THREE.InstancedMesh>(null);
  const tops = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!trunks.current || !tops.current) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), color = new THREE.Color();
    trees.forEach((t, i) => {
      m.compose(new THREE.Vector3(t.x, 0, t.z), q, new THREE.Vector3(t.size, t.size, t.size));
      trunks.current!.setMatrixAt(i, m);
      tops.current!.setMatrixAt(i, m);
      tops.current!.setColorAt(i, color.set(crowns[t.crown % crowns.length]));
    });
    trunks.current.instanceMatrix.needsUpdate = true;
    tops.current.instanceMatrix.needsUpdate = true;
    if (tops.current.instanceColor) tops.current.instanceColor.needsUpdate = true;
  }, [trees, crowns]);
  return <>
    <instancedMesh key={`t${trees.length}`} ref={trunks} args={[TRUNK, undefined, trees.length]} castShadow raycast={() => null}>
      <meshStandardMaterial color={trunk} roughness={1} />
    </instancedMesh>
    <instancedMesh key={`c${trees.length}`} ref={tops} args={[CROWN, undefined, trees.length]} castShadow raycast={() => null}>
      <meshStandardMaterial roughness={0.9} flatShading />
    </instancedMesh>
  </>;
}
