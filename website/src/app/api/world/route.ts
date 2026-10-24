import { getCatalogEntry } from '@/lib/buildings/catalog';
import { viewFor, WorldError } from '@/lib/world/rules';
import { worldStore } from '@/lib/world/store';
import type { WorldAction } from '@/lib/world/types';

// GET /api/world?buildingId=…&playerId=…&since=<version> → 200 WorldState, or 204 if nothing changed since `since`.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const entry = getCatalogEntry(params.get('buildingId') ?? undefined);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  const world = await worldStore.get(entry.building, Date.now());
  if (Number(params.get('since')) === world.version) return new Response(null, { status: 204 });
  return Response.json(viewFor(world, params.get('playerId') ?? undefined));
}

// POST /api/world, body: WorldAction → 200 { ok: true, state } or 400 { error }.
export async function POST(request: Request) {
  let action: WorldAction;
  try { action = await request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const entry = getCatalogEntry(action?.buildingId);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  try {
    const world = await worldStore.apply(entry.building, action, Date.now());
    return Response.json({ ok: true, state: viewFor(world, actorOf(action)) });
  } catch (error) {
    if (error instanceof WorldError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

/** The player an action comes from, so the returned state is their view. */
function actorOf(action: WorldAction): string | undefined {
  switch (action.type) {
    case 'player.upsert': return action.player?.id;
    case 'presence.set': return action.presence?.playerId;
    case 'pin.create': return action.pin?.authorId;
    case 'ping.send': return action.ping?.fromId;
    case 'skill.create': return action.skill?.authorId;
    default: return 'playerId' in action ? action.playerId : undefined;
  }
}
