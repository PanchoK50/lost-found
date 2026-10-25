/** Shapes returned by the agent's /hazards endpoints (lostfound/hazards). */

export type HazardKind = 'fire' | 'water' | 'electrical';

export const hazardMeta: Record<HazardKind, { label: string; icon: string; verb: string; color: string }> = {
  fire: { label: 'Fire', icon: '🔥', verb: 'Fire', color: '#e5484d' },
  water: { label: 'Water damage', icon: '💧', verb: 'Water', color: '#2f80ed' },
  electrical: { label: 'Electrical fault', icon: '⚡', verb: 'Power', color: '#f5a623' },
};

export interface SpreadEntry { space_id: string; kind: HazardKind; arrival_min: number; peak: number; via: string; from: string | null }
export interface Simulation { hazard: HazardKind; origin: string; minutes: number; ramp_min: Record<HazardKind, number>; spaces: SpreadEntry[]; cascades: { space_id: string; circuit: string; at_min: number; asset_ids: string[]; reason: string }[] }

export type Relation = 'origin' | 'below' | 'next door' | 'above' | 'same floor' | 'other floor';
export interface ImpactRoom {
  space_id: string; name: string; floor: string; floor_id: string; type: string; room_type: string; kind: HazardKind; relation: Relation;
  arrival_min: number; peak: number; via: string; people: number; critical_assets: { asset_id: string; name: string; type: string }[]; assets: number;
}
export interface Impact {
  hazard: HazardKind; hazard_name: string; origin: { space_id: string; name: string; floor: string; floor_id: string };
  rooms: ImpactRoom[]; assets_at_risk: { asset_id: string; name: string; type: string; space_id: string; room: string; kind: HazardKind; arrival_min: number; weight: number }[];
  people_at_risk: number; floors: string[]; by_relation: Record<Relation, number>; power_outage_spaces: number; cascades: Simulation['cascades'];
}
export interface Evacuation {
  at_min: number; blocked: string[]; lifts_off: string[]; people: number;
  rooms: { space_id: string; name: string; floor: string; people: number; distance_m: number; minutes: number; exit: string }[];
  cut_off: { space_id: string; name: string; floor: string; people: number }[];
  longest_m: number; longest_min: number;
  exits: { opening_id: string; people: number; position: [number, number]; floor_id: string; width_m: number; clear_min: number }[];
  routes: { space_id: string; name: string; exit: string; distance_m: number; polylines: { floor_id: string; level: number; points: [number, number][] }[]; space_path: string[] }[];
  /** Per room: its people and the way out as [floor_id, x, y] points, for the walking-people animation. */
  walkers: { space_id: string; people: number; distance_m: number; start_min: number; out_min?: number; exit?: string; cut_off?: boolean; path: [string, number, number][] }[];
  all_out_min: number;
  walk_m_per_min: number;
}
export interface Contact { id: string; role: string; name: string; phone: string; eta_min: number | null }
export interface PlaybookAction {
  order: number; kind: 'alarm' | 'call' | 'notify' | 'shutoff' | 'evacuate'; title: string; detail: string; auto: boolean; space_ids: string[];
  contact: Contact | null; eta_min: number | null; timeline: { at_s: number; status: string }[];
}
export interface SimulateResponse { building_id: string; simulation: Simulation; impact: Impact; evacuation: Evacuation | null; playbook: PlaybookAction[] }

export interface Assessment {
  is_damage: boolean; hazard: HazardKind | 'none'; severity: 1 | 2 | 3; confidence: number; title: string; description: string;
  signs: string[]; immediate_danger: boolean; place_hint: string;
}

export interface ReadinessFinding { id: string; severity: 'high' | 'medium' | 'low'; category: string; title: string; detail: string; space_ids: string[]; floor_ids?: string[]; rule: string; focus: string | null }
export interface Readiness { building_id: string; score: number; findings: ReadinessFinding[]; counts: Record<'high' | 'medium' | 'low', number> }

/** A live incident (reported or raised by a sensor); simulations have none. */
export interface Incident {
  id: string; buildingId: string; hazard: HazardKind; spaceId: string; severity: 1 | 2 | 3; source: 'photo' | 'report' | 'sensor';
  title: string; description: string; photo?: string; reporter?: string; createdAt: number; status: 'active' | 'contained' | 'resolved';
  /** The responder dispatched with one tap (technician, plumber, fire brigade): Reported → On the way → Fixed. */
  ticket?: { name: string; role: string; phone: string; etaMin: number | null; at: number };
  fixedAt?: number;
}

/** Level of one reached space at minute t (same ramp as lostfound/hazards/spread.py level_at). */
export function levelAt(entry: SpreadEntry, t: number, ramp: Record<HazardKind, number>) {
  if (t < entry.arrival_min) return 0;
  const r = ramp[entry.kind];
  return entry.peak * Math.min(1, r ? (t - entry.arrival_min) / r : 1);
}
