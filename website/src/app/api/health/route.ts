const AGENT_URL = process.env.LOSTFOUND_API_URL ?? 'http://127.0.0.1:8000';

// GET /api/health → is the Python agent up? Called when the page opens, so a cold agent starts while people
// read the start screen instead of on their first question (no Claude call, no cost).
export async function GET() {
  const started = Date.now();
  try {
    const res = await fetch(`${AGENT_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    return Response.json({ agent: res.ok, ms: Date.now() - started });
  } catch {
    return Response.json({ agent: false, ms: Date.now() - started });
  }
}
