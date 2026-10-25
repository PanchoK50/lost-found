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
export function VoiceAgent({ actions }: { actions: VoiceActions }) {
  return (
    <ConversationProvider>
      <Bubble actions={actions} />
    </ConversationProvider>
  );
}

function Bubble({ actions }: { actions: VoiceActions }) {
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

  return (
    <div className={`voice-agent${live ? ' is-live' : ''}${conversation.isSpeaking ? ' is-speaking' : ''}`}>
      {(line || error) && (
        <p className={`voice-line${error ? ' voice-line--error' : ''}`}>{error ?? <><strong>{line!.who === 'you' ? 'You' : 'Assistant'}</strong> {line!.text}</>}</p>
      )}
      <div className="voice-controls">
        {live ? <>
          <span className="voice-orb" aria-hidden><i /><i /><i /></span>
          <span className="voice-state">{conversation.status === 'connecting' ? 'Connecting…' : conversation.isSpeaking ? 'Speaking…' : 'Listening…'}</span>
          <button type="button" className="voice-end" onClick={() => { conversation.endSession(); setLine(null); }}>End</button>
        </> : (
          <button type="button" className="voice-start" onClick={() => void start()} disabled={starting}>
            <span className="voice-mic" aria-hidden />{starting ? 'Starting…' : 'Talk to the building'}
          </button>
        )}
      </div>
    </div>
  );
}
