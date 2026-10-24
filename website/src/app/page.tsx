import { BuildingExperience } from '@/components/experience/building-experience';
import { defaultBuildingId, getCatalogEntry, listBuildings } from '@/lib/buildings/catalog';

export default async function Home({ searchParams }: PageProps<'/'>) {
  const { building } = await searchParams;
  const entry = (await getCatalogEntry(typeof building === 'string' ? building : undefined)) ?? (await getCatalogEntry(defaultBuildingId))!;
  return <BuildingExperience key={entry.id} building={entry.building} buildings={await listBuildings()} suggestions={entry.suggestions} />;
}
