import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase/server';

/**
 * Demo logins without a sign-up flow (accounts from scripts/create_demo_users.py). The shared demo password
 * stays on the server: the browser picks a name and gets a normal Supabase session back.
 */
const DEMO_DOMAIN = 'lostfound.demo';

// GET /api/demo-login → [{ username, displayName, role }]
export async function GET() {
  const db = supabaseAdmin();
  if (!db) return Response.json([]);
  const { data, error } = await db.from('profiles').select('username, display_name, role').order('created_at');
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data.map(p => ({ username: p.username, displayName: p.display_name, role: p.role })));
}

// POST /api/demo-login { username } → { session: { access_token, refresh_token }, profile }
export async function POST(request: Request) {
  const db = supabaseAdmin();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, password = process.env.DEMO_PASSWORD;
  if (!db || !url || !key || !password) return Response.json({ error: 'Demo logins are not configured.' }, { status: 503 });
  let username: unknown;
  try { ({ username } = await request.json()); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  if (typeof username !== 'string' || !/^[a-z]{2,20}$/.test(username)) return Response.json({ error: 'Unknown demo user.' }, { status: 400 });

  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).auth;
  const { data, error } = await auth.signInWithPassword({ email: `${username}@${DEMO_DOMAIN}`, password });
  if (error || !data.session) return Response.json({ error: 'Unknown demo user.' }, { status: 401 });
  const { data: profile } = await db.from('profiles').select('username, display_name, role, groups').eq('id', data.user.id).single();
  return Response.json({
    session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
    profile: { id: data.user.id, username, displayName: profile?.display_name ?? username, role: profile?.role ?? 'member', groups: profile?.groups ?? [] },
  });
}
