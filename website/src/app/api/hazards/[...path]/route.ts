import { supabaseConfigured, userFrom } from '@/lib/supabase/server';

const AGENT_URL = process.env.LOSTFOUND_API_URL ?? 'http://127.0.0.1:8000';
const ALLOWED = new Set(['simulate', 'classify', 'readiness', 'sensors']);

/** Proxy to the agent's hazard endpoints (spread, impact, evacuation, playbook, readiness, photo assessment). */
async function forward(request: Request, path: string[]) {
  const name = path.join('/');
  if (!ALLOWED.has(name)) return Response.json({ error: 'Unknown hazard endpoint.' }, { status: 404 });
  // Photo assessment calls Claude: only for signed-in people when accounts are on.
  if (name === 'classify' && supabaseConfigured && !(await userFrom(request))) {
    return Response.json({ error: 'Sign in (pick a name under “Who are you?”) to report damage.' }, { status: 401 });
  }
  const url = new URL(request.url);
  try {
    const res = await fetch(`${AGENT_URL}/hazards/${name}${url.search}`, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body: request.method === 'POST' ? await request.text() : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return Response.json({ error: 'The building agent is not running.' }, { status: 503 });
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
