'use client';

import type { Building } from '@/lib/buildings/types';
import type { SceneDirective } from '@/lib/chat/contract';
import { saveProfile, type Profile } from '@/lib/world/profile';
import type { Pin, WorldState } from '@/lib/world/types';
import type { WorldActions } from './world-hud';

/**
 * One chip above the input when my room or my current route touches a reported problem (docs/MULTIPLAYER.md §4.2):
 * "Office lift still broken? [Still broken] [Fixed]". Asked once per pin, never for my own reports.
 */
export function PasserBy({ world, profile, building, routes, act }: {
  world?: WorldState;
  profile: Profile;
  building: Building;
  routes: SceneDirective['routes'];
  act: WorldActions['act'];
}) {
  const pin = world && passerByPin(world, profile, building, routes);
  if (!pin) return null;
  const done = () => saveProfile({ ...profile, asked: [...profile.asked.slice(-200), pin.id] });
  const vote = (choice: 'still' | 'fixed') => { done(); void act({ type: 'pin.vote', pinId: pin.id, playerId: profile.id, vote: choice }); };
  const state = pin.kind === 'blocked' ? 'blocked' : 'broken';
  return (
    <div className="passer-by" role="group" aria-label="Is this still a problem?">
      <span><i>!</i>{pin.title.replace(/\s+(out of order|blocked|broken)\b.*$/i, '')} still {state}?</span>
      <button type="button" onClick={() => vote('still')}>Still {state}</button>
      <button type="button" onClick={() => vote('fixed')}>Fixed</button>
      <button type="button" className="passer-by-close" onClick={done} aria-label="Don't ask">✕</button>
    </div>
  );
}

function passerByPin(world: WorldState, profile: Profile, building: Building, routes: SceneDirective['routes']): Pin | undefined {
  const here = new Set<string>(routes?.flatMap(r => r.spacePath ?? []) ?? []);
  const room = profile.rooms[building.building.id];
  if (room) here.add(room);
  if (!here.size) return undefined;
  return world.pins.find(pin => {
    if ((pin.kind !== 'blocked' && pin.kind !== 'broken') || pin.authorId === profile.id || profile.asked.includes(pin.id)) return false;
    if (pin.votes.some(v => v.playerId === profile.id)) return false;
    // A stair or lift counts at any of its stops.
    const places = building.vertical_connectors.find(c => c.id === pin.elementId)?.space_ids ?? [pin.spaceId];
    return places.some(id => here.has(id));
  });
}
