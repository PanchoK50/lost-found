import { listBuildings } from '@/lib/buildings/catalog';

// GET /api/buildings → every building the app can show (dataset + uploaded plans), for the building picker.
export async function GET() {
  return Response.json(await listBuildings());
}
