// Server-side only: who is calling the game API.
import { supabaseAdmin, supabaseConfigured, userFrom } from '@/lib/supabase/server';

export type Actor = { id: string; name: string };

/**
 * With Supabase, only signed-in users play, as themselves, under their profile name (like /api/world).
 * Without it (local work), the browser's guest profile is trusted.
 */
export async function actorFrom(request: Request, claimed: Partial<Actor> | undefined): Promise<Actor | { error: string; status: number }> {
  if (!claimed?.id || typeof claimed.id !== 'string') return { error: 'Who are you? Send your player id.', status: 400 };
  if (!supabaseConfigured) return { id: claimed.id, name: String(claimed.name ?? 'Guest').slice(0, 40) };
  const user = await userFrom(request);
  if (!user) return { error: 'Sign in to take part.', status: 401 };
  if (user.id !== claimed.id) return { error: 'You can only play as yourself.', status: 403 };
  const { data } = await supabaseAdmin()!.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
  return { id: user.id, name: data?.display_name ?? String(claimed.name ?? 'Player').slice(0, 40) };
}
