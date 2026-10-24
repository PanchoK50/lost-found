import { BuildingExperience } from '@/components/experience/building-experience';
import { defaultBuildingId, getCatalogEntry, listBuildings } from '@/lib/buildings/catalog';
import { applyEdits, loadEdits } from '@/lib/buildings/edits';

export default async function Home({ searchParams }: PageProps<'/'>) {
  const { building, check } = await searchParams;
  const entry = (await getCatalogEntry(typeof building === 'string' ? building : undefined)) ?? (await getCatalogEntry(defaultBuildingId))!;
  // The plan as it is now: base plan plus the edits made by conversation (new doors, moved assets, ...).
  const { building: current } = applyEdits(entry.building, await loadEdits(entry.id));
  const report = (current as { ingest_report?: { issues?: { severity: string; question?: string }[] } }).ingest_report;
  const open = (report?.issues ?? []).filter(i => i.question && i.severity !== 'low');
  const importIntro = check && report ? { checks: open.length, first: open[0]?.question } : undefined;
  return <BuildingExperience key={entry.id} building={current} buildings={await listBuildings()} suggestions={entry.suggestions} importIntro={importIntro} />;
}
