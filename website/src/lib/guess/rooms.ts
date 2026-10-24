import type { Building, Space } from '@/lib/buildings/types';
import { polygonArea } from '@/lib/buildings/geometry';
import { shuffle, type Rng } from './random';

export type Difficulty = 'easy' | 'hard';

export const ROUNDS = 5;
const MIN_AREA_M2 = 6;

/** Area tiers grow by about 1.6× each, so "small office" and "big office" differ but 14 vs 15 m² don't. */
function areaTier(area: number) {
  return Math.max(0, Math.floor(Math.log(area / MIN_AREA_M2) / Math.log(1.6)));
}

export interface RoomFacts {
  space: Space;
  area: number;
  doors: number;
  assets: number;
  /** Area tier, door count and the set of asset types: rooms with the same fingerprint look alike. */
  fingerprint: string;
}

/** Rooms worth guessing: real rooms or halls, not tiny, with something to recognise them by (§3). */
export function eligibleRooms(building: Building): RoomFacts[] {
  const doors = new Map<string, number>();
  for (const o of building.openings) for (const id of o.space_ids) doors.set(id, (doors.get(id) ?? 0) + 1);
  const assetTypes = new Map<string, string[]>();
  for (const a of building.assets) assetTypes.set(a.space_id, [...(assetTypes.get(a.space_id) ?? []), a.type]);
  return building.spaces
    .filter(s => s.type === 'room' || s.type === 'hall')
    .map(space => {
      const area = polygonArea(space.polygon);
      const types = assetTypes.get(space.id) ?? [];
      const n = doors.get(space.id) ?? 0;
      return { space, area, doors: n, assets: types.length, fingerprint: `${areaTier(area)}|${n}|${[...new Set(types)].sort().join(',')}` };
    })
    .filter(r => r.area >= MIN_AREA_M2 && (r.assets >= 2 || r.doors >= 2));
}

/**
 * The rooms of one game. Easy draws rooms with a unique fingerprint, hard draws rooms with look-alikes.
 * Rounds are spread over as many floors as possible. Falls back to any eligible (then any) room so
 * every building in the dataset format yields a game.
 */
export function pickRounds(building: Building, rng: Rng, difficulty: Difficulty, count = ROUNDS): Space[] {
  const rooms = eligibleRooms(building);
  const twins = new Map<string, number>();
  for (const r of rooms) twins.set(r.fingerprint, (twins.get(r.fingerprint) ?? 0) + 1);
  const fits = (r: RoomFacts) => difficulty === 'easy' ? twins.get(r.fingerprint) === 1 : twins.get(r.fingerprint)! >= 3;
  const preferred = rooms.filter(fits).map(r => r.space);
  const rest = rooms.filter(r => !fits(r)).map(r => r.space);
  const anyRoom = building.spaces.filter(s => (s.type === 'room' || s.type === 'hall') && !rooms.some(r => r.space.id === s.id));

  const picked: Space[] = [];
  for (const pool of [preferred, rest, anyRoom]) {
    if (picked.length >= count) break;
    picked.push(...spreadOverFloors(pool, rng, building).slice(0, count - picked.length));
  }
  return picked;
}

/** One room per floor in turn (floors in random order), so five rounds rarely share a floor. */
function spreadOverFloors(pool: Space[], rng: Rng, building: Building): Space[] {
  const byFloor = new Map<string, Space[]>();
  for (const f of shuffle(building.floors, rng)) byFloor.set(f.id, []);
  for (const s of shuffle(pool, rng)) byFloor.get(s.floor_id)?.push(s);
  const queues = [...byFloor.values()].filter(q => q.length);
  const out: Space[] = [];
  while (queues.some(q => q.length)) for (const q of queues) { const s = q.shift(); if (s) out.push(s); }
  return out;
}

/** What to call the room once it's revealed. */
export function roomName(space: Space): string {
  return space.name || space.ref || space.room_type.replaceAll('_', ' ') || 'Unnamed room';
}
