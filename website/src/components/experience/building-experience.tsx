'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { Building } from '@/lib/buildings/types';
import type { ChatResponse, SceneDirective } from '@/lib/chat/contract';
import type { SceneInsets } from './building-scene';

const BuildingScene = dynamic(() => import('./building-scene'), { ssr: false, loading: () => <div className="scene-loading">Building the model…</div> });

type Message = { id: number; role: 'user' | 'assistant'; content: string; response?: ChatResponse; error?: boolean };

interface Props {
  building: Building;
  buildings: { id: string; name: string }[];
  suggestions: string[];
}

const overview: SceneDirective = { focus: { mode: 'building' } };

export function BuildingExperience({ building, buildings, suggestions }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [directive, setDirective] = useState<SceneDirective>(overview);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [insets, setInsets] = useState<SceneInsets>({ left: 0, bottom: 160 });
  const nextId = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const started = messages.length > 0;
  const floors = [...building.floors].sort((a, b) => b.level - a.level);
  const focusedFloor = directive.focus.mode === 'floor' ? directive.focus.floorId : undefined;

  useEffect(() => {
    const measure = () => {
      const wide = window.innerWidth > 900;
      // Keep in sync with .transcript / .dock in globals.css: side panel on desktop, bottom sheet (30vh) on mobile.
      setInsets({ left: started && wide ? 400 : 0, bottom: !started ? 220 : wide ? 110 : window.innerHeight * 0.3 + 110 });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [started]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy]);

  const showOverview = useCallback(() => setDirective(overview), []);
  const focusFloor = useCallback((floorId: string) => setDirective(current => ({ ...current, focus: { mode: 'floor', floorId } })), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') showOverview(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showOverview]);

  async function ask(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages(current => [...current, { id: nextId.current++, role: 'user', content: message }]);
    setDraft('');
    setBusy(true);
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buildingId: building.building.id, message, history }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
      const response = data as ChatResponse;
      setMessages(current => [...current, { id: nextId.current++, role: 'assistant', content: response.reply, response }]);
      setDirective(response.scene);
    } catch (error) {
      setMessages(current => [...current, { id: nextId.current++, role: 'assistant', content: error instanceof Error ? error.message : 'Something went wrong.', error: true }]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void ask(draft); };

  return (
    <main className={`experience${started ? ' experience--started' : ''}`}>
      <div className="scene"><BuildingScene building={building} directive={directive} insets={insets} onFocusFloor={focusFloor} /></div>

      <header className="hud-top">
        <Link className="brand" href="/">◈ <span>lost & found</span></Link>
        <nav className="building-switch" aria-label="Building">
          {buildings.map(b => <Link key={b.id} href={`/?building=${b.id}`} className={b.id === building.building.id ? 'active' : ''} aria-current={b.id === building.building.id ? 'page' : undefined}>{b.name}</Link>)}
        </nav>
      </header>

      <nav className="floor-rail" aria-label="Floors">
        <button type="button" className={directive.focus.mode === 'building' ? 'active' : ''} onClick={showOverview} title="Whole building (Esc)">⌂</button>
        {floors.map(floor => (
          <button type="button" key={floor.id} className={focusedFloor === floor.id ? 'active' : ''} onClick={() => focusFloor(floor.id)} title={floor.name}>{floorShort(floor.level)}</button>
        ))}
      </nav>

      {started && (
        <section className="transcript" aria-label="Conversation" aria-live="polite">
          {messages.map(message => message.role === 'user'
            ? <p key={message.id} className="bubble bubble--user">{message.content}</p>
            : <article key={message.id} className={`bubble bubble--assistant${message.error ? ' bubble--error' : ''}`}>
                {message.response?.answer && (
                  <button type="button" className="answer-card" onClick={() => setDirective(message.response!.scene)} title="Show this answer again">
                    <span className="answer-title">{message.response.answer.title}</span>
                    {message.response.answer.value && <span className="answer-value">{message.response.answer.value}</span>}
                    {message.response.answer.detail && <span className="answer-detail">{message.response.answer.detail}</span>}
                  </button>
                )}
                <p>{message.content}</p>
              </article>)}
          {busy && <p className="bubble bubble--assistant bubble--thinking" aria-label="Thinking"><i /><i /><i /></p>}
          <div ref={transcriptEnd} />
        </section>
      )}

      <section className="dock">
        {!started && <div className="hero">
          <p className="eyebrow">{building.building.name} · {building.floors.length} floors · {building.spaces.length} spaces</p>
          <h1>Ask me anything.</h1>
        </div>}
        <form className="ask" onSubmit={submit}>
          <input ref={input} value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} placeholder={started ? 'Ask a follow-up…' : `Ask about ${building.building.name}: rooms, equipment, routes…`} aria-label="Ask about the building" autoFocus />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="Send">{busy ? '…' : '↑'}</button>
        </form>
        {!started && <div className="chips">{suggestions.map(s => <button type="button" key={s} onClick={() => void ask(s)}>{s}</button>)}</div>}
      </section>

      <footer className="attribution">{building.building.attribution} · {building.building.license}</footer>
    </main>
  );
}

function floorShort(level: number) {
  if (level === 0) return 'G';
  return level < 0 ? `B${-level}` : String(level);
}
