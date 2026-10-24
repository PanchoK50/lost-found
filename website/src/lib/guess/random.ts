/** Seeded randomness so a game can be replayed and shared (docs/GEOGUESSR.md §3). */

export type Rng = () => number;

/** mulberry32: tiny, fast, good enough for picking rooms. Returns numbers in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: turns any text seed ("abc", building id + date) into a 32-bit number. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Everyone playing the same building on the same day gets the same rooms. Uses the local calendar day. */
export function dailySeed(buildingId: string, date = new Date()): string {
  return `${buildingId}:${localDay(date)}`;
}

/** The day of a daily seed ("2026-10-25"), or undefined for any other seed. */
export function dailyDay(seed: string | undefined, buildingId: string): string | undefined {
  const match = seed?.match(/^(.+):(\d{4}-\d{2}-\d{2})$/);
  return match && match[1] === buildingId ? match[2] : undefined;
}

function localDay(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A short, shareable seed for a fresh game. */
export function randomSeed(): string {
  return Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
}

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
