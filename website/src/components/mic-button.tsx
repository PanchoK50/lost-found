'use client';

import { useEffect, useRef, useState } from 'react';

const MAX_SECONDS = 60;

/** Click to record, click again to stop; the transcript is handed to `onTranscript`. Esc cancels a recording. */
export function MicButton({ onTranscript, onError }: { onTranscript: (text: string) => void; onError?: (message: string) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (state !== 'recording') return;
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_SECONDS) recorder.current?.stop();
    }, 250);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { cancelled.current = true; recorder.current?.stop(); } };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(timer); window.removeEventListener('keydown', onKey); };
  }, [state]);

  useEffect(() => () => recorder.current?.stream.getTracks().forEach(track => track.stop()), []);

  async function start() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError?.('Microphone access was blocked. Allow it in the browser to talk.');
      return;
    }
    const chunks: Blob[] = [];
    const media = new MediaRecorder(stream);
    media.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    media.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      recorder.current = null;
      if (cancelled.current || !chunks.length) { setState('idle'); return; }
      setState('transcribing');
      try {
        const form = new FormData();
        form.append('audio', new Blob(chunks, { type: media.mimeType }), 'speech');
        const response = await fetch('/api/transcribe', { method: 'POST', body: form });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Could not transcribe that.');
        if (data.text) onTranscript(data.text);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : 'Could not transcribe that.');
      } finally {
        setState('idle');
      }
    };
    cancelled.current = false;
    recorder.current = media;
    setSeconds(0);
    media.start();
    setState('recording');
  }

  const label = state === 'recording' ? `Stop recording (${seconds}s)` : state === 'transcribing' ? 'Transcribing…' : 'Talk instead of typing';
  return (
    <button
      type="button" className={`mic-button ${state}`} aria-label={label} title={label} disabled={state === 'transcribing'}
      onClick={() => (state === 'recording' ? recorder.current?.stop() : start())}
    >
      {state === 'transcribing' ? <span className="mic-spinner" /> : state === 'recording' ? <span className="mic-stop" /> : (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      )}
      {state === 'recording' && <span className="mic-time">{seconds}s</span>}
    </button>
  );
}
