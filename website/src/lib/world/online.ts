// Server-side only: who has the app open right now, independent of location sharing.
import { supabaseAdmin } from '@/lib/supabase/server';

const ONLINE_WINDOW_MS = 45_000;   // seen within this window counts as online (the app polls every 2 s)
const WRITE_EVERY_MS = 15_000;     // at most one last_seen write per user and instance in this interval
const READ_CACHE_MS = 3_000;

const g = globalThis as { __lfLastWrite?: Map<string, number>; __lfSeen?: Map<string, number>; __lfOnline?: { at: number; ids: string[] } };
const lastWrite = (g.__lfLastWrite ??= new Map());
const seenInMemory = (g.__lfSeen ??= new Map());

/** Mark a signed-in user as seen now. */
export async function recordSeen(userId: string, now = Date.now()): Promise<void> {
  seenInMemory.set(userId, now);
  const db = supabaseAdmin();
  if (!db || now - (lastWrite.get(userId) ?? 0) < WRITE_EVERY_MS) return;
  lastWrite.set(userId, now);
  await db.from('profiles').update({ last_seen_at: new Date(now).toISOString() }).eq('id', userId);
}

/** Ids of everyone seen within the online window, sorted. */
export async function onlineIds(now = Date.now()): Promise<string[]> {
  const db = supabaseAdmin();
  if (!db) return [...seenInMemory].filter(([, at]) => now - at < ONLINE_WINDOW_MS).map(([id]) => id).sort();
  // Also count people this instance just saw, so you never miss yourself while the database read is cached.
  const local = [...seenInMemory].filter(([, at]) => now - at < ONLINE_WINDOW_MS).map(([id]) => id);
  if (!g.__lfOnline || now - g.__lfOnline.at >= READ_CACHE_MS) {
    const { data } = await db.from('profiles').select('id').gt('last_seen_at', new Date(now - ONLINE_WINDOW_MS).toISOString());
    g.__lfOnline = { at: now, ids: (data ?? []).map(row => row.id as string) };
  }
  return [...new Set([...g.__lfOnline.ids, ...local])].sort();
}
