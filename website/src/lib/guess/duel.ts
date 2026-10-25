import type { Point } from '@/lib/buildings/types';
import { hashSeed, mulberry32 } from './random';
import type { PhotoSpot, SpotPick } from './spots';

/**
 * Duels, as in GeoGuessr: everyone sees the same photo; the first guess starts a 15 s countdown for the rest.
 * Each round the best score deals the difference to everyone else's health, times a growing multiplier.
 * Last one standing wins. Pure rules: the server stores the state and calls `advance` on every read and write.
 */

export const START_HP = 6000;
export const GUESS_WINDOW_MS = 15_000;
/** Nobody guessed at all (everyone left): end the round anyway. */
export const ROUND_LIMIT_MS = 3 * 60_000;
/** Splash before each round, and the reveal after it. */
export const INTRO_MS = 3500;
export const REVEAL_MS = 9000;
export const MAX_PLAYERS = 8;

export interface DuelPlayer { id: string; name: string; hp: number; bot?: boolean; joinedAt: number }
export interface DuelGuess extends SpotPick { at: number }
export interface RoundScore { metres: number; walked: boolean; points: number }
export interface DuelRound {
  /** The photo; its place stays on the server until the round is resolved. */
  spot: PhotoSpot;
  startsAt: number;
  firstGuessAt?: number;
  guesses: Record<string, DuelGuess>;
  resolvedAt?: number;
  scores?: Record<string, RoundScore>;
  damage?: Record<string, number>;
  multiplier: number;
}
export interface Duel {
  id: string;
  buildingId: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'over';
  players: DuelPlayer[];
  rounds: DuelRound[];
  /** Photos in play order (cycled if the duel outlasts them). */
  spots: PhotoSpot[];
  winnerId?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export class DuelError extends Error {}

/** GeoGuessr-style damage multiplier: 1× for four rounds, then +0.5 per round. */
export function multiplierFor(round: number) {
  return round <= 4 ? 1 : 1 + (round - 4) * 0.5;
}

export function createDuel(id: string, buildingId: string, host: { id: string; name: string }, now: number): Duel {
  return { id, buildingId, hostId: host.id, status: 'lobby', players: [{ id: host.id, name: host.name, hp: START_HP, joinedAt: now }], rounds: [], spots: [], createdAt: now, updatedAt: now, version: 1 };
}

export type DuelAction =
  | { type: 'join'; player: { id: string; name: string } }
  | { type: 'bot'; playerId: string }
  | { type: 'leave'; playerId: string }
  | { type: 'start'; playerId: string; spots: PhotoSpot[] }
  | { type: 'guess'; playerId: string; pick: SpotPick };

export const BOT_NAMES = ['Robo Rita', 'Bot Bernd', 'Captain Cache', 'Pixel Paula'];

/** Applies a player's action (after `advance`, so timers are current). Throws DuelError when not allowed. */
export function applyDuel(duel: Duel, action: DuelAction, now: number): Duel {
  const next = structuredClone(duel);
  switch (action.type) {
    case 'join': {
      if (next.players.some(p => p.id === action.player.id)) break;
      if (next.status !== 'lobby') throw new DuelError('This duel has already started.');
      if (next.players.length >= MAX_PLAYERS) throw new DuelError('This duel is full.');
      next.players.push({ id: action.player.id, name: action.player.name, hp: START_HP, joinedAt: now });
      break;
    }
    case 'bot': {
      if (action.playerId !== next.hostId) throw new DuelError('Only the host can add a bot.');
      if (next.status !== 'lobby') throw new DuelError('This duel has already started.');
      if (next.players.length >= MAX_PLAYERS) throw new DuelError('This duel is full.');
      const n = next.players.filter(p => p.bot).length;
      next.players.push({ id: `bot-${next.id}-${n}`, name: BOT_NAMES[n % BOT_NAMES.length], hp: START_HP, bot: true, joinedAt: now });
      break;
    }
    case 'leave': {
      if (next.status === 'lobby') {
        next.players = next.players.filter(p => p.id !== action.playerId);
        // The host left: hand the duel to the next human.
        if (action.playerId === next.hostId) next.hostId = next.players.find(p => !p.bot)?.id ?? '';
      } else {
        const p = next.players.find(x => x.id === action.playerId);
        if (p) p.hp = 0;
        finishIfDecided(next, now);
      }
      break;
    }
    case 'start': {
      if (action.playerId !== next.hostId) throw new DuelError('Only the host can start.');
      if (next.status !== 'lobby') break;
      if (next.players.length < 2) throw new DuelError('You need at least one opponent (add a bot to practise).');
      if (!action.spots.length) throw new DuelError('This building has no photos yet. Add one first!');
      next.spots = action.spots;
      next.status = 'playing';
      next.rounds = [newRound(next, 1, now)];
      break;
    }
    case 'guess': {
      const round = next.rounds.at(-1);
      const me = next.players.find(p => p.id === action.playerId);
      if (next.status !== 'playing' || !round || round.resolvedAt !== undefined) throw new DuelError('No round to guess in.');
      if (!me || me.hp <= 0) throw new DuelError('You are out of this duel.');
      if (now < round.startsAt) throw new DuelError('The round has not started yet.');
      if (round.guesses[me.id]) break;
      round.guesses[me.id] = { ...action.pick, at: now };
      round.firstGuessAt ??= now;
      break;
    }
  }
  next.updatedAt = now;
  next.version += 1;
  return next;
}

function newRound(duel: Duel, n: number, startsAfter: number): DuelRound {
  return { spot: duel.spots[(n - 1) % duel.spots.length], startsAt: startsAfter + INTRO_MS, guesses: {}, multiplier: multiplierFor(n) };
}

type Scorer = (pick: SpotPick, spot: PhotoSpot) => RoundScore;
/** Picks a bot's guess for a spot: a space and a point in it. Injected so the rules stay free of geometry. */
export type BotGuesser = (spot: PhotoSpot, rng: () => number) => SpotPick;

/**
 * Moves the duel forward to `now`: bots guess when their time comes, rounds resolve once everyone alive
 * guessed or the countdown ran out, damage is dealt, and the next round starts after the reveal.
 * Returns the same object when nothing changed.
 */
export function advance(duel: Duel, now: number, score: Scorer, botGuess: BotGuesser): Duel {
  if (duel.status !== 'playing') return duel;
  let next: Duel | undefined;
  const edit = () => (next ??= structuredClone(duel));
  for (let guard = 0; guard < 100; guard++) {
    const d = next ?? duel;
    const round = d.rounds.at(-1)!;
    const alive = d.players.filter(p => p.hp > 0);
    if (round.resolvedAt === undefined) {
      // Bots guess at their own pace, or soon after someone else did.
      for (const bot of alive.filter(p => p.bot && !round.guesses[p.id])) {
        const at = botTime(d, round, bot.id);
        if (at !== undefined && at <= now && at <= deadline(round)) {
          const r = edit().rounds.at(-1)!;
          const rng = mulberry32(hashSeed(`${d.id}|${d.rounds.length}|${bot.id}|pick`));
          r.guesses[bot.id] = { ...botGuess(r.spot, rng), at };
          r.firstGuessAt = Math.min(r.firstGuessAt ?? at, at);
        }
      }
      const r = (next ?? duel).rounds.at(-1)!;
      const everyone = alive.every(p => r.guesses[p.id]);
      const end = everyone ? Math.max(...alive.map(p => r.guesses[p.id].at)) : deadline(r);
      if (!everyone && now < end) return next ?? duel;
      resolve(edit(), end, score);
      continue;
    }
    if (d.status !== 'playing') break;
    const startNext = round.resolvedAt + REVEAL_MS;
    if (now < startNext) break;
    const e = edit();
    e.rounds.push(newRound(e, e.rounds.length + 1, startNext));
  }
  if (next) { next.version += 1; next.updatedAt = now; }
  return next ?? duel;
}

function deadline(round: DuelRound) {
  return Math.min(round.startsAt + ROUND_LIMIT_MS, round.firstGuessAt !== undefined ? round.firstGuessAt + GUESS_WINDOW_MS : Infinity);
}

/** When a bot guesses: 8–30 s into the round, or 3–11 s after the first human guess, whichever is sooner. */
function botTime(duel: Duel, round: DuelRound, botId: string): number | undefined {
  const rng = mulberry32(hashSeed(`${duel.id}|${duel.rounds.length}|${botId}|time`));
  const own = round.startsAt + 8000 + rng() * 22_000;
  const humanFirst = Object.entries(round.guesses).filter(([id]) => !duel.players.find(p => p.id === id)?.bot).map(([, g]) => g.at);
  const reaction = humanFirst.length ? Math.min(...humanFirst) + 3000 + rng() * 8000 : Infinity;
  return Math.min(own, reaction);
}

function resolve(duel: Duel, at: number, score: Scorer) {
  const round = duel.rounds.at(-1)!;
  const alive = duel.players.filter(p => p.hp > 0);
  round.scores = Object.fromEntries(alive.map(p => {
    const g = round.guesses[p.id];
    return [p.id, g ? score(g, round.spot) : { metres: Infinity, walked: false, points: 0 }];
  }));
  const best = Math.max(...alive.map(p => round.scores![p.id].points));
  round.damage = {};
  for (const p of alive) {
    const hit = Math.round((best - round.scores[p.id].points) * round.multiplier);
    round.damage[p.id] = hit;
    p.hp = Math.max(0, p.hp - hit);
  }
  round.resolvedAt = at;
  finishIfDecided(duel, at, round);
}

function finishIfDecided(duel: Duel, at: number, round?: DuelRound) {
  const alive = duel.players.filter(p => p.hp > 0);
  if (alive.length > 1) return;
  duel.status = 'over';
  // Everyone at 0 in the same round (three or more players): the best score of that round wins.
  duel.winnerId = alive[0]?.id ?? (round?.scores ? Object.entries(round.scores).sort((a, b) => b[1].points - a[1].points)[0]?.[0] : undefined);
  duel.updatedAt = at;
}

/**
 * What one player may see: the photo of an open round but not where it was taken, and other players'
 * guesses only as "has guessed" until the round is resolved.
 */
export function duelView(duel: Duel, playerId: string | undefined) {
  return {
    ...duel,
    spots: [],
    rounds: duel.rounds.map(r => r.resolvedAt !== undefined ? r : {
      ...r,
      spot: { ...r.spot, floorId: '', spaceId: '', position: [0, 0] as Point, caption: undefined },
      guesses: Object.fromEntries(Object.entries(r.guesses).map(([id, g]) => [id, id === playerId ? g : { ...g, floorId: '', spaceId: '', position: [0, 0] as Point }])),
    }),
  };
}
export type DuelView = ReturnType<typeof duelView>;
