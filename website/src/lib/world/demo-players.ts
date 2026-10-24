// Server-side: scripted demo players, so one person alone still sees the building react (docs/MULTIPLAYER.md §9).
import type { Building, Space } from '@/lib/buildings/types';
import { mentionsIn } from '@/lib/chat/demo-resolver';
import { walkGraph } from './chat';
import { activeClosures, applyAction, WorldError, type StoredWorld } from './rules';
import type { Role, WorldAction } from './types';

export type DemoTimer =
  | { at: number; type: 'accept'; pingId: string; playerId: string }
  | { at: number; type: 'step'; pingId: string; playerId: string; path: string[]; index: number }
  | { at: number; type: 'answer'; pingId: string; playerId: string }
  | { at: number; type: 'vote'; pinId: string; playerId: string }
  | { at: number; type: 'event' };

const SECOND = 1000, MINUTE = 60 * SECOND;
const STEP_MS = 2 * SECOND;
const DAYS_30 = 30 * 24 * 60 * MINUTE;

/** The cast. Rooms are picked by room type in whatever building is loaded, never by id. */
const cast: { id: string; name: string; role: Role; groups: string[]; rooms: string[] }[] = [
  { id: 'demo-mia', name: 'Mia', role: 'member', groups: ['lunch-crew'], rooms: ['kitchen', 'canteen', 'living_room', 'lobby', 'office', 'generic_room'] },
  { id: 'demo-tom', name: 'Tom', role: 'member', groups: [], rooms: ['office', 'lab', 'seminar_room', 'bedroom', 'meeting_room', 'generic_room'] },
  { id: 'demo-jonas', name: 'Jonas', role: 'facility', groups: [], rooms: ['technical_room', 'server_room', 'warehouse_zone', 'logistics_zone', 'storage', 'corridor', 'generic_room'] },
  { id: 'demo-lea', name: 'Lea', role: 'first_aider', groups: ['lunch-crew'], rooms: ['lobby', 'meeting_room', 'library', 'bathroom', 'generic_room', 'corridor'] },
];

export const isDemo = (playerId: string | undefined) => !!playerId?.startsWith('demo-');

/** Put the demo players into rooms of this building and plan their first cake. */
export function seedDemo(world: StoredWorld, building: Building, now: number): StoredWorld {
  let w: StoredWorld = { ...world, demo: { timers: [{ at: now + 45 * SECOND, type: 'event' }] } };
  const taken = new Set<string>();
  for (const member of cast) {
    const space = pickRoom(building, member.rooms, taken, member.id);
    if (!space) continue;
    taken.add(space.id);
    w = tryApply(w, building, now, { type: 'player.upsert', buildingId: w.buildingId, player: { id: member.id, name: member.name, role: member.role, groups: member.groups, initials: '' } });
    w = tryApply(w, building, now, { type: 'presence.set', buildingId: w.buildingId, presence: { playerId: member.id, spaceId: space.id, floorId: space.floor_id, precision: 'room', audience: 'everyone', until: now + DAYS_30 } });
  }
  w.players = w.players.map(p => isDemo(p.id) ? { ...p, demo: true } : p);
  return w;
}

/** React to what a real player just did: answer pings to demo players, confirm broken reports. */
export function scheduleDemo(world: StoredWorld, action: WorldAction, now: number): StoredWorld {
  if (!world.demo) return world;
  const timers: DemoTimer[] = [];
  const demos = world.players.filter(p => p.demo);
  if (action.type === 'ping.send' && !isDemo(action.ping?.fromId)) {
    const ping = world.pings.at(-1);
    if (ping && ping.fromId === action.ping.fromId && ping.createdAt === now) {
      if (ping.kind === 'ask_crowd') {
        const helper = demos.find(p => p.role === 'facility') ?? demos[0];
        if (helper) timers.push({ at: now + 5 * SECOND, type: 'answer', pingId: ping.id, playerId: helper.id });
      } else {
        const to = ping.to;
        const who = demos.find(p => to === `player:${p.id}` || (to.startsWith('group:') && p.groups.includes(to.slice(6))) || to === `role:${p.role}`);
        if (who) timers.push({ at: now + 3 * SECOND, type: 'accept', pingId: ping.id, playerId: who.id });
      }
    }
  }
  if (action.type === 'pin.create' && !isDemo(action.pin?.authorId) && (action.pin?.kind === 'broken' || action.pin?.kind === 'blocked')) {
    const pin = world.pins.find(p => p.createdAt === now && p.authorId === action.pin.authorId);
    const facility = demos.find(p => p.role === 'facility');
    if (pin && facility) timers.push({ at: now + 10 * SECOND, type: 'vote', pinId: pin.id, playerId: facility.id });
  }
  return timers.length ? { ...world, demo: { timers: [...world.demo.timers, ...timers] } } : world;
}

/** Run every reaction that is due. Called on each read, so no cron job is needed. */
export function runDemo(world: StoredWorld, building: Building, now: number): StoredWorld {
  let w = world.demo ? world : seedDemo(world, building, now);
  for (let guard = 0; guard < 200; guard++) {
    const due = [...w.demo!.timers].filter(t => t.at <= now).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    w = { ...w, demo: { timers: w.demo!.timers.filter(t => t !== due) } };
    w = fire(w, building, due, now);
  }
  return w;
}

function fire(w: StoredWorld, building: Building, t: DemoTimer, now: number): StoredWorld {
  const id = w.buildingId;
  const spaces = new Map(building.spaces.map(s => [s.id, s]));
  const later = (timer: DemoTimer) => ({ ...w, demo: { timers: [...w.demo!.timers, timer] } });
  switch (t.type) {
    case 'accept': {
      const ping = w.pings.find(p => p.id === t.pingId);
      if (!ping || ping.status !== 'sent') return w;
      w = tryApply(w, building, now, { type: 'ping.update', buildingId: id, pingId: ping.id, playerId: t.playerId, status: 'accepted' });
      // Walk there space by space, avoiding what is closed.
      const from = w.presence.find(p => p.playerId === t.playerId)?.spaceId;
      const leg = from ? walkGraph(building, activeClosures(w, t.playerId)).route(from, ping.spaceId) : undefined;
      const path = leg?.spacePath.filter(s => spaces.has(s)) ?? [ping.spaceId];
      return later({ at: t.at + STEP_MS, type: 'step', pingId: ping.id, playerId: t.playerId, path, index: Math.min(1, path.length - 1) });
    }
    case 'step': {
      const space = spaces.get(t.path[t.index]);
      if (!space) return w;
      const arrived = t.index >= t.path.length - 1;
      w = tryApply(w, building, now, { type: 'presence.set', buildingId: id, presence: { playerId: t.playerId, spaceId: space.id, floorId: space.floor_id, precision: 'room', audience: 'everyone', until: now + DAYS_30 } });
      w.presence = w.presence.map(p => p.playerId === t.playerId ? { ...p, moving: !arrived } : p);
      if (!arrived) return later({ ...t, at: t.at + STEP_MS, index: t.index + 1 });
      const ping = w.pings.find(p => p.id === t.pingId);
      if (!ping) return w;
      w = tryApply(w, building, now, { type: 'ping.update', buildingId: id, pingId: ping.id, playerId: t.playerId, status: 'done' });
      // Picking something up clears the item pin there.
      if (ping.kind === 'pick_up') { w.pins = w.pins.filter(p => !(p.kind === 'item' && p.spaceId === space.id)); w.version++; }
      return w;
    }
    case 'answer': {
      const ping = w.pings.find(p => p.id === t.pingId);
      if (!ping) return w;
      const { text, space, title } = plausibleAnswer(w, building, ping.message ?? '', t.playerId);
      w = tryApply(w, building, now, { type: 'ping.update', buildingId: id, pingId: ping.id, playerId: t.playerId, answer: text });
      // What people tell each other becomes knowledge on the map.
      if (space) w = tryApply(w, building, now, { type: 'pin.create', buildingId: id, pin: { kind: 'info', spaceId: space.id, title, detail: `Q: ${ping.message ?? ''} · A: ${text}`.slice(0, 500), authorId: t.playerId, audience: 'everyone' } });
      return w;
    }
    case 'vote':
      return w.pins.some(p => p.id === t.pinId) ? tryApply(w, building, now, { type: 'pin.vote', buildingId: id, pinId: t.pinId, playerId: t.playerId, vote: 'still' }) : w;
    case 'event': {
      const author = w.players.find(p => p.id === 'demo-mia') ?? w.players.find(p => p.demo);
      const space = pickRoom(building, ['canteen', 'kitchen', 'lobby', 'living_room', 'meeting_room'], new Set(), 'event');
      if (author && space && !w.pins.some(p => p.kind === 'event' && p.authorId === author.id)) {
        w = tryApply(w, building, now, { type: 'pin.create', buildingId: id, pin: { kind: 'event', spaceId: space.id, title: `Cake in ${space.name}`, detail: 'Help yourselves!', authorId: author.id, audience: 'everyone', expiresAt: now + 2 * 60 * MINUTE } });
      }
      return later({ at: now + 20 * MINUTE, type: 'event' });
    }
  }
}

/** A short, honest-sounding answer from what the building knows. */
function plausibleAnswer(w: StoredWorld, building: Building, question: string, playerId: string): { text: string; space?: Space; title: string } {
  const m = mentionsIn(building, question);
  const from = w.presence.find(p => p.playerId === playerId)?.spaceId;
  if (m.assetType) {
    const label = m.assetType.replaceAll('_', ' ');
    const holders = [...new Set(building.assets.filter(a => a.type === m.assetType).map(a => a.space_id))];
    const dist = from ? walkGraph(building, []).distancesFrom(from) : new Map<string, number>();
    holders.sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity));
    const space = building.spaces.find(s => s.id === holders[0]);
    if (space) return { text: `There's a ${label} in ${space.name}.`, space, title: `${label[0].toUpperCase()}${label.slice(1)} in ${space.name}` };
  }
  if (m.spaces.length) {
    const space = m.spaces[0];
    const floor = building.floors.find(f => f.id === space.floor_id);
    return { text: `${space.name} is on ${floor?.name ?? 'another floor'}.`, space, title: `${space.name}: ${floor?.name ?? ''}` };
  }
  const desk = pickRoom(building, ['lobby', 'canteen', 'office', 'living_room'], new Set(), 'desk');
  return desk
    ? { text: `Not sure, but they usually know at ${desk.name}.`, space: desk, title: `Ask at ${desk.name}` }
    : { text: 'Not sure, sorry.', title: '' };
}

/** A room of the first type that exists, the same one every time for the same seed. */
function pickRoom(building: Building, types: string[], taken: Set<string>, seed: string): Space | undefined {
  const usable = building.spaces.filter(s => s.type !== 'stair' && s.type !== 'lift' && s.type !== 'outdoor' && !taken.has(s.id));
  for (const type of types) {
    const options = usable.filter(s => s.room_type === type);
    if (options.length) return options[hash(seed) % options.length];
  }
  const rooms = usable.filter(s => s.type === 'room');
  return rooms.length ? rooms[hash(seed) % rooms.length] : usable[0];
}

function hash(text: string) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Demo reactions never break the world: a rejected step is skipped. */
function tryApply(w: StoredWorld, building: Building, now: number, action: WorldAction): StoredWorld {
  try { return applyAction(w, action, building, now); } catch (error) { if (error instanceof WorldError) return w; throw error; }
}

