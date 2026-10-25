'use client';

import { useEffect, useMemo, useState, type Ref } from 'react';
import type { Building } from '@/lib/buildings/types';
import { hazardMeta, type Contact, type ImpactRoom, type Incident, type PlaybookAction, type Relation, type SimulateResponse } from '@/lib/hazards/types';
import { evacuationProgress, keyRoom, type HazardView } from './use-hazard';

const RELATION_LABEL: Record<Relation, string> = {
  origin: 'Where it started', below: 'Floor below', 'next door': 'Next door', above: 'Floor above', 'same floor': 'Same floor', 'other floor': 'Other floors',
};
type Tab = 'overview' | 'affected' | 'response';
const TITLE: Record<string, string> = { fire: 'Fire', water: 'Water leak', electrical: 'Power fault' };

/** Side panel for a simulation or a live incident: timeline, what is hit, evacuation and the response. */
export function HazardPanel({ building, view, incident, panelRef, onStartResponse, onRoom, onShowFloor, onClose, onResolve, onDispatch, onFixed }: {
  building: Building;
  view: HazardView;
  /** The live incident as stored (ticket, fixed); the view only holds the snapshot it was opened with. */
  incident?: Incident;
  /** One tap: dispatch the main responder for this hazard (technician, plumber, fire brigade). */
  onDispatch?(contact: Contact): void;
  /** The responder reports it fixed. */
  onFixed?(): void;
  panelRef?: Ref<HTMLElement>;
  onStartResponse(): void;
  /** Back to the whole-building view of the hazard. */
  onShowModel(): void;
  /** Show one floor of the building (the panel links floors that are affected). */
  onShowFloor(floorId: string): void;
  onRoom(spaceId: string): void;
  onClose(): void;
  onResolve?(): void;
}) {
  const meta = hazardMeta[view.hazard];
  const origin = building.spaces.find(s => s.id === view.spaceId);
  const floorName = building.floors.find(f => f.id === origin?.floor_id)?.name;
  const data = view.data;
  const [tab, setTab] = useState<Tab>('overview');
  const reached = useMemo(() => (data?.impact.rooms ?? []).filter(r => r.arrival_min <= view.t + 1e-6), [data, view.t]);
  const assets = useMemo(() => (data?.impact.assets_at_risk ?? []).filter(a => a.arrival_min <= view.t + 1e-6), [data, view.t]);
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
        <nav className="hazard-tabs" role="tablist">
          {(['overview', 'affected', 'response'] as Tab[]).map(t => (
            <button type="button" role="tab" key={t} aria-selected={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>
          ))}
        </nav>

        <div className="hazard-body">
          {tab === 'overview' && (
            <Overview view={view} data={data} reached={reached} progress={progress} incident={incident} onShowFloor={onShowFloor} onRoom={onRoom} onDetails={() => setTab('response')} />
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
          {view.mode === 'incident' && incident ? (
            incident.fixedAt ? <button type="button" className="hazard-secondary" onClick={onResolve ?? onClose}>Close incident</button>
            : incident.ticket ? <button type="button" className="hazard-run" onClick={onFixed}>Mark as fixed</button>
            : <>
                {primaryContact(data.playbook) && <button type="button" className="hazard-run" onClick={() => onDispatch?.(primaryContact(data.playbook)!)}>Call {roleLabel(primaryContact(data.playbook)!.role)}</button>}
                {!view.responseStartedAt && <button type="button" className="hazard-secondary" onClick={onStartResponse}>Notify everyone</button>}
              </>
          ) : !view.responseStartedAt && <button type="button" className="hazard-run" onClick={onStartResponse}>Run response drill</button>}
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


/**
 * Overview: facts first, each saying what it counts and why, then the response, then clearing the rooms.
 * Water (or fire) and the power cut it causes are counted separately, so the numbers add up.
 */
function Overview({ view, data, reached, progress, incident, onShowFloor, onRoom, onDetails }: {
  view: HazardView; data: SimulateResponse; reached: ImpactRoom[]; progress?: ReturnType<typeof evacuationProgress>; incident?: Incident;
  onShowFloor(floorId: string): void; onRoom(spaceId: string): void; onDetails(): void;
}) {
  const now = useNow(view.responseStartedAt);
  const elapsed = view.responseStartedAt ? (now - view.responseStartedAt) / 1000 : -1;
  const live = view.mode === 'incident';
  const main = view.hazard;
  const hit = dedupe(reached.filter(r => r.kind === main));
  const dark = dedupe(reached.filter(r => r.kind === 'electrical'));
  const darkOnly = dark.filter(r => !hit.some(h => h.space_id === r.space_id));
  const floors = [...new Map(hit.map(r => [r.floor_id, { id: r.floor_id, name: r.floor, rooms: hit.filter(h => h.floor_id === r.floor_id).length }])).values()];
  const cascade = data.impact.cascades.find(c => c.at_min <= view.t);
  const equipment = data.impact.assets_at_risk.filter(a => a.arrival_min <= view.t && a.kind === main);
  const key = keyRoom(data);
  const keyFloor = key && data.impact.rooms.find(r => r.space_id === key.space_id)?.floor_id;
  const calls = data.playbook.filter(a => a.contact && (a.kind === 'call' || a.kind === 'notify'));
  const unique = calls.filter((a, i) => calls.findIndex(b => b.contact!.name === a.contact!.name) === i).slice(0, 4);
  const confirmed = unique.filter(a => ['confirmed', 'done'].includes(statusOf(a, elapsed, live) ?? '')).length;
  const noun = main === 'fire' ? 'Fire and smoke' : main === 'water' ? 'Water' : 'Power off';
  const peopleInHit = hit.reduce((sum, r) => sum + r.people, 0);
  const peopleDark = darkOnly.reduce((sum, r) => sum + r.people, 0);
  // Power: what a tripped circuit takes with it. Lifts on it stop; server rooms on it run on their UPS.
  const powerRooms = main === 'electrical' ? hit : dark;
  const liftsOff = powerRooms.filter(r => r.type === 'lift').length;
  const ups = powerRooms.find(r => r.room_type === 'server_room') ?? powerRooms.find(r => r.room_type === 'technical_room');
  const outageStart = main === 'electrical' ? 0 : cascade?.at_min;
  const fixed = Boolean(incident?.fixedAt);
  const upsLeft = ups && outageStart !== undefined
    ? Math.max(0, UPS_MIN * 60 - (view.mode === 'incident' && incident ? (now - incident.createdAt) / 1000 : (view.t - outageStart) * 60))
    : undefined;
  const circuit = main === 'electrical' ? circuitLabel(data, view.spaceId) : undefined;
  return (
    <div className="hz-overview">
      {fixed && <p className="hz-fixed">Status: fixed · {incident?.ticket?.name ?? 'responder'} closed the job</p>}
      <section className="hz-section">
        <header><h3>Situation</h3><span>{live ? 'predicted' : 'simulated'} · at +{fmt(view.t)}</span></header>
        <dl className="hz-facts">
          <div>
            <dt><i className={`hazard-dot hazard-dot--${main}`} />{noun}</dt>
            <dd>
              {fixed ? 'Restored' : `${hit.length} ${hit.length === 1 ? 'space' : 'spaces'}`}{circuit && !fixed && <small>Circuit {circuit} tripped</small>}
              {floors.length > 0 && !fixed && <span className="hz-floors">{floors.map(f => <button type="button" key={f.id} onClick={() => onShowFloor(f.id)}>{f.name} ({f.rooms})</button>)}</span>}
            </dd>
          </div>
          {main === 'electrical' && (
            <div>
              <dt>Lifts</dt>
              <dd>{fixed ? 'Running' : liftsOff ? `${liftsOff} offline` : 'Running'}<small>{liftsOff && !fixed ? 'On the tripped circuit; use the stairs' : 'Not on the tripped circuit'}</small></dd>
            </div>
          )}
          {ups && upsLeft !== undefined && !fixed && (
            <div>
              <dt>Backup</dt>
              <dd className={upsLeft < 600 ? 'is-urgent' : ''}>{fmtClock(upsLeft)} left<small>{ups.name} on UPS ({UPS_MIN} min autonomy assumed)</small></dd>
            </div>
          )}
          {main !== 'electrical' && (
            <div>
              <dt><i className="hazard-dot hazard-dot--electrical" />Power</dt>
              <dd>{cascade ? <>{dark.length} spaces off since +{Math.round(cascade.at_min)} min<small>{cascade.reason.replace(/^Water reaches|^Fire reaches/, main === 'water' ? 'Water on' : 'Fire at')} in {data.impact.rooms.find(r => r.space_id === cascade.space_id)?.name}</small></> : <>On<small>{data.impact.cascades.length ? `Cut at +${Math.round(data.impact.cascades[0].at_min)} min if nothing is done` : 'No electrics in the path'}</small></>}</dd>
            </div>
          )}
          <div>
            <dt>People</dt>
            <dd>{fixed ? `Back to normal for ${peopleInHit + peopleDark}` : main === 'electrical' ? `${peopleInHit} without power` : `${peopleInHit} in affected rooms`}{main !== 'electrical' && peopleDark > 0 && <small>{peopleDark} more only without power</small>}</dd>
          </div>
          {!fixed && <div>
            <dt>Equipment</dt>
            <dd>{equipment.length ? <>{equipment.length} at risk<small>{[...new Set(equipment.map(a => `${a.type.replaceAll('_', ' ')} (${a.room})`))].slice(0, 2).join(' · ')}</small></> : 'None hit yet'}</dd>
          </div>}
        </dl>
        {key && !fixed && (
          <button type="button" className="hz-key" onClick={() => { if (keyFloor) onShowFloor(keyFloor); onRoom(key.space_id); }}>
            <span>{key.arrival_min <= view.t ? 'Reached' : `Next, at +${Math.round(key.arrival_min)} min`}</span>
            <strong>{key.name}</strong>
            <em>{key.floor}{key.relation === 'below' ? ', directly below' : ''}{key.critical_assets.length ? ` · ${key.critical_assets.length} critical item${key.critical_assets.length > 1 ? 's' : ''}` : key.people ? ` · ${key.people} people` : ''}</em>
          </button>
        )}
      </section>

      {incident?.ticket && (
        <section className="hz-section">
          <header><h3>Ticket</h3><span>{incident.ticket.name}</span></header>
          <ol className="hz-tracker">
            <li className="is-done">Reported</li>
            <li className={fixed ? 'is-done' : 'is-active'}>On the way{incident.ticket.etaMin && !fixed ? ` · ETA ${incident.ticket.etaMin} min` : ''}</li>
            <li className={fixed ? 'is-done' : ''}>Fixed</li>
          </ol>
        </section>
      )}

      <section className="hz-section">
        <header><h3>Response</h3><span>{view.responseStartedAt ? `${confirmed} of ${unique.length} confirmed` : live ? 'not started' : 'calls simulated'}</span></header>
        <ul className="hz-responders">
          {unique.map(action => {
            const status = statusOf(action, elapsed, live);
            const tone = status === 'confirmed' || status === 'done' ? 'ok' : status ? 'busy' : 'idle';
            return <li key={action.order} className={`is-${tone}`}><i /><span>{action.contact!.name.split(' (')[0]}</span><em>{status ? STATUS_LABEL[status] ?? status : 'Pending'}</em></li>;
          })}
        </ul>
        <button type="button" className="hazard-link" onClick={onDetails}>All {data.playbook.length} steps →</button>
      </section>

      {progress && progress.total > 0 && (
        <section className="hz-section">
          <header><h3>{main === 'fire' ? 'Evacuation' : 'Clearing the affected rooms'}</h3><span>{progress.out} of {progress.total} out</span></header>
          <div className="hazard-drill-bar"><span style={{ width: `${(100 * progress.out) / Math.max(1, progress.total)}%` }} /></div>
          <p className="hz-note">{main === 'fire' ? 'Everyone in the building' : `Everyone from the ${main === 'water' ? 'rooms the water reaches' : 'rooms without power'}`}, out by +{progress.lastOutMin.toFixed(1)} min{progress.trapped ? ` · ${progress.trapped} trapped` : ''}{main === 'fire' ? ' · lifts off' : ''}</p>
        </section>
      )}
    </div>
  );
}

const UPS_MIN = 40;

function fmtClock(seconds: number) {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** A short name for the circuit: the panel's name, or "zone N" where the plans have no panels. */
function circuitLabel(data: SimulateResponse, spaceId: string) {
  const entry = data.simulation.spaces.find(e => e.space_id === spaceId && e.kind === 'electrical') as (SimulateResponse['simulation']['spaces'][number] & { circuit?: string }) | undefined;
  const circuit = entry?.circuit;
  if (!circuit) return undefined;
  const [kind, ...rest] = circuit.split(':');
  return kind === 'zone' ? `${rest[0].split('-F').pop()}-${String.fromCharCode(65 + Number(rest[1]))}` : rest.join(':').split('-').pop();
}

/** The responder one tap dispatches: the first call in the playbook (electrician, plumber, fire brigade). */
function primaryContact(actions: PlaybookAction[]) {
  return actions.find(a => a.kind === 'call' && a.contact)?.contact ?? undefined;
}

function roleLabel(role: string) {
  return ({ electrician: 'technician', plumber: 'plumber', fire_brigade: 'fire brigade', facility: 'facility manager', it: 'IT' } as Record<string, string>)[role] ?? role.replaceAll('_', ' ');
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
