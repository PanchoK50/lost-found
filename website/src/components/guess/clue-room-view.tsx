'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Edges, Html, OrbitControls } from '@react-three/drei';
import type { Building, Point, Space } from '@/lib/buildings/types';
import { EYE_HEIGHT_M, roomView, type RoomView } from '@/lib/guess/room-view';
import styles from './guess.module.css';

const WALL = '#f8f9fb';
const EDGE = '#a3adbc';

/**
 * Street View for one room: you stand at 1.6 m in its middle and can only turn your head.
 * Walls from the outline, door gaps with brighter floor behind them, things as boxes with emoji signs. No text.
 */
export default function ClueRoomView({ building, space, yaw }: { building: Building; space: Space; yaw: number }) {
  const view = useMemo(() => roomView(building, space), [building, space]);
  // Plan (x, y up) → world (x, z = −y), with the eye at the origin.
  const at = useMemo(() => { const [ex, ey] = view.eye; return (p: Point): [number, number] => [p[0] - ex, -(p[1] - ey)]; }, [view]);
  const target: [number, number, number] = [Math.cos(yaw) * 0.01, EYE_HEIGHT_M, Math.sin(yaw) * 0.01];
  return (
    <div className={styles.roomView}>
      <Canvas camera={{ fov: 75, near: 0.05, far: 600, position: [0, EYE_HEIGHT_M, 0] }} flat dpr={[1, 1.5]} aria-label="View of the room you are in">
        <color attach="background" args={['#dfe4ec']} />
        {/* No tone mapping (`flat`): white walls stay white; the sun gives each wall direction its own shade. */}
        <ambientLight intensity={1.7} />
        <hemisphereLight args={['#ffffff', '#dfe4ec', 0.8]} />
        <directionalLight position={[4, 9, 2.5]} intensity={1.9} />
        <Surface view={view} at={at} y={0.001} color={view.floorColor} />
        <Surface view={view} at={at} y={view.height} color="#ffffff" />
        {view.walls.map((w, i) => <Wall key={i} piece={w} at={at} />)}
        {view.thresholds.map((t, i) => <Threshold key={i} threshold={t} at={at} />)}
        {view.boxes.map((b, i) => {
          const [x, z] = at(b.position);
          return (
            <group key={i} position={[x, 0, z]} rotation-y={b.rotation}>
              <mesh position-y={b.height / 2}><boxGeometry args={[b.width, b.height, b.depth]} /><meshStandardMaterial color={b.color} roughness={0.85} /><Edges color="#5d6878" /></mesh>
              {b.sign && <Html position={[0, b.height + 0.45, 0]} center zIndexRange={[2, 0]}><span className={styles.sign}>{b.sign}</span></Html>}
            </group>
          );
        })}
        <OrbitControls target={target} enableZoom={false} enablePan={false} rotateSpeed={-0.35} minPolarAngle={Math.PI * 0.22} maxPolarAngle={Math.PI * 0.78} enableDamping />
      </Canvas>
      <p className={styles.dragHint} aria-hidden>↔ Drag to look around</p>
    </div>
  );
}

function Surface({ view, at, y, color }: { view: RoomView; at: (p: Point) => [number, number]; y: number; color: string }) {
  const geometry = useMemo(() => {
    // Shape in (x, −z); rotating −90° about X lays it flat with y → −z.
    const shape = new THREE.Shape(view.polygon.map(p => { const [x, z] = at(p); return new THREE.Vector2(x, -z); }));
    return new THREE.ShapeGeometry(shape);
  }, [view, at]);
  return <mesh geometry={geometry} rotation-x={-Math.PI / 2} position-y={y}><meshStandardMaterial color={color} side={THREE.DoubleSide} roughness={0.95} /></mesh>;
}

function Wall({ piece, at }: { piece: RoomView['walls'][number]; at: (p: Point) => [number, number] }) {
  const [ax, az] = at(piece.a), [bx, bz] = at(piece.b);
  const length = Math.hypot(bx - ax, bz - az);
  const height = piece.top - piece.bottom;
  if (length < 0.01 || height <= 0) return null;
  return (
    <mesh position={[(ax + bx) / 2, (piece.top + piece.bottom) / 2, (az + bz) / 2]} rotation-y={-Math.atan2(bz - az, bx - ax)}>
      <planeGeometry args={[length, height]} />
      <meshStandardMaterial color={WALL} side={THREE.DoubleSide} roughness={0.9} />
      <Edges color={EDGE} />
    </mesh>
  );
}

/** A strip of bright floor just outside a door, so the gap reads as a way out. */
function Threshold({ threshold, at }: { threshold: RoomView['thresholds'][number]; at: (p: Point) => [number, number] }) {
  const geometry = useMemo(() => {
    const { a, b, outward } = threshold;
    const far = (p: Point): Point => [p[0] + outward[0] * 1.4, p[1] + outward[1] * 1.4];
    const shape = new THREE.Shape([a, b, far(b), far(a)].map(p => { const [x, z] = at(p); return new THREE.Vector2(x, -z); }));
    return new THREE.ShapeGeometry(shape);
  }, [threshold, at]);
  return <mesh geometry={geometry} rotation-x={-Math.PI / 2} position-y={0.002}><meshBasicMaterial color={threshold.entrance ? '#fff1e8' : '#ffffff'} side={THREE.DoubleSide} /></mesh>;
}
