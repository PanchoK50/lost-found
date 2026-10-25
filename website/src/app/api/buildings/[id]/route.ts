import { getCatalogEntry } from '@/lib/buildings/catalog';

/** GET /api/buildings/<id>: one building's JSON — the campus scene lazily loads the other member buildings. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const entry = await getCatalogEntry((await params).id);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  return Response.json(entry.building, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
