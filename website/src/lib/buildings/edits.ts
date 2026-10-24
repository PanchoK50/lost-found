// Server-side only. Building edits made by conversation (Supabase `building_edits`), replayed on the plan so
// the viewer shows what the agent sees: new doors, moved assets, renamed rooms, corrected scale.
// Mirrors lostfound/core/edits.py.
import type { Building } from './types';
import { supabaseAdmin } from '@/lib/supabase/server';

type Edit =
  | { action: 'close' | 'reopen'; element_id: string }
  | { action: 'add_door'; opening: Building['openings'][number] }
  | { action: 'move_asset'; asset_id: string; to_space_id: string; position: [number, number] }
  | { action: 'rename_room'; space_id: string; ref?: string; name: string }
  | { action: 'set_room_type'; space_id: string; room_type: string }
  | { action: 'set_door_width'; opening_id: string; width_m: number }
  | { action: 'rescale'; factor: number };

export async function loadEdits(buildingId: string): Promise<Edit[]> {
  const db = supabaseAdmin();
  if (!db) return [];
  const { data } = await db.from('building_edits').select('action').eq('building_id', buildingId).order('id');
  return (data ?? []).map(row => row.action as Edit).filter(edit => edit && typeof edit === 'object');
}

/** A copy of the building with the edits applied, plus the ids closed by them. */
export function applyEdits(base: Building, edits: Edit[]): { building: Building; closed: string[] } {
  if (!edits.length) return { building: base, closed: [] };
  const building = structuredClone(base);
  const closed = new Set<string>();
  const spaces = new Map(building.spaces.map(s => [s.id, s]));
  const round = (v: number) => Math.round(v * 1000) / 1000;
  for (const edit of edits) {
    switch (edit.action) {
      case 'close': closed.add(edit.element_id); break;
      case 'reopen': closed.delete(edit.element_id); break;
      case 'add_door':
        if (!building.openings.some(o => o.id === edit.opening.id) && edit.opening.space_ids.every(id => id === 'outside' || spaces.has(id))) building.openings.push(edit.opening);
        break;
      case 'move_asset': {
        const asset = building.assets.find(a => a.id === edit.asset_id), to = spaces.get(edit.to_space_id);
        if (asset && to) Object.assign(asset, { space_id: to.id, floor_id: to.floor_id, position: edit.position });
        break;
      }
      case 'rename_room': { const s = spaces.get(edit.space_id); if (s) Object.assign(s, { ref: edit.ref ?? s.ref, name: edit.name }); break; }
      case 'set_room_type': { const s = spaces.get(edit.space_id); if (s) s.room_type = edit.room_type; break; }
      case 'set_door_width': { const o = building.openings.find(x => x.id === edit.opening_id); if (o) o.width_m = edit.width_m; break; }
      case 'rescale': {
        const f = edit.factor, scale = (p: [number, number]): [number, number] => [round(p[0] * f), round(p[1] * f)];
        for (const s of building.spaces) s.polygon = s.polygon.map(scale);
        for (const o of building.openings) { o.position = scale(o.position); o.width_m = round(o.width_m * f); }
        for (const a of building.assets) {
          a.position = scale(a.position);
          const fp = (a as { footprint?: { width_m: number; depth_m: number } }).footprint;
          if (fp) { fp.width_m = round(fp.width_m * f); fp.depth_m = round(fp.depth_m * f); }
        }
        break;
      }
    }
  }
  return { building, closed: [...closed] };
}
