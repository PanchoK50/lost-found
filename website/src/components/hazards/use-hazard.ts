'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { FloorPoint, SceneDirective } from '@/lib/chat/contract';
import { levelAt, type HazardKind, type ImpactRoom, type Incident, type SimulateResponse } from '@/lib/hazards/types';

/** One emergency on screen: a manager's what-if simulation, or a live incident (reported or from a sensor). */
export interface HazardView {
  hazard: HazardKind;
  spaceId: string;
  mode: 'simulation' | 'incident';
  incident?: Incident;
  data?: SimulateResponse;
  error?: string;
  /** Minutes since the start, driving the spread on the map. */
  t: number;
  playing: boolean;
  /** When the response playbook started running (ms); undefined until it is started. */
  responseStartedAt?: number;
}

const PLAY_SECONDS = 30;
const SLOW_MIN = 6;
const SLOW_SECONDS = 20;

export function useHazard(building: Building) {
  const [view, setView] = useState<HazardView | null>(null);
  const request = useRef(0);

  const open = useCallback(async (spaceId: string, hazard: HazardKind, mode: HazardView['mode'] = 'simulation', incident?: Incident) => {
    const id = ++request.current;
        // Nothing is called until someone taps Call … or Notify everyone (also for live incidents).
    setView({ hazard, spaceId, mode, incident, t: 0, playing: true, responseStartedAt: undefined });
    try {
      const res = await fetch('/api/hazards/simulate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ building_id: building.building.id, hazard, space_id: spaceId, severity: incident?.severity ?? 2 }),
      });
      const data = await res.json();
      if (id !== request.current) return;
      if (!res.ok) throw new Error(data.detail ?? data.error ?? 'Simulation failed.');
      setView(current => current && { ...current, data });
    } catch (error) {
      if (id !== request.current) return;
      setView(current => current && { ...current, error: error instanceof Error ? error.message : 'Simulation failed.', playing: false });
    }
  }, [building.building.id]);

  const close = useCallback(() => { request.current++; setView(null); }, []);
  const setT = useCallback((t: number) => setView(current => current && { ...current, t, playing: false }), []);
  const togglePlay = useCallback(() => setView(current => current && {
    ...current, playing: !current.playing, t: !current.playing && current.data && current.t >= current.data.simulation.minutes ? 0 : current.t,
  }), []);
  const startResponse = useCallback(() => setView(current => current && { ...current, responseStartedAt: Date.now() }), []);

  // Play: the whole timeline in about PLAY_SECONDS.
  const minutes = view?.data?.simulation.minutes;
  const playing = view?.playing && minutes !== undefined;
  useEffect(() => {
    if (!playing || minutes === undefined) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setView(current => {
        if (!current || !current.playing) return current;
        // The first minutes (alarm, people walking out) play slowly; the rest of the spread faster.
        const rate = current.t < SLOW_MIN ? SLOW_MIN / SLOW_SECONDS : (minutes - SLOW_MIN) / Math.max(1, PLAY_SECONDS - SLOW_SECONDS);
        const t = Math.min(minutes, current.t + dt * rate);
        return { ...current, t, playing: t < minutes };
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, minutes]);

  return { view, open, close, setT, togglePlay, startResponse };
}

/** The map for a hazard at minute t: tinted spaces, the origin pin, evacuation routes (fire) and a camera on the floors hit. */
export function hazardDirective(building: Building, view: HazardView, focusRoom?: string | null, focusFloor?: string | null, fade = 1): SceneDirective {
  const origin = building.spaces.find(s => s.id === view.spaceId);
  const data = view.data;
  const floorOf = new Map(building.spaces.map(s => [s.id, s.floor_id]));
  // `fade` < 1 while a fixed incident clears from the map.
  const hazards = data ? data.simulation.spaces.map(e => ({ spaceId: e.space_id, kind: e.kind, level: levelAt(e, view.t, data.simulation.ramp_min) * fade })).filter(h => h.level > 0.02) : [];
  // Lifts whose shaft is without power stop (drawn as closed); fire switches all lifts off (below).
  const darkSpaces = new Set(hazards.filter(h => h.kind === 'electrical' && h.level > 0.3).map(h => h.spaceId));
  const liftsDark = building.vertical_connectors.filter(c => c.kind === 'lift' && c.space_ids.some(id => darkSpaces.has(id))).map(c => c.id);
  const key = data ? keyRoom(data) : undefined;
  const target = key && building.spaces.find(s => s.id === key.space_id);
  const originFloor = origin?.floor_id ?? building.floors[0].id;
  const focus: SceneDirective['focus'] = focusRoom && floorOf.get(focusRoom)
    ? { mode: 'floor', floorId: floorOf.get(focusRoom)! }
    : focusFloor === '__all__' ? { mode: 'building' }
    : focusFloor ? { mode: 'floor', floorId: focusFloor }
    : { mode: 'floor', floorId: originFloor };
  // One floor at a time (as in ArcGIS Indoors or Desigo CC): an arrow only when both rooms are on the floor shown.
  const shownFloor = focusRoom ? floorOf.get(focusRoom) : focusFloor && focusFloor !== '__all__' ? focusFloor : originFloor;
  const hasLink = Boolean(origin && target && target.id !== origin.id && origin.floor_id === shownFloor && target.floor_id === shownFloor);
  // The arrow's label already names the origin; then the pin needs no label of its own.
  const markers: SceneDirective['markers'] = [
    ...(origin ? [{ floorId: origin.floor_id, position: centroid(origin.polygon), label: hasLink ? '' : `${origin.name} · origin`, tone: 'primary' as const }] : []),
    // On another floor: label the key room there so it is clear why this floor matters.
    ...(target && target.id !== origin?.id && target.floor_id === shownFloor && !hasLink ? [{ floorId: target.floor_id, position: centroid(target.polygon), label: target.name, tone: 'secondary' as const }] : []),
  ];
  // The one consequence that matters most, as an arrow with a label: "Kitchen 3.14 → Server room 2.14".
  const links: SceneDirective['links'] = hasLink && fade > 0.5 && origin && target
    ? [{ from: { floorId: origin.floor_id, position: centroid(origin.polygon) }, to: { floorId: target.floor_id, position: centroid(target.polygon) }, label: `${origin.name} → ${target.name}` }]
    : undefined;
  const routes: SceneDirective['routes'] = view.hazard === 'fire' && data?.evacuation && view.t >= 1
    ? data.evacuation.routes.slice(0, 3).map(route => ({ spacePath: route.space_path, points: route.polylines.flatMap(run => run.points.map(position => ({ floorId: run.floor_id, position }) as FloorPoint)), label: route.name }))
    : undefined;
  const evacuees = data ? evacueesOf(data) : undefined;
  return {
    focus,
    evacuees,
    minute: view.t,
    walkMPerMin: data?.evacuation?.walk_m_per_min,
    // The whole building stays in view while the spread plays; a room tapped in the panel zooms to it.
    frameAll: !focusRoom,
    // X-ray: frame where it starts and the key room it reaches, with the building around them.
    frameSpaces: undefined,
    hazards,
    markers,
    links,
    routes,
    highlights: [...(target && target.id !== origin?.id ? [{ spaceId: target.id, tone: 'secondary' as const }] : []), ...(focusRoom ? [{ spaceId: focusRoom, tone: 'secondary' as const }] : [])],
    closed: fade < 1 ? undefined : [...new Set([...(view.hazard === 'fire' && data?.evacuation ? data.evacuation.lifts_off : []), ...liftsDark])],
  };
}

/** The affected room that matters most besides the origin: critical equipment first, then people, then how hard it is hit. */
export function keyRoom(data: SimulateResponse): ImpactRoom | undefined {
  const rooms = data.impact.rooms.filter(r => r.relation !== 'origin' && r.kind === data.simulation.hazard && (r.type === 'room' || r.type === 'hall'));
  const preferred = data.simulation.hazard === 'water' ? rooms.filter(r => r.relation === 'below') : rooms;
  const pool = preferred.length ? preferred : rooms;
  const score = (r: ImpactRoom) => r.critical_assets.length * 100 + r.people * 2 + r.peak * 10 - r.arrival_min;
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

// One evacuee list per simulation result: the scene rebuilds its figures only when this changes, not every frame.
const evacueeCache = new WeakMap<SimulateResponse, NonNullable<SceneDirective['evacuees']>>();
function evacueesOf(data: SimulateResponse) {
  let list = evacueeCache.get(data);
  if (!list) {
    list = (data.evacuation?.walkers ?? []).map(w => ({
      id: w.space_id, startMin: w.start_min, outMin: w.out_min, count: w.people, cutOff: w.cut_off,
      path: w.path.map(([floorId, x, y]) => ({ floorId, position: [x, y] as [number, number] })),
    }));
    evacueeCache.set(data, list);
  }
  return list;
}

/** People already out at minute t, and when the last one is out. */
export function evacuationProgress(data: SimulateResponse, t: number) {
  const walkers = data.evacuation?.walkers ?? [];
  const speed = data.evacuation?.walk_m_per_min ?? 60;
  let out = 0, total = 0, trapped = 0, last = 0;
  for (const w of walkers) {
    total += w.people;
    if (w.cut_off) { trapped += w.people; continue; }
    const arrive = w.out_min ?? w.start_min + w.distance_m / speed;
    last = Math.max(last, arrive);
    if (t >= arrive) out += w.people;
  }
  return { out, total, trapped, lastOutMin: last };
}

function centroid(polygon: [number, number][]): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  return Math.abs(a) < 1e-9 ? polygon[0] : [cx / (3 * a), cy / (3 * a)];
}
