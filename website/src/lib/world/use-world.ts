import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import { durationMs, settingsFor, type Profile } from './profile';
import { initialsOf } from './rules';
import { authHeader, supabaseBrowser } from '@/lib/supabase/browser';
import type { Audience, WorldAction, WorldState } from './types';

/** Safety refresh (expired pins and pings, a missed signal). Changes themselves arrive over Realtime. */
const REFRESH_MS = 60_000;
/** Without Supabase (local work) there is no Realtime: fall back to polling. */
const POLL_MS = 2000;
const ONLINE_CHANNEL = 'online';
type Act = (action: DistributiveOmit<WorldAction, 'buildingId'>) => Promise<{ ok: true } | { ok: false; error: string }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The shared world for one building. With Supabase it does not poll: it loads once, listens on a Realtime
 * channel for "changed" signals from the server and then fetches its own view (204 when nothing changed),
 * refreshes once a minute and when the tab becomes visible, and gets who is online from Realtime Presence
 * (no database traffic). Without Supabase it polls every 2 s. Also keeps the server's copy of this player and
 * their presence in sync with the profile.
 */
export function useWorld(building: Building, profile: Profile | null): { world?: WorldState; act: Act } {
  const buildingId = building.building.id;
  const playerId = profile?.id;
  const [world, setWorld] = useState<WorldState>();
  const version = useRef(0);
  const profileRef = useRef(profile);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  const [online, setOnline] = useState<string[]>([]);
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

  // Loading: once, then on Realtime "changed" signals, a safety refresh, and when the tab comes back.
  useEffect(() => {
    if (!playerId) return;
    let alive = true;
    version.current = 0;
    const load = async () => {
      try {
        const params = new URLSearchParams({ buildingId, playerId, since: String(version.current) });
        const res = await fetch(`/api/world?${params}`, { cache: 'no-store', headers: await authHeader() });
        if (alive && res.status === 200) accept(await res.json());
      } catch { /* offline for a moment; the next signal or refresh retries */ }
    };
    void load();
    const client = supabaseBrowser();
    const channel = client?.channel(`world:${buildingId}`)
      .on('broadcast', { event: 'changed' }, ({ payload }) => { if (!(payload?.version <= version.current)) void load(); })
      .subscribe(status => { if (status === 'SUBSCRIBED') void load(); });
    const timer = setInterval(load, client ? REFRESH_MS : POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (channel) void client!.removeChannel(channel);
    };
  }, [buildingId, playerId, accept]);

  // Online: Realtime Presence, independent of location sharing. Lives in Supabase's realtime server, not the database.
  useEffect(() => {
    const client = supabaseBrowser();
    if (!client || !playerId) return;
    const channel = client.channel(ONLINE_CHANNEL, { config: { presence: { key: playerId } } });
    channel
      .on('presence', { event: 'sync' }, () => setOnline(Object.keys(channel.presenceState()).sort()))
      .subscribe(status => { if (status === 'SUBSCRIBED') void channel.track({ playerId, at: Date.now() }); });
    return () => { void client.removeChannel(channel); };
  }, [playerId]);

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

  const merged = useMemo(() => world && { ...world, online }, [world, online]);
  return { world: merged, act };
}
