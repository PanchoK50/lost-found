import stammgelaende from '@/data/campus/stammgelaende.json';

/** A curated campus: buildings placed on one shared frame (metres), for cross-building routing.
 * Mirrors data/campus/*.json of the agent; the offsets are the real displacements where we know them. */
export interface CampusDefinition {
  id: string;
  name?: string;
  members: { buildingId: string; offset: [number, number] }[];
}

const CAMPUSES: Record<string, CampusDefinition> = {
  [stammgelaende.id]: stammgelaende as unknown as CampusDefinition,
};

export function getCampus(id: string | undefined): CampusDefinition | undefined {
  return id ? CAMPUSES[id] : undefined;
}
