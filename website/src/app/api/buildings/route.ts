import { listBuildings } from '@/lib/buildings/catalog';

export async function GET() {
  return Response.json({ buildings: await listBuildings() });
}
