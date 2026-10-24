'use client';

import { useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { Settings } from '@/lib/world/profile';
import type { Ping, Player, WorldState } from '@/lib/world/types';
import type { WorldActions } from './world-hud';

const kindLabel: Record<Ping['kind'], string> = {
  come_to_me: 'Come to me', meet_halfway: 'Meet halfway', pick_up: 'Please pick up', help: 'Needs help', ask: 'Asks you', ask_crowd: 'Asks everyone', share_location: 'Asks where you are',
};
const MAX_TOASTS = 2;

type Toast =
  | { key: string; type: 'incoming'; ping: Ping; from?: Player }
  | { key: string; type: 'update'; ping: Ping; who?: Player; text: string };

/**
 * Toasts under the HUD (docs/MULTIPLAYER.md §11): pings addressed to me with Go / Later, and news about
 * pings I sent (accepted, arrived, answered). At most two at once; "+n" opens the people sheet.
 */
export function Inbox({ world, playerId, building, pingFrom, groups, top, act, onGo, onMore, onShareLocation }: {
  world?: WorldState;
  playerId: string;
  building: Building;
  pingFrom: Settings['pingFrom'];
  groups: string[];
  /** Pixels from the top: right under the HUD. */
  top: number;
  act: WorldActions['act'];
  onGo(spaceId: string): void;
  onMore(): void;
  /** "Share location" on a "where are you?" request: open the location picker. */
  onShareLocation(): void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [answer, setAnswer] = useState<Record<string, string>>({});
  if (!world) return null;
  const toasts = inboxToasts(world, playerId, pingFrom, groups).filter(t => !dismissed.has(t.key));
  if (!toasts.length) return null;
  const dismiss = (key: string) => setDismissed(d => new Set(d).add(key));
  const spaceName = (id: string) => building.spaces.find(s => s.id === id)?.name ?? 'somewhere';

  return (
    <div className="inbox" style={{ top }} aria-live="polite">
      {toasts.slice(0, MAX_TOASTS).map(t => t.type === 'incoming' ? (
        <div key={t.key} className="toast">
          <span className={`person-dot${t.from?.demo ? ' person-dot--demo' : ''}`}>{t.from?.initials ?? '?'}</span>
          <div className="toast-body">
            <strong>{t.from?.name ?? 'Someone'} · {kindLabel[t.ping.kind]}</strong>
            <small>{t.ping.kind === 'share_location' ? 'Share your location with the team?' : isQuestion(t.ping) ? `"${t.ping.message}"` : `${spaceName(t.ping.spaceId)}${t.ping.message ? ` · ${t.ping.message}` : ''}`}</small>
            {t.ping.kind === 'share_location' ? (
              <span className="toast-actions">
                <button type="button" className="button button--primary" onClick={() => { void act({ type: 'ping.update', pingId: t.ping.id, playerId, status: 'accepted' }); dismiss(t.key); onShareLocation(); }}>Share location</button>
                <button type="button" className="button" onClick={() => { void act({ type: 'ping.update', pingId: t.ping.id, playerId, status: 'declined' }); dismiss(t.key); }}>Not now</button>
              </span>
            ) : isQuestion(t.ping) ? (
              <form className="toast-actions" onSubmit={event => {
                event.preventDefault();
                const text = answer[t.key]?.trim();
                if (!text) return;
                void act({ type: 'ping.update', pingId: t.ping.id, playerId, answer: text }).then(() => dismiss(t.key));
              }}>
                <input value={answer[t.key] ?? ''} maxLength={300} placeholder="Your answer" onChange={e => setAnswer(a => ({ ...a, [t.key]: e.target.value }))} />
                <button type="submit" className="button button--primary">Send</button>
                <button type="button" className="button" onClick={() => dismiss(t.key)}>Later</button>
              </form>
            ) : (
              <span className="toast-actions">
                <button type="button" className="button button--primary" onClick={() => { void act({ type: 'ping.update', pingId: t.ping.id, playerId, status: 'accepted' }); dismiss(t.key); onGo(t.ping.spaceId); }}>Go</button>
                <button type="button" className="button" onClick={() => dismiss(t.key)}>Later</button>
              </span>
            )}
          </div>
        </div>
      ) : (
        <div key={t.key} className="toast toast--update">
          <span className={`person-dot${t.who?.demo ? ' person-dot--demo' : ''}`}>{t.who?.initials ?? '✓'}</span>
          <div className="toast-body">
            <strong>{t.text}</strong>
            <small>{kindLabel[t.ping.kind]} · {spaceName(t.ping.spaceId)}</small>
          </div>
          <button type="button" className="sheet-close" onClick={() => dismiss(t.key)} aria-label="Dismiss">✕</button>
        </div>
      ))}
      {toasts.length > MAX_TOASTS && <button type="button" className="toast-more" onClick={onMore}>+{toasts.length - MAX_TOASTS} more</button>}
    </div>
  );
}

/** Pings answered with text instead of going somewhere. */
export const isQuestion = (ping: Ping) => ping.kind === 'ask' || ping.kind === 'ask_crowd';

/** Everything the inbox could show right now, newest first. Keys change when a ping changes, so news shows again. */
export function inboxToasts(world: WorldState, playerId: string, pingFrom: Settings['pingFrom'], groups: string[]): Toast[] {
  const players = new Map(world.players.map(p => [p.id, p]));
  const allowed = (ping: Ping) => {
    if (pingFrom === 'nobody') return false;
    if (pingFrom === 'groups') return ping.to.startsWith('group:') || (players.get(ping.fromId)?.groups ?? []).some(g => groups.includes(g));
    return true;
  };
  const toasts: Toast[] = [];
  for (const ping of [...world.pings].sort((a, b) => b.createdAt - a.createdAt)) {
    if (ping.fromId !== playerId) {
      const answered = ping.answers?.some(a => a.playerId === playerId) || ping.responses?.some(r => r.playerId === playerId);
      if (ping.status === 'sent' && !answered && allowed(ping)) toasts.push({ key: `in:${ping.id}`, type: 'incoming', ping, from: players.get(ping.fromId) });
      continue;
    }
    // Group pings: news per person who reacted.
    for (const r of ping.responses ?? []) {
      const who = players.get(r.playerId);
      const name = who?.name ?? 'Someone';
      const text = r.status === 'declined' ? `${name} can't come right now` : r.status === 'done' ? `${name} arrived` : `${name} is on the way`;
      toasts.push({ key: `rs:${ping.id}:${r.playerId}:${r.status}`, type: 'update', ping, who, text });
    }
    // My own pings: tell me when someone reacts.
    for (const a of ping.answers ?? []) {
      const who = players.get(a.playerId);
      toasts.push({ key: `ans:${ping.id}:${a.at}`, type: 'update', ping, who, text: `${who?.name ?? 'Someone'}: ${a.text}` });
    }
    if (ping.status === 'accepted' || ping.status === 'done' || ping.status === 'declined') {
      const who = ping.to.startsWith('player:') ? players.get(ping.to.slice(7)) : undefined;
      const name = who?.name ?? (ping.to.startsWith('group:') ? `Someone from ${ping.to.slice(6).replaceAll('-', ' ')}` : 'Someone');
      if (ping.kind === 'share_location' && ping.status === 'accepted') continue; // only "shared" or "not now" is news
      const text = ping.kind === 'share_location'
        ? (ping.status === 'done' ? `${name} shared their location` : `${name} isn't sharing right now`)
        : ping.status === 'declined' ? `${name} can't come right now`
        : ping.status === 'done' ? (ping.kind === 'pick_up' ? `${name} picked it up` : `${name} arrived`)
        : `${name} is on the way`;
      toasts.push({ key: `st:${ping.id}:${ping.status}`, type: 'update', ping, who, text });
    }
  }
  return toasts;
}
