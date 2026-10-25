// Server-side only: importing this from a client component would ship buildings to the browser.
import type { Building } from './types';
import { supabaseAdmin } from '@/lib/supabase/server';
import n3 from '@/data/buildings/osm-way22744230.json';
import n8 from '@/data/buildings/osm-way43035346.json';
import factory from '@/data/buildings/proc-factory-dev-003.json';

/** A suggestion chip: short label, full question sent when tapped. */
export interface Suggestion { label: string; question: string }

export interface CatalogEntry { id: string; name: string; suggestions: Suggestion[]; building: Building }

/** One row of the building picker. */
export interface BuildingSummary { id: string; name: string; source: string; split: string | null; floors: number; spaces: number }

const LIST_TTL_MS = 60_000;
const MAX_CACHED = 40;

/**
 * The showcase buildings are bundled, so the app works without Supabase. Every building, including uploaded ones,
 * gets fire co-pilot suggestions generated from its rooms and equipment.
 */
const showcase: CatalogEntry[] = [
  { id: 'osm-way22744230', name: 'N3', building: n3 as unknown as Building, suggestions: [] },
  { id: 'osm-way43035346', name: 'N8', building: n8 as unknown as Building, suggestions: [] },
  { id: 'proc-factory-dev-003', name: 'Fertigung Ost 27', building: factory as unknown as Building, suggestions: [] },
];
for (const entry of showcase) entry.suggestions = fireSuggestionsFor(entry.building);

export const defaultBuildingId = showcase[0].id;

const g = globalThis as { __lfBuildingList?: { at: number; list: BuildingSummary[] }; __lfBuildings?: Map<string, CatalogEntry> };
const cache = (g.__lfBuildings ??= new Map());

/** Every building the app can show: the dataset plus uploaded plans (Supabase), or the showcase without it. */
export async function listBuildings(): Promise<BuildingSummary[]> {
  const db = supabaseAdmin();
  const fallback = showcase.map(e => ({ id: e.id, name: e.name, source: e.building.building.source, split: null, floors: e.building.floors.length, spaces: e.building.spaces.length }));
  if (!db) return fallback;
  if (g.__lfBuildingList && Date.now() - g.__lfBuildingList.at < LIST_TTL_MS) return g.__lfBuildingList.list;
  const { data, error } = await db.from('buildings').select('id, name, source, split, floors, spaces').order('name');
  if (error || !data) return g.__lfBuildingList?.list ?? fallback;
  g.__lfBuildingList = { at: Date.now(), list: data as BuildingSummary[] };
  return g.__lfBuildingList.list;
}

/** Forget the cached list (after an upload), so the new building shows up right away. */
export function invalidateBuildingList() {
  g.__lfBuildingList = undefined;
}

export async function getCatalogEntry(id: string | undefined): Promise<CatalogEntry | undefined> {
  if (!id) return undefined;
  const known = showcase.find(entry => entry.id === id) ?? cache.get(id);
  if (known) return known;
  const db = supabaseAdmin();
  if (!db || !/^[\w.-]{1,120}$/.test(id)) return undefined;
  const { data: row } = await db.from('buildings').select('name, storage_path').eq('id', id).maybeSingle();
  if (!row) return undefined;
  const { data: file, error } = await db.storage.from('buildings').download(row.storage_path);
  if (error || !file) return undefined;
  const building = JSON.parse(await file.text()) as Building;
  const entry: CatalogEntry = { id, name: row.name, building, suggestions: fireSuggestionsFor(building) };
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(id, entry);
  return entry;
}

/** Example questions from what this building actually contains, so every building gets working chips. */
export function suggestionsFor(building: Building): Suggestion[] {
  const floors = [...building.floors].sort((a, b) => a.level - b.level);
  const floorName = (floorId: string) => floors.find(f => f.id === floorId)?.name.toLowerCase() ?? 'that floor';
  const rooms = building.spaces.filter(s => s.type === 'room' && s.name);
  const named = (s: { ref?: string; name: string }) => s.ref || s.name;
  const suggestions: Suggestion[] = [];

  const things = building.assets.filter(a => a.category === 'machine' || a.category === 'equipment');
  const thing = (things.length ? things : building.assets)[0];
  if (thing) suggestions.push({ label: 'Find something', question: `Where is the ${thing.type.replaceAll('_', ' ')}?` });
  if (rooms.length >= 2) suggestions.push({ label: 'Directions', question: `How do I get from ${named(rooms[0])} to ${named(rooms[rooms.length - 1])}?` });
  for (const type of ['toilet', 'kitchen', 'bathroom', 'meeting_room']) {
    if (building.spaces.some(s => s.room_type === type)) {
      suggestions.push({ label: 'Nearest', question: `Where is the nearest ${type.replaceAll('_', ' ')}?` });
      break;
    }
  }
  // A room type that appears several times on one floor makes a good "largest" and "total area" question.
  const counts = new Map<string, number>();
  for (const s of rooms) counts.set(`${s.floor_id}|${s.room_type}`, (counts.get(`${s.floor_id}|${s.room_type}`) ?? 0) + 1);
  const [busiest] = [...counts].sort((a, b) => b[1] - a[1]);
  if (busiest && busiest[1] >= 2) {
    const [floorId, type] = busiest[0].split('|');
    const label = type.replaceAll('_', ' ');
    suggestions.push({ label: 'Largest room', question: `Which is the largest ${label} on the ${floorName(floorId)}, and how big is it in m²?` });
    suggestions.push({ label: 'Total area', question: `What is the total area of all ${label}s on the ${floorName(floorId)}?` });
  }
  if (rooms[0]) suggestions.push({ label: 'Shared walls', question: `How many rooms share a wall with ${named(rooms[0])}?` });
  if (floors.length > 1) {
    const upper = rooms.find(s => s.floor_id !== floors[0].id);
    if (upper) suggestions.push({ label: 'Room below', question: `Which room is directly below ${named(upper)}?` });
    const lower = rooms.find(s => s.floor_id === floors[0].id);
    if (upper && lower) suggestions.push({ label: '3D distance', question: `What is the straight-line distance between ${named(lower)} and ${named(upper)}?` });
  }
  return suggestions;
}

function area(polygon: [number, number][]) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * Fire co-pilot chips for firefighters and emergency crews, with this building's real room names: getting in, the way
 * out, the size of the room, what is above and below, extinguishers and electrical panels. Built around one likely
 * fire room (an upper-floor lab, kitchen or technical room when there is one), so every chip works on any building.
 */
export function fireSuggestionsFor(building: Building): Suggestion[] {
  // Rooms where a fire is most likely to start or matters most (inside the function: the showcase calls this at load).
  const FIRE_PRONE = ['lab', 'laboratory', 'kitchen', 'server_room', 'technical_room', 'workshop', 'storage', 'seminar_room', 'lecture_hall', 'office'];
  const floors = [...building.floors].sort((a, b) => a.level - b.level);
  const level = new Map(floors.map(f => [f.id, f.level]));
  const rooms = building.spaces.filter(s => (s.type === 'room' || s.type === 'hall') && s.name && !s.synthetic);
  if (!rooms.length) return suggestionsFor(building);
  const rank = (s: (typeof rooms)[number]) => {
    const prone = FIRE_PRONE.indexOf(s.room_type);
    return (prone < 0 ? FIRE_PRONE.length : prone) * 10 + ((level.get(s.floor_id) ?? 0) > 0 ? 0 : 5);
  };
  const room = [...rooms].sort((a, b) => rank(a) - rank(b) || area(b.polygon) - area(a.polygon) || a.id.localeCompare(b.id))[0];
  const name = room.ref && !room.name.includes(room.ref) ? `${room.name} (${room.ref})` : room.name;
  const has = (type: string) => building.assets.some(a => a.type === type);
  const out: Suggestion[] = [
    { label: 'Get in', question: `Which entrance gets us fastest to ${name}, and what is the route from there without lifts?` },
    { label: 'Nearest exit', question: `How do I get from ${name} to the nearest exit?` },
    { label: 'Room size', question: `How big is ${name} in m²?` },
  ];
  if (floors.length > 1) out.push({ label: 'Above and below', question: `What is directly above and directly below ${name}?` });
  if (has('fire_extinguisher')) out.push({ label: 'Extinguisher', question: `Where is the nearest fire extinguisher to ${name}?` });
  out.push({ label: 'Next door', question: `Which rooms share a wall with ${name}?` });
  if (floors.length > 1) out.push({ label: 'Step-free out', question: `With all lifts off, is there a step-free way out of ${name}?` });
  if (has('electrical_panel')) out.push({ label: 'Electrical panel', question: 'Where is the electrical panel?' });
  return out;
}
