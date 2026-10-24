// Server-side only: holds every player's world state.
import type { Building } from '@/lib/buildings/types';
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

export const worldStore: WorldStore = new MemoryStore();
