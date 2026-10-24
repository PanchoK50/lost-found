'use client';

import { useMemo, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import { WalkGraph } from '@/lib/buildings/walk';
import type { Profile } from '@/lib/world/profile';
import type { Player, Role, WorldState } from '@/lib/world/types';
import { Sheet } from './sheet';
import type { WorldActions } from './world-hud';

const roleLabel: Record<Role, string> = { member: 'Member', facility: 'Facility', first_aider: 'First aider', visitor: 'Visitor', exhibitor: 'Exhibitor' };

/** Who someone on the map is and where: room, floor, role, groups, how far, and what I can do. */
export function PersonCard({ player, building, profile, world, act, onRoute, onAsk, onClose }: {
  player: Player;
  building: Building;
  profile: Profile;
  world?: WorldState;
  act: WorldActions['act'];
  onRoute(spaceId: string): void;
  /** Start a chat message to them ("@Tom "). */
  onAsk(name: string): void;
  onClose(): void;
}) {
  const [sent, setSent] = useState<string>();
  const presence = world?.presence.find(p => p.playerId === player.id);
  const space = presence && building.spaces.find(s => s.id === presence.spaceId);
  const floor = presence && building.floors.find(f => f.id === presence.floorId);
  const myRoom = building.spaces.find(s => s.id === profile.rooms[building.building.id]);
  const me = player.id === profile.id;
  const walk = useMemo(() => !me && myRoom && space && presence?.precision === 'room' ? walkMinutes(building, myRoom.id, space.id) : undefined, [me, myRoom, space, presence?.precision, building]);
  const reports = world?.pins.filter(p => p.authorId === player.id).length ?? 0;
  const where = !presence ? 'Not sharing a location'
    : presence.precision === 'room' ? `${space?.name ?? '?'} · ${floor?.name ?? ''}`
    : presence.precision === 'floor' ? floor?.name ?? '' : 'Somewhere in the building';
  const first = player.name.split(/\s+/)[0];

  const comeToMe = async () => {
    if (!myRoom) return;
    const result = await act({ type: 'ping.send', ping: { kind: 'come_to_me', fromId: profile.id, to: `player:${player.id}`, spaceId: myRoom.id, floorId: myRoom.floor_id, expiresAt: Date.now() + 30 * 60_000 } });
    setSent(result.ok ? `Asked ${first} to come to ${myRoom.name}` : result.error);
  };

  return (
    <Sheet title={me ? `${player.name} (you)` : player.name} onClose={onClose}>
      <section>
        <div className="person-head">
          <span className={`person-dot${player.demo ? ' person-dot--demo' : ''}${presence?.moving ? ' person-dot--moving' : ''}`}>{player.initials}</span>
          <span>
            <strong>{where}</strong>
            <small>
              {presence?.moving ? 'Walking right now · ' : ''}
              {walk !== undefined ? `about ${walk} min from you · ` : ''}
              {presence ? `sharing until ${until(presence.until)}` : ''}
            </small>
          </span>
        </div>
        <dl className="person-facts">
          <dt>Role</dt><dd>{roleLabel[player.role]}</dd>
          {player.groups.length > 0 && <><dt>Groups</dt><dd>{player.groups.map(g => g.replaceAll('-', ' ')).join(', ')}</dd></>}
          {reports > 0 && <><dt>Reports</dt><dd>{reports} on the map</dd></>}
          {presence && <><dt>Updated</dt><dd>{ago(presence.updatedAt)}</dd></>}
          {player.demo && <><dt>Note</dt><dd>Demo player, scripted so you can try things alone</dd></>}
        </dl>
        {!me && <div className="sheet-actions">
          {space && <button type="button" className="button" onClick={() => { onRoute(space.id); onClose(); }}>Route there</button>}
          <button type="button" className="button button--primary" onClick={() => { onAsk(first); onClose(); }}>Ask @{first}</button>
        </div>}
        {!me && myRoom && <div className="sheet-actions"><button type="button" className="button" disabled={!!sent} onClick={() => void comeToMe()}>Ask {first} to come to {myRoom.name}</button></div>}
        {sent && <p className="hint">{sent}</p>}
      </section>
    </Sheet>
  );
}

const graphs = new Map<string, WalkGraph>();
function walkMinutes(building: Building, from: string, to: string) {
  let graph = graphs.get(building.building.id);
  if (!graph) { graph = new WalkGraph(building); graphs.set(building.building.id, graph); }
  const leg = graph.route(from, to);
  return leg ? Math.max(1, Math.round(leg.length / 1.3 / 60)) : undefined;
}

function until(at: number) {
  const hours = (at - Date.now()) / 3_600_000;
  if (hours > 48) return 'further notice';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ago(at: number) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
