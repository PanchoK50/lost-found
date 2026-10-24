import { invalidateBuildingList } from '@/lib/buildings/catalog';
import { supabaseConfigured, userFrom } from '@/lib/supabase/server';

const AGENT_URL = process.env.LOSTFOUND_API_URL ?? 'http://127.0.0.1:8000';
const MAX_FILES = 20;
const MAX_BYTES = 4_000_000; // the request to this function is capped at 4.5 MB on Vercel

// POST /api/buildings/upload (multipart: name, files = floor_<level>.svg …) → the new building and what to check.
// The Python agent reads the plans (lostfound.ingest), verifies them and stores the building in Supabase.
export async function POST(request: Request) {
  const user = await userFrom(request);
  if (supabaseConfigured && !user) return Response.json({ error: 'Sign in to add a building.' }, { status: 401 });
  let form: FormData;
  try { form = await request.formData(); } catch { return Response.json({ error: 'Send the plans as a form upload.' }, { status: 400 }); }
  const name = String(form.get('name') ?? '').trim();
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!name || name.length > 80) return Response.json({ error: 'Give the building a name (up to 80 characters).' }, { status: 400 });
  if (!files.length || files.length > MAX_FILES) return Response.json({ error: `Choose 1 to ${MAX_FILES} floor plans (SVG).` }, { status: 400 });
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_BYTES) return Response.json({ error: 'The plans are too large together (max 4 MB).' }, { status: 413 });
  const bad = files.find(f => !/\.svg$/i.test(f.name) && f.type !== 'image/svg+xml');
  if (bad) return Response.json({ error: `${bad.name} is not an SVG. PNG and PDF plans are not supported yet.` }, { status: 400 });

  const payload = { name, created_by: user?.id ?? null, files: await Promise.all(files.map(async f => ({ name: f.name, content: await f.text() }))) };
  let agent: Response;
  try {
    agent = await fetch(`${AGENT_URL}/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store', signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return Response.json({ error: 'The plan importer is not running.' }, { status: 503 });
  }
  const data = await agent.json().catch(() => ({}));
  if (!agent.ok) return Response.json({ error: typeof data.detail === 'string' ? data.detail : 'The plans could not be imported.' }, { status: agent.status });
  invalidateBuildingList();
  return Response.json(data);
}
