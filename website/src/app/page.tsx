import { BuildingExperience } from '@/components/experience/building-experience';
import { defaultBuildingId, getCatalogEntry, listBuildings } from '@/lib/buildings/catalog';
import { getCampus } from '@/lib/buildings/campuses';
import { applyEdits, loadEdits } from '@/lib/buildings/edits';

export default async function Home({ searchParams }: PageProps<'/'>) {
  const { building, campus, check, ask } = await searchParams;
  const site = getCampus(typeof campus === 'string' ? campus : undefined);
  // ?campus=<id> opens the campus view; its first member is the building in the foreground.
  const primary = site?.members[0]?.buildingId;
  const entry = (await getCatalogEntry(typeof building === 'string' ? building : primary)) ?? (await getCatalogEntry(defaultBuildingId))!;
  // The plan as it is now: base plan plus the edits made by conversation (new doors, moved assets, ...).
  const { building: current } = applyEdits(entry.building, await loadEdits(entry.id));
  const report = (current as { ingest_report?: { issues?: { severity: string; question?: string }[] } }).ingest_report;
  const open = (report?.issues ?? []).filter(i => i.question && i.severity !== 'low');
  const importIntro = check && report ? { checks: open.length, first: open[0]?.question } : undefined;
  return <BuildingExperience key={site ? `${site.id}:${entry.id}` : entry.id} building={current} campus={site} autoAsk={typeof ask === 'string' ? ask.slice(0, 1000) : undefined} buildings={await listBuildings()} suggestions={entry.suggestions} importIntro={importIntro} />;
}
