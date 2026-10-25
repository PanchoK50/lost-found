'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { FloorPoint, SceneDirective } from '@/lib/chat/contract';

/** Fire brigade edition (docs/BRIGADE_BRIEF.md): types, data hook and the panels around the 3D view. */

export interface BrigadeSpace { space_id: string; name: string; floor: string; floor_id: string }
export interface Briefing {
  origin: BrigadeSpace; t_now: number; eta: number; t_arrival: number; horizon: number;
  facts: { rooms_on_fire_now: number; rooms_on_fire_at_arrival: number; people_inside_now: number; floors_affected: number };
  timeline: { t: number; rooms_fire: number; rooms_smoke: number; people_inside: number }[];
  stairwells: { connector_id: string; name: string; status_at_now: Status; status_at_arrival: Status; level: number }[];
  above_below: { above: BrigadeSpace | null; below: BrigadeSpace | null; source: string };
  wall_neighbours: BrigadeSpace[];
  hazards: (BrigadeSpace & { kind: string; label: string; assets: string[]; fire_arrival_min: number | null; source: string })[];
  entrances: { opening_id: string; into_space: string; width_m: number; step_free: boolean; recommended: boolean; reason?: string; distance_m: number | null }[];
  next_consequences: { t: number; text: string; space_ids: string[] }[];
}
type Status = 'clear' | 'smoke' | 'fire';
export interface People {
  inside: { floor: string; floor_id: string; count: number }[]; total_inside: number;
  cannot_self_evacuate: (BrigadeSpace & { person: string; reason: string; demo: boolean })[];
  demo_people: (BrigadeSpace & { person: string; need: string | null })[];
}
export interface CrewRoute {
  label: string; target: BrigadeSpace; reachable: boolean; length_m?: number; steps?: string[]; used_stairwell?: string[];
  polylines?: { floor_id: string; points: [number, number][] }[]; space_path?: string[];
  avoided: { connector_or_space: string; connector_id: string; reason: string }[];
  narrowest_door?: { opening_id: string; width_m: number } | null; stretcher_ok?: boolean | null; stretcher_m?: number | null;
  start: { opening_id: string; into_space: string; position: [number, number]; floor_id: string };
}

export const CREW_COLORS = ['#2EE6D6', '#FFD23F'];

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/hazards/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail ?? data.error ?? 'Request failed');
  return data as T;
}

/** Briefing and people once per (building, origin); crew routes at arrival (or later, when scrubbing past it). */
export function useBrigade(building: Building, origin: string | null, tNow: number, eta: number, t: number, rescueTarget: string | null) {
  const [briefing, setBriefing] = useState<Briefing>();
  const [people, setPeople] = useState<People>();
  const [routes, setRoutes] = useState<CrewRoute[]>();
  const [error, setError] = useState<string>();
  const id = building.building.id;
  useEffect(() => {
    if (!origin) return;
    let cancelled = false;
    post<Briefing>('brigade/briefing', { building_id: id, origin, t_now_min: tNow, eta_min: eta }).then(b => { if (!cancelled) setBriefing(b); }).catch(e => !cancelled && setError(String(e.message ?? e)));
    fetch(`/api/hazards/brigade/people?building_id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin)}&t=${tNow}`).then(r => (r.ok ? r.json() : null)).then(p => { if (!cancelled && p?.cannot_self_evacuate) setPeople(p); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [id, origin, tNow, eta]);
  const tRoutes = Math.max(Math.round(t), tNow + eta);
  const rescue = rescueTarget ?? people?.cannot_self_evacuate?.find(p => p.demo)?.space_id ?? null;
  useEffect(() => {
    if (!origin) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const targets = [...(rescue ? [{ space_id: rescue, label: 'Crew 1 · Rescue', min_width_m: 1.1 }] : []), { space_id: origin, label: 'Crew 2 · Attack' }];
      post<{ routes: CrewRoute[] }>('brigade/routes', { building_id: id, origin, t_arrival: tRoutes, targets }).then(r => { if (!cancelled) setRoutes(r.routes); }).catch(() => undefined);
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [id, origin, tRoutes, rescue]);
  return { briefing, people, routes, error };
}

/** Crew routes, people who can't get out and crossed-out stairwells on top of the fire scene. */
export function brigadeDirective(base: SceneDirective, building: Building, briefing: Briefing | undefined, people: People | undefined, routes: CrewRoute[] | undefined, showRoutes: boolean): SceneDirective {
  const centroid = (id: string): [number, number] | null => {
    const s = building.spaces.find(sp => sp.id === id);
    if (!s) return null;
    return [s.polygon.reduce((a, p) => a + p[0], 0) / s.polygon.length, s.polygon.reduce((a, p) => a + p[1], 0) / s.polygon.length];
  };
  const markers: NonNullable<SceneDirective['markers']> = [...(base.markers ?? [])];
  for (const p of people?.cannot_self_evacuate ?? []) {
    const c = centroid(p.space_id);
    if (c) markers.push({ floorId: p.floor_id, position: c, label: `${p.person} · can't get out alone`, tone: 'primary' });
  }
  const crossed = new Set((routes ?? []).flatMap(r => r.avoided.filter(a => !a.reason.startsWith('lift')).map(a => a.connector_id)));
  for (const connector of building.vertical_connectors.filter(c => crossed.has(c.id))) {
    const stair = briefing?.stairwells.find(s => s.connector_id === connector.id);
    for (const sid of connector.space_ids.slice(0, 1)) {
      const s = building.spaces.find(sp => sp.id === sid), c = centroid(sid);
      if (s && c) markers.push({ floorId: s.floor_id, position: c, label: `✕ ${connector.name} · ${stair?.status_at_arrival ?? 'smoke'}`, tone: 'muted' });
    }
  }
  const crewRoutes: NonNullable<SceneDirective['routes']> = showRoutes ? (routes ?? []).filter(r => r.reachable && r.polylines).map((r, i) => ({
    spacePath: r.space_path, label: r.label, color: CREW_COLORS[i % 2],
    points: r.polylines!.flatMap(run => run.points.map(position => ({ floorId: run.floor_id, position }) as FloorPoint)),
  })) : [];
  // No per-lift "Closed" tags: the crossed-out stairwells carry their own labels and lifts are off in every fire.
  return { ...base, markers, routes: crewRoutes, closed: [] };
}

const DEFAULT_CLOCK = '10:42';
/** F0: full-screen dispatch card. */
export function AlarmCard({ building, origin, tNow, eta, onOpen, onPick }: { building: Building; origin: BrigadeSpace | null; tNow: number; eta: number; onOpen(): void; onPick(): void }) {
  const [sound, setSound] = useState(false);
  useEffect(() => {
    if (!sound) return;
    let ctx: AudioContext | undefined;
    const beep = () => {
      ctx ??= new AudioContext();
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = i % 2 ? 660 : 880; g.gain.value = 0.12;
        o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.3); o.stop(ctx.currentTime + i * 0.3 + 0.22);
      }
    };
    beep();
    const timer = window.setInterval(beep, 2500);
    return () => { window.clearInterval(timer); void ctx?.close(); };
  }, [sound]);
  return (
    <div className="alarm-screen" role="dialog" aria-label="Incoming alarm">
      <div className="alarm-dispatch">
        <div className="alarm-kicker"><span>🔥 FIRE</span><em>SIMULATED</em><button type="button" className="alarm-sound" onClick={() => setSound(s => !s)} aria-pressed={sound} aria-label={sound ? 'Mute alarm tone' : 'Play alarm tone'}>{sound ? '🔊' : '🔈'}</button></div>
        <h1>{building.building.name}</h1>
        <p className="alarm-where">{origin ? `${origin.floor} · ${origin.name}` : 'Locating…'}</p>
        <dl className="alarm-meta">
          <div><dt>Detected</dt><dd>Smoke detector</dd></div>
          <div><dt>Alarm</dt><dd>{DEFAULT_CLOCK} <small>(+{tNow} min)</small></dd></div>
          <div><dt>ETA</dt><dd>{eta} min</dd></div>
        </dl>
        <button type="button" className="alarm-open" onClick={onOpen} disabled={!origin}>Open situation</button>
        <button type="button" className="alarm-pick" onClick={onPick}>Pick another building / room</button>
      </div>
    </div>
  );
}

/** Facts strip: rooms on fire now → at arrival · people still inside · floors affected (at the timeline's minute). */
export function FactsStrip({ briefing, t }: { briefing?: Briefing; t: number }) {
  if (!briefing) return <div className="facts-strip is-loading">Building the situation picture…</div>;
  const row = briefing.timeline[Math.min(briefing.timeline.length - 1, Math.max(0, Math.round(t)))];
  const arrival = briefing.timeline[Math.min(briefing.timeline.length - 1, Math.round(briefing.t_arrival))];
  return (
    <div className="facts-strip">
      <div><strong>{row.rooms_fire}<span> → {arrival.rooms_fire}</span></strong><em>Rooms on fire · now → arrival</em></div>
      <div><strong>{row.people_inside}</strong><em>People still inside</em></div>
      <div><strong>{briefing.facts.floors_affected}</strong><em>Floors affected</em></div>
    </div>
  );
}

/** F3: timeline from the alarm through now and arrival, with stairwell badges and the next consequence. */
export function BrigadeTimeline({ briefing, t, playing, onT, onPlay }: { briefing?: Briefing; t: number; playing: boolean; onT(t: number): void; onPlay(): void }) {
  const horizon = briefing?.horizon ?? 30;
  const marks = briefing ? [{ t: 0, label: 'Alarm' }, { t: briefing.t_now, label: `Now +${briefing.t_now}` }, { t: briefing.t_arrival, label: `Arrival +${briefing.t_arrival}`, arrival: true }, { t: 15, label: '+15' }, { t: 30, label: '+30' }] : [];
  const next = briefing?.next_consequences.find(n => n.t > t);
  const stairs = useMemo(() => briefing?.stairwells ?? [], [briefing]);
  const statusAt = (s: Briefing['stairwells'][number]) => (t >= (briefing?.t_arrival ?? 1e9) ? s.status_at_arrival : t >= (briefing?.t_now ?? 0) ? s.status_at_now : 'clear');
  return (
    <div className="brigade-timeline">
      <div className="bt-row">
        <button type="button" className="bt-play" onClick={onPlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
        <div className="bt-track">
          <input type="range" min={0} max={horizon} step={0.25} value={t} onChange={e => onT(Number(e.target.value))} aria-label="Minutes since the alarm" />
          {marks.map(m => <span key={m.label} className={`bt-mark${m.arrival ? ' bt-mark--arrival' : ''}`} style={{ left: `${(100 * m.t) / horizon}%` }}>{m.label}</span>)}
        </div>
        <span className="bt-clock">+{Math.floor(t)}:{String(Math.round((t % 1) * 60) % 60).padStart(2, '0')}</span>
      </div>
      <div className="bt-info">
        <div className="bt-stairs">{stairs.map(s => { const st = statusAt(s); return <span key={s.connector_id} className={`bt-stair is-${st}`}>{s.name}<b>{st}</b></span>; })}</div>
        {next && <span className="bt-next">Next: +{Math.round(next.t)} min · {next.text}</span>}
      </div>
    </div>
  );
}

type Tab = 'situation' | 'people' | 'routes' | 'ask';

/** Right rail: Situation (hazards), People, Routes. The chat (Ask) sits below it. */
export function BrigadePanel({ briefing, people, routes, onRoom, onRescue, tab, onTab }: {
  briefing?: Briefing; people?: People; routes?: CrewRoute[]; onRoom(spaceId: string): void; onRescue(spaceId: string): void; tab: Tab; onTab(tab: Tab): void;
}) {
  return (
    <section className="brigade-panel">
      <nav className="brigade-tabs" role="tablist">
        {(['situation', 'people', 'routes', 'ask'] as Tab[]).map(t => <button type="button" role="tab" key={t} aria-selected={tab === t} onClick={() => onTab(t)}>{t === 'situation' ? 'Situation' : t === 'people' ? `People${people?.cannot_self_evacuate?.length ? ` · ${people.cannot_self_evacuate.length}` : ''}` : t === 'routes' ? 'Routes' : 'Ask'}</button>)}
      </nav>
      {tab !== 'ask' && <div className="brigade-body">
        {!briefing && <p className="brigade-empty">Loading…</p>}
        {briefing && tab === 'situation' && <>
          <h3>Fire</h3>
          <button type="button" className="bcard bcard--fire" onClick={() => onRoom(briefing.origin.space_id)}><i>🔥</i><span><strong>{briefing.origin.name}</strong><em>{briefing.origin.floor} · origin</em></span></button>
          <h3>Above / below <small>from plan geometry</small></h3>
          {(['above', 'below'] as const).map(dir => briefing.above_below[dir] && (
            <button type="button" key={dir} className="bcard" onClick={() => onRoom(briefing.above_below[dir]!.space_id)}><i>{dir === 'above' ? '↑' : '↓'}</i><span><strong>{briefing.above_below[dir]!.name}</strong><em>{briefing.above_below[dir]!.floor} · directly {dir}</em></span></button>
          ))}
          {briefing.wall_neighbours.length > 0 && <>
            <h3>Shares a wall <small>from plan geometry</small></h3>
            <p className="bline">{briefing.wall_neighbours.map(w => w.name).join(' · ')}</p>
          </>}
          <h3>Hazards nearby <small>from asset list</small></h3>
          {briefing.hazards.length ? briefing.hazards.slice(0, 6).map(h => (
            <button type="button" key={`${h.space_id}-${h.kind}`} className={`bcard bcard--${h.kind}`} onClick={() => onRoom(h.space_id)}>
              <i>{h.kind === 'lab_chemicals' ? '⚗' : h.kind === 'server_batteries' ? '🔋' : '⚡'}</i>
              <span><strong>{h.name}</strong><em>{h.label} · {h.floor}{h.fire_arrival_min !== null ? ` · fire at +${Math.round(h.fire_arrival_min)} min` : ''}</em></span>
            </button>
          )) : <p className="bline">No labs, server rooms or panels near the fire in the asset list.</p>}
          {briefing.entrances.filter(e => e.recommended).map(e => (
            <div key={e.opening_id} className="bentrance"><strong>Recommended entrance: {e.into_space}</strong><em>{e.reason} · {e.width_m.toFixed(1)} m wide{e.step_free ? ' · step-free' : ''}</em></div>
          ))}
        </>}
        {briefing && tab === 'people' && <>
          <h3>Can&apos;t get out alone</h3>
          {people?.cannot_self_evacuate?.length ? people.cannot_self_evacuate.map(p => (
            <div key={`${p.person}-${p.space_id}`} className="bperson">
              <button type="button" onClick={() => onRoom(p.space_id)}><strong>{p.person}{p.demo && <em className="demo-tag">DEMO</em>}</strong><span>{p.name} · {p.floor}</span><span className="bperson-reason">{p.reason}</span></button>
              <button type="button" className="bperson-plan" onClick={() => onRescue(p.space_id)}>Plan rescue route</button>
            </div>
          )) : <p className="bline">Nobody flagged.</p>}
          <h3>Still inside · {people?.total_inside ?? '…'}</h3>
          {people?.inside.map(f => <p key={f.floor_id} className="bline bline--row"><span>{f.floor}</span><b>{f.count}</b></p>)}
        </>}
        {briefing && tab === 'routes' && <>
          {!routes && <p className="brigade-empty">Planning routes…</p>}
          {routes?.map((r, i) => (
            <div key={r.label} className="broute" style={{ borderLeftColor: CREW_COLORS[i % 2] }}>
              <strong style={{ color: CREW_COLORS[i % 2] }}>{r.label}</strong>
              <span>to {r.target.name} · {r.target.floor}</span>
              {r.reachable ? <>
                <span>From {r.start.into_space} · {Math.round(r.length_m ?? 0)} m{r.used_stairwell?.length ? ` · via ${r.used_stairwell.join(', ')}` : ''}</span>
                {r.stretcher_ok !== null && r.stretcher_ok !== undefined && <span className={r.stretcher_ok ? 'bok' : 'bbad'}>{r.stretcher_ok ? `Stretcher fits: every door ≥ ${r.stretcher_m} m ✓` : `Narrowest door ${r.narrowest_door?.width_m.toFixed(2)} m < ${r.stretcher_m} m: carry chair, not stretcher`}</span>}
                {r.avoided.filter(a => !a.reason.startsWith('lift')).map(a => <span key={a.connector_id} className="bavoid">✕ {a.connector_or_space} · {a.reason}</span>)}
                <ol>{(r.steps ?? []).slice(0, 6).map((s, j) => <li key={j}>{s}</li>)}</ol>
              </> : <span className="bbad">No way in at arrival</span>}
            </div>
          ))}
        </>}
      </div>}
    </section>
  );
}

/** F6: fire co-pilot questions for the crew, with the real room names (the first four show, the rest under More). */
export function brigadeChips(briefing: Briefing | undefined, people: People | undefined): { label: string; question: string }[] {
  if (!briefing) return [];
  const o = briefing.origin.name;
  const lea = people?.cannot_self_evacuate?.find(p => p.demo);
  return [
    { label: 'Which entrance gets us to the fire fastest?', question: `Which entrance gets us fastest to ${o}, and what is the route from there without lifts, avoiding the rooms on fire?` },
    { label: 'Nearest exit from the fire room', question: `How do I get from ${o} to the nearest exit, avoiding the rooms on fire?` },
    { label: 'How big is the fire room?', question: `How big is ${o} in m²?` },
    { label: "What's directly above and below the fire?", question: `What is directly above and directly below ${o}?` },
    { label: 'Which rooms share a wall with the fire room?', question: `Which rooms share a wall with ${o}?` },
    { label: 'Any labs, chemicals or server rooms near the fire?', question: `Are there labs with chemical cabinets or fume hoods, or server rooms, on ${briefing.origin.floor} or the floors directly above and below ${o}?` },
    { label: "Who is still inside and can't get out alone?", question: lea ? `${lea.person} uses a wheelchair and is in ${lea.name}. With all lifts off, is there a step-free way out from ${lea.name}?` : `With all lifts off, which rooms have no step-free way out?` },
    ...(lea ? [
      { label: `Fastest smoke-free route to ${lea.name}`, question: `Fastest route from the main entrance to ${lea.name} without using lifts.` },
      { label: `Will a stretcher fit to ${lea.name}?`, question: `Is every door on the route from the main entrance to ${lea.name} at least 1.1 m wide?` },
    ] : []),
    { label: 'Where is the main electrical panel?', question: 'Where is the electrical panel?' },
    { label: `How big is ${briefing.origin.floor}?`, question: `What is the total floor area of ${briefing.origin.floor}?` },
  ];
}
