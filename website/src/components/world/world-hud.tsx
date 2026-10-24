'use client';

import { modeLabel } from '@/lib/world/mode';
import type { useWorld } from '@/lib/world/use-world';
import type { WorldState } from '@/lib/world/types';

export type WorldActions = ReturnType<typeof useWorld>;

/** Mode badge and the people sharing their location, at the right of the HUD bar. Both open settings. */
export function WorldHud({ world, playerId, onOpen }: { world?: WorldState; playerId?: string; onOpen(): void }) {
  const sharing = (world?.presence ?? []).map(p => world!.players.find(x => x.id === p.playerId)).filter(p => p !== undefined);
  // Others first: the stack is about who else is here.
  sharing.sort((a, b) => Number(a.id === playerId) - Number(b.id === playerId));
  return (
    <div className="world-hud">
      {sharing.length > 0 && (
        <button type="button" className="avatar-stack" onClick={onOpen} aria-label={`${sharing.length} sharing their location`}>
          {sharing.slice(0, 3).map(p => <span key={p.id} className={`person-dot${p.demo ? ' person-dot--demo' : ''}${p.id === playerId ? ' person-dot--me' : ''}`} title={p.name}>{p.initials}</span>)}
          {sharing.length > 3 && <span className="more">+{sharing.length - 3}</span>}
        </button>
      )}
      <button type="button" className="mode-badge" onClick={onOpen} aria-label={`Mode: ${world ? modeLabel[world.mode] : 'loading'}. Open settings`}>
        {world ? modeLabel[world.mode] : '…'}
      </button>
    </div>
  );
}
