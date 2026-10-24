'use client';

import type { Building } from '@/lib/buildings/types';

/** Spaces grouped by floor, optionally with the stairs and lifts first. Values are space or connector ids. */
export function SpaceSelect({ building, value, onChange, connectors = false, empty, id }: {
  building: Building;
  value: string;
  onChange(id: string): void;
  connectors?: boolean;
  empty?: string;
  id?: string;
}) {
  const floors = [...building.floors].sort((a, b) => a.level - b.level);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });
  return (
    <select id={id} value={value} onChange={event => onChange(event.target.value)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {connectors && building.vertical_connectors.length > 0 && (
        <optgroup label="Stairs and lifts">
          {[...building.vertical_connectors].sort(byName).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </optgroup>
      )}
      {floors.map(floor => (
        <optgroup key={floor.id} label={floor.name}>
          {building.spaces.filter(s => s.floor_id === floor.id && s.type !== 'stair' && s.type !== 'lift').sort(byName).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
