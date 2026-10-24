import { getCatalogEntry } from '@/lib/buildings/catalog';
import type { Building } from '@/lib/buildings/types';
import { WalkGraph } from '@/lib/buildings/walk';
import type { ChatRequest, ChatResponse } from '@/lib/chat/contract';
import { resolveDemo } from '@/lib/chat/demo-resolver';

// Chat boundary for the viewer. Swap `resolveDemo` for the real agent; keep the ChatResponse shape.
export async function POST(request: Request) {
  let body: Partial<ChatRequest>;
  try { body = await request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 1000) return Response.json({ error: 'Ask something between 1 and 1000 characters.' }, { status: 400 });
  const entry = getCatalogEntry(body.buildingId);
  if (!entry) return Response.json({ error: 'Unknown building.' }, { status: 404 });
  const response: ChatResponse = resolveDemo(entry.building, message);
  return Response.json(withRoutePoints(entry.building, response));
}

/** Backends may return routes as a space list only (what the route check scores); draw them with the walking model. */
function withRoutePoints(building: Building, response: ChatResponse): ChatResponse {
  const routes = response.scene.routes;
  if (!routes?.some(r => r.spacePath && !r.points)) return response;
  const graph = new WalkGraph(building, { closed: response.scene.closed });
  return {
    ...response,
    scene: { ...response.scene, routes: routes.map(r => (r.points || !r.spacePath ? r : { ...r, points: graph.measure(r.spacePath)?.points ?? [] })) },
  };
}
