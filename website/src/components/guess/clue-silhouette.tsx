'use client';

import { useMemo } from 'react';
import type { Building, Point, Space } from '@/lib/buildings/types';
import { polygonCentroid } from '@/lib/buildings/geometry';
import { representativePoint } from '@/lib/buildings/graph';
import { wallsWithDoors } from '@/lib/guess/room-view';
import styles from './guess.module.css';

const VIEW = 100;
const PAD = 10;

/**
 * The room's outline only: rotated by `angle`, scaled to fit (no scale bar), doors as gaps in the wall.
 * Entrances from outside are marked in orange (docs/GEOGUESSR.md §2).
 */
export function ClueSilhouette({ building, space, angle }: { building: Building; space: Space; angle: number }) {
  const shape = useMemo(() => silhouette(building, space, angle), [building, space, angle]);
  return (
    <figure className={styles.silhouette}>
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} role="img" aria-label="Outline of the room you are in">
        <path className={styles.floorFill} d={shape.fill} />
        {shape.walls.map((w, i) => <line key={i} className={styles.wall} x1={w[0][0]} y1={w[0][1]} x2={w[1][0]} y2={w[1][1]} pathLength={1} />)}
        {shape.doors.map((d, i) => <line key={i} className={d.entrance ? styles.entrance : styles.door} x1={d.a[0]} y1={d.a[1]} x2={d.b[0]} y2={d.b[1]} />)}
        <circle className={styles.youAreHere} cx={shape.you[0]} cy={shape.you[1]} r={2.2} />
        <circle className={styles.youPulse} cx={shape.you[0]} cy={shape.you[1]} r={2.2} />
      </svg>
      <figcaption>
        <span><i className={styles.legendWall} /> wall</span>
        <span><i className={styles.legendDoor} /> door</span>
        {shape.doors.some(d => d.entrance) && <span><i className={styles.legendEntrance} /> entrance</span>}
        <span>not to scale · rotated</span>
      </figcaption>
    </figure>
  );
}

function silhouette(building: Building, space: Space, angle: number) {
  const { ring, gaps } = wallsWithDoors(building, space);
  const [cx, cy] = polygonCentroid(ring);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Rotate about the centroid; SVG y points down, so flip y (coordinates are metres with y up).
  const turn = ([x, y]: Point): Point => [(x - cx) * cos - (y - cy) * sin, -((x - cx) * sin + (y - cy) * cos)];
  const turned = ring.map(turn);
  const xs = turned.map(p => p[0]), ys = turned.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = (VIEW - 2 * PAD) / Math.max(maxX - minX, maxY - minY, 1e-6);
  const ox = (VIEW - (maxX - minX) * k) / 2 - minX * k, oy = (VIEW - (maxY - minY) * k) / 2 - minY * k;
  const view = (p: Point): Point => [p[0] * k + ox, p[1] * k + oy];
  const pts = turned.map(view);

  const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const walls: [Point, Point][] = [];
  const doors: { a: Point; b: Point; entrance: boolean }[] = [];
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    let t = 0;
    for (const g of gaps[i]) {
      if (g.from > t) walls.push([lerp(p, q, t), lerp(p, q, g.from)]);
      doors.push({ a: lerp(p, q, g.from), b: lerp(p, q, g.to), entrance: g.entrance });
      t = Math.max(t, g.to);
    }
    if (t < 1) walls.push([lerp(p, q, t), q]);
  });

  return { fill: `M${pts.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L')}Z`, walls, doors, you: view(turn(representativePoint(ring))) };
}
