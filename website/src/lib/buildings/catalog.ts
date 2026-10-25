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
 * Hand-written suggestions for the two showcase buildings (also bundled, so the app works without Supabase).
 * Every other building, including uploaded ones, gets suggestions generated from its rooms and equipment.
 */
const showcase: CatalogEntry[] = [
  {
    id: 'osm-way22744230',
    name: 'N3',
    building: n3 as unknown as Building,
    // The two everyday questions first, then one example per benchmark kind (docs/answer-types.md).
    suggestions: [
      { label: 'Find something', question: 'Where is the projector?' },
      { label: 'Directions', question: 'How do I get from N2301 to N5325?' },
      { label: 'Largest room', question: 'Which is the largest generic room on floor 5, and how big is it in m²?' },
      { label: 'Total area', question: 'What is the total area of all generic rooms on floor 4?' },
      { label: 'Shared walls', question: 'We\'re soundproofing Generic room -1364. How many rooms share a wall with it?' },
      { label: 'Wide delivery', question: 'A 0.8 m wide trolley arrives through the entrance into Corridor -1328. Into how many rooms on floor 2 can it be delivered?' },
      { label: 'Step-free reach', question: 'Lift 1 is out of service. A wheelchair user comes in through the entrance into Stairwell N0320A. How many rooms on floor 2 can they still reach?' },
      { label: 'What-if door', question: 'What if we add a door between Corridor -1328 and Corridor -1351? How many rooms on basement 1 get a shorter walk out?' },
      { label: 'Room below', question: 'Which room is directly below N2324?' },
      { label: 'Errand', question: 'I\'m in N2301. I need to grab a coat rack from the room that has one closest to me, then carry it to the largest generic room on floor 5.' },
      { label: '3D distance', question: 'What is the straight-line distance between N0304 and N2323?' },
      { label: 'To another building', question: 'How do I get from N2301 to the largest generic room in N8?' },
    ],
  },
  {
    id: 'osm-way43035346',
    name: 'N8',
    building: n8 as unknown as Building,
    suggestions: [
      { label: 'Find something', question: 'Where is the nearest toilet?' },
      { label: 'Directions', question: 'How do I get from the entrance to the largest room on floor 2?' },
      { label: 'To another building', question: 'How do I get from N0839 to N2301 in N3?' },
    ],
  },
  {
    id: 'proc-factory-dev-003',
    name: 'Fertigung Ost 27',
    building: factory as unknown as Building,
    suggestions: [
      { label: 'Find something', question: 'Where is the coordinate measuring machine?' },
      { label: 'Directions', question: 'How do I get from Office 0.23 to Kitchen 1.08?' },
      { label: 'Largest room', question: 'Which is the largest kitchen on floor 1, and how big is it?' },
      { label: 'Total area', question: 'What is the total area of all meeting rooms on the ground floor?' },
      { label: 'Shared walls', question: 'We\'re soundproofing Assembly zone H-A2. How many rooms share a wall with it?' },
      { label: 'Wide delivery', question: 'A 1.1 m wide cleaning machine arrives through the entrance into Warehouse zone H-C3. Into how many rooms on floor 1 can it be delivered?' },
      { label: 'Step-free reach', question: 'A wheelchair user comes in through the entrance into Office corridor 0.16. How many rooms on floor 1 can they reach?' },
      { label: 'What-if door', question: 'What if we add a door between Production zone H-A1 and Meeting room 0.20? How many rooms on the ground floor get a shorter walk out?' },
      { label: 'Room above', question: 'Which room is directly above Office 0.23?' },
      { label: 'Errand', question: 'I\'m in Office 0.38. I need to grab a stove from the room that has one closest to me, then carry it to the largest kitchen on floor 1.' },
      { label: '3D distance', question: 'What is the straight-line distance between Office 0.23 and Kitchen 1.14?' },
    ],
  },
];

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
  const entry: CatalogEntry = { id, name: row.name, building, suggestions: suggestionsFor(building) };
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
