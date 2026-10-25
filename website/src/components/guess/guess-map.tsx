'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import type { Building } from '@/lib/buildings/types';
import type { FloorPoint, SceneDirective, SceneFocus } from '@/lib/chat/contract';
import type { SpotPick } from '@/lib/guess/spots';
import { floorShort } from './ui';
import styles from './gg.module.css';

const BuildingScene = dynamic(() => import('@/components/experience/building-scene'), { ssr: false, loading: () => <div className={styles.mapLoading}>Loading the building…</div> });

interface Props {
  building: Building;
  /** Reveal: shown as given, no picking. */
  scene?: SceneDirective;
  pick?: SpotPick;
  onPick?(pick: SpotPick): void;
  /** Pixels covered at the bottom (a result panel), so the camera frames above it. */
  bottomInset?: number;
  children?: ReactNode;
}

/** Andy's 3D model as the guessing map: pick a floor, tap the exact spot, a pin marks it. No room names. */
export function GuessMap({ building, scene, pick, onPick, bottomInset = 0, children }: Props) {
  const floors = useMemo(() => [...building.floors].sort((a, b) => a.level - b.level), [building]);
  const home = useMemo((): SceneFocus => floors.length === 1 ? { mode: 'floor', floorId: floors[0].id } : { mode: 'building' }, [floors]);
  const [view, setView] = useState<SceneFocus>(home);
  const directive = useMemo((): SceneDirective => scene ?? {
    focus: view,
    // A faint tint plus a pin; the muted tone keeps the camera where the player put it.
    highlights: pick ? [{ spaceId: pick.spaceId, tone: 'muted' }] : [],
    markers: pick ? [{ floorId: pick.floorId, position: pick.position, label: '', tone: 'primary' }] : [],
  }, [scene, view, pick]);
  const select = useCallback((spaceId: string, point: FloorPoint) => onPick?.({ floorId: point.floorId, spaceId, position: point.position }), [onPick]);
  const focusFloor = useCallback((floorId: string) => { if (!scene) setView({ mode: 'floor', floorId }); }, [scene]);
  const insets = useMemo(() => ({ top: scene ? 0 : 60, left: 0, bottom: bottomInset }), [scene, bottomInset]);
  const focused = view.mode === 'floor' ? view.floorId : undefined;

  return (
    <div className={styles.map}>
      <BuildingScene building={building} directive={directive} insets={insets} onFocusFloor={focusFloor} onSelect={onPick && !scene ? select : undefined} hideLabels />
      {!scene && (
        <nav className={styles.rail} aria-label="Floors">
          {floors.length > 1 && <button type="button" className={view.mode === 'building' ? styles.active : ''} onClick={() => setView({ mode: 'building' })} aria-label="Whole building">⌂</button>}
          {floors.map(f => <button type="button" key={f.id} className={focused === f.id ? styles.active : ''} onClick={() => setView({ mode: 'floor', floorId: f.id })} aria-label={f.name} aria-pressed={focused === f.id}>{floorShort(f.level)}</button>)}
        </nav>
      )}
      {!scene && !pick && <p className={styles.mapHint}>{floors.length > 1 && view.mode === 'building' ? 'Pick a floor, then tap the spot' : 'Tap the exact spot'}</p>}
      {children}
      <p className={styles.attribution}>{building.building.attribution}</p>
    </div>
  );
}
