import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildingDir } from '@/lib/buildings/catalog';

// Original plan image for one floor: /api/buildings/<id>/plan?level=0
export async function GET(request: Request, ctx: RouteContext<'/api/buildings/[id]/plan'>) {
  const dir = await buildingDir((await ctx.params).id);
  const level = Number(new URL(request.url).searchParams.get('level'));
  if (!dir || !Number.isInteger(level)) return new Response('Not found', { status: 404 });
  try {
    const image = await readFile(path.join(dir, `floor_${level}.png`));
    return new Response(image, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
