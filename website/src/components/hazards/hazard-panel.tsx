'use client';

import { useEffect, useMemo, useState, type Ref } from 'react';
import type { Building } from '@/lib/buildings/types';
import { hazardMeta, type ImpactRoom, type PlaybookAction, type Relation } from '@/lib/hazards/types';
import { evacuationProgress, keyRoom, type HazardView } from './use-hazard';

const RELATION_LABEL: Record<Relation, string> = {
  origin: 'Where it started', below: 'Floor below', 'next door': 'Next door', above: 'Floor above', 'same floor': 'Same floor', 'other floor': 'Other floors',
};
type Tab = 'overview' | 'affected' | 'response';
const TITLE: Record<string, string> = { fire: 'Fire', water: 'Water leak', electrical: 'Power fault' };

/** Side panel for a simulation or a live incident: timeline, what is hit, evacuation and the response. */
export function HazardPanel({ building, view, panelRef, onStartResponse, onRoom, onShowModel, onClose, onResolve }: {
  building: Building;
  view: HazardView;
  panelRef?: Ref<HTMLElement>;
  onStartResponse(): void;
  /** Back to the whole-building view of the hazard. */
  onShowModel(): void;
  onRoom(spaceId: string): void;
  onClose(): void;
  onResolve?(): void;
}) {
  const meta = hazardMeta[view.hazard];
  const origin = building.spaces.find(s => s.id === view.spaceId);
  const floorName = building.floors.find(f => f.id === origin?.floor_id)?.name;
  const data = view.data;
  const [tab, setTab] = useState<Tab>('overview');
  const key = data ? keyRoom(data) : undefined;
  const reached = useMemo(() => (data?.impact.rooms ?? []).filter(r => r.arrival_min <= view.t + 1e-6), [data, view.t]);
  const people = useMemo(() => sum(dedupe(reached).map(r => r.people)), [reached]);
  const assets = useMemo(() => (data?.impact.assets_at_risk ?? []).filter(a => a.arrival_min <= view.t + 1e-6), [data, view.t]);
  const powerOut = reached.filter(r => r.kind === 'electrical').length;
  const progress = data?.evacuation ? evacuationProgress(data, view.t) : undefined;

  return (
    <aside ref={panelRef} className={`hazard-panel hazard-panel--${view.hazard}${view.mode === 'incident' ? ' hazard-panel--live' : ''}`} aria-label={`${meta.label} in ${origin?.name}`}>
      <header className="hazard-head">
        <span className={`hazard-swatch hazard-swatch--${view.hazard}`} aria-hidden />
        <div>
          <h2>{TITLE[view.hazard]} / {origin?.name}</h2>
          <span className="hazard-place">{view.mode === 'incident' ? `Live incident${view.incident?.reporter ? ` · reported by ${view.incident.reporter}` : ''}` : 'Practice response · Calls simulated'}{floorName ? ` · ${floorName}` : ''}</span>
        </div>
        <button type="button" className="hazard-close" onClick={onClose} aria-label="Close">✕</button>
      </header>

      {view.incident && (view.incident.photo || (view.incident.description && view.incident.description !== 'Reported without details.')) && (
        <div className="hazard-report">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, nothing to optimise */}
          {view.incident.photo && <img src={view.incident.photo} alt="Reported damage" />}
          <p>{view.incident.description}</p>
        </div>
      )}

      {view.error && <p className="hazard-error">{view.error}</p>}
      {!data && !view.error && <p className="hazard-loading">Working out what this means for the building…</p>}

      {data && <>
        <dl className="hazard-figures">
          <div><dt>Spaces</dt><dd>{dedupe(reached).length}</dd></div>
          <div><dt>People</dt><dd>{people}</dd></div>
          <div><dt>{view.hazard === 'electrical' ? 'No power' : 'Critical assets'}</dt><dd>{view.hazard === 'electrical' ? powerOut : assets.length}</dd></div>
        </dl>
        {data.impact.cascades.filter(c => c.at_min <= view.t).slice(0, 1).map(c => (
          <p key={c.circuit} className="hazard-cascade">{c.reason}: power cut on that circuit at +{Math.round(c.at_min)} min.</p>
        ))}

        <nav className="hazard-tabs" role="tablist">
          {(['overview', 'affected', 'response'] as Tab[]).map(t => (
            <button type="button" role="tab" key={t} aria-selected={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>
          ))}
        </nav>

        <div className="hazard-body">
          {tab === 'overview' && (
            <Overview view={view} originName={origin?.name ?? ''} keyName={key?.name} keyRelation={key?.relation} reached={dedupe(reached).length} people={people} assets={assets.length}
              actions={data.playbook} progress={progress} onShowModel={onShowModel} onDetails={() => setTab('response')} />
          )}
          {tab === 'affected' && <Rooms rooms={reached} onRoom={onRoom} />}
          {tab === 'affected' && assets.length > 0 && <h3 className="hazard-subhead">Critical assets</h3>}
          {tab === 'affected' && (assets.length ? (
            <ul className="hazard-list">
              {assets.map(a => (
                <li key={`${a.asset_id}-${a.kind}`}><button type="button" onClick={() => onRoom(a.space_id)}>
                  <strong>{a.name}</strong><span>{a.room} · {a.kind === 'electrical' ? 'power cut' : a.kind} at +{Math.round(a.arrival_min)} min</span>
                </button></li>
              ))}
            </ul>
          ) : null)}
          {tab === 'response' && data.evacuation && data.evacuation.walkers.length > 0 && (
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

      {data && (
        <footer className="hazard-foot">
          {!view.responseStartedAt && <button type="button" className="hazard-run" onClick={onStartResponse}>{view.mode === 'incident' ? 'Start response' : 'Run response drill'}</button>}
          {view.mode === 'incident' && onResolve && <button type="button" className="hazard-secondary" onClick={onResolve}>Mark as resolved</button>}
        </footer>
      )}
    </aside>
  );
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

const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', affected: 'Affected', response: 'Response' };

function clockTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The response as numbered steps, like a checklist: report → affected spaces → responders → (evacuation). */
function Overview({ view, originName, keyName, keyRelation, reached, actions, progress, onShowModel, onDetails }: {
  view: HazardView; originName: string; keyName?: string; keyRelation?: Relation; reached: number; people: number; assets: number;
  actions: PlaybookAction[]; progress?: ReturnType<typeof evacuationProgress>; onShowModel(): void; onDetails(): void;
}) {
  const now = useNow(view.responseStartedAt);
  const elapsed = view.responseStartedAt ? (now - view.responseStartedAt) / 1000 : -1;
  const calls = actions.filter(a => a.contact && (a.kind === 'call' || a.kind === 'notify'));
  const unique = calls.filter((a, i) => calls.findIndex(b => b.contact!.name === a.contact!.name) === i).slice(0, 4);
  const live = view.mode === 'incident';
  const started = view.incident?.createdAt ?? view.responseStartedAt;
  return (
    <ol className="hazard-steps">
      <li className="hazard-step is-done">
        <span className="hazard-step-n">1</span>
        <div><strong>{live ? 'Report received' : 'Scenario started'}</strong><p>{live ? `Room confirmed: ${originName}` : `${TITLE[view.hazard]} starts in ${originName}`}</p></div>
        {started && <time>{clockTime(started)}</time>}
      </li>
      <li className="hazard-step">
        <span className="hazard-step-n">2</span>
        <div>
          <strong>Review affected spaces</strong>
          <p>{keyName ? `${originName}, and ${keyName}${keyRelation && keyRelation !== 'same floor' ? ` ${keyRelation === 'below' ? 'on the floor below' : keyRelation}` : ''}` : originName}{reached > 1 ? ` · ${reached - 1} more space${reached - 1 === 1 ? '' : 's'} by now` : ''}</p>
        </div>
        <button type="button" className="hazard-link" onClick={onShowModel}>Show on model →</button>
      </li>
      <li className="hazard-step">
        <span className="hazard-step-n">3</span>
        <div>
          <strong>Notify responders</strong>
          <div className="hazard-responders">
            {unique.map(action => {
              const status = statusOf(action, elapsed, live);
              const tone = status === 'confirmed' || status === 'done' ? 'ok' : status ? 'busy' : 'idle';
              return <span key={action.order} className={`hazard-responder is-${tone}`}><i />{action.contact!.name.split(' (')[0]}<em>{status ? `${live ? '' : 'Demo '}${STATUS_LABEL[status]?.toLowerCase() ?? status}` : 'Pending'}</em></span>;
            })}
          </div>
        </div>
      </li>
      {progress && progress.total > 0 && (
        <li className="hazard-step">
          <span className="hazard-step-n">4</span>
          <div>
            <strong>{view.hazard === 'fire' ? 'Evacuate' : 'Clear the affected rooms'}</strong>
            <p>{progress.out} of {progress.total} people safe{progress.trapped ? ` · ${progress.trapped} trapped` : ''} · all out by +{progress.lastOutMin.toFixed(1)} min</p>
            <div className="hazard-drill-bar"><span style={{ width: `${(100 * progress.out) / Math.max(1, progress.total)}%` }} /></div>
          </div>
        </li>
      )}
      {view.responseStartedAt && <li className="hazard-step-actions"><button type="button" className="hazard-link" onClick={onDetails}>All {actions.length} response steps →</button></li>}
    </ol>
  );
}

function statusOf(action: PlaybookAction, elapsed: number, live: boolean) {
  if (elapsed < 0 || !(action.auto || live)) return undefined;
  return [...action.timeline].reverse().find(step => elapsed >= step.at_s)?.status;
}

function useNow(active?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Scenario playback under the model: play/pause and scrub the minutes. */
export function HazardPlayback({ view, onT, onPlay }: { view: HazardView; onT(t: number): void; onPlay(): void }) {
  const minutes = view.data?.simulation.minutes ?? 30;
  return (
    <div className="hazard-playback">
      <div className="hazard-playback-head"><strong>Scenario playback</strong><span>{view.mode === 'incident' ? 'Predicted spread' : 'Illustrative scenario'}</span></div>
      <div className="hazard-timeline">
        <button type="button" className="hazard-play" onClick={onPlay} disabled={!view.data} aria-label={view.playing ? 'Pause' : 'Play'}>{view.playing ? '❚❚' : '▶'}</button>
        <span className="hazard-clock">{fmt(view.t)}</span>
        <input type="range" min={0} max={minutes} step={0.25} value={view.t} onChange={event => onT(Number(event.target.value))} aria-label="Minutes after the start" disabled={!view.data} />
        <span className="hazard-clock">{fmt(minutes)}</span>
      </div>
    </div>
  );
}

function fmt(minutes: number) {
  const m = Math.floor(minutes), s = Math.round((minutes - m) * 60);
  return `${m}:${String(s === 60 ? 0 : s).padStart(2, '0')}`;
}

const STATUS_LABEL: Record<string, string> = { dialing: 'Calling…', connected: 'Connected', confirmed: 'Confirmed', in_progress: 'In progress', done: 'Done' };

/** The playbook; once started, calls go out one after another (simulated, the same timeline on every screen). */
function Response({ actions, startedAt, live, onStart }: { actions: PlaybookAction[]; startedAt?: number; live: boolean; onStart(): void }) {
  const now = useNow(startedAt);
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
        const status = startedAt ? statusOf(action, elapsed, live) : undefined;
        return (
          <li key={action.order} className={`hazard-action hazard-action--${action.kind}${status ? ` is-${status}` : ''}`}>
            <span className="hazard-action-icon" aria-hidden>{action.order + 1}</span>
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


function dedupe(rooms: ImpactRoom[]) {
  const seen = new Map<string, ImpactRoom>();
  for (const room of rooms) if (!seen.has(room.space_id)) seen.set(room.space_id, room);
  return [...seen.values()];
}
function sum(values: number[]) { return values.reduce((a, b) => a + b, 0); }
