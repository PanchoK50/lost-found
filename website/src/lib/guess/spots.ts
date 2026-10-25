import type { Building, Point, Space } from '@/lib/buildings/types';
import { pointInPolygon, polygonArea, bounds } from '@/lib/buildings/geometry';
import { representativePoint } from '@/lib/buildings/graph';
import { hashSeed, mulberry32, shuffle, type Rng } from './random';

/**
 * A photo the community took somewhere in a building, tagged with the exact spot on the 3D model
 * (docs/GEOGUESSR.md). The game shows the photo; players tap where they think it was taken.
 */
export interface PhotoSpot {
  id: string;
  buildingId: string;
  floorId: string;
  spaceId: string;
  /** Building metres, y up. */
  position: Point;
  imageUrl: string;
  authorId: string;
  authorName: string;
  /** Shown after the reveal only, so it can't give the place away. */
  caption?: string;
  createdAt: number;
  /** Placeholder photo seeded until real ones arrive. */
  mock?: boolean;
}

/** Where a player tapped: a point on a floor, inside a space. */
export interface SpotPick { floorId: string; spaceId: string; position: Point }

const BAYS = /production|assembly|workshop|warehouse|logistics|additive/;

/** Placeholder photos (public/guess/mock, CC0) and the kind of space each fits. */
const MOCK_PHOTOS: { file: string; caption: string; fits(s: Space): boolean }[] = [
  { file: 'corridor-0.jpg', caption: 'The long corridor', fits: s => s.type === 'corridor' },
  { file: 'corridor-1.jpg', caption: 'Around the corner', fits: s => s.type === 'corridor' },
  { file: 'corridor-2.jpg', caption: 'Hallway with the pin board', fits: s => s.type === 'corridor' },
  { file: 'stairs-0.jpg', caption: 'Up we go', fits: s => s.type === 'stair' },
  { file: 'stairs-1.jpg', caption: 'The bright staircase', fits: s => s.type === 'stair' },
  { file: 'toilet-0.jpg', caption: 'Sink with a view', fits: s => /toilet|wc|restroom|bath|wash/.test(s.room_type) },
  { file: 'toilet-3.jpg', caption: 'Row of sinks', fits: s => /toilet|wc|restroom|bath|wash/.test(s.room_type) },
  { file: 'kitchen-2.jpg', caption: 'Tea kitchen by the window', fits: s => /kitchen|pantry|tea/.test(s.room_type) },
  { file: 'kitchen-3.jpg', caption: 'The good kitchen', fits: s => /kitchen|pantry|tea/.test(s.room_type) },
  { file: 'canteen-1.jpg', caption: 'Where the coffee happens', fits: s => /kitchen|pantry|tea|canteen|cafeteria|mensa|dining|cafe/.test(s.room_type) },
  { file: 'canteen-2.jpg', caption: 'Lunch spot', fits: s => /canteen|cafeteria|mensa|dining|cafe|lobby|foyer/.test(s.room_type) },
  { file: 'lecture-0.jpg', caption: 'Front row seats', fits: s => /lecture|auditor|seminar|hall_room/.test(s.room_type) },
  { file: 'lecture-1.jpg', caption: 'Monday morning lecture', fits: s => /lecture|auditor|seminar|class/.test(s.room_type) },
  { file: 'library-0.jpg', caption: 'Quiet zone', fits: s => /library|reading|study/.test(s.room_type) },
  { file: 'library-3.jpg', caption: 'Between the shelves', fits: s => /library|reading|study/.test(s.room_type) },
  { file: 'lobby-1.jpg', caption: 'The entrance hall', fits: s => /lobby|foyer|entrance|reception|atrium/.test(s.room_type) },
  { file: 'server-2.jpg', caption: 'Blinking lights', fits: s => /server|data|it_|network/.test(s.room_type) },
  { file: 'server-3.jpg', caption: 'It is cold in here', fits: s => /server|data|it_|network/.test(s.room_type) },
  { file: 'factory-0.jpg', caption: 'On the shop floor', fits: s => BAYS.test(s.room_type) },
  { file: 'factory-1.jpg', caption: 'Machines everywhere', fits: s => BAYS.test(s.room_type) },
  { file: 'meeting-0.jpg', caption: 'Meeting room, empty for once', fits: s => /meeting|conference/.test(s.room_type) },
  { file: 'meeting-1.jpg', caption: 'The round table', fits: s => /meeting|conference/.test(s.room_type) },
  { file: 'office-1.jpg', caption: 'Someone\'s desk', fits: s => /office/.test(s.room_type) },
  { file: 'office-3.jpg', caption: 'Corner office', fits: s => /office/.test(s.room_type) },
];
/** For buildings that only know "generic rooms" (most OSM ones): the photos that pass for any room. */
const ANY_ROOM = new Set(['meeting-0.jpg', 'meeting-1.jpg', 'office-1.jpg', 'office-3.jpg']);

const MOCK_AUTHORS = ['Mia', 'Jonas', 'Lena', 'Emre', 'Sofia', 'Paul', 'Aylin', 'Felix'];
const MOCK_EPOCH = Date.UTC(2026, 9, 20, 9);

/**
 * Placeholder spots for any building: each mock photo goes into a space of a fitting kind, one photo per
 * space, at a random point inside it. Deterministic per building, so everyone sees the same ones.
 */
export function mockSpots(building: Building): PhotoSpot[] {
  const id = building.building.id;
  const rng = mulberry32(hashSeed(`mock|${id}`));
  const used = new Set<string>();
  const usable = building.spaces.filter(s => s.polygon.length >= 3 && polygonArea(s.polygon) >= 4 && s.type !== 'outdoor');
  const spots: PhotoSpot[] = [];
  MOCK_PHOTOS.forEach((photo, i) => {
    let options = usable.filter(s => !used.has(s.id) && photo.fits(s));
    if (!options.length && ANY_ROOM.has(photo.file)) options = usable.filter(s => !used.has(s.id) && s.type === 'room' && !/toilet|stair|lift/.test(s.room_type));
    if (!options.length) return;
    const space = shuffle(options, rng)[0];
    used.add(space.id);
    spots.push({
      id: `mock-${id}-${photo.file.replace('.jpg', '')}`,
      buildingId: id,
      floorId: space.floor_id,
      spaceId: space.id,
      position: pointInside(space.polygon, rng),
      imageUrl: `/guess/mock/${photo.file}`,
      authorId: 'mock',
      authorName: MOCK_AUTHORS[i % MOCK_AUTHORS.length],
      caption: photo.caption,
      createdAt: MOCK_EPOCH + i * 3 * 3600_000,
      mock: true,
    });
  });
  return spots;
}

/** A random point well inside a polygon (falls back to the representative point). */
export function pointInside(polygon: Point[], rng: Rng): Point {
  const b = bounds(polygon);
  const anchor = representativePoint(polygon);
  for (let i = 0; i < 40; i++) {
    // Pull towards the anchor so the point keeps some distance from the walls.
    const x = b.minX + rng() * (b.maxX - b.minX), y = b.minY + rng() * (b.maxY - b.minY);
    const p: Point = [anchor[0] + (x - anchor[0]) * 0.7, anchor[1] + (y - anchor[1]) * 0.7];
    if (pointInPolygon(p, polygon)) return p;
  }
  return anchor;
}

/** The photos of one game: shuffled with the seed, as many as there are (up to `count`). */
export function pickSpots(spots: PhotoSpot[], seed: string, count: number): PhotoSpot[] {
  return shuffle([...spots].sort((a, b) => a.id.localeCompare(b.id)), mulberry32(hashSeed(`spots|${seed}`))).slice(0, count);
}

/** What to call the place once it's revealed. */
export function placeName(building: Building, spaceId: string): string {
  const s = building.spaces.find(x => x.id === spaceId);
  if (!s) return 'Somewhere';
  return s.name || s.ref || s.room_type.replaceAll('_', ' ') || 'Unnamed room';
}
