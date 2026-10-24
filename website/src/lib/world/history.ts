import { useEffect } from 'react';
import type { Building } from '@/lib/buildings/types';
import { saveProfile, type Profile, type SentRecord } from './profile';
import type { Ping, WorldState } from './types';

const KEEP = 50;

/** Copy the pings I sent (with status and answers) into my profile, so they outlive the server's 30–60 min. */
export function useSentHistory(world: WorldState | undefined, profile: Profile | null, building: Building) {
  useEffect(() => {
    if (!world || !profile) return;
    const mine = world.pings.filter(p => p.fromId === profile.id);
    if (!mine.length) return;
    const names = new Map(world.players.map(p => [p.id, p.name]));
    const sent = [...profile.sent];
    let changed = false;
    for (const ping of mine) {
      const i = sent.findIndex(r => r.id === ping.id);
      const before = sent[i];
      const record = toRecord(ping, names, building, before);
      if (before && before.status === record.status && before.answers.length === record.answers.length) continue;
      record.updatedAt = before ? Date.now() : ping.createdAt;
      if (i >= 0) sent[i] = record; else sent.unshift(record);
      changed = true;
    }
    if (changed) saveProfile({ ...profile, sent: sent.sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP) });
  }, [world, profile, building]);
}

function toRecord(ping: Ping, names: Map<string, string>, building: Building, before?: SentRecord): SentRecord {
  const to = ping.to === 'team' || ping.to === 'everyone' || ping.to === 'nearby' ? 'Everyone here'
    : ping.to.startsWith('player:') ? names.get(ping.to.slice(7)) ?? before?.to ?? 'Someone'
    : ping.to.startsWith('group:') ? ping.to.slice(6).replaceAll('-', ' ')
    : ping.to.slice(5).replaceAll('_', ' ');
  // Keep answers we saw before even if a name is no longer visible.
  const answers = (ping.answers ?? []).map(a => ({ name: names.get(a.playerId) ?? before?.answers.find(b => b.at === a.at)?.name ?? 'Someone', text: a.text, at: a.at }));
  return {
    id: ping.id,
    buildingId: building.building.id,
    kind: ping.kind,
    to,
    message: ping.message,
    place: building.spaces.find(s => s.id === ping.spaceId)?.name,
    createdAt: ping.createdAt,
    status: ping.status,
    answers,
    updatedAt: before?.updatedAt ?? ping.createdAt,
  };
}

/** News since I last looked: answers or a status change on something I sent. */
export const unreadCount = (profile: Profile, buildingId: string) =>
  profile.sent.filter(r => r.buildingId === buildingId && r.updatedAt > profile.messagesSeenAt && (r.answers.length > 0 || r.status !== 'sent')).length;
