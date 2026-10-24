'use client';

import { useEffect, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import { saveProfile, type Profile, type SentRecord, type Settings } from '@/lib/world/profile';
import type { WorldState } from '@/lib/world/types';
import { inboxToasts, isQuestion } from './inbox';
import { Sheet } from './sheet';
import type { WorldActions } from './world-hud';

const kindLabel: Record<SentRecord['kind'], string> = {
  come_to_me: 'Come to me', meet_halfway: 'Meet', pick_up: 'Pick up', help: 'Help', ask: 'Question', ask_crowd: 'Question to everyone',
};

/**
 * Everything between me and other people here: pings waiting for me, and what I asked or sent others,
 * with their answers. My side is kept in my profile, so it survives reloads and the server's expiry.
 */
export function MessagesSheet({ building, profile, world, pingFrom, act, onGo, onClose }: {
  building: Building;
  profile: Profile;
  world?: WorldState;
  pingFrom: Settings['pingFrom'];
  act: WorldActions['act'];
  onGo(spaceId: string): void;
  onClose(): void;
}) {
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  // Opening Messages marks everything as read.
  useEffect(() => { saveProfile({ ...profile, messagesSeenAt: Date.now() }); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per opening
  const incoming = world ? inboxToasts(world, profile.id, pingFrom, profile.groups).filter(t => t.type === 'incoming' && !answered.has(t.ping.id)) : [];
  const sent = profile.sent.filter(r => r.buildingId === building.building.id);
  const spaceName = (id: string) => building.spaces.find(s => s.id === id)?.name ?? '';

  return (
    <Sheet title="Messages" onClose={onClose}>
      <section>
        <h3>For you</h3>
        {incoming.length ? incoming.map(t => t.type === 'incoming' && (
          <div key={t.key} className="message">
            <p className="message-head"><span className={`person-dot${t.from?.demo ? ' person-dot--demo' : ''}`}>{t.from?.initials ?? '?'}</span><strong>{t.from?.name ?? 'Someone'}</strong><small>{when(t.ping.createdAt)}</small></p>
            <p className="message-text">{isQuestion(t.ping) ? t.ping.message : `${kindLabel[t.ping.kind]} · ${spaceName(t.ping.spaceId)}${t.ping.message ? ` · ${t.ping.message}` : ''}`}</p>
            {isQuestion(t.ping) ? (
              <form className="toast-actions" onSubmit={event => {
                event.preventDefault();
                const text = answer[t.ping.id]?.trim();
                if (!text) return;
                void act({ type: 'ping.update', pingId: t.ping.id, playerId: profile.id, answer: text }).then(() => setAnswered(a => new Set(a).add(t.ping.id)));
              }}>
                <input value={answer[t.ping.id] ?? ''} maxLength={300} placeholder="Your answer" onChange={e => setAnswer(a => ({ ...a, [t.ping.id]: e.target.value }))} />
                <button type="submit" className="button button--primary">Send</button>
              </form>
            ) : (
              <span className="toast-actions"><button type="button" className="button button--primary" onClick={() => { void act({ type: 'ping.update', pingId: t.ping.id, playerId: profile.id, status: 'accepted' }); onGo(t.ping.spaceId); onClose(); }}>Go</button></span>
            )}
          </div>
        )) : <p className="hint">Nothing waiting for you.</p>}
      </section>

      <section>
        <h3>You asked</h3>
        {sent.length ? sent.map(r => (
          <div key={r.id} className="message">
            <p className="message-head"><strong>To {r.to}</strong><small>{kindLabel[r.kind]} · {when(r.createdAt)}</small><span className={`message-status message-status--${statusOf(r).tone}`}>{statusOf(r).label}</span></p>
            {(r.message || r.place) && <p className="message-text">{r.message ?? r.place}</p>}
            {r.answers.map(a => <p key={a.at} className="message-answer"><strong>{a.name}</strong> {a.text}</p>)}
          </div>
        )) : <p className="hint">Questions and pings you send show up here, with their answers. Try &ldquo;@Tom where is the key?&rdquo; in the chat.</p>}
      </section>
    </Sheet>
  );
}

function statusOf(r: SentRecord): { label: string; tone: 'wait' | 'ok' | 'off' } {
  if (r.answers.length) return { label: r.answers.length === 1 ? 'Answered' : `${r.answers.length} answers`, tone: 'ok' };
  if (r.status === 'accepted') return { label: 'On the way', tone: 'ok' };
  if (r.status === 'done') return { label: 'Done', tone: 'ok' };
  if (r.status === 'declined') return { label: 'Declined', tone: 'off' };
  return { label: 'Waiting', tone: 'wait' };
}

function when(at: number) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
