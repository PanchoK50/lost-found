'use client';

import { modeLabel } from '@/lib/world/mode';
import type { useWorld } from '@/lib/world/use-world';
import type { WorldState } from '@/lib/world/types';

export type WorldActions = ReturnType<typeof useWorld>;

/** Avatars shown before "+n": teams are small, so show who is online. */
const MAX_AVATARS = 6;

/** Mode badge and the people sharing their location, at the right of the HUD bar. Both open settings. */
export function WorldHud({ world, playerId, unread, onOpen, onMessages, location, onLocation }: {
  world?: WorldState; playerId?: string; unread: number; onOpen(): void; onMessages(): void;
  /** The player's room name, null when not set, undefined when signed out (no chip). */
  location?: string | null; onLocation?(): void;
}) {
  // Everyone online, plus people sharing a location (a shared location can outlive the open app).
  const ids = [...new Set([...(world?.online ?? []), ...(world?.presence ?? []).map(p => p.playerId)])];
  const sharing = ids.map(id => world!.players.find(x => x.id === id)).filter(p => p !== undefined);
  // Others first: the stack is about who else is here.
  sharing.sort((a, b) => Number(a.id === playerId) - Number(b.id === playerId));
  return (
    <div className="world-hud">
      {location !== undefined && onLocation && (
        <button type="button" className={`location-chip${location ? '' : ' location-chip--unset'}`} onClick={onLocation} aria-label={location ? `You are in ${location}. Change` : 'Set your location'}>
          📍 <span>{location ?? 'Set your location'}</span>
        </button>
      )}
      {sharing.length > 0 && (
        <button type="button" className="avatar-stack" onClick={onOpen} aria-label={`${sharing.length} online`}>
          {sharing.slice(0, MAX_AVATARS).map(p => <span key={p.id} className={`person-dot${p.demo ? ' person-dot--demo' : ''}${p.id === playerId ? ' person-dot--me' : ''}`} title={p.name}>{p.initials}</span>)}
          {sharing.length > MAX_AVATARS && <span className="more">+{sharing.length - MAX_AVATARS}</span>}
        </button>
      )}
      <button type="button" className="messages-button" onClick={onMessages} aria-label={`Messages${unread ? `, ${unread} new` : ''}`}>✉{unread > 0 && <b>{unread}</b>}</button>
      <button type="button" className="mode-badge" onClick={onOpen} aria-label={`Mode: ${world ? modeLabel[world.mode] : 'loading'}. Open settings`}>
        {world ? modeLabel[world.mode] : '…'}
      </button>
    </div>
  );
}
