'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConversationProvider, useConversation } from '@elevenlabs/react';
import { authHeader } from '@/lib/supabase/browser';

/** What the voice agent can do in the app; each returns a short sentence the agent can say back. */
export interface VoiceActions {
  ask(question: string): Promise<string>;
  simulate(hazard: string, room: string): string;
  showFloor(floor: string): string;
  reportIncident(hazard: string, room: string): string;
  callFireBrigade(): string;
  clearMap(): void;
}

/**
 * Live voice agent (ElevenLabs): a floating bubble at the bottom centre of the model. Talking to it runs the same
 * tools as the chat and the panel, and everything it does shows on the map; building questions go to our own agent,
 * whose answers also appear in the chat.
 */
export function VoiceAgent({ actions, situation }: { actions: VoiceActions; situation: string }) {
  return (
    <ConversationProvider>
      <Bubble actions={actions} situation={situation} />
    </ConversationProvider>
  );
}

function Bubble({ actions, situation }: { actions: VoiceActions; situation: string }) {
  // Tools call the latest actions (the page re-renders with new state all the time).
  const latest = useRef(actions);
  useEffect(() => { latest.current = actions; });
  const [line, setLine] = useState<{ who: 'you' | 'agent'; text: string } | null>(null);
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const conversation = useConversation({
    onMessage: ({ message, source }: { message: string; source: string }) => setLine({ who: source === 'user' ? 'you' : 'agent', text: message }),
    onError: (message: string) => setError(typeof message === 'string' ? message : 'Voice connection problem.'),
  });
  const live = conversation.status === 'connected' || conversation.status === 'connecting';

  // The emergency on screen, as context for the agent: sent on connect and whenever it changes (not spoken).
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (conversation.status !== 'connected') { sent.current = null; return; }
    if (sent.current === situation) return;
    sent.current = situation;
    conversation.sendContextualUpdate(situation);
  }, [conversation, conversation.status, situation]);

  const start = useCallback(async () => {
    setError(undefined);
    setStarting(true);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const res = await fetch('/api/voice', { headers: await authHeader() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not start the voice agent.');
      conversation.startSession({
        signedUrl: data.signedUrl,
        clientTools: {
          ask_building: async ({ question }: { question: string }) => latest.current.ask(question),
          simulate: ({ hazard, room }: { hazard: string; room: string }) => latest.current.simulate(hazard, room),
          show_floor: ({ floor }: { floor: string }) => latest.current.showFloor(floor),
          report_incident: ({ hazard, room }: { hazard: string; room: string }) => latest.current.reportIncident(hazard, room),
          call_fire_brigade: () => latest.current.callFireBrigade(),
          clear_map: () => { latest.current.clearMap(); return 'Cleared.'; },
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the voice agent.');
    } finally {
      setStarting(false);
    }
  }, [conversation]);

  // The orb breathes with the voice: output volume while the agent speaks, the microphone while it listens.
  const orb = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = orb.current;
    if (!live || !node) return;
    let frame = 0, level = 0;
    const tick = () => {
      const v = conversation.isSpeaking ? conversation.getOutputVolume() : conversation.getInputVolume();
      level += ((Number.isFinite(v) ? v : 0) - level) * 0.25;
      node.style.setProperty('--level', String(Math.min(1, level * 2.2)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); node.style.setProperty('--level', '0'); };
  }, [live, conversation]);

  const label = starting ? 'Starting voice assistant' : live ? 'End voice conversation' : 'Talk to the building';
  return (
    <div className={`voice-agent${live ? ' is-live' : ''}${conversation.isSpeaking ? ' is-speaking' : ''}${starting || conversation.status === 'connecting' ? ' is-connecting' : ''}`}>
      {(line || error) && (
        <p className={`voice-line${error ? ' voice-line--error' : ''}`}>{error ?? <><strong>{line!.who === 'you' ? 'You' : 'Assistant'}</strong> {line!.text}</>}</p>
      )}
      <button ref={orb} type="button" className="voice-drop" aria-label={label} title={label} disabled={starting}
        onClick={() => { if (live) { conversation.endSession(); setLine(null); } else void start(); }}>
        <span className="voice-drop-blob voice-drop-blob--a" aria-hidden />
        <span className="voice-drop-blob voice-drop-blob--b" aria-hidden />
        <span className="voice-drop-blob voice-drop-blob--c" aria-hidden />
        <span className="voice-drop-shine" aria-hidden />
      </button>
    </div>
  );
}
