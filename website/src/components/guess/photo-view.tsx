'use client';

import { useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import styles from './gg.module.css';

const MAX_ZOOM = 4;

/** The photo, full screen like Street View: blurred fill behind, zoom with buttons, wheel or double tap, drag to pan. */
export function PhotoView({ src, credit }: { src: string; credit?: string }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const drag = useRef<{ x: number; y: number; pan: [number, number] } | null>(null);
  const zoomTo = (z: number) => { const next = Math.min(MAX_ZOOM, Math.max(1, z)); setZoom(next); if (next === 1) setPan([0, 0]); };
  const down = (e: PointerEvent) => { if (zoom > 1) { drag.current = { x: e.clientX, y: e.clientY, pan }; (e.target as HTMLElement).setPointerCapture(e.pointerId); } };
  const move = (e: PointerEvent) => { const d = drag.current; if (d) setPan([d.pan[0] + (e.clientX - d.x) / zoom, d.pan[1] + (e.clientY - d.y) / zoom]); };
  const wheel = (e: WheelEvent) => zoomTo(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  return (
    <div className={styles.photo} onWheel={wheel}>
      {/* eslint-disable-next-line @next/next/no-img-element -- community photos come from data URLs and Storage, not the image optimizer */}
      <img className={styles.photoBlur} src={src} alt="" aria-hidden />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={styles.photoMain} src={src} alt="Where was this photo taken?" draggable={false}
        style={{ transform: `scale(${zoom}) translate(${pan[0]}px, ${pan[1]}px)`, cursor: zoom > 1 ? 'grab' : 'zoom-in' }}
        onDoubleClick={() => zoomTo(zoom > 1 ? 1 : 2.2)} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }}
      />
      <div className={styles.zoom}>
        <button type="button" onClick={() => zoomTo(zoom * 1.5)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomTo(zoom / 1.5)} aria-label="Zoom out" disabled={zoom <= 1}>−</button>
      </div>
      {credit && <p className={styles.credit}>📸 {credit}</p>}
    </div>
  );
}
