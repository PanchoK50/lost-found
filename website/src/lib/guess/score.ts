import type { Building, Space } from '@/lib/buildings/types';
import type { WalkGraph } from '@/lib/buildings/walk';
import { representativePoint } from '@/lib/buildings/graph';

/** Points per round; a game of five rounds tops out at 25,000 (docs/GEOGUESSR.md §4). */
export const MAX_POINTS = 5000;
/** Walking a straight line through walls is cheating: unreachable rooms count 1.5× the 3D distance. */
const UNREACHABLE_FACTOR = 1.5;

/** Distance at which points drop to 1/e: the 3D diagonal of the building over 8, so small and huge buildings play alike. */
export function scoreScale(building: Building): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of building.spaces) for (const [x, y] of s.polygon) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const levels = building.floors.map(f => f.elevation_m);
  const height = levels.length ? Math.max(...levels) - Math.min(...levels) : 0;
  return Math.max(5, Math.hypot(maxX - minX, maxY - minY, height) / 8);
}

export interface GuessDistance {
  metres: number;
  /** False if no walking route exists and the distance is the 3D fallback. */
  walked: boolean;
}

/** Walking distance from the guessed room to the answer, from the same model as the benchmark's route check. */
export function guessDistance(graph: WalkGraph, building: Building, guess: Space, answer: Space): GuessDistance {
  if (guess.id === answer.id) return { metres: 0, walked: true };
  const walked = graph.distancesFrom(guess.id).get(answer.id);
  if (walked !== undefined) return { metres: walked, walked: true };
  const z = (s: Space) => building.floors.find(f => f.id === s.floor_id)?.elevation_m ?? 0;
  const [ax, ay] = representativePoint(guess.polygon), [bx, by] = representativePoint(answer.polygon);
  return { metres: Math.hypot(ax - bx, ay - by, z(guess) - z(answer)) * UNREACHABLE_FACTOR, walked: false };
}

export function points(metres: number, scale: number): number {
  return metres <= 0 ? MAX_POINTS : Math.round(MAX_POINTS * Math.exp(-metres / scale));
}

export function emojiFor(score: number): string {
  if (score >= 4000) return '🟩';
  if (score >= 2000) return '🟨';
  if (score >= 500) return '🟧';
  return '🟥';
}

/** The building comments on your guess, in the first person (§5). */
export function verdict(score: number, metres: number, sameFloor: boolean): string {
  if (score === MAX_POINTS) return 'You know me better than my caretaker.';
  if (!sameFloor) return 'Cold. Very cold. Wrong floor entirely.';
  if (metres > 100) return 'That\'s not even the same wing.';
  if (score >= 4000) return 'So close I can feel it.';
  if (score >= 2000) return 'Right neighbourhood, wrong door.';
  return 'Lukewarm. Have you ever been here?';
}

export function shareText(buildingName: string, scores: number[], url?: string): string {
  const total = scores.reduce((a, b) => a + b, 0);
  return [`Lost & Found GeoGuessr · ${buildingName} · ${total.toLocaleString('en')} / ${(scores.length * MAX_POINTS).toLocaleString('en')} · ${scores.map(emojiFor).join('')}`, url].filter(Boolean).join('\n');
}
