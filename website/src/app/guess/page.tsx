import type { Metadata } from 'next';
import { GuessGame } from '@/components/guess/guess-game';
import { defaultBuildingId, getCatalogEntry, listBuildings } from '@/lib/buildings/catalog';
import { applyEdits, loadEdits } from '@/lib/buildings/edits';

// No room names here: the title must not give the answer away (docs/GEOGUESSR.md §9).
export const metadata: Metadata = { title: 'Building GeoGuessr · Lost & Found', description: 'See a room, find it on the map. Points by walking distance.' };

export default async function GuessPage({ searchParams }: PageProps<'/guess'>) {
  const { building, seed, level, mode } = await searchParams;
  // The hidden benchmark buildings stay out of the game (docs/GEOGUESSR.md §7).
  const playable = (await listBuildings()).filter(b => b.split !== 'test');
  const requested = typeof building === 'string' && playable.some(b => b.id === building) ? building : undefined;
  const entry = (await getCatalogEntry(requested)) ?? (await getCatalogEntry(defaultBuildingId))!;
  // Same plan as the main app: base plan plus the edits made by conversation.
  const { building: current } = applyEdits(entry.building, await loadEdits(entry.id));
  const buildings = playable.map(({ id, name }) => ({ id, name }));
  return (
    <GuessGame
      key={`${entry.id}|${typeof seed === 'string' ? seed : ''}`}
      building={current}
      buildingName={entry.name}
      buildings={buildings}
      seed={typeof seed === 'string' && seed ? seed.slice(0, 64) : undefined}
      difficulty={level === 'hard' ? 'hard' : 'easy'}
      mode={mode === 'detective' || mode === 'room' ? mode : 'silhouette'}
    />
  );
}
