// Server-side only: holds every player's world state (Supabase when configured, else in memory).
import type { Building } from '@/lib/buildings/types';
import { supabaseAdmin } from '@/lib/supabase/server';
import { runDemo, scheduleDemo } from './demo-players';
import { applyAction, createWorld, prune, type StoredWorld } from './rules';
import type { WorldAction } from './types';

/** Storage behind one interface, so a Redis store can replace the memory one without touching the UI (§6). */
export interface WorldStore {
  get(building: Building, now: number): Promise<StoredWorld>;
  /** Validates the action, applies the §4 rules and bumps the version. Throws WorldError if not allowed. */
  apply(building: Building, action: WorldAction, now: number): Promise<StoredWorld>;
}

/**
 * One `Map` per server process: enough for `next dev` and `next start`, where two browser windows already
 * play together. Kept on globalThis so hot reloads in development don't wipe the world.
 * Serverless hosts don't share memory between instances; swap in a Redis-backed store there.
 */
class MemoryStore implements WorldStore {
  private readonly worlds: Map<string, StoredWorld>;
  constructor() {
    const g = globalThis as { __lostFoundWorlds?: Map<string, StoredWorld> };
    this.worlds = g.__lostFoundWorlds ??= new Map();
  }
  async get(building: Building, now: number) {
    // Demo players are seeded on first use and their due reactions run on every read (§9).
    const world = runDemo(this.worlds.get(building.building.id) ?? createWorld(building), building, now);
    prune(world, now);
    this.worlds.set(world.buildingId, world);
    return world;
  }
  async apply(building: Building, action: WorldAction, now: number) {
    const next = scheduleDemo(applyAction(await this.get(building, now), action, building, now), action, now);
    this.worlds.set(next.buildingId, next);
    return next;
  }
}

/**
 * Supabase (table `worlds`): one versioned document per building. `apply` re-reads and retries when another
 * request changed the world in between, so concurrent players never overwrite each other.
 */
class SupabaseStore implements WorldStore {
  private static readonly RETRIES = 5;
  constructor(private readonly db: NonNullable<ReturnType<typeof supabaseAdmin>>) {}

  private async load(building: Building): Promise<{ world: StoredWorld; version: number }> {
    const id = building.building.id;
    const { data, error } = await this.db.from('worlds').select('state, version').eq('building_id', id).maybeSingle();
    if (error) throw new Error(`Loading the world failed: ${error.message}`);
    if (data) return { world: data.state as StoredWorld, version: data.version };
    const world = createWorld(building);
    const inserted = await this.db.from('worlds').insert({ building_id: id, state: world, version: world.version });
    if (inserted.error && inserted.error.code !== '23505') throw new Error(`Creating the world failed: ${inserted.error.message}`);
    return inserted.error ? this.load(building) : { world, version: world.version };
  }

  async get(building: Building, now: number) {
    const { world: loaded, version } = await this.load(building);
    // Demo players are seeded on first use and their due reactions run on every read (§9), like in memory.
    const world = runDemo(loaded, building, now);
    const pruned = prune(world, now);
    if (world !== loaded || pruned) {
      // Demo reactions or expiry changed the world: save it (if someone else saved first, theirs is as fresh).
      await this.db.from('worlds').update({ state: world, version: world.version, updated_at: new Date(now).toISOString() })
        .eq('building_id', world.buildingId).eq('version', version);
    }
    return world;
  }

  async apply(building: Building, action: WorldAction, now: number) {
    for (let attempt = 0; attempt < SupabaseStore.RETRIES; attempt++) {
      const { world: loaded, version } = await this.load(building);
      const world = runDemo(loaded, building, now);
      prune(world, now);
      const next = scheduleDemo(applyAction(world, action, building, now), action, now);
      const { data, error } = await this.db
        .from('worlds')
        .update({ state: next, version: next.version, updated_at: new Date(now).toISOString() })
        .eq('building_id', next.buildingId)
        .eq('version', version)
        .select('version');
      if (error) throw new Error(`Saving the world failed: ${error.message}`);
      if (data.length) return next;
    }
    throw new Error('The world is busy; try again.');
  }
}

const db = supabaseAdmin();
export const worldStore: WorldStore = db ? new SupabaseStore(db) : new MemoryStore();
