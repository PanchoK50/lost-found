import { getCatalogEntry } from '@/lib/buildings/catalog';
import { applyEdits, loadEdits } from '@/lib/buildings/edits';
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
  const entry = await getCatalogEntry(body.buildingId);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  // Reports from people in the building close doors, stairs and lifts for routing (docs/MULTIPLAYER.md §8).
  const playerId = typeof body.playerId === 'string' ? body.playerId : undefined;
  const world = await worldStore.get(entry.building, Date.now());
  const worldClosed = activeClosures(world, playerId);
  // People, reports and skills first (docs/MULTIPLAYER.md §7); everything else is a question about the building.
  // Every account can be addressed with @, also people who are not sharing their location right now.
  const input = { world: { ...viewFor(world, playerId), players: world.players.filter(p => !p.demo || p.id === playerId) }, playerId, skillId: typeof body.skillId === 'string' ? body.skillId : undefined, history: Array.isArray(body.history) ? body.history : undefined, closed: worldClosed };
  // With something selected on the map ("this door", "this room") the message is about that thing: the building
  // agent answers it. The people/reports layer only takes messages without a selection.
  const hasSelection = Boolean(body.selection && typeof body.selection.id === 'string');
  const fromWorld = hasSelection ? null : resolveWorld(entry.building, message, input);
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
    if (supabaseConfigured && !user) {
      return Response.json({ error: 'Sign in (pick a name under “Who are you?”) to ask the building agent.' }, { status: 401 });
    }
    const spent = await spentToday();
    if (spent >= DAILY_LIMIT_USD) {
      // Over the day's budget: answer with the free offline resolver rather than spend more credits.
      const demo = resolveDemo(entry.building, message, { closed: worldClosed });
      return Response.json(await withRoutePoints(entry.building, { ...demo, source: 'demo', reply: `${demo.reply}\n\n(The AI agent reached today's budget, so this is the simple offline answer.)` }));
    }
    const location = typeof body.location === 'string' && entry.building.spaces.some(s => s.id === body.location) ? body.location : undefined;
    const selection = body.selection && ['asset', 'opening', 'space'].includes(body.selection.kind) && typeof body.selection.id === 'string'
      ? { kind: body.selection.kind, id: body.selection.id, view_right: Array.isArray(body.selection.view_right) && body.selection.view_right.length === 2 ? body.selection.view_right.map(Number) as [number, number] : undefined }
      : undefined;
    const spaceIds = new Set(entry.building.spaces.map(s => s.id));
    const incident = body.incident && ['fire', 'water', 'electrical'].includes(body.incident.hazard) && spaceIds.has(body.incident.origin)
      ? { hazard: body.incident.hazard, origin: body.incident.origin, t: Number(body.incident.t) || 0, affected: (Array.isArray(body.incident.affected) ? body.incident.affected : []).filter(id => typeof id === 'string' && spaceIds.has(id)).slice(0, 60) }
      : undefined;
    const agent = await askAgent(entry.id, message, body.sessionId, worldClosed, input.history, location, selection, incident);
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
  // Draw routes on the plan as it is now (doors added by conversation), including this turn's edits.
  const current = applyEdits(entry.building, [...(await loadEdits(entry.id)), ...((response.edits ?? []) as Parameters<typeof applyEdits>[1])]).building;
  const finished = await withRoutePoints(current, response);
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

/** Dollars the agent may spend per day (all users together); above it the offline resolver answers. */
const DAILY_LIMIT_USD = Number(process.env.AGENT_DAILY_LIMIT_USD ?? 20);
const SPEND_CACHE_MS = 60_000;
const spend = globalThis as { __lfSpend?: { at: number; dollars: number } };

/** Today's agent spend from the saved chat history (UTC day), cached for a minute. */
async function spentToday(): Promise<number> {
  const db = supabaseAdmin();
  if (!db) return 0;
  if (spend.__lfSpend && Date.now() - spend.__lfSpend.at < SPEND_CACHE_MS) return spend.__lfSpend.dollars;
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { data } = await db.from('messages').select('cost').gte('created_at', since.toISOString()).not('cost', 'is', null).limit(10_000);
  const dollars = (data ?? []).reduce((sum, row) => sum + Number(row.cost ?? 0), 0);
  spend.__lfSpend = { at: Date.now(), dollars };
  return dollars;
}

type AgentResult =
  | { ok: true; response: ChatResponse }
  | { ok: false; unreachable: true }
  | { ok: false; unreachable: false; error: string };

async function askAgent(buildingId: string, message: string, sessionId: string | undefined, closed: string[], history?: ChatRequest['history'], location?: string, selection?: ChatRequest['selection'], incident?: ChatRequest['incident']): Promise<AgentResult> {
  let agent: Response;
  try {
    agent = await fetch(`${AGENT_URL}/ui/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildingId, message, sessionId, closed, history: history ?? [], location, selection, incident }),
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
 * turn-by-turn steps with the walking model. Cross-building routes name spaces of several buildings: each
 * leg is measured against the building its spaces belong to (the outdoor leg already brings points).
 */
const otherBuildings = new Map<string, Building | null>();

async function withRoutePoints(building: Building, response: ChatResponse): Promise<ChatResponse> {
  const routes = response.scene.routes;
  if (!routes?.some(r => r.spacePath && (!r.points || !r.steps))) return response;
  const filled = await Promise.all(routes.map(async r => {
    if (!r.spacePath || (r.points && r.steps)) return r;
    const legBuilding = await buildingFor(r.spacePath, building);
    if (!legBuilding) return r;
    const graph = new WalkGraph(legBuilding, { closed: response.scene.closed });
    const leg = graph.measure(r.spacePath);
    return { ...r, points: r.points ?? leg?.points ?? [], steps: r.steps ?? (leg ? turnByTurn(legBuilding, leg.segments, r.spacePath) : []) };
  }));
  return { ...response, scene: { ...response.scene, routes: filled } };
}

/** The building a space list belongs to: space ids start with the building id ('osm-…-F0-S001'). */
async function buildingFor(spacePath: string[], primary: Building): Promise<Building | null> {
  const first = spacePath[0] ?? '';
  const prefix = first.slice(0, first.indexOf('-F'));
  if (!prefix || prefix === primary.building.id) return primary;
  if (!otherBuildings.has(prefix)) {
    const entry = await getCatalogEntry(prefix).catch(() => undefined);
    otherBuildings.set(prefix, entry?.building ?? null);
  }
  return otherBuildings.get(prefix) ?? null;
}
