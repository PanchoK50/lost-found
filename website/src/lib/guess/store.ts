// Server-side only: community photos and duels (Supabase when configured, else in memory, like the world store).
import type { Building, Space } from '@/lib/buildings/types';
import { getCatalogEntry } from '@/lib/buildings/catalog';
import { applyEdits, loadEdits } from '@/lib/buildings/edits';
import { WalkGraph } from '@/lib/buildings/walk';
import { representativePoint } from '@/lib/buildings/graph';
import { supabaseAdmin } from '@/lib/supabase/server';
import { hashSeed, mulberry32 } from './random';
import { points, scoreScale, spotDistance } from './score';
import { mockSpots, pointInside, type PhotoSpot, type SpotPick } from './spots';
import { advance, applyDuel, DuelError, type BotGuesser, type Duel, type DuelAction, type RoundScore } from './duel';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const BUCKET = 'guess-photos';
/** Lobbies older than this drop off the "open duels" list. */
const LOBBY_TTL_MS = 30 * 60_000;

// ---------- building context: walk graph, scoring, bots ----------

interface Context { building: Building; graph: WalkGraph; scale: number }
const g = globalThis as { __lfGuessContexts?: Map<string, Context>; __lfGuessSpots?: Map<string, PhotoSpot[]>; __lfGuessImages?: Map<string, { type: string; data: Buffer }>; __lfGuessDuels?: Map<string, Duel> };
const contexts: Map<string, Context> = (g.__lfGuessContexts ??= new Map());

/** The building with its walk graph, built once per server process (up to ~0.7 s for the biggest one). */
export async function contextFor(buildingId: string): Promise<Context | undefined> {
  const known = contexts.get(buildingId);
  if (known) return known;
  const entry = await getCatalogEntry(buildingId);
  if (!entry) return undefined;
  // The plan players see: base plan plus the edits made by conversation (as on the page).
  const { building } = applyEdits(entry.building, await loadEdits(entry.id));
  const context = { building, graph: new WalkGraph(building), scale: scoreScale(building) };
  contexts.set(buildingId, context);
  return context;
}

export function scorer({ building, graph, scale }: Context) {
  return (pick: SpotPick, spot: PhotoSpot): RoundScore => {
    const d = spotDistance(graph, building, pick, spot);
    return { metres: d.metres, walked: d.walked, points: points(d.metres, scale) };
  };
}

/** A decent but beatable bot: often the right room, else somewhere nearby on the floor, sometimes lost. */
export function botGuesser({ building }: Context): BotGuesser {
  return (spot, rng) => {
    const roll = rng();
    const usable = building.spaces.filter(s => s.polygon.length >= 3 && s.type !== 'outdoor');
    let space: Space | undefined;
    if (roll < 0.3) space = usable.find(s => s.id === spot.spaceId);
    else if (roll < 0.8) {
      const near = usable.filter(s => s.floor_id === spot.floorId && s.id !== spot.spaceId)
        .map(s => ({ s, d: Math.hypot(representativePoint(s.polygon)[0] - spot.position[0], representativePoint(s.polygon)[1] - spot.position[1]) }))
        .sort((a, b) => a.d - b.d).slice(0, 8);
      space = near[Math.floor(rng() * near.length)]?.s;
    }
    space ??= usable[Math.floor(rng() * usable.length)];
    return { floorId: space.floor_id, spaceId: space.id, position: pointInside(space.polygon, rng) };
  };
}

// ---------- photos ----------

export interface NewSpot { buildingId: string; pick: SpotPick; caption?: string; author: { id: string; name: string }; image: { type: string; data: Buffer } }

export interface SpotStore {
  /** The building's photos: the mock ones plus everything the community uploaded, newest first. */
  list(building: Building): Promise<PhotoSpot[]>;
  add(spot: NewSpot): Promise<PhotoSpot>;
  /** Only the author can take a photo down. */
  remove(buildingId: string, id: string, authorId: string): Promise<void>;
  image?(id: string): { type: string; data: Buffer } | undefined;
}

class MemorySpots implements SpotStore {
  private readonly spots: Map<string, PhotoSpot[]> = (g.__lfGuessSpots ??= new Map());
  private readonly images: Map<string, { type: string; data: Buffer }> = (g.__lfGuessImages ??= new Map());
  async list(building: Building) {
    return [...(this.spots.get(building.building.id) ?? []), ...mockSpots(building)];
  }
  async add(n: NewSpot) {
    const id = crypto.randomUUID();
    this.images.set(id, n.image);
    const spot: PhotoSpot = { id, buildingId: n.buildingId, ...n.pick, imageUrl: `/api/guess/photos/${id}`, authorId: n.author.id, authorName: n.author.name, caption: n.caption, createdAt: Date.now() };
    this.spots.set(n.buildingId, [spot, ...(this.spots.get(n.buildingId) ?? [])]);
    return spot;
  }
  async remove(buildingId: string, id: string, authorId: string) {
    const list = this.spots.get(buildingId) ?? [];
    if (!list.some(s => s.id === id && s.authorId === authorId)) throw new DuelError('Only the author can remove a photo.');
    this.spots.set(buildingId, list.filter(s => s.id !== id));
    this.images.delete(id);
  }
  image(id: string) { return this.images.get(id); }
}

/** Table `guess_spots`, images in the public Storage bucket `guess-photos` (supabase/migrations). */
class SupabaseSpots implements SpotStore {
  constructor(private readonly db: NonNullable<ReturnType<typeof supabaseAdmin>>) {}
  private publicUrl(path: string) { return this.db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl; }
  async list(building: Building) {
    const { data, error } = await this.db.from('guess_spots').select('*').eq('building_id', building.building.id).order('created_at', { ascending: false }).limit(500);
    const rows = error ? [] : data;
    return [...rows.map((r): PhotoSpot => ({
      id: r.id, buildingId: r.building_id, floorId: r.floor_id, spaceId: r.space_id, position: [r.x, r.y], imageUrl: this.publicUrl(r.image_path),
      authorId: r.author_id, authorName: r.author_name, caption: r.caption ?? undefined, createdAt: Date.parse(r.created_at),
    })), ...mockSpots(building)];
  }
  async add(n: NewSpot) {
    const id = crypto.randomUUID();
    const path = `${n.buildingId}/${id}.jpg`;
    const up = await this.db.storage.from(BUCKET).upload(path, n.image.data, { contentType: n.image.type, upsert: false });
    if (up.error) throw new Error(`Uploading the photo failed: ${up.error.message}`);
    const row = { id, building_id: n.buildingId, floor_id: n.pick.floorId, space_id: n.pick.spaceId, x: n.pick.position[0], y: n.pick.position[1], image_path: path, author_id: n.author.id, author_name: n.author.name, caption: n.caption ?? null };
    const { data, error } = await this.db.from('guess_spots').insert(row).select('created_at').single();
    if (error) throw new Error(`Saving the photo failed: ${error.message}`);
    return { id, buildingId: n.buildingId, ...n.pick, imageUrl: this.publicUrl(path), authorId: n.author.id, authorName: n.author.name, caption: n.caption, createdAt: Date.parse(data.created_at) };
  }
  async remove(buildingId: string, id: string, authorId: string) {
    const { data } = await this.db.from('guess_spots').delete().eq('id', id).eq('author_id', authorId).select('image_path');
    if (!data?.length) throw new DuelError('Only the author can remove a photo.');
    await this.db.storage.from(BUCKET).remove([data[0].image_path]);
  }
}

// ---------- duels ----------

export interface DuelStore {
  create(duel: Duel): Promise<void>;
  /** The duel, moved forward to `now` (bots, timers, rounds). */
  get(id: string, now: number): Promise<Duel | undefined>;
  apply(id: string, action: DuelAction, now: number): Promise<Duel>;
  /** Duels in this building still waiting for players. */
  open(buildingId: string, now: number): Promise<Duel[]>;
}

async function moveOn(duel: Duel, now: number) {
  if (duel.status !== 'playing') return duel;
  const context = await contextFor(duel.buildingId);
  return context ? advance(duel, now, scorer(context), botGuesser(context)) : duel;
}

class MemoryDuels implements DuelStore {
  private readonly duels: Map<string, Duel> = (g.__lfGuessDuels ??= new Map());
  async create(duel: Duel) { this.duels.set(duel.id, duel); }
  async get(id: string, now: number) {
    const duel = this.duels.get(id);
    if (!duel) return undefined;
    const next = await moveOn(duel, now);
    this.duels.set(id, next);
    return next;
  }
  async apply(id: string, action: DuelAction, now: number) {
    const duel = await this.get(id, now);
    if (!duel) throw new DuelError('This duel does not exist (any more).');
    const next = await moveOn(applyDuel(duel, action, now), now);
    this.duels.set(id, next);
    return next;
  }
  async open(buildingId: string, now: number) {
    return [...this.duels.values()].filter(d => d.buildingId === buildingId && d.status === 'lobby' && now - d.updatedAt < LOBBY_TTL_MS && d.players.length);
  }
}

/** Table `guess_duels`: one versioned JSON document per duel, written with optimistic retries. */
class SupabaseDuels implements DuelStore {
  constructor(private readonly db: NonNullable<ReturnType<typeof supabaseAdmin>>) {}
  async create(duel: Duel) {
    const { error } = await this.db.from('guess_duels').insert({ id: duel.id, building_id: duel.buildingId, status: duel.status, state: duel, version: duel.version });
    if (error) throw new Error(`Creating the duel failed: ${error.message}`);
  }
  private async load(id: string) {
    const { data } = await this.db.from('guess_duels').select('state, version').eq('id', id).maybeSingle();
    return data ? { duel: data.state as Duel, version: data.version as number } : undefined;
  }
  private async save(duel: Duel, version: number) {
    const { data } = await this.db.from('guess_duels').update({ state: duel, version: duel.version, status: duel.status, updated_at: new Date(duel.updatedAt).toISOString() }).eq('id', duel.id).eq('version', version).select('version');
    if (data?.length) await notifyDuel(duel.id, duel.version);
    return Boolean(data?.length);
  }
  async get(id: string, now: number) {
    const loaded = await this.load(id);
    if (!loaded) return undefined;
    const next = await moveOn(loaded.duel, now);
    if (next !== loaded.duel) await this.save(next, loaded.version); // if someone saved first, theirs is as fresh
    return next;
  }
  async apply(id: string, action: DuelAction, now: number) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const loaded = await this.load(id);
      if (!loaded) throw new DuelError('This duel does not exist (any more).');
      const next = await moveOn(applyDuel(await moveOn(loaded.duel, now), action, now), now);
      if (await this.save(next, loaded.version)) return next;
    }
    throw new Error('The duel is busy; try again.');
  }
  async open(buildingId: string, now: number) {
    const { data } = await this.db.from('guess_duels').select('state').eq('building_id', buildingId).eq('status', 'lobby')
      .gte('updated_at', new Date(now - LOBBY_TTL_MS).toISOString()).order('updated_at', { ascending: false }).limit(20);
    return (data ?? []).map(r => r.state as Duel).filter(d => d.players.length);
  }
}

export const duelTopic = (id: string) => `guess-duel:${id}`;

/** Realtime "changed" signal so browsers refetch at once instead of waiting for their next poll. */
async function notifyDuel(id: string, version: number) {
  if (!url || !secretKey) return;
  await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: secretKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic: duelTopic(id), event: 'changed', payload: { version }, private: false }] }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
}

/** A fresh, short duel id that reads well in a link. */
export function duelId() {
  const rng = mulberry32(hashSeed(crypto.randomUUID()));
  return Array.from({ length: 6 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(rng() * 31)]).join('');
}

const db = supabaseAdmin();
export const spotStore: SpotStore = db ? new SupabaseSpots(db) : new MemorySpots();
export const duelStore: DuelStore = db ? new SupabaseDuels(db) : new MemoryDuels();
