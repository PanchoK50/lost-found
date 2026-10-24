// Server-side only: tell browsers that a building's world changed (Supabase Realtime broadcast). The message
// carries only the version; browsers then fetch their own filtered view from /api/world, so privacy rules hold.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

export const worldTopic = (buildingId: string) => `world:${buildingId}`;

export async function notifyChanged(buildingId: string, version: number): Promise<void> {
  if (!url || !secretKey) return;
  await fetch(`${url}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: secretKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic: worldTopic(buildingId), event: 'changed', payload: { version }, private: false }] }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined); // a missed signal is caught by the clients' periodic refresh
}
