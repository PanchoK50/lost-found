'use client';

import { useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { Profile } from '@/lib/world/profile';
import type { PinKind, WorldAction, WorldState } from '@/lib/world/types';
import type { WorldActions } from './world-hud';
import { Segmented } from './segmented';
import { Sheet } from './sheet';
import { SpaceSelect } from './space-select';

type ReportKind = Exclude<PinKind, 'meet'>;
/** A pin proposed in chat, to edit before posting. */
export type ReportDraft = Extract<WorldAction, { type: 'pin.create' }>['pin'];
const kinds: { value: ReportKind; label: string }[] = [
  { value: 'blocked', label: 'Blocked' }, { value: 'broken', label: 'Broken' }, { value: 'item', label: 'Item' },
  { value: 'event', label: 'Event' }, { value: 'info', label: 'Info' },
];
const suggest: Record<ReportKind, (place: string) => string> = {
  blocked: place => `${place} blocked`,
  broken: place => `${place} out of order`,
  item: place => `Item left in ${place}`,
  event: place => `Event in ${place}`,
  info: place => `Note about ${place}`,
};

/**
 * Quick action "Report" (docs/MULTIPLAYER.md §11): pick what and where, check the preview, confirm (U8).
 * Blocked and broken reports on stairs, lifts or spaces close them for routing. Phase 2 routes this through chat proposals.
 */
export function ReportSheet({ building, profile, world, floorId, initial, act, onPosted, onClose }: {
  building: Building;
  profile: Profile;
  world?: WorldState;
  /** The floor in view: a stair or lift report is pinned on this floor if it stops here. */
  floorId?: string;
  initial?: ReportDraft;
  act: WorldActions['act'];
  onPosted(floorId: string): void;
  onClose(): void;
}) {
  const initialPlace = initial && building.vertical_connectors.some(c => c.id === initial.elementId) ? initial.elementId! : initial?.spaceId;
  const [kind, setKind] = useState<ReportKind>(initial && initial.kind !== 'meet' ? initial.kind : 'blocked');
  const [place, setPlace] = useState(initialPlace ?? profile.rooms[building.building.id] ?? '');
  const [title, setTitle] = useState<string | undefined>(initial?.title);
  const [detail, setDetail] = useState(initial?.detail ?? '');
  // An item the chat recognised (e.g. a broken coffee machine) stays attached while the place is unchanged.
  const assetId = initial?.assetId && place === initialPlace ? initial.assetId : undefined;
  const [step, setStep] = useState<'form' | 'preview'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const connector = building.vertical_connectors.find(c => c.id === place);
  const space = connector
    ? building.spaces.find(s => s.id === (connector.space_ids[connector.floor_ids.indexOf(floorId ?? '')] ?? connector.space_ids[0]))
    : building.spaces.find(s => s.id === place);
  const placeName = connector?.name ?? space?.name ?? '';
  const finalTitle = (title ?? (placeName ? suggest[kind](placeName) : '')).trim();
  const closes = (kind === 'blocked' || kind === 'broken') && !assetId;
  const floor = building.floors.find(f => f.id === space?.floor_id);

  async function confirm() {
    if (!space) return;
    setBusy(true);
    const result = await act({
      type: 'pin.create',
      pin: {
        kind, spaceId: space.id, title: finalTitle,
        detail: detail.trim() || undefined,
        elementId: closes ? (connector?.id ?? space.id) : undefined,
        assetId,
        position: assetId ? initial?.position : undefined,
        authorId: profile.id,
        audience: world?.mode === 'public' ? 'everyone' : 'team',
      },
    });
    setBusy(false);
    if (!result.ok) { setError(result.error); setStep('form'); return; }
    onPosted(space.floor_id);
    onClose();
  }

  return (
    <Sheet title="Report" onClose={onClose}>
      {step === 'form' ? <>
        <section>
          <h3>What</h3>
          <Segmented<ReportKind> label="Kind" className="segmented--kinds" options={kinds} value={kind} onChange={setKind} />
        </section>
        <section>
          <h3>Where</h3>
          <SpaceSelect building={building} connectors value={place} empty="Pick a place" onChange={id => { setPlace(id); setError(undefined); }} />
          {closes && space && <p className="hint">Routes for everyone will avoid {placeName}{world?.mode === 'public' ? ' once a second person confirms it' : ''}.</p>}
        </section>
        <section>
          <label>Title<input value={title ?? finalTitle} maxLength={80} onChange={e => setTitle(e.target.value)} placeholder="What is going on?" /></label>
          <label>Details (optional)<input value={detail} maxLength={500} onChange={e => setDetail(e.target.value)} /></label>
          {error && <p className="sheet-error">{error}</p>}
          <div className="sheet-actions">
            <button type="button" className="button button--primary" disabled={!space || !finalTitle} onClick={() => setStep('preview')}>Preview</button>
          </div>
        </section>
      </> : <section>
        <h3>Post this?</h3>
        <div className={`preview-card preview-card--${closes ? 'alert' : kind === 'item' ? 'item' : 'info'}`}>
          <span>
            <strong>{finalTitle}</strong>
            <small>{placeName}{floor ? ` · ${floor.name}` : ''} · {kinds.find(k => k.value === kind)!.label}{closes ? ' · closes it for routing' : ''}</small>
            {detail.trim() && <small>{detail.trim()}</small>}
          </span>
        </div>
        <div className="sheet-actions">
          <button type="button" className="button" onClick={() => setStep('form')}>Edit</button>
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void confirm()}>{busy ? 'Posting…' : 'Confirm'}</button>
        </div>
      </section>}
    </Sheet>
  );
}
