// Server-side only: importing this from a client component would ship every building to the browser.
import type { Building } from './types';
import n3 from '@/data/buildings/osm-way22744230.json';
import factory from '@/data/buildings/proc-factory-dev-003.json';

/** A suggestion chip: short label, full question sent when tapped. */
export interface Suggestion { label: string; question: string }

export interface CatalogEntry { id: string; name: string; suggestions: Suggestion[]; building: Building }

/** Buildings the UI can show. Swap for real storage once plan ingestion lands. */
const catalog: CatalogEntry[] = [
  {
    id: 'osm-way22744230',
    name: 'N3',
    building: n3 as unknown as Building,
    // One example per benchmark kind (docs/answer-types.md).
    suggestions: [
      { label: 'Largest room', question: 'Which is the largest generic room on floor 5, and how big is it in m²?' },
      { label: 'Total area', question: 'What is the total area of all generic rooms on floor 4?' },
      { label: 'Shared walls', question: 'We\'re soundproofing Generic room -1364. How many rooms share a wall with it?' },
      { label: 'Wide delivery', question: 'A 0.8 m wide trolley arrives through the entrance into Corridor -1328. Into how many rooms on floor 2 can it be delivered?' },
      { label: 'Step-free reach', question: 'Lift 1 is out of service. A wheelchair user comes in through the entrance into Stairwell N0320A. How many rooms on floor 2 can they still reach?' },
      { label: 'What-if door', question: 'What if we add a door between Corridor -1328 and Corridor -1351? How many rooms on basement 1 get a shorter walk out?' },
      { label: 'Room below', question: 'Which room is directly below N2324?' },
      { label: 'Errand', question: 'I\'m in N2301. I need to grab a coat rack from the room that has one closest to me, then carry it to the largest generic room on floor 5.' },
      { label: '3D distance', question: 'What is the straight-line distance between N0304 and N2323?' },
    ],
  },
  {
    id: 'proc-factory-dev-003',
    name: 'Fertigung Ost 27',
    building: factory as unknown as Building,
    suggestions: [
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

export const defaultBuildingId = catalog[0].id;

export function listBuildings() {
  return catalog.map(({ id, name }) => ({ id, name }));
}

export function getCatalogEntry(id: string | undefined): CatalogEntry | undefined {
  return catalog.find(entry => entry.id === id);
}
