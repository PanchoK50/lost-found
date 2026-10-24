'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { Building } from '@/lib/buildings/types';
import { DirectionsPanel } from './directions-panel';
import type { ChatResponse, SceneDirective } from '@/lib/chat/contract';
import type { SceneInsets } from './building-scene';

const BuildingScene = dynamic(() => import('./building-scene'), { ssr: false, loading: () => <div className="scene-loading">Building the model…</div> });

type Message = { id: number; role: 'user' | 'assistant'; content: string; response?: ChatResponse; error?: boolean };

interface Props {
  building: Building;
  buildings: { id: string; name: string }[];
  suggestions: { label: string; question: string }[];
}

const overview: SceneDirective = { focus: { mode: 'building' } };
/** Matches the desktop breakpoint in globals.css. Phone layout is the default. */
const wideQuery = '(min-width: 900px)';

function useWide() {
  return useSyncExternalStore(
    notify => { const mq = window.matchMedia(wideQuery); mq.addEventListener('change', notify); return () => mq.removeEventListener('change', notify); },
    () => window.matchMedia(wideQuery).matches,
    () => false,
  );
}

export function BuildingExperience({ building, buildings, suggestions }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [directive, setDirective] = useState<SceneDirective>(overview);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // The route step the camera is showing: `${messageId}:${leg}-${step}`.
  const [activeStep, setActiveStep] = useState<string>();
  const [insets, setInsets] = useState<SceneInsets>({ top: 0, left: 0, bottom: 0 });
  const wide = useWide();
  const nextId = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLElement>(null);
  const dock = useRef<HTMLElement>(null);
  const floorList = useRef<HTMLDivElement>(null);
  const started = messages.length > 0;
  const floors = [...building.floors].sort((a, b) => a.level - b.level);
  const focusedFloor = directive.focus.mode === 'floor' ? directive.focus.floorId : undefined;
  // On phones the sheet shows only the latest exchange until expanded.
  const showAll = wide || expanded;
  const lastUser = messages.findLastIndex(m => m.role === 'user');
  const visible = showAll ? messages : messages.slice(Math.max(0, busy ? lastUser : messages.length - 1));

  // Frame the model in whatever the UI leaves free, measured from the real layout.
  useLayoutEffect(() => {
    const measure = () => {
      const h = window.innerHeight;
      const top = header.current?.getBoundingClientRect().bottom ?? 0;
      const dockTop = dock.current?.getBoundingClientRect().top ?? h;
      const sheet = transcript.current?.getBoundingClientRect();
      const next = wide
        ? { top, left: sheet ? sheet.right : 0, bottom: h - dockTop }
        : { top, left: 0, bottom: h - Math.min(dockTop, sheet?.top ?? h) };
      const round = (v: number) => Math.round(v / 8) * 8;
      setInsets(prev => (round(prev.top) === round(next.top) && round(prev.left) === round(next.left) && round(prev.bottom) === round(next.bottom) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    [header, transcript, dock].forEach(ref => ref.current && observer.observe(ref.current));
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [wide, started]);
  useEffect(() => { floorList.current?.querySelector('.active')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); }, [focusedFloor]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy, expanded]);

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
    setExpanded(false);
    // Close the phone keyboard so the answer and the model are visible.
    if (!wide) input.current?.blur();
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buildingId: building.building.id, message, history }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
      const response = data as ChatResponse;
      setMessages(current => [...current, { id: nextId.current++, role: 'assistant', content: response.reply, response }]);
      setDirective(response.scene);
      setActiveStep(undefined);
    } catch (error) {
      setMessages(current => [...current, { id: nextId.current++, role: 'assistant', content: error instanceof Error ? error.message : 'Something went wrong.', error: true }]);
    } finally {
      setBusy(false);
      if (wide) input.current?.focus();
    }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void ask(draft); };

  return (
    <main className={`experience${started ? ' experience--started' : ''}`}>
      <div className="scene"><BuildingScene building={building} directive={directive} insets={insets} onFocusFloor={focusFloor} /></div>

      <div className="hud-top" ref={header}>
        <header className="hud-bar">
          <Link className="brand" href="/" aria-label="lost & found home">◈ <span>lost & found</span></Link>
          <nav className="building-switch" aria-label="Building">
            {buildings.map(b => <Link key={b.id} href={`/?building=${b.id}`} className={b.id === building.building.id ? 'active' : ''} aria-current={b.id === building.building.id ? 'page' : undefined}>{b.name}</Link>)}
          </nav>
        </header>
        <nav className="floor-rail" aria-label="Floors">
          <button type="button" className={directive.focus.mode === 'building' ? 'active' : ''} onClick={showOverview} aria-label="Whole building">⌂</button>
          <div className="floor-list" ref={floorList}>
            {floors.map(floor => (
              <button type="button" key={floor.id} className={focusedFloor === floor.id ? 'active' : ''} onClick={() => focusFloor(floor.id)} aria-label={floor.name} aria-pressed={focusedFloor === floor.id}>{floorShort(floor.level)}</button>
            ))}
          </div>
        </nav>
      </div>

      <div className="console">
        {started && (
          <section ref={transcript} className={`transcript${showAll ? ' transcript--expanded' : ''}`} aria-label="Conversation" aria-live="polite">
            {!wide && messages.length > 2 && (
              <button type="button" className="sheet-handle" onClick={() => setExpanded(e => !e)} aria-expanded={expanded}>
                <span />{expanded ? 'Show latest only' : `Conversation · ${Math.ceil(messages.length / 2)} questions`}
              </button>
            )}
            <div className="transcript-scroll">
              {visible.map(message => message.role === 'user'
                ? <p key={message.id} className="bubble bubble--user">{message.content}</p>
                : <article key={message.id} className={`bubble bubble--assistant${message.error ? ' bubble--error' : ''}`}>
                    {message.response?.answer && (
                      <button type="button" className="answer-card" onClick={() => { setDirective(message.response!.scene); setActiveStep(undefined); }} aria-label={`Show ${message.response.answer.title} on the model`}>
                        <span className="answer-title">{message.response.answer.title}</span>
                        {message.response.answer.value && <span className="answer-value">{message.response.answer.value}</span>}
                        {message.response.answer.detail && <span className="answer-detail">{message.response.answer.detail}</span>}
                      </button>
                    )}
                    <p>{withoutAnswerLine(message.content)}</p>
                    {message.response?.actions?.length ? (
                      <div className="answer-actions">
                        {message.response.actions.map(action => (
                          <button type="button" key={action.label} onClick={() => {
                            if (action.send) { void ask(action.message); return; }
                            // Pre-fill and let the user finish the sentence, e.g. "… from " + their room.
                            setDraft(action.message);
                            requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
                          }}>{action.label}</button>
                        ))}
                      </div>
                    ) : null}
                    {message.response && (
                      <DirectionsPanel
                        building={building}
                        response={message.response}
                        open={wide}
                        active={activeStep?.startsWith(`${message.id}:`) ? activeStep.slice(`${message.id}:`.length) : undefined}
                        onStep={(step, key) => {
                          // Fly to the maneuver on its floor, keeping the route and labels of this answer.
                          setDirective({ ...message.response!.scene, focus: { mode: 'floor', floorId: step.at.floorId, around: step.at.position } });
                          setActiveStep(`${message.id}:${key}`);
                        }}
                        onOverview={() => { setDirective(message.response!.scene); setActiveStep(undefined); }}
                      />
                    )}
                  </article>)}
              {busy && <p className="bubble bubble--assistant bubble--thinking" aria-label="Thinking"><i /><i /><i /></p>}
              <div ref={transcriptEnd} />
            </div>
          </section>
        )}

        <section className="dock" ref={dock}>
          {!started && <div className="hero">
            <p className="eyebrow">{building.building.name} · {building.floors.length} floors · {building.spaces.length} spaces</p>
            <h1>Ask me anything.</h1>
          </div>}
          {!started && <div className="chips">{suggestions.map(s => <button type="button" key={s.label} title={s.question} onClick={() => void ask(s.question)}>{s.label}</button>)}</div>}
          <form className="ask" onSubmit={submit}>
            <input ref={input} value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} enterKeyHint="send" autoComplete="off" placeholder={started ? 'Ask a follow-up…' : 'Where is…? How do I get to…?'} aria-label="Ask about the building" />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Send">{busy ? '…' : '↑'}</button>
          </form>
        </section>
      </div>

      <footer className="attribution">{building.building.attribution} · {building.building.license}</footer>
    </main>
  );
}

/** Benchmark replies end with an "Answer: …" line; the headline card already shows it. */
function withoutAnswerLine(reply: string) {
  return reply.replace(/\n*^\s*Answer:.*$/gim, '').trim();
}

function floorShort(level: number) {
  if (level === 0) return 'G';
  return level < 0 ? `B${-level}` : String(level);
}
