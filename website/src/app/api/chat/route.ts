import { getCatalogEntry } from '@/lib/buildings/catalog';
import type { Building } from '@/lib/buildings/types';
import { WalkGraph } from '@/lib/buildings/walk';
import { turnByTurn } from '@/lib/buildings/turns';
import type { ChatRequest, ChatResponse } from '@/lib/chat/contract';
import { resolveDemo } from '@/lib/chat/demo-resolver';

/** The Python agent (lostfound.api.server). Start it with `uv run uvicorn lostfound.api.server:app --port 8000`. */
const AGENT_URL = process.env.LOSTFOUND_API_URL ?? 'http://127.0.0.1:8000';
const AGENT_TIMEOUT_MS = 120_000;

// Chat boundary for the viewer: the Python agent answers; the demo resolver steps in only when the agent is
// not running, so the UI can still be worked on without the backend.
export async function POST(request: Request) {
  let body: Partial<ChatRequest>;
  try { body = await request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 1000) return Response.json({ error: 'Ask something between 1 and 1000 characters.' }, { status: 400 });
  const entry = getCatalogEntry(body.buildingId);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });

  let agent: Response;
  try {
    agent = await fetch(`${AGENT_URL}/ui/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildingId: entry.id, message, sessionId: body.sessionId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
  } catch {
    const demo: ChatResponse = { ...resolveDemo(entry.building, message), source: 'demo' };
    return Response.json(withRoutePoints(entry.building, demo));
  }
  if (!agent.ok) {
    const detail = await agent.json().catch(() => ({}));
    return Response.json({ error: typeof detail.detail === 'string' ? detail.detail : 'The building agent could not answer.' }, { status: 502 });
  }
  const response = (await agent.json()) as ChatResponse;
  return Response.json(withRoutePoints(entry.building, response));
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
