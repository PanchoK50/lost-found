import type { Building } from '@/lib/buildings/types';
import { polygonArea } from '@/lib/buildings/geometry';
import type { Briefing, CrewRoute, People } from '@/components/brigade/brigade';
import type { HazardView } from '@/components/hazards/use-hazard';
import { hazardMeta, levelAt } from './types';

const list = (names: string[], max = 8) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

/**
 * The emergency on screen as plain facts for the voice co-pilot (sent as a contextual update), so "where's the fire?"
 * or "how big is the room?" is answered at once from what the map shows. Minutes are rounded to keep updates rare.
 */
export function situationSummary(building: Building, view: HazardView | null, brigade?: { briefing?: Briefing; people?: People; routes?: CrewRoute[] }): string {
  if (!view) return 'SITUATION: no active emergency or simulation on screen right now.';
  const space = (id: string) => building.spaces.find(s => s.id === id);
  const floorName = (floorId: string) => building.floors.find(f => f.id === floorId)?.name ?? '';
  const origin = space(view.spaceId);
  const kind = hazardMeta[view.hazard].label.toLowerCase();
  const minute = Math.max(0, Math.round(view.t));
  const lines = [
    `SITUATION (${view.mode === 'incident' ? 'live incident' : 'fire brigade drill, simulated; treat it as real'}), ${minute} min since the alarm:`,
  ];
  if (origin) lines.push(`- ${hazardMeta[view.hazard].label} origin: ${origin.name}, ${floorName(origin.floor_id)}, ${Math.round(polygonArea(origin.polygon))} m².`);
  const data = view.data;
  if (data) {
    const hit = data.simulation.spaces.filter(e => e.kind === view.hazard && levelAt(e, view.t, data.simulation.ramp_min) > 0.5);
    const names = hit.map(e => space(e.space_id)?.name).filter((n): n is string => Boolean(n));
    const floors = [...new Set(hit.map(e => space(e.space_id)?.floor_id).filter((f): f is string => Boolean(f)))].map(floorName);
    lines.push(`- Rooms with ${kind} now: ${hit.length}${names.length ? ` (${list(names)})` : ''}. Floors affected: ${floors.join(', ') || 'none yet'}.`);
    const evacuation = data.evacuation;
    if (evacuation) {
      lines.push(`- Evacuation: ${evacuation.people} people in the building at the alarm, everyone out after about ${Math.round(evacuation.all_out_min)} min. Lifts off.`);
      if (evacuation.cut_off.length) lines.push(`- Cut off: ${list(evacuation.cut_off.map(c => `${c.name} (${c.floor}, ${c.people} people)`), 5)}.`);
    }
    const attack = data.firefighting;
    // In a brigade drill the crew routes below (smoke at arrival) replace the simple attack route.
    if (attack && !brigade?.briefing) lines.push(`- Attack route: entrance into ${attack.entrance_room}, ${attack.stairs.length ? `via ${attack.stairs.join(', ')}, ` : ''}${Math.round(attack.distance_m)} m to the fire.`);
  }
  const briefing = brigade?.briefing;
  if (briefing) {
    const { above, below } = briefing.above_below;
    lines.push(`- Fire brigade ETA: ${briefing.eta} min (arrival at +${briefing.t_arrival} min). People still inside now: ${briefing.facts.people_inside_now}. Rooms on fire at arrival: ${briefing.facts.rooms_on_fire_at_arrival}.`);
    lines.push(`- Above the fire: ${above ? `${above.name} (${above.floor})` : 'nothing'}. Below: ${below ? `${below.name} (${below.floor})` : 'nothing'}.`);
    if (briefing.wall_neighbours.length) lines.push(`- Shares a wall with: ${list(briefing.wall_neighbours.map(n => n.name), 6)}.`);
    if (briefing.stairwells.length) lines.push(`- Stairwells now: ${briefing.stairwells.map(s => `${s.name} ${s.status_at_now}`).join(', ')}; at arrival: ${briefing.stairwells.map(s => `${s.name} ${s.status_at_arrival}`).join(', ')}.`);
    const entrance = briefing.entrances.find(e => e.recommended);
    if (entrance) lines.push(`- Recommended entrance: into ${space(entrance.into_space)?.name ?? entrance.into_space}${entrance.reason ? ` (${entrance.reason})` : ''}.`);
    if (briefing.hazards.length) lines.push(`- Hazards near the fire: ${list(briefing.hazards.map(h => `${h.name} (${h.label})`), 5)}.`);
    if (briefing.next_consequences.length) lines.push(`- Next: ${briefing.next_consequences.slice(0, 2).map(c => `+${c.t} min ${c.text}`).join('; ')}.`);
  }
  const people = brigade?.people;
  if (people?.cannot_self_evacuate.length) lines.push(`- Cannot get out alone: ${list(people.cannot_self_evacuate.map(p => `${p.person} in ${p.name} (${p.floor}, ${p.reason})`), 4)}.`);
  for (const route of brigade?.routes ?? []) {
    if (route.reachable) lines.push(`- ${route.label} to ${route.target.name}: ${Math.round(route.length_m ?? 0)} m${route.used_stairwell?.length ? ` via ${route.used_stairwell.join(', ')}` : ''}${route.stretcher_ok === false ? ', too narrow for a stretcher' : ''}.`);
  }
  lines.push('Answer from these facts directly. Use ask_building only for anything not listed here.');
  return lines.join('\n');
}
