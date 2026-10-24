import type { Building, Space } from '@/lib/buildings/types';
import type { WalkGraph } from '@/lib/buildings/walk';
import { bounds, pointInPolygon, polygonArea, sharedWall } from '@/lib/buildings/geometry';

/** Detective clues: every one computed from the data, nothing invented (docs/GEOGUESSR.md §2). */
export type ClueKind = 'area' | 'doors' | 'assets' | 'wall' | 'stacked' | 'lift' | 'floor';

export interface Clue {
  kind: ClueKind;
  icon: string;
  title: string;
  /** Plain text; `**…**` marks the important part. */
  text: string;
  /** Points it costs to reveal. The first clue is free. */
  cost: number;
}

export const CLUE_COST = 500;
export const FLOOR_CLUE_COST = 1500;
/** Shared walls shorter than this are corners touching, not neighbours. */
const MIN_SHARED_WALL_M = 0.8;

const label = (s: Space) => s.type === 'corridor' ? 'corridor' : s.type === 'stair' ? 'stairwell' : s.type === 'lift' ? 'lift' : (s.room_type || s.type).replaceAll('_', ' ');
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

function plural(type: string, n: number) {
  const word = type.replaceAll('_', ' ');
  if (n === 1) return word;
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/shelf$/.test(word)) return `${word.slice(0, -1)}ves`;
  return `${word}s`;
}

function list(words: string[]) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The clues for one room in reveal order; the floor is last and dearest. Clues without data are left out. */
export function detectiveClues(building: Building, room: Space, graph: WalkGraph): Clue[] {
  const clues: Clue[] = [];
  const area = polygonArea(room.polygon);
  clues.push({ kind: 'area', icon: '📐', title: 'Size', text: `The room is about **${Math.max(5, Math.round(area / 5) * 5)} m²**.`, cost: 0 });

  const openings = building.openings.filter(o => o.space_ids.includes(room.id));
  const outside = openings.filter(o => o.kind === 'entrance').length;
  if (openings.length) clues.push({
    kind: 'doors', icon: '🚪', title: 'Doors',
    text: `There ${openings.length === 1 ? 'is' : 'are'} **${openings.length} door${openings.length === 1 ? '' : 's'}**${outside ? `, ${outside === 1 ? 'one' : outside} of them to the outside` : ''}.`,
    cost: CLUE_COST,
  });

  const counts = new Map<string, number>();
  for (const a of building.assets) if (a.space_id === room.id) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4);
  clues.push({ kind: 'assets', icon: '🪑', title: 'Inside', text: top.length ? `Inside: **${list(top.map(([type, n]) => `${n} ${plural(type, n)}`))}**${counts.size > top.length ? ' and more' : ''}.` : 'The room is **empty**.', cost: CLUE_COST });

  // Neighbours: the rarest room types first, they say the most.
  const typeCount = new Map<string, number>();
  for (const s of building.spaces) typeCount.set(label(s), (typeCount.get(label(s)) ?? 0) + 1);
  const neighbours = building.spaces
    .filter(s => s.floor_id === room.floor_id && s.id !== room.id && s.type !== 'outdoor')
    .filter(s => sharedWall(room.polygon, s.polygon).length >= MIN_SHARED_WALL_M)
    .map(label);
  const distinct = [...new Set(neighbours)];
  const rooms = distinct.filter(l => !['corridor', 'stairwell', 'lift'].includes(l)).sort((a, b) => (typeCount.get(a) ?? 0) - (typeCount.get(b) ?? 0));
  const shown = (rooms.length ? rooms : distinct).slice(0, 2);
  if (shown.length) clues.push({ kind: 'wall', icon: '🧱', title: 'Next door', text: `The room shares a wall with ${list(shown.map(l => `${article(l)} **${l}**`))}.`, cost: CLUE_COST });

  const stacked = stackedClue(building, room);
  if (stacked) clues.push(stacked);

  // Walking distance to the nearest lift (or stairs when there is no lift).
  const dist = graph.distancesFrom(room.id);
  for (const [type, word] of [['lift', 'lift'], ['stair', 'stairs']] as const) {
    const best = Math.min(...building.spaces.filter(s => s.type === type).map(s => dist.get(s.id) ?? Infinity));
    if (Number.isFinite(best)) {
      clues.push({ kind: 'lift', icon: type === 'lift' ? '🛗' : '🪜', title: type === 'lift' ? 'Nearest lift' : 'Nearest stairs', text: `The nearest **${word}** ${type === 'lift' ? 'is' : 'are'} **${Math.max(1, Math.round(best))} m** away on foot.`, cost: CLUE_COST });
      break;
    }
  }

  if (building.floors.length > 1) {
    const floor = building.floors.find(f => f.id === room.floor_id);
    if (floor) clues.push({ kind: 'floor', icon: '🏢', title: 'Floor', text: `You are on **${floor.name}**.`, cost: FLOOR_CLUE_COST });
  }
  return clues;
}

/** What lies directly above (or, on the top floor, below): the space covering most of this room. */
function stackedClue(building: Building, room: Space): Clue | undefined {
  const floors = [...building.floors].sort((a, b) => a.level - b.level);
  const at = floors.findIndex(f => f.id === room.floor_id);
  const other = floors[at + 1] ?? floors[at - 1];
  if (at < 0 || !other) return undefined;
  const above = other === floors[at + 1];
  // Sample the room on a grid and count which space on the other floor holds each sample.
  const b = bounds(room.polygon);
  const step = Math.max(0.25, Math.sqrt(((b.maxX - b.minX) * (b.maxY - b.minY)) / 400));
  const candidates = building.spaces.filter(s => s.floor_id === other.id && s.type !== 'outdoor');
  const hits = new Map<Space, number>();
  let samples = 0;
  for (let x = b.minX + step / 2; x < b.maxX; x += step) for (let y = b.minY + step / 2; y < b.maxY; y += step) {
    if (!pointInPolygon([x, y], room.polygon)) continue;
    samples++;
    const s = candidates.find(c => pointInPolygon([x, y], c.polygon));
    if (s) hits.set(s, (hits.get(s) ?? 0) + 1);
  }
  const [best] = [...hits].sort((x, y) => y[1] - x[1]);
  if (!best || best[1] < samples * 0.2) return undefined;
  const word = label(best[0]);
  return { kind: 'stacked', icon: above ? '⬆️' : '⬇️', title: above ? 'Upstairs' : 'Downstairs', text: `Directly ${above ? 'above' : 'below'} is ${article(word)} **${word}**.`, cost: CLUE_COST };
}
