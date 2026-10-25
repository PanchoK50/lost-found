import { getCatalogEntry } from '@/lib/buildings/catalog';
import { pointInPolygon } from '@/lib/buildings/geometry';
import { actorFrom } from '@/lib/guess/actor';
import { DuelError } from '@/lib/guess/duel';
import { spotStore } from '@/lib/guess/store';

/** Biggest accepted photo after the browser has resized it. */
const MAX_BYTES = 3 * 1024 * 1024;

// GET /api/guess/spots?buildingId=… → { spots: PhotoSpot[] }: everything the community shared here.
export async function GET(request: Request) {
  const entry = await getCatalogEntry(new URL(request.url).searchParams.get('buildingId') ?? undefined);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  return Response.json({ spots: await spotStore.list(entry.building) });
}

// POST /api/guess/spots, body { buildingId, pick: { floorId, spaceId, position }, caption?, image: data URL, player } → { spot }.
export async function POST(request: Request) {
  let body: { buildingId?: string; pick?: { floorId?: string; spaceId?: string; position?: [number, number] }; caption?: string; image?: string; player?: { id?: string; name?: string } };
  try { body = await request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const actor = await actorFrom(request, body.player);
  if ('error' in actor) return Response.json({ error: actor.error }, { status: actor.status });
  const entry = await getCatalogEntry(body.buildingId);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  const space = entry.building.spaces.find(s => s.id === body.pick?.spaceId && s.floor_id === body.pick?.floorId);
  const position = body.pick?.position;
  if (!space || !Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) return Response.json({ error: 'Tag the spot on the model first.' }, { status: 400 });
  if (!pointInPolygon(position, space.polygon)) return Response.json({ error: 'That spot is outside the room you tapped.' }, { status: 400 });
  const image = body.image?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!image) return Response.json({ error: 'Attach a JPEG, PNG or WebP photo.' }, { status: 400 });
  const data = Buffer.from(image[2], 'base64');
  if (data.length > MAX_BYTES) return Response.json({ error: 'That photo is too big (max 3 MB).' }, { status: 413 });
  const spot = await spotStore.add({ buildingId: entry.id, pick: { floorId: space.floor_id, spaceId: space.id, position }, caption: body.caption?.trim().slice(0, 80) || undefined, author: actor, image: { type: image[1], data } });
  return Response.json({ spot });
}

// DELETE /api/guess/spots?buildingId=…&id=…&playerId=… → { ok: true }: authors can take their photos down.
export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const actor = await actorFrom(request, { id: params.get('playerId') ?? undefined });
  if ('error' in actor) return Response.json({ error: actor.error }, { status: actor.status });
  try {
    await spotStore.remove(params.get('buildingId') ?? '', params.get('id') ?? '', actor.id);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof DuelError) return Response.json({ error: error.message }, { status: 403 });
    throw error;
  }
}
