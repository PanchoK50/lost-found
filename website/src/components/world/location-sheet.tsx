'use client';

import type { Building } from '@/lib/buildings/types';
import { Sheet } from './sheet';
import { SpaceSelect } from './space-select';

/** "Where are you?": picked by hand, since the plans are not where we physically are (no GPS indoors). */
export function LocationSheet({ building, room, sharing, onChange, onSettings, onClose }: {
  building: Building;
  room?: string;
  sharing: boolean;
  onChange(spaceId: string | undefined): void;
  onSettings(): void;
  onClose(): void;
}) {
  return (
    <Sheet title="Where are you?" onClose={onClose}>
      <p className="sheet-hint">Pick the room you are in, or tap a room on the map and choose “I’m here”. Routes start here, and teammates see you on the map.</p>
      <SpaceSelect building={building} value={room ?? ''} empty="Not set" onChange={id => onChange(id || undefined)} />
      <p className="sheet-hint location-sharing">
        {sharing ? 'Shared with your team.' : 'Not shared: only you see it.'}{' '}
        <button type="button" className="link-button" onClick={onSettings}>Privacy settings</button>
      </p>
      {room && <button type="button" className="demo-signout" onClick={() => onChange(undefined)}>Clear my location</button>}
    </Sheet>
  );
}
