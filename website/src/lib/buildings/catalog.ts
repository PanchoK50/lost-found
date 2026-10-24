// Server-side only: importing this from a client component would ship every building to the browser.
import type { Building } from './types';
import n3 from '@/data/buildings/osm-way22744230.json';
import factory from '@/data/buildings/proc-factory-dev-003.json';

export interface CatalogEntry { id: string; name: string; suggestions: string[]; building: Building }

/** Buildings the UI can show. Swap for real storage once plan ingestion lands. */
const catalog: CatalogEntry[] = [
  {
    id: 'osm-way22744230',
    name: 'N3',
    building: n3 as unknown as Building,
    suggestions: [
      'Which is the largest generic room on floor 5, and how big is it in m²?',
      'What is the total area of all generic rooms on floor 4?',
      'We\'re soundproofing Generic room -1364. How many rooms share a wall with it?',
      'Lift 1 is out of service. A wheelchair user comes in through the entrance into Stairwell N0320A. How many rooms on floor 2 can they still reach?',
      'What if we add a door between Corridor -1328 and Corridor -1351? How many rooms on basement 1 get a shorter walk out?',
      'Which room is directly below N2324?',
      'How do I get from N2301 to N5325?',
      'Straight-line distance between N0304 and N2323?',
      'Where is the projector?',
    ],
  },
  {
    id: 'proc-factory-dev-003',
    name: 'Fertigung Ost 27',
    building: factory as unknown as Building,
    suggestions: [
      'Which is the largest kitchen on floor 1, and how big is it?',
      'A 1.1 m wide cleaning machine arrives through the entrance into Warehouse zone H-C3. Into how many rooms on floor 1 can it be delivered?',
      'We\'re soundproofing Assembly zone H-A2. How many rooms share a wall with it?',
      'Where is the coordinate measuring machine?',
      'How many meeting tables are on the ground floor?',
      'How do I get from Office 0.23 to Kitchen 1.08?',
      'What is the total area of all meeting rooms on the ground floor?',
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
