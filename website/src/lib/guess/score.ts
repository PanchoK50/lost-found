import type { Building } from '@/lib/buildings/types';
import type { WalkGraph } from '@/lib/buildings/walk';
import type { SpotPick } from './spots';

/** Points per round; a game of five rounds tops out at 25,000 (docs/GEOGUESSR.md §4). */
export const MAX_POINTS = 5000;
/** Walking a straight line through walls is cheating: unreachable rooms count 1.5× the 3D distance. */
const UNREACHABLE_FACTOR = 1.5;

/** Distance at which points drop to 1/e: the 3D diagonal of the building over 4 (walks run much longer than straight lines), so small and huge buildings play alike. */
export function scoreScale(building: Building): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of building.spaces) for (const [x, y] of s.polygon) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const levels = building.floors.map(f => f.elevation_m);
  const height = levels.length ? Math.max(...levels) - Math.min(...levels) : 0;
  return Math.max(5, Math.hypot(maxX - minX, maxY - minY, height) / 4);
}

export interface GuessDistance {
  metres: number;
  /** False if no walking route exists and the distance is the 3D fallback. */
  walked: boolean;
}

/** Closer than this counts as standing on the spot (a phone photo is never pinned to the centimetre). */
export const BULLSEYE_M = 1.5;

/**
 * Distance from the tapped point to where the photo was taken. Same space: straight across the room.
 * Otherwise the walk between the two spaces (the benchmark's walking model), never less than the straight
 * 3D line between the two points. Unreachable: 1.5× the straight line.
 */
export function spotDistance(graph: WalkGraph, building: Building, guess: SpotPick, answer: SpotPick): GuessDistance {
  const z = (floorId: string) => building.floors.find(f => f.id === floorId)?.elevation_m ?? 0;
  const straight = Math.hypot(guess.position[0] - answer.position[0], guess.position[1] - answer.position[1], z(guess.floorId) - z(answer.floorId));
  if (guess.spaceId === answer.spaceId) return { metres: straight, walked: true };
  const walked = graph.distancesFrom(guess.spaceId).get(answer.spaceId);
  if (walked !== undefined) return { metres: Math.max(walked, straight), walked: true };
  return { metres: straight * UNREACHABLE_FACTOR, walked: false };
}

export function points(metres: number, scale: number): number {
  return metres <= BULLSEYE_M ? MAX_POINTS : Math.round(MAX_POINTS * Math.exp(-metres / scale));
}

export function emojiFor(score: number): string {
  if (score >= 4000) return '🟩';
  if (score >= 2000) return '🟨';
  if (score >= 500) return '🟧';
  return '🟥';
}

export interface VerdictInput {
  points: number;
  metres: number;
  /** Floor names of the guess and the answer. */
  guessFloor: string;
  answerFloor: string;
  cluesBought?: boolean;
  /** Varies the line between rounds without randomness. */
  round: number;
}

const pick = (lines: string[], round: number) => lines[round % lines.length];

/** The building comments on your guess, in the first person (§5). */
export function verdict({ points: score, metres, guessFloor, answerFloor, cluesBought, round }: VerdictInput): string {
  if (metres <= BULLSEYE_M) return pick(['You know me better than my caretaker.', 'Bullseye. Have you been sleeping here?', 'Exactly here. I\'m flattered.'], round);
  if (cluesBought) return 'Cheating is allowed. But I\'ll remember.';
  if (guessFloor !== answerFloor) return `Cold. Very cold. You're on ${guessFloor}, I meant ${answerFloor}.`;
  if (metres > 100) return 'That\'s not even the same wing.';
  if (score >= 4000) return pick(['So close I can feel it.', 'One wall away. Almost.', 'Warm. Very warm.'], round);
  if (score >= 2000) return pick(['Right neighbourhood, wrong door.', 'You\'d hear me from there.', 'Lukewarm, leaning warm.'], round);
  return pick(['Lukewarm. Have you ever been here?', 'Did you take the scenic route?', 'Not quite. Try following the coffee smell.'], round);
}

/** Wordle-style result: `Lost & Found GeoGuessr · Terminal 2 · 18,400 / 25,000 · 🟩🟨🟩🟥🟩`. */
export function shareText(buildingName: string, scores: number[], url?: string, day?: string): string {
  const total = scores.reduce((a, b) => a + b, 0);
  const head = ['Lost & Found GeoGuessr', buildingName, day && `Daily ${day}`, `${total.toLocaleString('en')} / ${(scores.length * MAX_POINTS).toLocaleString('en')}`, scores.map(emojiFor).join('')];
  return [head.filter(Boolean).join(' · '), url].filter(Boolean).join('\n');
}
