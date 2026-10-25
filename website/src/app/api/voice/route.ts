import { supabaseConfigured, userFrom } from '@/lib/supabase/server';

/**
 * A short-lived signed URL for the ElevenLabs voice agent (scripts/create_voice_agent.py), so the browser can start
 * a live conversation without ever seeing the API key. Signed-in people only when accounts are on (it uses credits).
 */
export async function GET(request: Request) {
  const key = process.env.ELEVENLABS_API_KEY, agent = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agent) return Response.json({ error: 'The voice agent is not set up (ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID).' }, { status: 503 });
  if (supabaseConfigured && !(await userFrom(request))) return Response.json({ error: 'Sign in to talk to the building.' }, { status: 401 });
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agent)}`, { headers: { 'xi-api-key': key }, cache: 'no-store' });
  if (!res.ok) return Response.json({ error: 'Could not start the voice agent.' }, { status: 502 });
  const { signed_url: signedUrl } = await res.json() as { signed_url: string };
  return Response.json({ signedUrl });
}
