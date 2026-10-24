import { useCallback, useEffect, useRef, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import { durationMs, settingsFor, type Profile } from './profile';
import { initialsOf } from './rules';
import { authHeader } from '@/lib/supabase/browser';
import type { Audience, WorldAction, WorldState } from './types';

const POLL_MS = 2000;
type Act = (action: DistributiveOmit<WorldAction, 'buildingId'>) => Promise<{ ok: true } | { ok: false; error: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The shared world for one building: polls GET /api/world every 2 s (204 when nothing changed) and right
 * after every action. Also keeps the server's copy of this player and their presence in sync with the profile.
 */
export function useWorld(building: Building, profile: Profile | null): { world?: WorldState; act: Act } {
  const buildingId = building.building.id;
  const playerId = profile?.id;
  const [world, setWorld] = useState<WorldState>();
  const version = useRef(0);
  const profileRef = useRef(profile);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  const accept = useCallback((state: WorldState) => { version.current = state.version; setWorld(state); }, []);
  // The signed-in user's access token, kept for the page-close beacon (which cannot send headers).
  const token = useRef<string | undefined>(undefined);

  const post = useCallback(async (action: WorldAction) => {
    const auth = await authHeader();
    token.current = auth.Authorization?.slice('Bearer '.length);
    const res = await fetch('/api/world', { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(action) });
    const data = await res.json().catch(() => ({ error: 'Something went wrong.' }));
    if (res.ok) accept(data.state);
    return { res, data };
  }, [accept]);

  const upsertPlayer = useCallback(async () => {
    const p = profileRef.current;
    if (!p) return;
    await post({ type: 'player.upsert', buildingId, player: { id: p.id, name: p.name, role: p.role, groups: p.groups, initials: initialsOf(p.name) } });
  }, [buildingId, post]);

  const act: Act = useCallback(async action => {
    const full = { ...action, buildingId } as WorldAction;
    let { res, data } = await post(full);
    // The server forgot us (restart): introduce ourselves again and retry once.
    if (res.status === 400 && /unknown player/i.test(data.error ?? '')) { await upsertPlayer(); ({ res, data } = await post(full)); }
    return res.ok ? { ok: true } : { ok: false, error: data.error ?? 'Something went wrong.' };
  }, [buildingId, post, upsertPlayer]);

  // Polling.
  useEffect(() => {
    if (!playerId) return;
    let alive = true;
    version.current = 0;
    const poll = async () => {
      try {
        const res = await fetch(`/api/world?buildingId=${encodeURIComponent(buildingId)}&playerId=${encodeURIComponent(playerId)}&since=${version.current}`, { cache: 'no-store' });
        if (alive && res.status === 200) accept(await res.json());
      } catch { /* offline for a moment; the next poll retries */ }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [buildingId, playerId, accept]);

  // This player, whenever the name, role or groups change.
  const identity = profile && JSON.stringify([profile.id, profile.name, profile.role, profile.groups]);
  useEffect(() => { if (identity) void upsertPlayer(); }, [identity, upsertPlayer]);

  // Presence: shared from "Where am I?" with the privacy settings; cleared when sharing is off or the page closes.
  const mode = world?.mode;
  const settings = profile && mode ? settingsFor(profile, mode) : undefined;
  const room = profile?.rooms[buildingId];
  const space = room ? building.spaces.find(s => s.id === room) : undefined;
  const audience: Audience | undefined = !settings || settings.share === 'off' ? undefined
    : settings.share === 'team' ? 'team'
    : profile?.groups[0] ? `group:${profile.groups[0]}` : 'team'; // no group yet: share with the team
  const presenceKey = identity && JSON.stringify([space?.id, audience, settings?.precision, settings?.duration]);
  useEffect(() => {
    if (!presenceKey || !playerId || !settings) return;
    const run = async () => {
      if (!space || !audience) { await act({ type: 'presence.clear', playerId }); return; }
      await upsertPlayer();
      await act({ type: 'presence.set', presence: { playerId, spaceId: space.id, floorId: space.floor_id, precision: settings.precision, audience, until: Date.now() + durationMs[settings.duration] } });
    };
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- presenceKey captures everything that matters
  }, [presenceKey]);
  const leaving = settings?.duration === 'leave' && !!space && !!audience;
  useEffect(() => {
    if (!leaving || !playerId) return;
    const leave = () => navigator.sendBeacon('/api/world', JSON.stringify({ ...({ type: 'presence.clear', buildingId, playerId } satisfies WorldAction), accessToken: token.current }));
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [leaving, buildingId, playerId]);

  return { world, act };
}
