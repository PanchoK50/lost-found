import { getCatalogEntry } from '@/lib/buildings/catalog';
import type { Building } from '@/lib/buildings/types';
import { WalkGraph } from '@/lib/buildings/walk';
import { turnByTurn } from '@/lib/buildings/turns';
import type { ChatRequest, ChatResponse } from '@/lib/chat/contract';
import { resolveDemo } from '@/lib/chat/demo-resolver';
import { markBroken, offerAskCrowd, resolveWorld } from '@/lib/world/chat';
import { activeClosures, viewFor } from '@/lib/world/rules';
import { worldStore } from '@/lib/world/store';
import { supabaseAdmin, supabaseConfigured, userFrom } from '@/lib/supabase/server';

/** The Python agent (lostfound.api.server). Start it with `uv run uvicorn lostfound.api.server:app --port 8000`. */
const AGENT_URL = process.env.LOSTFOUND_API_URL ?? 'http://127.0.0.1:8000';
const AGENT_TIMEOUT_MS = 120_000;

// Chat boundary for the viewer: the world layer answers messages about people, reports and skills; the Python
// agent answers questions about the building; the demo resolver steps in only when the agent is not running, so
// the UI can still be worked on without the backend.
export async function POST(request: Request) {
  let body: Partial<ChatRequest>;
  try { body = await request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 1000) return Response.json({ error: 'Ask something between 1 and 1000 characters.' }, { status: 400 });
  const entry = getCatalogEntry(body.buildingId);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  // Reports from people in the building close doors, stairs and lifts for routing (docs/MULTIPLAYER.md §8).
  const playerId = typeof body.playerId === 'string' ? body.playerId : undefined;
  const world = await worldStore.get(entry.building, Date.now());
  const worldClosed = activeClosures(world, playerId);
  // People, reports and skills first (docs/MULTIPLAYER.md §7); everything else is a question about the building.
  // Every account can be addressed with @, also people who are not sharing their location right now.
  const input = { world: { ...viewFor(world, playerId), players: world.players.filter(p => !p.demo || p.id === playerId) }, playerId, skillId: typeof body.skillId === 'string' ? body.skillId : undefined, history: Array.isArray(body.history) ? body.history : undefined, closed: worldClosed };
  const fromWorld = resolveWorld(entry.building, message, input);
  if (fromWorld?.usedSkill && playerId) await worldStore.apply(entry.building, { type: 'skill.use', buildingId: entry.building.building.id, skillId: fromWorld.usedSkill, playerId }, Date.now()).catch(() => undefined);

  let resolved: ChatResponse;
  const user = await userFrom(request);
  const directAsk = fromWorld?.response.proposals?.length === 1 ? fromWorld.response.proposals[0] : undefined;
  if (fromWorld && directAsk?.action.type === 'ping.send' && (directAsk.action.ping.kind === 'ask' || directAsk.action.ping.kind === 'share_location') && message.includes('@')
      && playerId && (!supabaseConfigured || user?.id === playerId)) {
    // "@Rabea where is the key?" is an explicit message: send it now instead of asking for a confirm tap.
    try {
      await worldStore.apply(entry.building, directAsk.action, Date.now());
      const to = directAsk.label.replace(/^Ask\s+/i, '');
      const locationRequest = directAsk.action.ping.kind === 'share_location';
      resolved = locationRequest
        ? { ...fromWorld.response, proposals: undefined, source: 'world', reply: `${to} isn't sharing a location right now, so I asked them to share it. You'll see them on the map once they do.`, answer: { title: `Location request to ${to}`, value: 'Sent' } }
        : { ...fromWorld.response, proposals: undefined, source: 'world', reply: `Sent to ${to}. The answer shows up under Messages (✉).`, answer: { title: `Message to ${to}`, value: 'Sent' } };
    } catch (error) {
      resolved = { ...fromWorld.response, source: 'world', reply: `I couldn't send it: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  } else if (fromWorld) {
    resolved = { ...fromWorld.response, source: 'world' };
  } else {
    // Building questions go to the Python agent, which routes around the same reported closures.
    const location = typeof body.location === 'string' && entry.building.spaces.some(s => s.id === body.location) ? body.location : undefined;
    const agent = await askAgent(entry.id, message, body.sessionId, worldClosed, input.history, location);
    if (agent.ok) {
      resolved = markBroken(entry.building, agent.response, input.world);
    } else if (agent.unreachable) {
      const demo = resolveDemo(entry.building, message, { closed: worldClosed });
      resolved = { ...markBroken(entry.building, offerAskCrowd(entry.building, message, input, demo), input.world), source: 'demo' };
    } else {
      return Response.json({ error: agent.error }, { status: 502 });
    }
  }
  const response = resolved.scene.routes?.length && worldClosed.length
    ? { ...resolved, scene: { ...resolved.scene, closed: [...new Set([...(resolved.scene.closed ?? []), ...worldClosed])] } }
    : resolved;
  const finished = withRoutePoints(entry.building, response);
  const conversationId = user ? await saveTurn(user.id, entry.id, body.conversationId, message, finished).catch(() => undefined) : undefined;
  return Response.json({ ...finished, conversationId });
}

/** Chat history (Supabase): the user's message, the full answer (to replay its scene) and any building edits. */
async function saveTurn(userId: string, buildingId: string, conversationId: string | undefined, message: string, response: ChatResponse): Promise<string | undefined> {
  const db = supabaseAdmin();
  if (!db) return undefined;
  let id = conversationId;
  if (id) {
    const { data } = await db.from('conversations').select('id').eq('id', id).eq('user_id', userId).maybeSingle();
    id = data?.id;
  }
  if (!id) {
    const { data, error } = await db.from('conversations')
      .insert({ user_id: userId, building_id: buildingId, agent_session_id: response.sessionId ?? null, title: message.slice(0, 80) })
      .select('id').single();
    if (error) throw error;
    id = data.id as string;
  } else {
    await db.from('conversations').update({ updated_at: new Date().toISOString(), agent_session_id: response.sessionId ?? null }).eq('id', id);
  }
  await db.from('messages').insert([
    { conversation_id: id, role: 'user', content: message },
    { conversation_id: id, role: 'assistant', content: response.reply, response, source: response.source ?? null, cost: response.cost ?? null },
  ]);
  if (response.edits?.length) {
    await db.from('building_edits').insert(response.edits.map(action => ({ building_id: buildingId, user_id: userId, conversation_id: id, action })));
  }
  return id;
}

type AgentResult =
  | { ok: true; response: ChatResponse }
  | { ok: false; unreachable: true }
  | { ok: false; unreachable: false; error: string };

async function askAgent(buildingId: string, message: string, sessionId: string | undefined, closed: string[], history?: ChatRequest['history'], location?: string): Promise<AgentResult> {
  let agent: Response;
  try {
    agent = await fetch(`${AGENT_URL}/ui/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildingId, message, sessionId, closed, history: history ?? [], location }),
      cache: 'no-store',
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, unreachable: true };
  }
  if (!agent.ok) {
    const detail = await agent.json().catch(() => ({}));
    return { ok: false, unreachable: false, error: typeof detail.detail === 'string' ? detail.detail : 'The building agent could not answer.' };
  }
  return { ok: true, response: (await agent.json()) as ChatResponse };
}

/**
 * Backends may return routes as a space list only (what the route check scores). Fill in the drawn path and
 * turn-by-turn steps with the walking model.
 */
function withRoutePoints(building: Building, response: ChatResponse): ChatResponse {
  const routes = response.scene.routes;
  if (!routes?.some(r => r.spacePath && (!r.points || !r.steps))) return response;
  const graph = new WalkGraph(building, { closed: response.scene.closed });
  return {
    ...response,
    scene: {
      ...response.scene,
      routes: routes.map(r => {
        if (!r.spacePath || (r.points && r.steps)) return r;
        const leg = graph.measure(r.spacePath);
        return { ...r, points: r.points ?? leg?.points ?? [], steps: r.steps ?? (leg ? turnByTurn(building, leg.segments, r.spacePath) : []) };
      }),
    },
  };
}
