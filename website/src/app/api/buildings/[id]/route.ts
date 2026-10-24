import { loadBuilding } from '@/lib/buildings/catalog';

export async function GET(_request: Request, ctx: RouteContext<'/api/buildings/[id]'>) {
  const building = await loadBuilding((await ctx.params).id);
  if (!building) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  return Response.json(building, { headers: { 'Cache-Control': 'private, max-age=3600' } });
}
