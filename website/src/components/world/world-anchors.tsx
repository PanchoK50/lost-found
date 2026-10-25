'use client';

import { useEffect, useState } from 'react';
import type { SceneFocus } from '@/lib/chat/contract';
import type { Pin, Player, Presence, WorldState } from '@/lib/world/types';
import { blockHeight, type BuildingModel, type FloorPose } from '@/components/experience/scene-model';
import type { Anchor } from '@/components/experience/building-scene';

/** Alerts, notes and people on one floor, for the badges on the floor rail. */
export function floorCounts(world: WorldState | undefined, floorId: string) {
  if (!world) return { alerts: 0, notes: 0, people: 0, summary: '' };
  const pins = world.pins.filter(p => p.floorId === floorId);
  const alerts = pins.filter(p => p.kind === 'blocked' || p.kind === 'broken').length;
  const notes = pins.length - alerts;
  const people = world.presence.filter(p => p.precision !== 'building' && p.floorId === floorId).length;
  const summary = [alerts && plural(alerts, 'alert'), notes && plural(notes, 'note'), people && plural(people, 'person', 'people')].filter(Boolean).join(' · ');
  return { alerts, notes, people, summary };
}

/**
 * The world as scene anchors (docs/MULTIPLAYER.md §11): people and pins on the floors that are shown,
 * and one count chip per floor in the building overview. Unlike answer anchors, they persist across answers.
 */
export function worldAnchors(
  model: BuildingModel,
  poses: Map<string, FloorPose>,
  focus: SceneFocus,
  world: WorldState,
  handlers: { onPin?(pinId: string): void; onPerson?(playerId: string): void; onFocusFloor(floorId: string): void },
): Anchor[] {
  const shown = (floorId: string) => (poses.get(floorId)?.opacity ?? 0) > 0.5;
  const floorModel = new Map(model.floors.map(f => [f.floor.id, f]));
  /** Just above the blocks of a floor, however flat they are drawn right now. */
  const top = (floorId: string, extra: number) => {
    const pose = poses.get(floorId), f = floorModel.get(floorId);
    return (pose?.y ?? 0) + (f && pose ? blockHeight(f.storey, pose.flat) : 0) + extra;
  };
  const visible = world.presence.filter(p => p.precision !== 'building');

  // The building overview shows no floating chips: per-floor counts are badges on the floor rail (floorCounts).
  if (focus.mode === 'building') return [];

  const players = new Map(world.players.map(p => [p.id, p]));
  const anchors: Anchor[] = [];
  // People with room precision, grouped per room.
  const byRoom = new Map<string, Presence[]>();
  for (const p of visible) if (p.precision === 'room') byRoom.set(p.spaceId, [...(byRoom.get(p.spaceId) ?? []), p]);
  for (const [spaceId, here] of byRoom) {
    const m = model.spaces.get(spaceId);
    if (!m || !shown(m.space.floor_id)) continue;
    const people = here.map(p => players.get(p.playerId)).filter((p): p is Player => !!p);
    const moving = new Set(here.filter(p => p.moving).map(p => p.playerId));
    if (!people.length) continue;
    anchors.push({
      key: `w-people-${spaceId}`,
      position: [m.centre[0], top(m.space.floor_id, 0.4), m.centre[1]],
      content: (
        <div className="scene-label scene-label--person">
          {people.slice(0, 3).map(p => (
            <button type="button" key={p.id} className="person-tap" onClick={() => handlers.onPerson?.(p.id)} aria-label={`${p.name}: room and info`}>
              <span className={`person-dot${p.demo ? ' person-dot--demo' : ''}${moving.has(p.id) ? ' person-dot--moving' : ''}`}>{p.initials}</span>
              {people.length === 1 && <span>{p.name}</span>}
            </button>
          ))}
          <span>{people.length > 3 ? `+${people.length - 3}` : ''}</span>
        </div>
      ),
    });
  }
  for (const pin of world.pins) {
    if (!shown(pin.floorId)) continue;
    const [x, z] = model.toWorld(pin.position);
    anchors.push({
      key: `w-pin-${pin.id}`,
      placement: 'above',
      position: [x, top(pin.floorId, 0.3), z],
      content: (
        <button type="button" className={`scene-label scene-label--pin-${pinStyle(pin)}${pin.status === 'unconfirmed' ? ' is-unconfirmed' : ''}`} onClick={() => handlers.onPin?.(pin.id)}>
          <Countdown pin={pin} />
          <span>{pin.title}</span>
          {pin.status === 'unconfirmed' && <small>unconfirmed</small>}
        </button>
      ),
    });
  }
  return anchors;
}

export function pinStyle(pin: Pin): 'alert' | 'item' | 'info' {
  if (pin.kind === 'blocked' || pin.kind === 'broken') return 'alert';
  return pin.kind === 'item' ? 'item' : 'info';
}

/** Ring that empties as the pin runs out (§4.1), around its icon or photo. */
export function Countdown({ pin, size = 20 }: { pin: Pin; size?: number }) {
  const left = useTimeLeft(pin.expiresAt);
  const share = Math.max(0, Math.min(1, left / Math.max(1, pin.expiresAt - pin.createdAt)));
  const r = size / 2 - 1.5, c = 2 * Math.PI * r;
  const style = pinStyle(pin);
  return (
    <span className="pin-ring" style={{ width: size, height: size }}>
      {pin.photo ? <b style={{ backgroundImage: `url(${pin.photo})` }} /> : <i>{style === 'alert' ? '!' : style === 'item' ? '◆' : ''}</i>}
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} strokeDasharray={`${c * share} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
    </span>
  );
}

/** Milliseconds until `until`, refreshed every 30 s. */
export function useTimeLeft(until: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return until - now;
}

export function formatLeft(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
