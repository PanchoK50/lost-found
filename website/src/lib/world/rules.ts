import type { Building } from '@/lib/buildings/types';
import { representativePoint } from '@/lib/buildings/graph';
import { CLOSING_KINDS, detectCategory, modeFor, PIN_TTL, type MultiplayerMode } from './mode';
import type { Audience, Pin, PinKind, Ping, PingKind, Player, Presence, Role, Skill, WorldAction, WorldState } from './types';

/**
 * The truth rules of docs/MULTIPLAYER.md §4, as pure functions: no I/O, so any store (memory, Redis)
 * can run them inside `apply` and `get`, and expiry needs no cron job.
 */

export interface StoredWorld {
  buildingId: string;
  detected: MultiplayerMode;
  override?: MultiplayerMode;
  version: number;
  players: Player[];
  presence: Presence[];
  /** Live pins only: resolved and expired pins are dropped. */
  pins: Pin[];
  pings: Ping[];
  skills: Skill[];
  /** When each player created pins, for the rate limit. */
  created: { playerId: string; at: number }[];
}

/** A rejected action; the API answers 400 with its message. */
export class WorldError extends Error {}

const MINUTE = 60_000;
const RATE_WINDOW = 10 * MINUTE, RATE_MAX = 5;
const CONFIRM_WINDOW = 30 * MINUTE;
const MAX_PRESENCE = 30 * 24 * 60 * MINUTE;
const ROLES: Role[] = ['member', 'facility', 'first_aider', 'visitor', 'exhibitor'];
const PIN_KINDS: PinKind[] = ['blocked', 'broken', 'item', 'event', 'info', 'meet'];
const PING_KINDS: PingKind[] = ['come_to_me', 'meet_halfway', 'pick_up', 'help', 'ask_crowd'];

export function createWorld(building: Building): StoredWorld {
  return { buildingId: building.building.id, detected: modeFor[detectCategory(building)], version: 1, players: [], presence: [], pins: [], pings: [], skills: [], created: [] };
}

export const modeOf = (world: StoredWorld) => world.override ?? world.detected;

/** Drop everything that has run out. Returns true if anything visible changed. */
export function prune(world: StoredWorld, now: number): boolean {
  const before = world.pins.length + world.presence.length + world.pings.length;
  world.pins = world.pins.filter(p => p.expiresAt > now);
  world.presence = world.presence.filter(p => p.until > now);
  world.pings = world.pings.filter(p => p.expiresAt > now);
  world.created = world.created.filter(c => now - c.at < RATE_WINDOW);
  const changed = world.pins.length + world.presence.length + world.pings.length !== before;
  if (changed) world.version++;
  return changed;
}

/** Validate an action and apply it to a copy of the world. Throws WorldError if it isn't allowed. */
export function applyAction(current: StoredWorld, action: WorldAction, building: Building, now: number): StoredWorld {
  const world: StoredWorld = structuredClone(current);
  prune(world, now);
  const v = new Validator(building, world);
  switch (action.type) {
    case 'player.upsert': {
      const p = action.player;
      const name = v.text(p?.name, 'name', 40);
      const player: Player = {
        id: v.id(p.id, 'player id'),
        name,
        role: v.oneOf(p.role, ROLES, 'role'),
        groups: v.list(p.groups, 'groups', 10, 32).map(g => g.toLowerCase().replace(/\s+/g, '-')),
        initials: initialsOf(name),
      };
      world.players = [...world.players.filter(x => x.id !== player.id), player];
      break;
    }
    case 'presence.set': {
      const p = action.presence;
      const player = v.player(p?.playerId);
      const space = v.space(p.spaceId);
      const presence: Presence = {
        playerId: player.id,
        spaceId: space.id,
        floorId: space.floor_id,
        precision: v.oneOf(p.precision, ['room', 'floor', 'building'] as const, 'precision'),
        audience: v.audience(p.audience),
        until: Math.min(v.time(p.until, 'until'), now + MAX_PRESENCE),
        updatedAt: now,
      };
      if (presence.until <= now) throw new WorldError('That presence has already ended.');
      world.presence = [...world.presence.filter(x => x.playerId !== player.id), presence];
      break;
    }
    case 'presence.clear':
      world.presence = world.presence.filter(x => x.playerId !== action.playerId);
      break;
    case 'pin.create': {
      const p = action.pin;
      const kind = v.oneOf(p?.kind, PIN_KINDS, 'pin kind');
      const space = v.space(p.spaceId);
      const author = p.authorId === undefined ? undefined : v.player(p.authorId);
      const authorKey = author?.id ?? 'anonymous';
      if (world.created.filter(c => c.playerId === authorKey).length >= RATE_MAX) throw new WorldError('That is a lot of reports. Please wait a few minutes.');
      const elementId = p.elementId === undefined ? undefined : v.element(p.elementId);
      const key = elementId ?? space.id;
      // Somebody else already reported the same thing: count it as a confirmation, not a second pin.
      const twin = world.pins.find(x => x.kind === kind && (x.elementId ?? x.spaceId) === key);
      if (twin) {
        if (!author || twin.authorId === author.id) throw new WorldError('This is already reported.');
        vote(world, twin, author, 'still', now);
        break;
      }
      const ttl = PIN_TTL[kind];
      const pin: Pin = {
        id: crypto.randomUUID(),
        kind,
        spaceId: space.id,
        floorId: space.floor_id,
        position: v.point(p.position) ?? representativePoint(space.polygon),
        title: v.text(p.title, 'title', 80),
        detail: p.detail === undefined ? undefined : v.text(p.detail, 'detail', 500),
        photo: p.photo === undefined ? undefined : v.photo(p.photo),
        elementId,
        assetId: p.assetId === undefined ? undefined : v.asset(p.assetId),
        authorId: author?.id,
        audience: v.audience(p.audience),
        createdAt: now,
        // Events end when their author says; everything else lives for its kind's default.
        expiresAt: kind === 'event' && typeof p.expiresAt === 'number' ? Math.min(Math.max(p.expiresAt, now + MINUTE), now + PIN_TTL.info) : now + ttl,
        votes: [],
        // Team: known people, so a report counts at once. Public: wait for a second report (§4.4).
        status: modeOf(world) === 'public' ? 'unconfirmed' : 'active',
      };
      world.pins.push(pin);
      world.created.push({ playerId: authorKey, at: now });
      break;
    }
    case 'pin.vote': {
      const pin = v.pin(action.pinId);
      vote(world, pin, v.player(action.playerId), v.oneOf(action.vote, ['still', 'fixed'] as const, 'vote'), now);
      break;
    }
    case 'pin.resolve': {
      const pin = v.pin(action.pinId);
      const player = v.player(action.playerId);
      if (pin.authorId !== player.id && player.role !== 'facility') throw new WorldError('Only the author or facility can close this pin.');
      world.pins = world.pins.filter(x => x.id !== pin.id);
      break;
    }
    case 'ping.send': {
      const p = action.ping;
      const space = v.space(p?.spaceId);
      world.pings.push({
        id: crypto.randomUUID(),
        kind: v.oneOf(p.kind, PING_KINDS, 'ping kind'),
        fromId: v.player(p.fromId).id,
        to: p.to === 'nearby' ? 'nearby' : v.audience(p.to),
        spaceId: space.id,
        floorId: space.floor_id,
        message: p.message === undefined ? undefined : v.text(p.message, 'message', 300),
        pinId: p.pinId === undefined ? undefined : v.pin(p.pinId).id,
        createdAt: now,
        expiresAt: Math.min(v.time(p.expiresAt ?? now + 30 * MINUTE, 'expiresAt'), now + 60 * MINUTE),
        status: 'sent',
      });
      break;
    }
    case 'ping.update': {
      const ping = world.pings.find(x => x.id === action.pingId);
      if (!ping) throw new WorldError('That ping is gone.');
      const player = v.player(action.playerId);
      if (!reaches(world, ping.to, player) && ping.fromId !== player.id) throw new WorldError('That ping is not for you.');
      if (action.status) ping.status = v.oneOf(action.status, ['sent', 'accepted', 'declined', 'done'] as const, 'status');
      if (action.answer !== undefined) ping.answers = [...(ping.answers ?? []), { playerId: player.id, text: v.text(action.answer, 'answer', 300), at: now }];
      break;
    }
    case 'skill.create': {
      const s = action.skill;
      world.skills.push({
        id: crypto.randomUUID(),
        name: v.text(s?.name, 'name', 40),
        phrases: v.list(s.phrases, 'phrases', 10, 40).map(x => x.toLowerCase()),
        kind: v.oneOf(s.kind, ['nearest', 'place', 'answer'] as const, 'skill kind'),
        target: {
          assetType: s.target?.assetType === undefined ? undefined : v.text(s.target.assetType, 'asset type', 40),
          roomType: s.target?.roomType === undefined ? undefined : v.text(s.target.roomType, 'room type', 40),
          spaceId: s.target?.spaceId === undefined ? undefined : v.space(s.target.spaceId).id,
        },
        answer: s.answer === undefined ? undefined : v.text(s.answer, 'answer', 300),
        skipBroken: !!s.skipBroken,
        authorId: s.authorId === undefined ? undefined : v.player(s.authorId).id,
        audience: v.audience(s.audience),
        votes: 0,
        uses: 0,
        createdAt: now,
      });
      break;
    }
    case 'skill.vote': {
      const skill = world.skills.find(x => x.id === action.skillId);
      if (!skill) throw new WorldError('Unknown skill.');
      v.player(action.playerId);
      skill.votes++;
      break;
    }
    case 'mode.set': {
      v.player(action.playerId);
      const mode = v.oneOf(action.mode, ['auto', 'team', 'public', 'home'] as const, 'mode');
      world.override = mode === 'auto' ? undefined : mode;
      break;
    }
    default:
      throw new WorldError('Unknown action.');
  }
  world.version++;
  return world;
}

/** One vote per player; the latest counts (§4.2, §4.3). */
function vote(world: StoredWorld, pin: Pin, player: Player, choice: 'still' | 'fixed', now: number) {
  pin.votes = [...pin.votes.filter(x => x.playerId !== player.id), { playerId: player.id, vote: choice, at: now }];
  if (choice === 'fixed') {
    const fixed = pin.votes.filter(x => x.vote === 'fixed').length;
    if (fixed >= 2 || pin.authorId === player.id || player.role === 'facility') world.pins = world.pins.filter(x => x.id !== pin.id);
    return;
  }
  const ttl = PIN_TTL[pin.kind];
  pin.expiresAt = Math.min(Math.max(pin.expiresAt, now) + ttl, pin.createdAt + 3 * ttl);
  if (pin.status === 'unconfirmed' && confirmed(pin)) pin.status = 'active';
}

/** Two independent reports (the original plus "still" votes from other people) within 30 minutes. */
function confirmed(pin: Pin) {
  const reports = [...(pin.authorId ? [{ playerId: pin.authorId, at: pin.createdAt }] : []), ...pin.votes.filter(x => x.vote === 'still' && x.playerId !== pin.authorId)];
  return reports.some((a, i) => reports.slice(i + 1).some(b => a.playerId !== b.playerId && Math.abs(a.at - b.at) <= CONFIRM_WINDOW));
}

/** Who an audience reaches. 'team' means everyone in team and home mode, nobody else in public mode. */
function reaches(world: StoredWorld, audience: Audience | 'nearby', player: Player | undefined) {
  if (audience === 'everyone') return true;
  if (audience === 'team') return modeOf(world) !== 'public';
  if (!player) return false;
  if (audience.startsWith('group:')) return player.groups.includes(audience.slice(6));
  if (audience.startsWith('player:')) return audience.slice(7) === player.id;
  if (audience.startsWith('role:')) return audience.slice(5) === player.role;
  return false;
}

/** Element ids closed for this player's routes (§8): active pins, plus their own unconfirmed ones. */
export function activeClosures(world: StoredWorld, playerId?: string): string[] {
  return [...new Set(world.pins
    .filter(p => p.elementId && CLOSING_KINDS.has(p.kind) && (p.status === 'active' || (playerId && p.authorId === playerId)))
    .map(p => p.elementId!))];
}

/** What one player may see. */
export function viewFor(world: StoredWorld, playerId?: string): WorldState {
  const me = world.players.find(p => p.id === playerId);
  const presence = world.presence.filter(p => p.playerId === playerId || reaches(world, p.audience, me));
  const pins = world.pins.filter(p => p.authorId === playerId || reaches(world, p.audience, me));
  const pings = world.pings.filter(p => p.fromId === playerId || (p.to !== 'nearby' && reaches(world, p.to, me)));
  const skills = world.skills.filter(s => s.authorId === playerId || reaches(world, s.audience, me));
  // Only name the people this player can already see something of.
  const named = new Set([playerId, ...presence.map(p => p.playerId), ...pins.map(p => p.authorId), ...pings.map(p => p.fromId)]);
  return {
    buildingId: world.buildingId,
    mode: modeOf(world),
    modeOverride: world.override !== undefined,
    version: world.version,
    players: world.players.filter(p => named.has(p.id)),
    presence,
    pins,
    pings,
    skills,
  };
}

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts.at(-1)![0] : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** Checks untrusted input against the building and the world. */
class Validator {
  private readonly spaces: Map<string, Building['spaces'][number]>;
  private readonly elements: Set<string>;
  private readonly assets: Set<string>;
  constructor(building: Building, private readonly world: StoredWorld) {
    this.spaces = new Map(building.spaces.map(s => [s.id, s]));
    this.elements = new Set([...building.openings.map(o => o.id), ...building.vertical_connectors.map(c => c.id), ...building.spaces.map(s => s.id)]);
    this.assets = new Set(building.assets.map(a => a.id));
  }
  text(value: unknown, field: string, max: number) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > max) throw new WorldError(`The ${field} must be 1 to ${max} characters.`);
    return text;
  }
  id(value: unknown, field: string) {
    if (typeof value !== 'string' || !/^[\w-]{1,64}$/.test(value)) throw new WorldError(`Invalid ${field}.`);
    return value;
  }
  oneOf<T extends string>(value: unknown, options: readonly T[], field: string): T {
    if (!options.includes(value as T)) throw new WorldError(`Invalid ${field}.`);
    return value as T;
  }
  list(value: unknown, field: string, maxItems: number, maxLength: number) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maxItems) throw new WorldError(`Invalid ${field}.`);
    return value.map(x => this.text(x, field, maxLength));
  }
  time(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new WorldError(`Invalid ${field}.`);
    return value;
  }
  point(value: unknown): [number, number] | undefined {
    return Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n)) ? [value[0], value[1]] : undefined;
  }
  photo(value: unknown) {
    if (typeof value !== 'string' || !value.startsWith('data:image/') || value.length > 1_500_000) throw new WorldError('The photo must be an image under about 1 MB.');
    return value;
  }
  audience(value: unknown): Audience {
    if (value === 'everyone' || value === 'team') return value;
    if (typeof value === 'string' && /^(group|player|role):[\w-]{1,64}$/.test(value)) return value as Audience;
    throw new WorldError('Invalid audience.');
  }
  player(value: unknown) {
    const player = this.world.players.find(p => p.id === value);
    if (!player) throw new WorldError('Unknown player. Reload the page.');
    return player;
  }
  space(value: unknown) {
    const space = typeof value === 'string' ? this.spaces.get(value) : undefined;
    if (!space) throw new WorldError('Unknown space.');
    return space;
  }
  element(value: unknown) {
    if (typeof value !== 'string' || !this.elements.has(value)) throw new WorldError('Unknown door, stair, lift or space.');
    return value;
  }
  asset(value: unknown) {
    if (typeof value !== 'string' || !this.assets.has(value)) throw new WorldError('Unknown asset.');
    return value;
  }
  pin(value: unknown) {
    const pin = this.world.pins.find(p => p.id === value);
    if (!pin) throw new WorldError('That pin is gone.');
    return pin;
  }
}
