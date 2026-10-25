import { getCatalogEntry } from '@/lib/buildings/catalog';
import { actorFrom } from '@/lib/guess/actor';
import { createDuel, DuelError, duelView, type DuelAction } from '@/lib/guess/duel';
import { duelId, duelStore, spotStore } from '@/lib/guess/store';
import { pickSpots } from '@/lib/guess/spots';

/** Photos drawn for one duel; it cycles through them if it lasts longer. */
const DUEL_PHOTOS = 30;

// GET /api/guess/duels?id=…&playerId=… → { duel, now }: the duel as this player may see it, plus server time for the timers.
// GET /api/guess/duels?buildingId=… → { open: [...] }: lobbies waiting for players.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const now = Date.now();
  const buildingId = params.get('buildingId');
  if (buildingId) {
    const open = await duelStore.open(buildingId, now);
    return Response.json({ open: open.map(d => ({ id: d.id, hostId: d.hostId, players: d.players.map(p => ({ id: p.id, name: p.name, bot: p.bot })), createdAt: d.createdAt })) });
  }
  const duel = await duelStore.get(params.get('id') ?? '', now);
  if (!duel) return Response.json({ error: 'This duel does not exist (any more).' }, { status: 404 });
  return Response.json({ duel: duelView(duel, params.get('playerId') ?? undefined), now });
}

type Body =
  | { type: 'create'; buildingId: string; player: { id: string; name: string } }
  | { type: 'join'; id: string; player: { id: string; name: string } }
  | { type: 'bot' | 'leave' | 'start'; id: string; player: { id: string; name: string } }
  | { type: 'guess'; id: string; player: { id: string; name: string }; pick: { floorId: string; spaceId: string; position: [number, number] } };

// POST /api/guess/duels, body: { type: create | join | bot | leave | start | guess, … } → { duel, now }.
export async function POST(request: Request) {
  let body: Body;
  try { body = await request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const actor = await actorFrom(request, body?.player);
  if ('error' in actor) return Response.json({ error: actor.error }, { status: actor.status });
  const now = Date.now();
  try {
    if (body.type === 'create') {
      const entry = await getCatalogEntry(body.buildingId);
      if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
      const duel = createDuel(duelId(), entry.id, actor, now);
      await duelStore.create(duel);
      return Response.json({ duel: duelView(duel, actor.id), now });
    }
    let action: DuelAction;
    if (body.type === 'join') action = { type: 'join', player: actor };
    else if (body.type === 'guess') action = { type: 'guess', playerId: actor.id, pick: body.pick };
    else if (body.type === 'start') {
      const current = await duelStore.get(body.id, now);
      const entry = current && await getCatalogEntry(current.buildingId);
      if (!entry) return Response.json({ error: 'This duel does not exist (any more).' }, { status: 404 });
      action = { type: 'start', playerId: actor.id, spots: pickSpots(await spotStore.list(entry.building), `${body.id}|${now}`, DUEL_PHOTOS) };
    } else if (body.type === 'bot' || body.type === 'leave') action = { type: body.type, playerId: actor.id };
    else return Response.json({ error: 'Unknown action.' }, { status: 400 });
    const duel = await duelStore.apply(body.id, action, now);
    return Response.json({ duel: duelView(duel, actor.id), now });
  } catch (error) {
    if (error instanceof DuelError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
