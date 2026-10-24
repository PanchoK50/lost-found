import { getCatalogEntry } from '@/lib/buildings/catalog';
import { viewFor, WorldError } from '@/lib/world/rules';
import { worldStore } from '@/lib/world/store';
import { supabaseAdmin, supabaseConfigured, userFrom } from '@/lib/supabase/server';
import type { WorldAction } from '@/lib/world/types';

// GET /api/world?buildingId=…&playerId=…&since=<version> → 200 WorldState, or 204 if nothing changed since `since`.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const entry = getCatalogEntry(params.get('buildingId') ?? undefined);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  const world = await worldStore.get(entry.building, Date.now());
  if (Number(params.get('since')) === world.version) return new Response(null, { status: 204 });
  const playerId = params.get('playerId') ?? undefined;
  // Accounts are known by name to everyone (for @ and pings); where they are stays private to their audience.
  return Response.json({ ...viewFor(world, playerId), players: world.players.filter(p => !p.demo || p.id === playerId) });
}

// POST /api/world, body: WorldAction → 200 { ok: true, state } or 400 { error }.
// With Supabase configured, only signed-in users act, and only as themselves; their name, role and groups come
// from their profile, not from the browser.
export async function POST(request: Request) {
  let action: WorldAction;
  let accessToken: unknown;
  try {
    const { accessToken: token, ...rest } = await request.json();
    accessToken = token;
    action = rest as WorldAction;
  } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const entry = getCatalogEntry(action?.buildingId);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  if (supabaseConfigured) {
    const headers = typeof accessToken === 'string' ? new Headers({ authorization: `Bearer ${accessToken}` }) : request.headers;
    const user = await userFrom(new Request(request.url, { headers }));
    if (!user) return Response.json({ error: 'Sign in to take part.' }, { status: 401 });
    if (actorOf(action) !== user.id) return Response.json({ error: 'You can only act as yourself.' }, { status: 403 });
    if (action.type === 'player.upsert') {
      const { data: profile } = await supabaseAdmin()!.from('profiles').select('display_name, role, groups').eq('id', user.id).single();
      if (profile) action = { ...action, player: { ...action.player, name: profile.display_name, role: profile.role, groups: profile.groups } };
    }
  }
  try {
    const world = await worldStore.apply(entry.building, action, Date.now());
    const actor = actorOf(action);
    return Response.json({ ok: true, state: { ...viewFor(world, actor), players: world.players.filter(p => !p.demo || p.id === actor) } });
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
