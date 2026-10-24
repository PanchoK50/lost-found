import { getCatalogEntry } from '@/lib/buildings/catalog';
import type { Building } from '@/lib/buildings/types';
import { WalkGraph } from '@/lib/buildings/walk';
import { turnByTurn } from '@/lib/buildings/turns';
import type { ChatRequest, ChatResponse } from '@/lib/chat/contract';
import { resolveDemo } from '@/lib/chat/demo-resolver';
import { markBroken, offerAskCrowd, resolveWorld } from '@/lib/world/chat';
import { activeClosures, viewFor } from '@/lib/world/rules';
import { worldStore } from '@/lib/world/store';

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
  const input = { world: viewFor(world, playerId), playerId, skillId: typeof body.skillId === 'string' ? body.skillId : undefined, history: Array.isArray(body.history) ? body.history : undefined, closed: worldClosed };
  const fromWorld = resolveWorld(entry.building, message, input);
  if (fromWorld?.usedSkill && playerId) await worldStore.apply(entry.building, { type: 'skill.use', buildingId: entry.building.building.id, skillId: fromWorld.usedSkill, playerId }, Date.now()).catch(() => undefined);

  let resolved: ChatResponse;
  if (fromWorld) {
    resolved = { ...fromWorld.response, source: 'world' };
  } else {
    // Building questions go to the Python agent, which routes around the same reported closures.
    const agent = await askAgent(entry.id, message, body.sessionId, worldClosed);
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
  return Response.json(withRoutePoints(entry.building, response));
}

type AgentResult =
  | { ok: true; response: ChatResponse }
  | { ok: false; unreachable: true }
  | { ok: false; unreachable: false; error: string };

async function askAgent(buildingId: string, message: string, sessionId: string | undefined, closed: string[]): Promise<AgentResult> {
  let agent: Response;
  try {
    agent = await fetch(`${AGENT_URL}/ui/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildingId, message, sessionId, closed }),
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
