'use client';

import type { Building } from '@/lib/buildings/types';
import type { ChatResponse, RouteStep } from '@/lib/chat/contract';

/** Google-Maps-style directions: origin, maneuvers with turn icons and distances, destination. */
export function DirectionsPanel({ building, response, open, active, onStep, onOverview }: {
  building: Building;
  response: ChatResponse;
  open: boolean;
  /** `${leg}-${step}` of the step the camera is showing, if any. */
  active?: string;
  onStep(step: RouteStep, key: string): void;
  onOverview(): void;
}) {
  const legs = (response.scene.routes ?? []).filter(r => r.steps?.length && r.spacePath?.length);
  if (!legs.length) return null;
  const spaces = new Map(building.spaces.map(s => [s.id, s]));
  const floors = new Map(building.floors.map(f => [f.id, f]));
  const labels = new Map((response.scene.highlights ?? []).filter(h => h.label).map(h => [h.spaceId, h.label!]));
  const place = (id: string, fallback?: string) => {
    const space = spaces.get(id);
    return { name: space?.name ?? id, floor: space ? floors.get(space.floor_id)?.name : undefined, label: fallback };
  };
  const total = legs.reduce((n, leg) => n + leg.steps!.length, 0);

  return (
    <details className="directions" open={open || undefined}>
      <summary>
        <span>Directions · {total} steps</span>
        {active && <button type="button" className="directions-overview" onClick={event => { event.preventDefault(); onOverview(); }}>Whole route</button>}
      </summary>
      <Place kind="origin" {...place(legs[0].spacePath![0])} />
      {legs.map((leg, l) => {
        const end = leg.spacePath!.at(-1)!;
        const isLast = l === legs.length - 1;
        return (
          <div key={l}>
            <ol className="maneuvers">
              {leg.steps!.map((step, i) => {
                const key = `${l}-${i}`;
                return (
                  <li key={key}>
                    <button type="button" className={`maneuver${active === key ? ' maneuver--active' : ''}`} onClick={() => onStep(step, key)} aria-label={`${step.text}. Show on the map`}>
                      <TurnIcon action={step.action} />
                      <span className="maneuver-text">
                        {step.text}
                        {step.note && <span className="maneuver-note"><i aria-hidden>i</i>{step.note}</span>}
                      </span>
                    </button>
                    <div className="maneuver-distance"><span>{step.floors ? `${step.floors} floor${step.floors === 1 ? '' : 's'}` : formatDistance(step.distance)}</span><hr /></div>
                  </li>
                );
              })}
            </ol>
            <Place kind={isLast ? 'destination' : 'stop'} {...place(end, labels.get(end))} />
          </div>
        );
      })}
    </details>
  );
}

function Place({ kind, name, floor, label }: { kind: 'origin' | 'stop' | 'destination'; name: string; floor?: string; label?: string }) {
  // Stop labels from the scene ("Pick up stove · Kitchen 0.28") say what happens there.
  const title = kind === 'stop' && label ? label : name;
  return (
    <div className={`place place--${kind}`}>
      <span className="place-dot" aria-hidden />
      <span><strong>{title}</strong>{floor && <small>{floor}</small>}</span>
    </div>
  );
}

function formatDistance(m: number) {
  if (m < 1) return 'a few steps';
  if (m < 10) return `${Math.round(m)} m`;
  return `${Math.round(m / 5) * 5} m`;
}

const icons: Record<RouteStep['action'], string> = {
  straight: 'M12 20V5M6.5 10.5 12 5l5.5 5.5',
  'slight-right': 'M8 20v-6.5l8-8M10.5 5.5H16v5.5',
  right: 'M7 20v-7a4 4 0 0 1 4-4h8M15 5l4 4-4 4',
  'sharp-right': 'M8 4v10M8 14l9-6M11.5 6.5 17 8l-1.5 5.5',
  'slight-left': 'M16 20v-6.5l-8-8M13.5 5.5H8v5.5',
  left: 'M17 20v-7a4 4 0 0 0-4-4H5M9 5 5 9l4 4',
  'sharp-left': 'M16 4v10M16 14 7 8M12.5 6.5 7 8l1.5 5.5',
  'u-turn': 'M8 20V9a4 4 0 0 1 8 0v7M12.5 12.5 16 16l3.5-3.5',
  'stairs-up': 'M3 20h5v-4.5h4.5V11H17V6.5h4M15 3.5h5v5',
  'stairs-down': 'M3 6.5h4V11h4.5v4.5H16V20h5M20 15.5V20h-5',
  'lift-up': 'M6 3h12v18H6zM12 7.5 9.5 11h5zM9 16h6',
  'lift-down': 'M6 3h12v18H6zM12 16.5 9.5 13h5zM9 8h6',
  outside: 'M10 3H5v18h5M14 16.5l4.5-4.5L14 7.5M18.5 12H9',
  inside: 'M14 3h5v18h-5M9.5 16.5 14 12 9.5 7.5M14 12H4',
};

function TurnIcon({ action }: { action: RouteStep['action'] }) {
  return (
    <svg className="turn-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      <path d={icons[action] ?? icons.straight} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
