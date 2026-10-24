import { demoBuilding } from '@/lib/buildings/demo';

// Deterministic lookup seam. Replace this with building storage / agent tools later.
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q')?.trim().toLowerCase() ?? '';
  if (!query || query.length > 200) {
    return Response.json({ error: 'Enter a search between 1 and 200 characters.' }, { status: 400 });
  }
  const terms = query.split(/\s+/);
  const matches = [...demoBuilding.spaces, ...demoBuilding.assets].filter(item => {
    const text = `${item.name} ${item.id} ${'room_type' in item ? item.room_type : item.type}`.toLowerCase().replaceAll('_', ' ');
    return terms.every(term => text.includes(term));
  });
  return Response.json({ buildingId: demoBuilding.building.id, matches });
}
