// Speech to text: the browser posts recorded audio, we forward it to ElevenLabs Scribe so the API key stays server-side.
const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return Response.json({ error: 'Voice input is not set up: add ELEVENLABS_API_KEY to website/.env.local.' }, { status: 503 });

  const audio = (await request.formData()).get('audio');
  if (!(audio instanceof Blob) || audio.size === 0) return Response.json({ error: 'No audio received.' }, { status: 400 });
  if (audio.size > MAX_BYTES) return Response.json({ error: 'Recording too long.' }, { status: 413 });

  const body = new FormData();
  body.append('model_id', 'scribe_v2');
  body.append('tag_audio_events', 'false');
  // Browsers record webm (Chrome, Firefox) or mp4 (Safari); keep the real extension so the format is detected.
  const extension = audio.type.split(';')[0].split('/')[1] || 'webm';
  body.append('file', audio, `speech.${extension}`);
  const response = await fetch(ELEVENLABS_URL, { method: 'POST', headers: { 'xi-api-key': apiKey }, body });
  if (!response.ok) {
    console.error('ElevenLabs speech-to-text failed', response.status, await response.text());
    return Response.json({ error: 'Could not transcribe that. Try again.' }, { status: 502 });
  }
  const { text } = (await response.json()) as { text?: string };
  return Response.json({ text: (text ?? '').trim() });
}
