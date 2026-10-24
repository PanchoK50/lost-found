import { getCatalogEntry } from '@/lib/buildings/catalog';
import type { Building } from '@/lib/buildings/types';
import { WalkGraph } from '@/lib/buildings/walk';
import { turnByTurn } from '@/lib/buildings/turns';
import type { ChatRequest, ChatResponse } from '@/lib/chat/contract';
import { resolveDemo } from '@/lib/chat/demo-resolver';
import { offerAskCrowd, resolveWorld } from '@/lib/world/chat';
import { activeClosures, viewFor } from '@/lib/world/rules';
import { worldStore } from '@/lib/world/store';

// Chat boundary for the viewer. Swap `resolveDemo` for the real agent; keep the ChatResponse shape.
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
  const resolved: ChatResponse = fromWorld?.response ?? offerAskCrowd(entry.building, message, input, resolveDemo(entry.building, message, { closed: worldClosed }));
  const response = resolved.scene.routes?.length && worldClosed.length
    ? { ...resolved, scene: { ...resolved.scene, closed: [...new Set([...(resolved.scene.closed ?? []), ...worldClosed])] } }
    : resolved;
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
