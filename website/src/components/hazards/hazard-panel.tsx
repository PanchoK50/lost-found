'use client';

import { useEffect, useMemo, useState, type Ref } from 'react';
import type { Building } from '@/lib/buildings/types';
import { hazardMeta, type ImpactRoom, type PlaybookAction, type Relation } from '@/lib/hazards/types';
import { evacuationProgress, type HazardView } from './use-hazard';

const RELATION_LABEL: Record<Relation, string> = {
  origin: 'Where it started', below: 'Floor below', 'next door': 'Next door', above: 'Floor above', 'same floor': 'Same floor', 'other floor': 'Other floors',
};
type Tab = 'rooms' | 'assets' | 'evacuation' | 'response';

/** Side panel for a simulation or a live incident: timeline, what is hit, evacuation and the response. */
export function HazardPanel({ building, view, panelRef, onT, onPlay, onStartResponse, onRoom, onClose, onResolve }: {
  building: Building;
  view: HazardView;
  panelRef?: Ref<HTMLElement>;
  onT(t: number): void;
  onPlay(): void;
  onStartResponse(): void;
  onRoom(spaceId: string): void;
  onClose(): void;
  onResolve?(): void;
}) {
  const meta = hazardMeta[view.hazard];
  const origin = building.spaces.find(s => s.id === view.spaceId);
  const floorName = building.floors.find(f => f.id === origin?.floor_id)?.name;
  const data = view.data;
  const [tab, setTab] = useState<Tab>(view.mode === 'incident' ? 'response' : 'rooms');
  const reached = useMemo(() => (data?.impact.rooms ?? []).filter(r => r.arrival_min <= view.t + 1e-6), [data, view.t]);
  const people = useMemo(() => sum(dedupe(reached).map(r => r.people)), [reached]);
  const assets = useMemo(() => (data?.impact.assets_at_risk ?? []).filter(a => a.arrival_min <= view.t + 1e-6), [data, view.t]);
  const powerOut = reached.filter(r => r.kind === 'electrical').length;
  const minutes = data?.simulation.minutes ?? 30;
  const progress = data?.evacuation ? evacuationProgress(data, view.t) : undefined;

  return (
    <aside ref={panelRef} className={`hazard-panel hazard-panel--${view.hazard}${view.mode === 'incident' ? ' hazard-panel--live' : ''}`} aria-label={`${meta.label} in ${origin?.name}`}>
      <header className="hazard-head">
        <span className="hazard-icon" aria-hidden>{meta.icon}</span>
        <div>
          <span className="hazard-kicker">{view.mode === 'incident' ? 'Live incident' : 'Simulation'} · {meta.label}</span>
          <h2>{view.incident?.title ?? origin?.name}</h2>
          <span className="hazard-place">{origin?.name}{floorName ? ` · ${floorName}` : ''}</span>
        </div>
        <button type="button" className="hazard-close" onClick={onClose} aria-label="Close">✕</button>
      </header>

      {view.incident && (view.incident.photo || view.incident.description) && (
        <div className="hazard-report">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, nothing to optimise */}
          {view.incident.photo && <img src={view.incident.photo} alt="Reported damage" />}
          <p>{view.incident.description}{view.incident.reporter ? <em> · reported by {view.incident.reporter}</em> : null}</p>
        </div>
      )}

      {view.error && <p className="hazard-error">{view.error}</p>}
      {!data && !view.error && <p className="hazard-loading">Working out what this means for the building…</p>}

      {data && <>
        <div className="hazard-timeline">
          <button type="button" className="hazard-play" onClick={onPlay} aria-label={view.playing ? 'Pause' : 'Play'}>{view.playing ? '❚❚' : '▶'}</button>
          <input type="range" min={0} max={minutes} step={0.25} value={view.t} onChange={event => onT(Number(event.target.value))} aria-label="Minutes after the start" />
          <span className="hazard-clock">{view.t < 1 ? 'Start' : `+${Math.round(view.t)} min`}</span>
        </div>

        <div className="hazard-stats">
          <Stat value={dedupe(reached).length} label="spaces hit" />
          <Stat value={people} label="people at risk" />
          <Stat value={assets.length} label="critical assets" />
          {(powerOut > 0 || view.hazard === 'electrical') && <Stat value={powerOut} label="without power" />}
        </div>
        {progress && progress.total > 0 && (
          <div className="hazard-drill" aria-live="polite">
            <div className="hazard-drill-bar"><span style={{ width: `${(100 * progress.out) / progress.total}%` }} /></div>
            <span>🏃 <strong>{progress.out}</strong> of {progress.total} people safe{progress.out >= progress.total - progress.trapped && progress.total - progress.trapped > 0 ? ` · all out by +${progress.lastOutMin.toFixed(1)} min` : ''}{progress.trapped ? ` · ${progress.trapped} trapped` : ''}</span>
          </div>
        )}
        {data.impact.cascades.filter(c => c.at_min <= view.t).map(c => (
          <p key={c.circuit} className="hazard-cascade">⚡ {c.reason}: power cut on that circuit (+{Math.round(c.at_min)} min).</p>
        ))}

        <nav className="hazard-tabs" role="tablist">
          {(['rooms', 'assets', ...(data.evacuation?.walkers.length ? ['evacuation' as const] : []), 'response'] as Tab[]).map(t => (
            <button type="button" role="tab" key={t} aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'rooms' ? 'Rooms' : t === 'assets' ? 'Assets' : t === 'evacuation' ? 'Evacuation' : 'Response'}</button>
          ))}
        </nav>

        <div className="hazard-body">
          {tab === 'rooms' && <Rooms rooms={reached} onRoom={onRoom} />}
          {tab === 'assets' && (assets.length ? (
            <ul className="hazard-list">
              {assets.map(a => (
                <li key={`${a.asset_id}-${a.kind}`}><button type="button" onClick={() => onRoom(a.space_id)}>
                  <strong>{a.name}</strong><span>{a.room} · {a.kind === 'electrical' ? 'power cut' : a.kind} at +{Math.round(a.arrival_min)} min</span>
                </button></li>
              ))}
            </ul>
          ) : <p className="hazard-empty">No critical equipment hit yet.</p>)}
          {tab === 'evacuation' && data.evacuation && (
            <div className="hazard-evac">
              <p><strong>{data.evacuation.people}</strong> people to get out · longest way {Math.round(data.evacuation.longest_m)} m · everyone out by <strong>+{data.evacuation.all_out_min.toFixed(1)} min</strong>{view.hazard === 'fire' ? ' · lifts off' : ''}.</p>
              {data.evacuation.exits.length > 1 && data.evacuation.exits[0].people > 0.7 * data.evacuation.people && (
                <p className="hazard-cascade">🚪 Bottleneck: {Math.round((100 * data.evacuation.exits[0].people) / data.evacuation.people)}% of people use one exit ({data.evacuation.exits[0].width_m.toFixed(1)} m wide, clear at +{data.evacuation.exits[0].clear_min.toFixed(1)} min). Signpost the other exits.</p>
              )}
              {data.evacuation.cut_off.length > 0 && <p className="hazard-error">{data.evacuation.cut_off.length} rooms cut off by the fire: {data.evacuation.cut_off.slice(0, 4).map(c => c.name).join(', ')}. Rescue needed.</p>}
              <ul className="hazard-list">
                {data.evacuation.exits.slice(0, 5).map(exit => {
                  const opening = building.openings.find(o => o.id === exit.opening_id);
                  const inside = building.spaces.find(s => opening?.space_ids.includes(s.id));
                  return <li key={exit.opening_id}><span className="hazard-row"><strong>Exit by {inside?.name ?? 'entrance'}</strong><span>{exit.people} people · clear +{exit.clear_min.toFixed(1)} min</span></span></li>;
                })}
              </ul>
            </div>
          )}
          {tab === 'response' && <Response actions={data.playbook} startedAt={view.responseStartedAt} live={view.mode === 'incident'} onStart={onStartResponse} />}
        </div>
      </>}

      {view.mode === 'incident' && onResolve && <footer className="hazard-foot"><button type="button" onClick={onResolve}>Mark as resolved</button></footer>}
    </aside>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return <div className="hazard-stat"><strong>{value}</strong><span>{label}</span></div>;
}

function Rooms({ rooms, onRoom }: { rooms: ImpactRoom[]; onRoom(spaceId: string): void }) {
  const groups = new Map<Relation, ImpactRoom[]>();
  for (const room of rooms) groups.set(room.relation, [...(groups.get(room.relation) ?? []), room]);
  if (!rooms.length) return <p className="hazard-empty">Nothing reached yet. Press play.</p>;
  return <>
    {(Object.keys(RELATION_LABEL) as Relation[]).filter(rel => groups.has(rel)).map(rel => (
      <section key={rel} className="hazard-group">
        <h3>{RELATION_LABEL[rel]} <span>{groups.get(rel)!.length}</span></h3>
        <ul className="hazard-list">
          {groups.get(rel)!.slice(0, 12).map(room => (
            <li key={`${room.space_id}-${room.kind}`}><button type="button" onClick={() => onRoom(room.space_id)}>
              <span className={`hazard-dot hazard-dot--${room.kind}`} />
              <strong>{room.name}</strong>
              <span>{room.floor !== rooms[0].floor || rel !== 'origin' ? `${room.floor} · ` : ''}{room.kind === 'electrical' ? 'no power' : room.kind === 'water' ? 'water' : 'fire/smoke'} +{Math.round(room.arrival_min)} min{room.people ? ` · ${room.people} people` : ''}{room.critical_assets.length ? ` · ${room.critical_assets[0].name}` : ''}</span>
            </button></li>
          ))}
          {groups.get(rel)!.length > 12 && <li className="hazard-more">+{groups.get(rel)!.length - 12} more</li>}
        </ul>
      </section>
    ))}
  </>;
}

const STATUS_LABEL: Record<string, string> = { dialing: 'Calling…', connected: 'Connected', confirmed: 'Confirmed', in_progress: 'In progress', done: 'Done' };

/** The playbook; once started, calls go out one after another (simulated, the same timeline on every screen). */
function Response({ actions, startedAt, live, onStart }: { actions: PlaybookAction[]; startedAt?: number; live: boolean; onStart(): void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  const elapsed = startedAt ? (now - startedAt) / 1000 : -1;
  return <>
    {!startedAt && (
      <div className="hazard-start">
        <p>{live ? 'Response ready.' : 'This is what would happen. Nobody is called in a simulation.'}</p>
        <button type="button" onClick={onStart}>{live ? 'Start response' : 'Run response drill'}</button>
      </div>
    )}
    <ol className="hazard-actions">
      {actions.map(action => {
        const status = startedAt && (action.auto || live) ? [...action.timeline].reverse().find(step => elapsed >= step.at_s)?.status : undefined;
        return (
          <li key={action.order} className={`hazard-action hazard-action--${action.kind}${status ? ` is-${status}` : ''}`}>
            <span className="hazard-action-icon" aria-hidden>{ACTION_ICON[action.kind]}</span>
            <div>
              <strong>{action.title}</strong>
              <p>{action.detail}</p>
              {action.contact && <span className="hazard-contact">{action.contact.name} · {action.contact.phone}{action.eta_min && status === 'confirmed' ? ` · on the way, ETA ${action.eta_min} min` : ''}</span>}
            </div>
            <span className="hazard-status">{status ? STATUS_LABEL[status] ?? status : action.auto ? 'Auto' : 'Manual'}</span>
          </li>
        );
      })}
    </ol>
  </>;
}

const ACTION_ICON: Record<PlaybookAction['kind'], string> = { alarm: '🚨', call: '📞', notify: '💬', shutoff: '⏻', evacuate: '🏃' };

function dedupe(rooms: ImpactRoom[]) {
  const seen = new Map<string, ImpactRoom>();
  for (const room of rooms) if (!seen.has(room.space_id)) seen.set(room.space_id, room);
  return [...seen.values()];
}
function sum(values: number[]) { return values.reduce((a, b) => a + b, 0); }
