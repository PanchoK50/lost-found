'use client';

import { useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { Profile } from '@/lib/world/profile';
import type { Pin, WorldState } from '@/lib/world/types';
import type { WorldActions } from './world-hud';
import { Countdown, formatLeft, pinStyle, useTimeLeft } from './world-anchors';
import { Sheet } from './sheet';

/** A pin's details with the §4 votes: "Still …" extends it, two "Fixed" (or the author, or facility) close it. */
export function PinCard({ pin, building, profile, world, act, onClose }: {
  pin: Pin;
  building: Building;
  profile: Profile;
  world?: WorldState;
  act: WorldActions['act'];
  onClose(): void;
}) {
  const [error, setError] = useState<string>();
  const left = useTimeLeft(pin.expiresAt);
  const space = building.spaces.find(s => s.id === pin.spaceId);
  const floor = building.floors.find(f => f.id === pin.floorId);
  const element = building.vertical_connectors.find(c => c.id === pin.elementId)?.name ?? (pin.elementId && pin.elementId !== pin.spaceId ? pin.elementId : undefined);
  const author = world?.players.find(p => p.id === pin.authorId);
  const reports = 1 + pin.votes.filter(v => v.vote === 'still' && v.playerId !== pin.authorId).length;
  const fixed = pin.votes.filter(v => v.vote === 'fixed').length;
  const mine = pin.votes.find(v => v.playerId === profile.id)?.vote;
  const canResolve = pin.authorId === profile.id || profile.role === 'facility';
  const alert = pinStyle(pin) === 'alert';
  const still = pin.kind === 'blocked' ? 'Still blocked' : pin.kind === 'broken' ? 'Still broken' : 'Still there';

  const run = async (action: Parameters<WorldActions['act']>[0]) => {
    const result = await act(action);
    if (result.ok) onClose(); else setError(result.error);
  };

  return (
    <Sheet title={pin.title} onClose={onClose}>
      <section>
        <div className={`preview-card preview-card--${pinStyle(pin)}`}>
          <Countdown pin={pin} size={32} />
          <span>
            <strong>{element ? `${element} · ` : ''}{space?.name}{floor ? ` · ${floor.name}` : ''}</strong>
            <small>
              {pin.status === 'unconfirmed' ? 'Unconfirmed, waiting for a second report' : `${reports} ${reports === 1 ? 'report' : 'reports'}`}
              {fixed ? ` · ${fixed} said fixed` : ''} · {formatLeft(left)} left
            </small>
            <small>{author ? `By ${author.name}${author.id === profile.id ? ' (you)' : ''}` : 'Anonymous'}{alert && pin.elementId ? ' · routes avoid it' : ''}</small>
            {pin.detail && <small>{pin.detail}</small>}
          </span>
        </div>
        {error && <p className="sheet-error">{error}</p>}
        <div className="sheet-actions">
          <button type="button" className="button" aria-pressed={mine === 'still'} onClick={() => void run({ type: 'pin.vote', pinId: pin.id, playerId: profile.id, vote: 'still' })}>{still}</button>
          <button type="button" className="button button--primary" aria-pressed={mine === 'fixed'} onClick={() => void run({ type: 'pin.vote', pinId: pin.id, playerId: profile.id, vote: 'fixed' })}>{alert ? 'Fixed' : 'Gone'}</button>
        </div>
        {canResolve && <div className="sheet-actions"><button type="button" className="button button--danger" onClick={() => void run({ type: 'pin.resolve', pinId: pin.id, playerId: profile.id })}>Remove pin</button></div>}
      </section>
    </Sheet>
  );
}
