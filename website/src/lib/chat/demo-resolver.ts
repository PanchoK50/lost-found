import type { Asset, Building, Floor, Opening, Space } from '@/lib/buildings/types';
import { bounds, pointInPolygon, polygonArea, polygonCentroid, sharedWall } from '@/lib/buildings/geometry';
import { buildGraph, OUTSIDE, shortestPaths, type GraphOptions } from '@/lib/buildings/graph';
import { WalkGraph, type WalkLeg, type WalkRules } from '@/lib/buildings/walk';
import { turnByTurn } from '@/lib/buildings/turns';
import type { ChatResponse, FloorPoint } from './contract';

/**
 * PLACEHOLDER so the UI can be demoed end to end. Keyword matching plus simple geometry;
 * it is not benchmark-accurate. Replace `resolveDemo` with a call to the real agent,
 * which should return the same `ChatResponse` shape.
 */
export function resolveDemo(building: Building, message: string, options: ResolveOptions = {}): ChatResponse {
  const ctx = new Context(building, message, options);
  const text = ctx.text;
  const rooms = ctx.mentionedSpaces();
  const loadWidth = text.match(/(\d+(?:\.\d+)?)\s*m(?:etres?|eters?)?\s+wide\b/);

  // Type 2: a number over a set of rooms. Checked first: their wording overlaps with routes ("walk out").
  if (rooms.length >= 2 && /\b(what if|add a door|new door)\b/.test(text)) return whatIfDoor(ctx, rooms[0], rooms[1]);
  if (loadWidth && rooms.length >= 1) return wideDelivery(ctx, ctx.spaceAfter('into') ?? rooms[0], Number(loadWidth[1]));
  if (rooms.length >= 1 && /\b(wheelchair|step[- ]free)\b/.test(text) && /\bhow many\b/.test(text)) return stepFreeReachable(ctx, ctx.spaceAfter('into') ?? rooms[0]);
  if (rooms.length >= 1 && /\b(share|shares|sharing|shared)\b[^.?]*\bwalls?\b|\bneighbou?r(s|ing)?\b|\badjacent\b/.test(text)) return sharedWalls(ctx, rooms[0]);

  // Type 3: routes. The start must be named in the question for now.
  const routeWords = /\b(get|route|way|go|walk|directions?|path|visit|take me|bring)\b/.test(text);
  if (/\b(grab|pick up|fetch|collect)\b/.test(text) && /\bcarry\b/.test(text)) return errand(ctx);
  if (routeWords) {
    const { stops, closed } = ctx.routeStops();
    const assetType = ctx.mentionedAssetType();
    if (stops.length >= 2) return route(ctx, stops, closed);
    if (stops.length === 1 && assetType) return route(ctx, stops, closed, assetType);
    if (/\bfrom\b|\bto\b/.test(text) && (stops.length || assetType)) return notFound('Where are you starting from? Name the room you are in, for example "from Office 0.23".', stops[0] && ctx.floorOf(stops[0]));
  }
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

export interface ResolveOptions {
  /** Opening, connector or space ids closed by reports from people in the building (docs/MULTIPLAYER.md §8). */
  closed?: string[];
  /** Spaces never picked as "the nearest …" (skills skip items reported broken). */
  skip?: string[];
}

class Context {
  readonly text: string;
  readonly floors: Map<string, Floor>;
  /** Closures from the world, with names for the reply. */
  readonly worldClosed: { id: string; name: string }[];
  readonly skip: Set<string>;
  constructor(readonly building: Building, message: string, options: ResolveOptions = {}) {
    this.text = message.toLowerCase();
    this.floors = new Map(building.floors.map(floor => [floor.id, floor]));
    this.worldClosed = (options.closed ?? []).map(id => ({ id, name: elementName(building, id) }));
    this.skip = new Set(options.skip);
  }
  floorOf(space: Space) { return this.floors.get(space.floor_id)!; }
  spacesOn(floor: Floor) { return this.building.spaces.filter(space => space.floor_id === floor.id); }
  area(space: Space) { return polygonArea(space.polygon); }
  centre(space: Space): FloorPoint { return { floorId: space.floor_id, position: polygonCentroid(space.polygon) }; }

  /** The floor a question is about. Floor notes after room names, like "(Floor 2)", are ignored unless nothing else names a floor. */
  mentionedFloor(): Floor | undefined {
    const stripped = this.text.replace(/\((?:ground floor|floor\s*-?\d+|basement\s*\d*)\)/g, ' ');
    return this.parseFloor(stripped) ?? this.parseFloor(this.text);
  }

  private parseFloor(t: string): Floor | undefined {
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
    return this.mentions().map(hit => hit.space);
  }

  /** First space mentioned after a word, e.g. the room after "into" in "comes in through the entrance into …". */
  spaceAfter(word: string): Space | undefined {
    const at = this.text.search(new RegExp(`\\b${escape(word)}\\b`));
    return at < 0 ? undefined : this.mentions().find(hit => hit.index > at)?.space;
  }

  /**
   * Route stops in order, plus what is closed. A sentence that says something is closed or blocked
   * ("Staircase 2 is closed for maintenance.") closes the stairs, lifts and spaces it names; stops come
   * from the other sentences.
   */
  routeStops(): { stops: Space[]; closed: { id: string; name: string }[] } {
    const closure = /\b(closed|out of service|out of order|maintenance|blocked|broken|not working)\b/;
    const closed: { id: string; name: string }[] = [];
    const closedSpaces = new Set<string>();
    for (const sentence of this.text.split(/(?<=[.!?;])\s+/)) {
      if (!closure.test(sentence) || /\b(from|how do i|route)\b/.test(sentence)) continue;
      for (const c of this.building.vertical_connectors) if (new RegExp(`\\b${escape(c.name.toLowerCase())}\\b`).test(sentence)) closed.push({ id: c.id, name: c.name });
      for (const space of new Context(this.building, sentence).mentionedSpaces()) { closed.push({ id: space.id, name: space.name }); closedSpaces.add(space.id); }
    }
    const closedNames = new Set(closed.map(c => c.name.toLowerCase()));
    const stops = this.mentionedSpaces().filter(space => !closedSpaces.has(space.id) && !closedNames.has(space.name.toLowerCase()));
    // A reported room never blocks a route that starts or ends in it: people must be able to get in and out.
    for (const c of this.worldClosed) if (!closed.some(x => x.id === c.id) && !stops.some(stop => stop.id === c.id)) closed.push(c);
    return { stops, closed };
  }

  /** Stairs or lifts named in the message, e.g. "Lift 1 is out of service". */
  mentionedConnectors() {
    return this.building.vertical_connectors.filter(c => new RegExp(`\\b${escape(c.name.toLowerCase())}\\b`).test(this.text));
  }

  private mentions() {
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
    const result: typeof hits = [];
    let end = -1;
    for (const hit of hits) {
      if (hit.index < end || result.some(r => r.space === hit.space)) continue;
      result.push(hit); end = hit.index + hit.length;
    }
    return result;
  }

  /** Room type the question is about: prefer the phrase after "largest", "every", "all", … over room names like "Office 1.09". */
  mentionedRoomType(): string | undefined {
    const phrase = this.text.match(/\b(?:largest|biggest|smallest|every|all(?: the)?|each)\s+([a-z ]+?)(?:\s+(?:on|in|at)\b|[?.,]|$)/)?.[1];
    return (phrase && this.roomTypeIn(phrase)) ?? this.roomTypeIn(this.text);
  }

  private roomTypeIn(text: string): string | undefined {
    const types = [...new Set(this.building.spaces.map(space => space.room_type))];
    return types
      .map(type => ({ type, label: type.replaceAll('_', ' ') }))
      .sort((a, b) => b.label.length - a.label.length)
      .find(({ label }) => new RegExp(`\\b${escape(label)}(s|es)?\\b`).test(text))?.type;
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
        ...candidates.slice(1).filter(space => space.floor_id === winner.floor_id).map(space => ({ spaceId: space.id, tone: 'muted' as const })),
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
      highlights: [...new Set(assets.map(asset => asset.space_id))].map(spaceId => ({ spaceId, tone: 'muted' as const })),
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

// ---------- Type 3: routes ----------

const walkGraphs = new Map<string, WalkGraph>();

/** Walk graphs are expensive to build for big buildings; cache one per building and rule set. */
function walkGraph(building: Building, rules: WalkRules): WalkGraph {
  const key = JSON.stringify([building.building.id, !!rules.stepFree, !!rules.forklift, [...(rules.closed ?? [])].sort()]);
  let graph = walkGraphs.get(key);
  if (!graph) { graph = new WalkGraph(building, rules); walkGraphs.set(key, graph); }
  return graph;
}

function routeRules(ctx: Context, closed: { id: string }[]): WalkRules {
  return {
    stepFree: /\b(step[- ]free|wheelchair|without (stairs|steps)|no stairs|can'?t (use|take|climb) (the )?stairs|accessible|pram|stroller|walker)\b/.test(ctx.text),
    forklift: /\bforklift\b/.test(ctx.text),
    closed: closed.map(c => c.id),
  };
}

function ruleNotes(rules: WalkRules) {
  return [rules.stepFree && 'step-free', rules.forklift && 'forklift aisles only', (rules.closed && [...rules.closed].length) && 'avoiding closures'].filter(Boolean) as string[];
}

/** Nearest room (by walking) that holds an item of this type. */
function nearestWithAsset(ctx: Context, graph: WalkGraph, from: Space, type: string, exclude?: string) {
  const dist = graph.distancesFrom(from.id);
  const rooms = [...new Set(ctx.building.assets.filter(a => a.type === type).map(a => a.space_id))].filter(id => id !== exclude && !ctx.skip.has(id) && dist.has(id));
  rooms.sort((a, b) => dist.get(a)! - dist.get(b)!);
  return rooms.length ? ctx.building.spaces.find(sp => sp.id === rooms[0]) : undefined;
}

function route(ctx: Context, stops: Space[], closed: { id: string; name: string }[], assetType?: string): ChatResponse {
  const rules = routeRules(ctx, closed);
  const graph = walkGraph(ctx.building, rules);
  const labels = new Map<string, string>();
  if (assetType) {
    // A route to an item ends in the room or bay that holds it.
    const target = nearestWithAsset(ctx, graph, stops[0], assetType);
    if (!target) return noRoute(ctx, stops[0], undefined, rules, closed, `I couldn't reach any ${assetType.replaceAll('_', ' ')} from ${stops[0].name}${ruleNotes(rules).length ? ` (${ruleNotes(rules).join(', ')})` : ''}.`);
    stops = [stops[0], target];
    const item = assetType.replaceAll('_', ' ');
    labels.set(target.id, `${item[0].toUpperCase()}${item.slice(1)} · ${target.name}`);
  }
  const legs: WalkLeg[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const leg = graph.route(stops[i].id, stops[i + 1].id);
    if (!leg) return noRoute(ctx, stops[i], stops[i + 1], rules, closed);
    legs.push(leg);
  }
  const kind = stops.length > 2 ? 'tour' : closed.length ? 'route_with_closure' : rules.stepFree ? 'route_step_free' : 'route';
  return routeResponse(ctx, kind, stops, legs, rules, closed, labels);
}

function errand(ctx: Context): ChatResponse {
  const { stops, closed } = ctx.routeStops();
  const start = stops[0];
  const assetType = ctx.mentionedAssetType();
  if (!start || !assetType) return notFound('Tell me where you are and what to pick up, for example "I\'m in Office 0.38. I need to grab a stove, then carry it to the largest kitchen on floor 1."');
  const rules = routeRules(ctx, closed);
  const graph = walkGraph(ctx.building, rules);
  // Errands are scored as one distance in the kit's route model (README section 3), so "closest" and the
  // total use that model; the drawn path still comes from the walking model.
  const kit = buildGraph(ctx.building, { stepFree: rules.stepFree, closed: rules.closed });
  const fromStart = shortestPaths(kit, [start.id]).dist;
  const holders = [...new Set(ctx.building.assets.filter(a => a.type === assetType).map(a => a.space_id))].filter(id => fromStart.has(id));
  holders.sort((a, b) => fromStart.get(a)! - fromStart.get(b)!);
  const pickup = ctx.building.spaces.find(sp => sp.id === holders[0]);
  if (!pickup) return noRoute(ctx, start, undefined, rules, closed, `I couldn't reach any ${assetType.replaceAll('_', ' ')} from ${start.name}.`);
  // Destination: a named room, or "the largest <room type> on <floor>".
  const named = stops.find(sp => sp.id !== start.id);
  const floor = ctx.mentionedFloor();
  const roomType = ctx.mentionedRoomType();
  const destination = named ?? ctx.building.spaces
    .filter(sp => (!floor || sp.floor_id === floor.id) && (!roomType || sp.room_type === roomType))
    .sort((a, b) => ctx.area(b) - ctx.area(a))[0];
  if (!destination) return notFound(`I couldn't find where to take the ${assetType.replaceAll('_', ' ')}.`, floor);
  const first = graph.route(start.id, pickup.id);
  const second = graph.route(pickup.id, destination.id);
  if (!first) return noRoute(ctx, start, pickup, rules, closed);
  if (!second) return noRoute(ctx, pickup, destination, rules, closed);
  const labels = new Map([[pickup.id, `Pick up ${assetType.replaceAll('_', ' ')} · ${pickup.name}`]]);
  const total = fromStart.get(pickup.id)! + (shortestPaths(kit, [pickup.id]).dist.get(destination.id) ?? NaN);
  return routeResponse(ctx, 'errand', [start, pickup, destination], [first, second], rules, closed, labels, total);
}

function describeVia(ctx: Context, legs: WalkLeg[], stops: Space[]) {
  const spaces = new Map(ctx.building.spaces.map(sp => [sp.id, sp]));
  const stopIds = new Set(stops.map(sp => sp.id));
  const via: string[] = [];
  for (const leg of legs) for (let i = 1; i < leg.spacePath.length; i++) {
    const [a, b] = [spaces.get(leg.spacePath[i - 1]), spaces.get(leg.spacePath[i])];
    if (a && b && a.floor_id !== b.floor_id) {
      const connector = ctx.building.vertical_connectors.find(c => c.space_ids.includes(a.id) && c.space_ids.includes(b.id));
      const name = `${connector?.name ?? 'the stairs'} to ${ctx.floorOf(b).name}`;
      if (connector && via.at(-1)?.startsWith(connector.name)) via[via.length - 1] = name; else via.push(name);
    } else if (b && !stopIds.has(b.id) && (b.type === 'corridor' || b.type === 'hall') && via.length < 3 && !via.includes(b.name)) via.push(b.name);
    else if (leg.spacePath[i] === OUTSIDE) via.push('outside');
  }
  return via;
}

function routeResponse(ctx: Context, kind: ChatResponse['kind'], stops: Space[], legs: WalkLeg[], rules: WalkRules, closed: { id: string; name: string }[], labels = new Map<string, string>(), distance?: number): ChatResponse {
  const total = distance ?? legs.reduce((sum, leg) => sum + leg.length, 0);
  const minutes = Math.max(1, Math.round(total / 1.3 / 60));
  const start = stops[0], end = stops.at(-1)!;
  // Floors where something happens: the stops and wherever the route walks.
  const walked = new Map<string, number>();
  legs.forEach(leg => leg.points.forEach(p => walked.set(p.floorId, (walked.get(p.floorId) ?? 0) + 1)));
  const floorIds = [...new Set([...stops.map(sp => sp.floor_id), ...[...walked].filter(([, n]) => n >= 2).map(([id]) => id)])];
  const stopIds = new Set(stops.map(sp => sp.id));
  const passed = [...new Set(legs.flatMap(leg => leg.spacePath))].filter(id => id !== OUTSIDE && !stopIds.has(id));
  const via = describeVia(ctx, legs, stops);
  const notes = ruleNotes(rules);
  const value = distance === undefined ? `≈ ${total.toFixed(0)} m` : `${total.toFixed(2)} m`;
  const label = (sp: Space, i: number) => labels.get(sp.id) ?? (i === 0 ? `Start · ${sp.name}` : i === stops.length - 1 ? sp.name : `Stop ${i} · ${sp.name}`);
  return {
    kind,
    reply: `${kind === 'errand' ? 'In total it' : `From ${start.name} to ${end.name} it`} is about ${total.toFixed(0)} m, roughly ${minutes} min on foot${via.length ? `, via ${via.join(', ')}` : ''}.${closed.length ? ` I avoided ${closed.map(c => c.name).join(' and ')}.` : ''}${rules.stepFree ? ' No stairs or steps on the way.' : ''}`,
    answer: { title: kind === 'errand' ? `${start.ref} → pick up → ${end.ref}` : stops.map(sp => sp.ref).join(' → '), value, detail: [`${floorIds.length} floor${floorIds.length === 1 ? '' : 's'}`, `about ${minutes} min`, ...notes].join(' · ') },
    scene: {
      focus: floorIds.length === 1 ? { mode: 'floor', floorId: floorIds[0] } : { mode: 'stack', floorIds },
      highlights: [
        ...stops.map((sp, i) => ({ spaceId: sp.id, tone: i === 0 ? 'secondary' as const : 'primary' as const, label: label(sp, i) })),
        ...passed.map(id => ({ spaceId: id, tone: 'muted' as const })),
      ],
      // Draw only the floors on view: rides through intermediate floors become one vertical hop.
      routes: legs.map((leg, i) => ({ spacePath: leg.spacePath, points: leg.points.filter(p => floorIds.includes(p.floorId)), steps: turnByTurn(ctx.building, leg.segments, leg.spacePath, { endsAt: i < legs.length - 1 ? 'stop' : 'destination' }) })),
      closed: closed.map(c => c.id),
    },
  };
}

/** Explain why there is no route under the rules, by checking which rule blocks it. */
function noRoute(ctx: Context, from: Space, to: Space | undefined, rules: WalkRules, closed: { id: string; name: string }[], message?: string): ChatResponse {
  let why = '';
  const blockers: { floorId: string; position: [number, number]; label: string }[] = [];
  if (to) {
    const without = (r: WalkRules) => walkGraph(ctx.building, r).route(from.id, to.id);
    if (closed.length && without({ ...rules, closed: [] })) why = `The only way is through ${closed.map(c => c.name).join(' and ')}, which ${closed.length === 1 ? 'is' : 'are'} closed.`;
    else if (rules.forklift && without({ ...rules, forklift: false })) why = 'The only way uses doors narrower than 3 m, pedestrian walkways or stairs and lifts, which a forklift can\'t use.';
    else if (rules.stepFree) {
      const relaxed = without({ ...rules, stepFree: false });
      if (relaxed) {
        const needed = ctx.building.vertical_connectors.filter(c => !c.step_free || c.kind === 'stairs').filter(c => relaxed.spacePath.some((id, i) => i > 0 && c.space_ids.includes(id) && c.space_ids.includes(relaxed.spacePath[i - 1])));
        why = needed.length ? `Every way there needs ${needed.map(c => c.name).join(' or ')}, and there is no working lift on the way.` : 'Every way there has steps.';
        for (const c of needed) {
          const sp = ctx.building.spaces.find(x => x.id === c.space_ids[0]);
          if (sp) blockers.push({ floorId: sp.floor_id, position: polygonCentroid(sp.polygon), label: `${c.name} · stairs` });
        }
      }
    }
  }
  const constraint = rules.stepFree ? ' step-free' : rules.forklift ? ' forklift' : '';
  const reply = message ?? `There is no${constraint} route from ${from.name} to ${to!.name}. ${why}`.trim();
  // Show how far you can get under the rules from the start, on its floor.
  const reach = walkGraph(ctx.building, rules).distancesFrom(from.id);
  const reachable = ctx.spacesOn(ctx.floorOf(from)).filter(sp => sp.id !== from.id && reach.has(sp.id)).map(sp => sp.id);
  const floors = [...new Set([from.floor_id, ...(to ? [to.floor_id] : [])])];
  return {
    kind: rules.stepFree ? 'route_step_free' : closed.length ? 'route_with_closure' : 'route',
    reply,
    answer: { title: to ? `${from.ref} → ${to.ref}` : from.name, value: `No${constraint} route`, detail: why || undefined },
    scene: {
      focus: floors.length === 1 ? { mode: 'floor', floorId: floors[0] } : { mode: 'stack', floorIds: floors },
      highlights: [
        { spaceId: from.id, tone: 'secondary', label: `Start · ${from.name}` },
        ...(to ? [{ spaceId: to.id, tone: 'primary' as const, label: to.name }] : []),
        ...reachable.map(id => ({ spaceId: id, tone: 'muted' as const })),
      ],
      markers: blockers,
      closed: closed.map(c => c.id),
    },
  };
}

// ---------- Type 2: a number over a set of rooms ----------

/** Rooms that can share a wall: rooms and halls, never corridors, stairwells or lifts. */
function isWalledRoom(space: Space) {
  return (space.type === 'room' || space.type === 'hall') && !['corridor', 'stairwell', 'lift'].includes(space.room_type);
}

/** Destinations for reachability counts ("how many rooms can it reach"): rooms only, not halls, lobbies or corridors. */
function isDestinationRoom(space: Space) {
  return space.type === 'room';
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Rooms on `floor` reachable from `start` under the given constraints (the start counts if it is a room). */
function reachableRooms(ctx: Context, start: Space, floor: Floor, options: GraphOptions) {
  const { dist } = shortestPaths(buildGraph(ctx.building, options), [start.id]);
  return { dist, rooms: ctx.spacesOn(floor).filter(space => isDestinationRoom(space) && dist.has(space.id)) };
}

function sharedWalls(ctx: Context, target: Space): ChatResponse {
  const floor = ctx.floorOf(target);
  const neighbours = ctx.spacesOn(floor)
    .filter(space => space.id !== target.id && isWalledRoom(space))
    .map(space => ({ space, length: Math.max(sharedWall(target.polygon, space.polygon).length, sharedWall(space.polygon, target.polygon).length) }))
    .filter(entry => entry.length >= 1)
    .sort((a, b) => b.length - a.length);
  const n = neighbours.length;
  return {
    kind: 'shared_walls_count',
    reply: `${plural(n, 'room')} on ${floor.name} share at least 1 m of wall with ${target.name}${n ? `: ${neighbours.map(e => `${e.space.name} (${e.length.toFixed(1)} m)`).join(', ')}` : ''}. Corridors, stairwells and lifts are not counted.`,
    answer: { title: `Rooms sharing a wall with ${target.name}`, value: String(n), detail: `${floor.name} · at least 1 m of shared wall` },
    scene: {
      focus: { mode: 'floor', floorId: floor.id },
      highlights: [
        { spaceId: target.id, tone: 'secondary', label: target.name },
        ...neighbours.map(e => ({ spaceId: e.space.id, tone: 'primary' as const })),
      ],
    },
  };
}

function wideDelivery(ctx: Context, start: Space, width: number): ChatResponse {
  const floor = ctx.mentionedFloor() ?? ctx.floorOf(start);
  const { dist, rooms } = reachableRooms(ctx, start, floor, { stepFree: true, minWidth: width });
  // Doors on this floor that stop the load: too narrow, with only one side reachable.
  const blocking = ctx.building.openings.filter(o => o.floor_id === floor.id && o.width_m < width && o.space_ids.some(id => dist.has(id)) && o.space_ids.some(id => id !== OUTSIDE && !dist.has(id)));
  const n = rooms.length;
  return {
    kind: 'wide_delivery_count',
    reply: `A ${width} m wide load coming in at ${start.name} can reach ${plural(n, 'room')} on ${floor.name}, avoiding stairs and steps and only using doors at least ${width} m wide.${blocking.length ? ` ${plural(blocking.length, 'door')} on this floor ${blocking.length === 1 ? 'is' : 'are'} too narrow and block the rest.` : ''}`,
    answer: { title: `Rooms a ${width} m load can reach on ${floor.name}`, value: String(n), detail: `From ${start.name} · no steps · doors ≥ ${width} m` },
    scene: {
      focus: { mode: 'floor', floorId: floor.id },
      highlights: [
        ...rooms.filter(space => space.id !== start.id).map(space => ({ spaceId: space.id, tone: 'primary' as const })),
        { spaceId: start.id, tone: rooms.some(space => space.id === start.id) ? 'primary' : 'secondary', label: `Entry · ${start.name}` },
      ],
      markers: blocking.map(o => ({ floorId: o.floor_id, position: o.position, label: `${o.width_m} m door`, tone: 'muted' as const })),
    },
  };
}

function stepFreeReachable(ctx: Context, start: Space): ChatResponse {
  const floor = ctx.mentionedFloor() ?? ctx.floorOf(start);
  const mentioned = /\b(closed|out of service|maintenance|broken)\b/.test(ctx.text) ? ctx.mentionedConnectors() : [];
  const closed = [...mentioned, ...ctx.worldClosed.filter(c => !mentioned.some(m => m.id === c.id))];
  const { rooms } = reachableRooms(ctx, start, floor, { stepFree: true, closed: closed.map(c => c.id) });
  const n = rooms.length;
  const closedNames = closed.map(c => c.name).join(' and ');
  return {
    kind: 'step_free_reachable_count',
    reply: `Coming in at ${start.name}, a wheelchair user can reach ${plural(n, 'room')} on ${floor.name} without stairs or steps${closed.length ? ` while ${closedNames} ${closed.length === 1 ? 'is' : 'are'} out of service` : ''}.`,
    answer: { title: `Step-free rooms on ${floor.name}`, value: String(n), detail: closed.length ? `${closedNames} closed · from ${start.name}` : `From ${start.name}` },
    scene: {
      focus: { mode: 'floor', floorId: floor.id },
      highlights: rooms.map(space => ({ spaceId: space.id, tone: 'primary' as const })),
      closed: closed.map(c => c.id),
    },
  };
}

function whatIfDoor(ctx: Context, a: Space, b: Space): ChatResponse {
  const doorFloor = ctx.floorOf(a);
  const floor = ctx.mentionedFloor() ?? doorFloor;
  const middle = sharedWall(a.polygon, b.polygon).middle ?? sharedWall(b.polygon, a.polygon).middle;
  if (a.floor_id !== b.floor_id || !middle) return notFound(`${a.name} and ${b.name} don't share a wall, so a door can't go between them.`, doorFloor);
  const door: Opening = { id: 'what-if-door', floor_id: a.floor_id, space_ids: [a.id, b.id], kind: 'door', position: middle, width_m: 0.9, step_free: true, synthetic: true };
  const before = shortestPaths(buildGraph(ctx.building), [OUTSIDE]).dist;
  const after = shortestPaths(buildGraph(ctx.building, { extraOpenings: [door] }), [OUTSIDE]).dist;
  const improved = ctx.spacesOn(floor)
    .filter(space => isDestinationRoom(space) && after.has(space.id) && (before.get(space.id) ?? Infinity) - after.get(space.id)! > 1)
    .map(space => ({ space, saved: (before.get(space.id) ?? Infinity) - after.get(space.id)! }));
  const n = improved.length;
  const best = [...improved].sort((x, y) => y.saved - x.saved)[0];
  return {
    kind: 'what_if_door',
    reply: `A new door between ${a.name} and ${b.name} would give ${plural(n, 'room')} on ${floor.name} a walk out of the building that is more than 1 m shorter.${best && Number.isFinite(best.saved) ? ` The biggest saving is ${best.saved.toFixed(1)} m, for ${best.space.name}.` : ''}`,
    answer: { title: `Rooms on ${floor.name} with a shorter way out`, value: String(n), detail: `New door: ${a.ref} ↔ ${b.ref} · saving > 1 m` },
    scene: {
      focus: floor.id === doorFloor.id ? { mode: 'floor', floorId: floor.id } : { mode: 'stack', floorIds: [doorFloor.id, floor.id] },
      highlights: [
        ...improved.map(e => ({ spaceId: e.space.id, tone: 'primary' as const })),
        { spaceId: a.id, tone: 'secondary' },
        { spaceId: b.id, tone: 'secondary' },
      ],
      markers: [{ floorId: door.floor_id, position: door.position, label: 'New door' }],
    },
  };
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

/** A readable name for a closed element: the stair or lift, the space, or the door between two spaces. */
function elementName(building: Building, id: string) {
  const connector = building.vertical_connectors.find(c => c.id === id);
  if (connector) return connector.name;
  const space = building.spaces.find(s => s.id === id);
  if (space) return space.name;
  const opening = building.openings.find(o => o.id === id);
  const sides = opening?.space_ids.map(sid => building.spaces.find(s => s.id === sid)?.name).filter(Boolean) ?? [];
  return sides.length ? `the ${opening!.kind} to ${sides.join(' / ')}` : id;
}

/** Names in a message: spaces, stairs and lifts, asset and room types. Used by the multiplayer chat patterns. */
export function mentionsIn(building: Building, message: string) {
  const ctx = new Context(building, message);
  return { spaces: ctx.mentionedSpaces(), connectors: ctx.mentionedConnectors(), assetType: ctx.mentionedAssetType(), roomType: ctx.mentionedRoomType() };
}
