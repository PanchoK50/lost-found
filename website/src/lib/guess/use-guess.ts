'use client';

import { useCallback, useEffect, useState } from 'react';
import { authHeader, supabaseBrowser } from '@/lib/supabase/browser';
import type { DuelView } from './duel';
import type { PhotoSpot } from './spots';

/** Identity sent with every game request (checked against the signed-in account when Supabase is on). */
export interface Me { id: string; name: string }

async function call<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { ...init, headers: { 'Content-Type': 'application/json', ...(await authHeader()), ...init?.headers }, cache: 'no-store' });
  const data = await res.json().catch(() => ({ error: 'Something went wrong.' }));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
  return data as T;
}

/** The building's community photos; refreshed every 30 s and after uploads. */
export function useSpots(buildingId: string) {
  const [spots, setSpots] = useState<PhotoSpot[]>();
  const reload = useCallback(async () => {
    try { setSpots((await call<{ spots: PhotoSpot[] }>(`/api/guess/spots?buildingId=${encodeURIComponent(buildingId)}`)).spots); } catch { /* keep the last list */ }
  }, [buildingId]);
  useEffect(() => {
    let alive = true;
    const load = async () => { if (alive) await reload(); };
    void load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [reload]);
  return { spots, reload };
}

export async function uploadSpot(body: { buildingId: string; pick: { floorId: string; spaceId: string; position: [number, number] }; caption?: string; image: string; player: Me }) {
  return (await call<{ spot: PhotoSpot }>('/api/guess/spots', { method: 'POST', body: JSON.stringify(body) })).spot;
}

export async function deleteSpot(buildingId: string, id: string, me: Me) {
  await call(`/api/guess/spots?buildingId=${encodeURIComponent(buildingId)}&id=${encodeURIComponent(id)}&playerId=${encodeURIComponent(me.id)}`, { method: 'DELETE' });
}

export type DuelPost =
  | { type: 'create'; buildingId: string }
  | { type: 'join' | 'bot' | 'leave' | 'start'; id: string }
  | { type: 'guess'; id: string; pick: { floorId: string; spaceId: string; position: [number, number] } };

export async function postDuel(action: DuelPost, me: Me) {
  return call<{ duel: DuelView; now: number }>('/api/guess/duels', { method: 'POST', body: JSON.stringify({ ...action, player: me }) });
}

export async function openDuels(buildingId: string) {
  return (await call<{ open: { id: string; hostId: string; players: { id: string; name: string; bot?: boolean }[]; createdAt: number }[] }>(`/api/guess/duels?buildingId=${encodeURIComponent(buildingId)}`)).open;
}

/**
 * One duel, kept fresh: polls every second (timers resolve on the server when someone reads), and with
 * Supabase also refetches on the Realtime "changed" signal.
 */
export function useDuel(id: string | undefined, me: Me | undefined) {
  const [duel, setDuel] = useState<DuelView>();
  const [error, setError] = useState<string>();
  const [offset, setOffset] = useState(0);
  const accept = useCallback((data: { duel: DuelView; now: number }) => {
    setOffset(data.now - Date.now());
    setDuel(current => (current && current.version > data.duel.version && current.id === data.duel.id ? current : data.duel));
    setError(undefined);
  }, []);
  const meId = me?.id;
  useEffect(() => {
    if (!id || !meId) return;
    let alive = true;
    const load = async () => {
      try {
        const data = await call<{ duel: DuelView; now: number }>(`/api/guess/duels?id=${encodeURIComponent(id)}&playerId=${encodeURIComponent(meId)}`);
        if (alive) accept(data);
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Lost the connection.'); }
    };
    void load();
    const timer = setInterval(load, 1000);
    const client = supabaseBrowser();
    const channel = client?.channel(`guess-duel:${id}`).on('broadcast', { event: 'changed' }, () => void load()).subscribe();
    return () => { alive = false; clearInterval(timer); if (channel) void client!.removeChannel(channel); };
  }, [id, meId, accept]);
  const act = useCallback(async (action: DuelPost) => {
    if (!me) return;
    try { accept(await postDuel(action, me)); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
  }, [me, accept]);
  /** Server clock minus this one, for countdowns: server time = Date.now() + offset. */
  return { duel, error, act, offset };
}

/** A clock that ticks every `ms`, for countdowns. */
export function useTick(ms = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Shrinks a photo in the browser before upload: longest side 1600 px, JPEG. */
export async function shrinkPhoto(file: File, max = 1600): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}
