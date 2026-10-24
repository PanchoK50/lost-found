import type { Building } from '@/lib/buildings/types';
import { polygonArea } from '@/lib/buildings/geometry';
import type { PinKind } from './types';

export type BuildingCategory = 'factory' | 'office' | 'campus' | 'public' | 'residential';
export type MultiplayerMode = 'team' | 'public' | 'home';

export const modeFor: Record<BuildingCategory, MultiplayerMode> = {
  factory: 'team', office: 'team', campus: 'team', public: 'public', residential: 'home',
};
export const modeLabel: Record<MultiplayerMode, string> = { team: 'Team', public: 'Public', home: 'Home' };
export const categoryLabel: Record<BuildingCategory, string> = { factory: 'Factory', office: 'Office', campus: 'Campus', public: 'Public building', residential: 'Home' };

const signals: Record<BuildingCategory, string[]> = {
  factory: ['production_zone', 'assembly_zone', 'warehouse_zone', 'logistics_zone', 'additive_zone', 'quality_lab'],
  office: ['office', 'meeting_room', 'print_room', 'server_room'],
  campus: ['lecture_hall', 'seminar_room', 'lab', 'library', 'makerspace'],
  public: ['shop', 'retail', 'restaurant', 'cafe', 'food_court', 'gate', 'platform', 'exhibition', 'waiting_area'],
  residential: ['bedroom', 'living_room', 'bathroom', 'balcony'],
};
const RESIDENTIAL_SOURCES = new Set(['resplan', 'swiss_dwellings']);

/**
 * Category from the floor area per room type. Area, not counts: a factory has a few huge bays
 * and many small offices, and the bays are what it is. Ties and unknown types fall back to office.
 */
export function detectCategory(building: Building): BuildingCategory {
  if (RESIDENTIAL_SOURCES.has(building.building.source)) return 'residential';
  const area = new Map<string, number>();
  for (const s of building.spaces) area.set(s.room_type, (area.get(s.room_type) ?? 0) + polygonArea(s.polygon));
  let best: BuildingCategory = 'office', bestScore = 0;
  for (const category of Object.keys(signals) as BuildingCategory[]) {
    const score = signals[category].reduce((sum, type) => sum + (area.get(type) ?? 0), 0);
    if (score > bestScore) { best = category; bestScore = score; }
  }
  return best;
}

const HOUR = 3_600_000;
/** How long each pin kind lives before it expires (§4). */
export const PIN_TTL: Record<PinKind, number> = {
  blocked: 2 * HOUR, broken: 24 * HOUR, item: 24 * HOUR, event: 2 * HOUR, info: 7 * 24 * HOUR, meet: 0.5 * HOUR,
};
/** Pin kinds that close the element they name for routing. */
export const CLOSING_KINDS = new Set<PinKind>(['blocked', 'broken']);
