import type { Building } from './types';

export interface DirectionStep { text: string; kind: 'start' | 'through' | 'floor' | 'outside' | 'arrive' }

/**
 * Turn an ordered list of space ids (the scored route format) into short, followable steps.
 * Consecutive rides on the same stairs or lift merge into one step.
 */
export function directions(building: Building, spacePath: string[]): DirectionStep[] {
  const spaces = new Map(building.spaces.map(s => [s.id, s]));
  const floors = new Map(building.floors.map(f => [f.id, f]));
  const steps: DirectionStep[] = [];
  let ride: { connector: string; step: DirectionStep } | undefined;
  spacePath.forEach((id, i) => {
    const space = spaces.get(id);
    const prev = spaces.get(spacePath[i - 1]);
    if (id === 'outside') { steps.push({ text: 'Go outside and in through the next entrance', kind: 'outside' }); ride = undefined; return; }
    if (!space) return;
    if (i === 0) { steps.push({ text: `Start in ${space.name}`, kind: 'start' }); return; }
    if (prev && prev.floor_id !== space.floor_id) {
      const connector = building.vertical_connectors.find(c => c.space_ids.includes(prev.id) && c.space_ids.includes(space.id));
      const from = floors.get(prev.floor_id)!, to = floors.get(space.floor_id)!;
      const text = `Take ${connector?.name ?? 'the stairs'} ${to.level > from.level ? 'up' : 'down'} to ${to.name}`;
      if (ride && connector && ride.connector === connector.id) ride.step.text = text; // keep riding
      else { const step: DirectionStep = { text, kind: 'floor' }; steps.push(step); ride = connector && { connector: connector.id, step }; }
      if (i === spacePath.length - 1) steps.push({ text: `Arrive at ${space.name}`, kind: 'arrive' });
      return;
    }
    ride = undefined;
    // Walking through a stairwell or lift lobby on the way to a ride isn't worth its own step.
    if (i < spacePath.length - 1 && (space.type === 'stair' || space.type === 'lift') && spaces.get(spacePath[i + 1])?.floor_id !== space.floor_id) return;
    steps.push(i === spacePath.length - 1 ? { text: `Arrive at ${space.name}`, kind: 'arrive' } : { text: `Through ${space.name}`, kind: 'through' });
  });
  return steps;
}
