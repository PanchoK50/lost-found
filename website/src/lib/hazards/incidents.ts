'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Incident } from './types';

/**
 * Live incidents. For now they live in the browser (localStorage) and reach every open tab at once through a
 * BroadcastChannel, so a report on one screen sounds the alarm on the others; Supabase comes next.
 */
const KEY = 'lf-incidents';
const CHANNEL = 'lf-incidents';

function read(): Incident[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Incident[]; } catch { return []; }
}

// localStorage as an external store: one parsed snapshot per stored string, re-read on any change.
let cachedRaw: string | null = null;
let cached: Incident[] = [];
const EMPTY: Incident[] = [];
function snapshot(): Incident[] {
  const raw = localStorage.getItem(KEY);
  if (raw !== cachedRaw) { cachedRaw = raw; cached = read(); }
  return cached;
}
const listeners = new Set<() => void>();
const arrivals = new Set<(incident: Incident) => void>();
let channel: BroadcastChannel | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type: 'raised' | 'changed'; incident?: Incident }>) => {
      listeners.forEach(l => l());
      if (event.data.type === 'raised' && event.data.incident) arrivals.forEach(a => a(event.data.incident!));
    };
  }
  return () => { listeners.delete(listener); };
}

function save(next: Incident[], message: { type: 'raised' | 'changed'; incident?: Incident }) {
  localStorage.setItem(KEY, JSON.stringify(next.slice(-50)));
  listeners.forEach(l => l());
  const out = new BroadcastChannel(CHANNEL);
  out.postMessage(message);
  out.close();
}

export function useIncidents(buildingId: string) {
  const all = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const [arrived, setArrived] = useState<Incident | null>(null);
  useEffect(() => {
    const onArrival = (incident: Incident) => setArrived(incident);
    arrivals.add(onArrival);
    return () => { arrivals.delete(onArrival); };
  }, []);
  const raise = useCallback((incident: Incident) => save([...read(), incident], { type: 'raised', incident }), []);
  const setStatus = useCallback((id: string, status: Incident['status']) => save(read().map(i => (i.id === id ? { ...i, status } : i)), { type: 'changed' }), []);
  const clearArrived = useCallback(() => setArrived(null), []);
  const active = useMemo(() => all.filter(i => i.buildingId === buildingId && i.status !== 'resolved'), [all, buildingId]);
  return { active, raise, setStatus, arrived, clearArrived };
}

/** A short two-tone alarm (Web Audio), played when an incident arrives. */
export function playAlarm() {
  try {
    const context = new AudioContext();
    for (let i = 0; i < 4; i++) {
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = i % 2 ? 660 : 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime + i * 0.28);
      gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + i * 0.28 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + i * 0.28 + 0.25);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + i * 0.28);
      oscillator.stop(context.currentTime + i * 0.28 + 0.26);
    }
    setTimeout(() => void context.close(), 1600);
  } catch { /* no audio: the banner still shows */ }
}
