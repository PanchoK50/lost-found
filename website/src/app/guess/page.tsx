import type { Metadata, Viewport } from 'next';
import { GuessApp, type View } from '@/components/guess/guess-app';
import { defaultBuildingId, getCatalogEntry, listBuildings } from '@/lib/buildings/catalog';
import { applyEdits, loadEdits } from '@/lib/buildings/edits';

// No room names here: the title must not give the answer away (docs/GEOGUESSR.md).
export const metadata: Metadata = { title: 'Building GeoGuessr · Lost & Found', description: 'Community photos of your building. Guess where they were taken, solo or in live duels.' };
export const viewport: Viewport = { themeColor: '#1b1145' };

export default async function GuessPage({ searchParams }: PageProps<'/guess'>) {
  const { building, play, seed, duel } = await searchParams;
  // The hidden benchmark buildings stay out of the game.
  const playable = (await listBuildings()).filter(b => b.split !== 'test');
  const requested = typeof building === 'string' && playable.some(b => b.id === building) ? building : undefined;
  const entry = (await getCatalogEntry(requested)) ?? (await getCatalogEntry(defaultBuildingId))!;
  // Same plan as the main app: base plan plus the edits made by conversation.
  const { building: current } = applyEdits(entry.building, await loadEdits(entry.id));
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 64) : undefined);
  const initial: View = str(duel) || play === 'duels' ? { name: 'duels', duel: str(duel) }
    : play === 'solo' && str(seed) ? { name: 'solo', seed: str(seed)! }
    : play === 'upload' ? { name: 'upload' }
    : { name: 'home' };
  return <GuessApp key={entry.id} building={current} buildingName={entry.name} buildings={playable.map(({ id, name }) => ({ id, name }))} initial={initial} />;
}
