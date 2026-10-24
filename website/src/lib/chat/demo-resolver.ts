import type { Asset, Building, Floor, Space } from '@/lib/buildings/types';
import { bounds, pointInPolygon, polygonArea, polygonCentroid } from '@/lib/buildings/geometry';
import type { ChatResponse, FloorPoint } from './contract';

/**
 * PLACEHOLDER so the UI can be demoed end to end. Keyword matching plus simple geometry;
 * it is not benchmark-accurate. Replace `resolveDemo` with a call to the real agent,
 * which should return the same `ChatResponse` shape.
 */
export function resolveDemo(building: Building, message: string): ChatResponse {
  const ctx = new Context(building, message);
  const text = ctx.text;
  const rooms = ctx.mentionedSpaces();

  if (rooms.length >= 2 && /\b(get|route|way|go|walk|directions?|path)\b/.test(text)) return route(ctx, rooms);
  if (rooms.length >= 1 && /\b(below|beneath|under(neath)?|above|over)\b/.test(text)) return stacked(ctx, rooms[0]);
  if (rooms.length >= 2 && /\b(distance|straight[- ]line|far apart)\b/.test(text)) return straightLine(ctx, rooms[0], rooms[1]);
  if (/\b(largest|biggest|smallest)\b/.test(text)) return largestRoom(ctx);
  if (/\b(total|sum|added together|combined)\b/.test(text) && /\barea\b/.test(text)) return totalArea(ctx);
  const assetType = ctx.mentionedAssetType();
  if (assetType && /\bhow many\b/.test(text)) return countAssets(ctx, assetType);
  if (assetType) return locateAssets(ctx, assetType);
  if (rooms.length) return showSpace(ctx, rooms[0]);
  const floor = ctx.mentionedFloor();
  if (floor) return { kind: 'show', reply: `Here is ${floor.name}.`, answer: { title: floor.name, value: `${ctx.spacesOn(floor).length} spaces` }, scene: { focus: { mode: 'floor', floorId: floor.id } } };
  return {
    kind: 'unknown',
    reply: 'I can find rooms and equipment, compare room sizes, measure distances and plan routes. Try naming a room, a floor or a piece of equipment.',
    scene: { focus: { mode: 'building' } },
  };
}

class Context {
  readonly text: string;
  readonly floors: Map<string, Floor>;
  constructor(readonly building: Building, message: string) {
    this.text = message.toLowerCase();
    this.floors = new Map(building.floors.map(floor => [floor.id, floor]));
  }
  floorOf(space: Space) { return this.floors.get(space.floor_id)!; }
  spacesOn(floor: Floor) { return this.building.spaces.filter(space => space.floor_id === floor.id); }
  area(space: Space) { return polygonArea(space.polygon); }
  centre(space: Space): FloorPoint { return { floorId: space.floor_id, position: polygonCentroid(space.polygon) }; }

  mentionedFloor(): Floor | undefined {
    const t = this.text;
    let level: number | undefined;
    if (/\bground floor\b/.test(t)) level = 0;
    const basement = t.match(/\bbasement\s*(\d+)?/);
    if (basement) level = -Number(basement[1] ?? 1);
    const numbered = t.match(/\b(?:floor|level)\s*(-?\d+)\b/) ?? t.match(/\b(-?\d+)(?:st|nd|rd|th)?\s+floor\b/);
    if (numbered) level = Number(numbered[1]);
    return level === undefined ? undefined : this.building.floors.find(floor => floor.level === level);
  }

  /** Spaces named by ref or full name, in the order they appear in the message. */
  mentionedSpaces(): Space[] {
    const hits: { index: number; length: number; space: Space }[] = [];
    for (const space of this.building.spaces) {
      for (const needle of [space.name, space.ref]) {
        if (!needle || needle.length < 2) continue;
        const match = new RegExp(`(?<![\\w.-])${escape(needle.toLowerCase())}(?![\\w-]|\\.\\d)`).exec(this.text);
        if (match) { hits.push({ index: match.index, length: needle.length, space }); break; }
      }
    }
    // Drop hits nested inside a longer hit (e.g. ref "0.23" inside "Office 0.23").
    hits.sort((a, b) => a.index - b.index || b.length - a.length);
    const result: Space[] = [];
    let end = -1;
    for (const hit of hits) {
      if (hit.index < end || result.includes(hit.space)) continue;
      result.push(hit.space); end = hit.index + hit.length;
    }
    return result;
  }

  mentionedRoomType(): string | undefined {
    const types = [...new Set(this.building.spaces.map(space => space.room_type))];
    return types
      .map(type => ({ type, label: type.replaceAll('_', ' ') }))
      .sort((a, b) => b.label.length - a.label.length)
      .find(({ label }) => new RegExp(`\\b${escape(label)}(s|es)?\\b`).test(this.text))?.type;
  }

  mentionedAssetType(): string | undefined {
    const types = [...new Set(this.building.assets.map(asset => asset.type))];
    return types
      .map(type => ({ type, label: type.replaceAll('_', ' ') }))
      .sort((a, b) => b.label.length - a.label.length)
      .find(({ label }) => new RegExp(`\\b${escape(label)}(s|es)?\\b`).test(this.text))?.type;
  }
}

function largestRoom(ctx: Context): ChatResponse {
  const floor = ctx.mentionedFloor();
  const roomType = ctx.mentionedRoomType();
  const smallest = /\bsmallest\b/.test(ctx.text);
  const candidates = ctx.building.spaces
    .filter(space => (!floor || space.floor_id === floor.id) && (roomType ? space.room_type === roomType : space.type === 'room' || space.type === 'hall'))
    .sort((a, b) => (ctx.area(b) - ctx.area(a)) * (smallest ? -1 : 1));
  const label = roomType ? roomType.replaceAll('_', ' ') : 'room';
  const where = floor ? ` on ${floor.name}` : '';
  if (!candidates.length) return notFound(`I couldn't find any ${label}${where}.`, floor);
  const winner = candidates[0];
  const area = `${ctx.area(winner).toFixed(2)} m²`;
  return {
    kind: 'largest_room',
    reply: `The ${smallest ? 'smallest' : 'largest'} ${label}${where} is ${winner.name}, at ${area}. I compared ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}.`,
    answer: { title: winner.name, value: area, detail: `${smallest ? 'Smallest' : 'Largest'} of ${candidates.length} · ${ctx.floorOf(winner).name}` },
    scene: {
      focus: { mode: 'floor', floorId: winner.floor_id },
      highlights: [
        { spaceId: winner.id, tone: 'primary', label: `${winner.name} · ${area}` },
        ...candidates.slice(1).filter(space => space.floor_id === winner.floor_id).map(space => ({ spaceId: space.id, tone: 'secondary' as const })),
      ],
    },
  };
}

function totalArea(ctx: Context): ChatResponse {
  const floor = ctx.mentionedFloor();
  const roomType = ctx.mentionedRoomType();
  const spaces = ctx.building.spaces.filter(space => (!floor || space.floor_id === floor.id) && (!roomType || space.room_type === roomType));
  const label = roomType ? `${roomType.replaceAll('_', ' ')}s` : 'spaces';
  const where = floor ? ` on ${floor.name}` : '';
  if (!spaces.length) return notFound(`I couldn't find any ${label}${where}.`, floor);
  const total = spaces.reduce((sum, space) => sum + ctx.area(space), 0);
  const value = `${total.toFixed(2)} m²`;
  return {
    kind: 'floor_area_total',
    reply: `The ${spaces.length} ${label}${where} add up to ${value}.`,
    answer: { title: `${spaces.length} ${label}${where}`, value, detail: 'Summed floor area' },
    scene: {
      focus: floor ? { mode: 'floor', floorId: floor.id } : { mode: 'building' },
      highlights: spaces.map(space => ({ spaceId: space.id, tone: 'primary' as const })),
    },
  };
}

function locateAssets(ctx: Context, type: string): ChatResponse {
  const floor = ctx.mentionedFloor();
  const assets = ctx.building.assets.filter(asset => asset.type === type && (!floor || asset.floor_id === floor.id));
  const label = type.replaceAll('_', ' ');
  if (!assets.length) return notFound(`I couldn't find a ${label}${floor ? ` on ${floor.name}` : ''}.`, floor);
  const spaces = new Map(ctx.building.spaces.map(space => [space.id, space]));
  const first = assets[0];
  const firstSpace = spaces.get(first.space_id);
  const listed = assets.slice(0, 5).map(asset => `${asset.name} in ${spaces.get(asset.space_id)?.name ?? 'an unknown space'} (${ctx.floors.get(asset.floor_id)?.name})`);
  return {
    kind: 'locate',
    reply: assets.length === 1 ? `The ${label} is in ${firstSpace?.name}, ${ctx.floors.get(first.floor_id)?.name}.` : `I found ${assets.length} ${label}s. ${listed.join('; ')}${assets.length > 5 ? '; …' : '.'}`,
    answer: { title: firstSpace?.name ?? first.name, value: ctx.floors.get(first.floor_id)?.name, detail: assets.length > 1 ? `${assets.length} matches · showing the first floor` : first.name },
    scene: {
      focus: { mode: 'floor', floorId: first.floor_id },
      highlights: [...new Set(assets.filter(asset => asset.floor_id === first.floor_id).map(asset => asset.space_id))].map(spaceId => ({ spaceId, tone: 'primary' as const })),
      markers: assets.map(asset => assetMarker(asset)),
    },
  };
}

function countAssets(ctx: Context, type: string): ChatResponse {
  const floor = ctx.mentionedFloor();
  const assets = ctx.building.assets.filter(asset => asset.type === type && (!floor || asset.floor_id === floor.id));
  const label = type.replaceAll('_', ' ');
  const where = floor ? ` on ${floor.name}` : ' in the building';
  const floorIds = [...new Set(assets.map(asset => asset.floor_id))];
  return {
    kind: 'count',
    reply: `There ${assets.length === 1 ? 'is' : 'are'} ${assets.length} ${label}${assets.length === 1 ? '' : 's'}${where}.`,
    answer: { title: `${label[0].toUpperCase()}${label.slice(1)}s${where}`, value: String(assets.length) },
    scene: {
      focus: floor ? { mode: 'floor', floorId: floor.id } : floorIds.length === 1 ? { mode: 'floor', floorId: floorIds[0] } : { mode: 'building' },
      highlights: [...new Set(assets.map(asset => asset.space_id))].map(spaceId => ({ spaceId, tone: 'secondary' as const })),
      markers: assets.map(asset => assetMarker(asset)),
    },
  };
}

function showSpace(ctx: Context, space: Space): ChatResponse {
  const area = `${ctx.area(space).toFixed(2)} m²`;
  return {
    kind: 'show',
    reply: `${space.name} is on ${ctx.floorOf(space).name}. It measures ${area}.`,
    answer: { title: space.name, value: area, detail: ctx.floorOf(space).name },
    scene: { focus: { mode: 'floor', floorId: space.floor_id }, highlights: [{ spaceId: space.id, tone: 'primary', label: space.name }] },
  };
}

function stacked(ctx: Context, source: Space): ChatResponse {
  const below = !/\b(above|over)\b/.test(ctx.text);
  const sourceFloor = ctx.floorOf(source);
  const target = [...ctx.building.floors]
    .filter(floor => (below ? floor.level < sourceFloor.level : floor.level > sourceFloor.level))
    .sort((a, b) => (below ? b.level - a.level : a.level - b.level))[0];
  if (!target) return notFound(`There is no floor ${below ? 'below' : 'above'} ${sourceFloor.name}.`, sourceFloor);
  // Approximate overlap by sampling a grid inside the source polygon.
  const box = bounds(source.polygon);
  const samples: [number, number][] = [];
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) {
    const p: [number, number] = [box.minX + ((i + 0.5) / 24) * (box.maxX - box.minX), box.minY + ((j + 0.5) / 24) * (box.maxY - box.minY)];
    if (pointInPolygon(p, source.polygon)) samples.push(p);
  }
  const scored = ctx.spacesOn(target)
    .map(space => ({ space, hits: samples.filter(p => pointInPolygon(p, space.polygon)).length }))
    .filter(entry => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (!scored.length) return notFound(`Nothing on ${target.name} sits ${below ? 'under' : 'over'} ${source.name}.`, sourceFloor);
  const winner = scored[0].space;
  return {
    kind: 'room_stacked',
    reply: `Directly ${below ? 'below' : 'above'} ${source.name} is ${winner.name} on ${target.name}${scored.length > 1 ? `. It also partly overlaps ${scored.slice(1, 4).map(entry => entry.space.name).join(', ')}` : ''}.`,
    answer: { title: winner.name, value: target.name, detail: `${below ? 'Below' : 'Above'} ${source.name}` },
    scene: {
      focus: { mode: 'stack', floorIds: [target.id, sourceFloor.id] },
      highlights: [
        { spaceId: winner.id, tone: 'primary', label: winner.name },
        { spaceId: source.id, tone: 'secondary', label: source.name },
        ...scored.slice(1).map(entry => ({ spaceId: entry.space.id, tone: 'muted' as const })),
      ],
    },
  };
}

function straightLine(ctx: Context, a: Space, b: Space): ChatResponse {
  const ca = polygonCentroid(a.polygon), cb = polygonCentroid(b.polygon);
  const dz = ctx.floorOf(a).elevation_m - ctx.floorOf(b).elevation_m;
  const distance = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], dz);
  const value = `${distance.toFixed(2)} m`;
  return {
    kind: 'straight_line_3d',
    reply: `The straight line between the centres of ${a.name} and ${b.name} is ${value}.`,
    answer: { title: `${a.ref} ↔ ${b.ref}`, value, detail: 'Centroid to centroid, at floor elevation' },
    scene: {
      focus: a.floor_id === b.floor_id ? { mode: 'floor', floorId: a.floor_id } : { mode: 'stack', floorIds: [a.floor_id, b.floor_id] },
      highlights: [{ spaceId: a.id, tone: 'primary', label: a.name }, { spaceId: b.id, tone: 'primary', label: b.name }],
      links: [{ from: ctx.centre(a), to: ctx.centre(b), label: value }],
    },
  };
}

function route(ctx: Context, rooms: Space[]): ChatResponse {
  const { building } = ctx;
  const stepFree = /\b(step[- ]free|wheelchair|no stairs|without stairs|accessible)\b/.test(ctx.text);
  const closed = /\b(closed|out of service|maintenance|blocked|broken)\b/.test(ctx.text)
    ? building.vertical_connectors.filter(connector => ctx.text.includes(connector.name.toLowerCase())).map(connector => connector.id)
    : [];
  const centres = new Map(building.spaces.map(space => [space.id, polygonCentroid(space.polygon)]));
  type Edge = { to: string; cost: number; via: FloorPoint[] };
  const graph = new Map<string, Edge[]>();
  const add = (from: string, edge: Edge) => graph.set(from, [...(graph.get(from) ?? []), edge]);
  for (const opening of building.openings) {
    const [a, b] = opening.space_ids;
    if (a === 'outside' || b === 'outside' || (stepFree && !opening.step_free)) continue;
    const ca = centres.get(a), cb = centres.get(b);
    if (!ca || !cb) continue;
    const cost = Math.hypot(ca[0] - opening.position[0], ca[1] - opening.position[1]) + Math.hypot(cb[0] - opening.position[0], cb[1] - opening.position[1]);
    const via = [{ floorId: opening.floor_id, position: opening.position }];
    add(a, { to: b, cost, via }); add(b, { to: a, cost, via });
  }
  const levels = new Map(building.floors.map(floor => [floor.id, floor.level]));
  for (const connector of building.vertical_connectors) {
    if (closed.includes(connector.id) || (stepFree && (!connector.step_free || connector.kind === 'stairs'))) continue;
    connector.space_ids.forEach((a, i) => connector.space_ids.forEach((b, j) => {
      if (i === j) return;
      const floors = Math.abs((levels.get(connector.floor_ids[i]) ?? 0) - (levels.get(connector.floor_ids[j]) ?? 0));
      add(a, { to: b, cost: connector.kind === 'lift' ? 15 + 6 * floors : 12 * floors, via: [] });
    }));
  }
  const legs: { path: FloorPoint[]; length: number }[] = [];
  for (let i = 0; i < rooms.length - 1; i++) {
    const leg = dijkstra(graph, rooms[i].id, rooms[i + 1].id);
    if (!leg) return notFound(`I couldn't find a${stepFree ? ' step-free' : ''} route from ${rooms[i].name} to ${rooms[i + 1].name}.`, ctx.floorOf(rooms[i]));
    const spaceFloor = new Map(building.spaces.map(space => [space.id, space.floor_id]));
    const path: FloorPoint[] = [ctx.centre(rooms[i])];
    leg.steps.forEach(step => { path.push(...step.via, { floorId: spaceFloor.get(step.to)!, position: centres.get(step.to)! }); });
    legs.push({ path, length: leg.length });
  }
  const total = legs.reduce((sum, leg) => sum + leg.length, 0);
  const floorIds = [...new Set(legs.flatMap(leg => leg.path.map(point => point.floorId)))];
  const value = `≈ ${total.toFixed(0)} m`;
  return {
    kind: closed.length ? 'route_with_closure' : stepFree ? 'route_step_free' : rooms.length > 2 ? 'tour' : 'route',
    reply: `From ${rooms[0].name} to ${rooms.at(-1)!.name} is about ${total.toFixed(0)} m${stepFree ? ', step-free' : ''}${floorIds.length > 1 ? `, across ${floorIds.length} floors` : ''}.${closed.length ? ' I avoided the closed connector.' : ''}`,
    answer: { title: `${rooms[0].ref} → ${rooms.at(-1)!.ref}`, value, detail: `${stepFree ? 'Step-free · ' : ''}${floorIds.length} floor${floorIds.length === 1 ? '' : 's'}` },
    scene: {
      focus: floorIds.length === 1 ? { mode: 'floor', floorId: floorIds[0] } : { mode: 'stack', floorIds },
      highlights: rooms.map((space, i) => ({ spaceId: space.id, tone: i === rooms.length - 1 ? 'primary' as const : 'secondary' as const, label: space.name })),
      routes: legs.map(leg => ({ points: leg.path })),
      closed,
    },
  };
}

function dijkstra(graph: Map<string, { to: string; cost: number; via: FloorPoint[] }[]>, from: string, to: string) {
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { from: string; to: string; via: FloorPoint[] }>();
  const done = new Set<string>();
  while (true) {
    let current: string | undefined, best = Infinity;
    for (const [node, d] of dist) if (!done.has(node) && d < best) { best = d; current = node; }
    if (current === undefined) return undefined;
    if (current === to) break;
    done.add(current);
    for (const edge of graph.get(current) ?? []) {
      const next = best + edge.cost;
      if (next < (dist.get(edge.to) ?? Infinity)) { dist.set(edge.to, next); prev.set(edge.to, { from: current, to: edge.to, via: edge.via }); }
    }
  }
  const steps: { to: string; via: FloorPoint[] }[] = [];
  for (let node = to; node !== from; node = prev.get(node)!.from) steps.unshift(prev.get(node)!);
  return { steps, length: dist.get(to)! };
}

function assetMarker(asset: Asset) {
  return { floorId: asset.floor_id, position: asset.position, label: asset.name };
}

function notFound(reply: string, floor?: Floor): ChatResponse {
  return { kind: 'unknown', reply, scene: { focus: floor ? { mode: 'floor', floorId: floor.id } : { mode: 'building' } } };
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
