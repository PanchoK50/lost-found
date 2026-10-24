'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { Building } from '@/lib/buildings/types';
import { MicButton } from '@/components/mic-button';
import { DirectionsPanel } from './directions-panel';
import type { ChatResponse, SceneDirective } from '@/lib/chat/contract';
import type { SceneInsets } from './building-scene';
import { detectCategory } from '@/lib/world/mode';
import { useProfile } from '@/lib/world/profile';
import { DemoLoginSheet, useSignedIn } from '@/components/auth/demo-login';
import { authHeader, supabaseBrowser } from '@/lib/supabase/browser';
import { useWorld } from '@/lib/world/use-world';
import { WorldHud } from '@/components/world/world-hud';
import { SettingsSheet } from '@/components/world/settings-sheet';
import { ReportSheet, type ReportDraft } from '@/components/world/report-sheet';
import { ProposalCards } from '@/components/world/proposal-cards';
import { SkillChips } from '@/components/world/skill-chips';
import { Inbox, inboxToasts } from '@/components/world/inbox';
import { mentionQuery } from '@/components/world/mention-picker';
import { PasserBy } from '@/components/world/passer-by';
import { MessagesSheet } from '@/components/world/messages-sheet';
import { PersonCard } from '@/components/world/person-card';
import { MentionPicker } from '@/components/world/mention-picker';
import { unreadCount, useSentHistory } from '@/lib/world/history';
import { settingsFor } from '@/lib/world/profile';
import type { WorldState } from '@/lib/world/types';
import { PinCard } from '@/components/world/pin-card';

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
  // Backend conversation id: follow-ups and edits (closed lifts, new doors) stay in one session.
  const sessionId = useRef<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  // The route step the camera is showing: `${messageId}:${leg}-${step}`.
  const [activeStep, setActiveStep] = useState<string>();
  const [insets, setInsets] = useState<SceneInsets>({ top: 0, left: 0, bottom: 0 });
  const wide = useWide();
  // Multiplayer: the shared world of this building (docs/MULTIPLAYER.md).
  const profile = useProfile();
  const { world: fullWorld, act } = useWorld(building, profile);
  const settings = profile && fullWorld ? settingsFor(profile, fullWorld.mode) : undefined;
  // "Show demo players" off: hide the scripted people (docs/MULTIPLAYER.md §9).
  const hideDemo = settings?.demoPlayers === false;
  const world = useMemo(() => hideDemo && fullWorld ? withoutDemo(fullWorld) : fullWorld, [fullWorld, hideDemo]);
  const category = useMemo(() => detectCategory(building), [building]);
  const [sheet, setSheet] = useState<'settings' | 'report' | 'account' | 'messages'>();
  const signedIn = useSignedIn();
  // Chat history in Supabase: one conversation per thread, started on the first message.
  const conversationId = useRef<string | undefined>(undefined);
  const [personId, setPersonId] = useState<string>();
  const closePerson = useCallback(() => setPersonId(undefined), []);
  const openPerson = world?.players.find(p => p.id === personId);
  useSentHistory(fullWorld, profile, building);
  const unread = profile ? unreadCount(profile, building.building.id) + (world && settings ? inboxToasts(world, profile.id, settings.pingFrom, profile.groups).filter(t => t.type === 'incoming').length : 0) : 0;
  const closeSheet = useCallback(() => setSheet(undefined), []);
  // A pin proposed in chat that the user wants to edit before posting.
  const [reportDraft, setReportDraft] = useState<ReportDraft>();
  const [pinId, setPinId] = useState<string>();
  const closePin = useCallback(() => setPinId(undefined), []);
  const openPin = world?.pins.find(p => p.id === pinId);
  const nextId = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLElement>(null);
  const dock = useRef<HTMLElement>(null);
  const floorList = useRef<HTMLDivElement>(null);
  const latestQuestion = useRef<HTMLParagraphElement>(null);
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
  useEffect(() => {
    const list = floorList.current;
    if (!list) return;
    const active = list.querySelector('.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    else list.scrollTo({ left: 0, behavior: 'smooth' });
  }, [focusedFloor]);
  // Show the latest question with its answer card at the top, not the end of a long step list.
  useEffect(() => {
    const target = busy ? transcriptEnd.current : latestQuestion.current ?? transcriptEnd.current;
    target?.scrollIntoView({ behavior: 'smooth', block: busy ? 'end' : 'start' });
  }, [messages, busy, expanded]);

  // Whole building, keeping the current answer's highlights and route.
  const showOverview = useCallback(() => setDirective(current => ({ ...current, focus: { mode: 'building' } })), []);
  /** Back to the start screen: whole building, "Ask me anything", suggestions. */
  const startOver = useCallback(() => {
    setMessages([]);
    sessionId.current = undefined;
    conversationId.current = undefined;
    setDirective(overview);
    setDraft('');
    setExpanded(false);
    setActiveStep(undefined);
  }, []);
  const focusFloor = useCallback((floorId: string) => setDirective(current => ({ ...current, focus: { mode: 'floor', floorId } })), []);
  useEffect(() => {
    // Esc: first back to the whole building, then (pressed again) back to the start screen.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (directive.focus.mode !== 'building') showOverview(); else startOver();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showOverview, startOver, directive.focus.mode]);

  async function ask(text: string, skillId?: string) {
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
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ buildingId: building.building.id, message, history, sessionId: sessionId.current, conversationId: conversationId.current, playerId: profile?.id, skillId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
      const response = data as ChatResponse;
      sessionId.current = response.sessionId;
      conversationId.current = response.conversationId ?? conversationId.current;
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
  // Voice goes into the box like typed text, so it can be checked before sending.
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const addTranscript = (text: string) => {
    setVoiceError(null);
    setDraft(current => (current.trim() ? `${current.trimEnd()} ${text}` : text));
    requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  };
  // "Route here" on a tapped room: walk from the room set under "Where are you?", or ask for it first.
  const askRef = useRef(ask);
  useEffect(() => { askRef.current = ask; });
  const myRoom = profile?.rooms[building.building.id];
  const routeTo = useCallback((spaceId: string) => {
    const from = building.spaces.find(s => s.id === myRoom), to = building.spaces.find(s => s.id === spaceId);
    if (!to) return;
    if (!from) { setSheet('settings'); return; }
    void askRef.current(from.id === to.id ? `Show ${to.name}` : `How do I get from ${from.name} to ${to.name}?`);
  }, [building, myRoom]);

  return (
    <main className={`experience${started ? ' experience--started' : ''}`}>
      <div className="scene"><BuildingScene building={building} directive={directive} insets={insets} onFocusFloor={focusFloor} world={world} onPin={setPinId} onPerson={setPersonId} onRoute={routeTo} /></div>

      <div className="hud-top" ref={header}>
        <header className="hud-bar">
          <Link className="brand" href={`/?building=${building.building.id}`} aria-label="lost & found: back to overview" onClick={event => { event.preventDefault(); startOver(); }}>◈ <span>lost & found</span></Link>
          {started && <button type="button" className="back-overview" onClick={startOver}>← Overview</button>}
          <nav className="building-switch" aria-label="Building">
            {buildings.map(b => <Link key={b.id} href={`/?building=${b.id}`} className={b.id === building.building.id ? 'active' : ''} aria-current={b.id === building.building.id ? 'page' : undefined}>{b.name}</Link>)}
          </nav>
          <WorldHud world={world} playerId={profile?.id} unread={unread} onOpen={() => setSheet('settings')} onMessages={() => setSheet('messages')} />
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
                ? <p key={message.id} ref={message.id === messages[lastUser]?.id ? latestQuestion : undefined} className="bubble bubble--user">{message.content}</p>
                : <article key={message.id} className={`bubble bubble--assistant${message.error ? ' bubble--error' : ''}`}>
                    <AgentAvatar />
                    {message.response?.answer && (
                      <button type="button" className={`answer-card${message.response.answer.negative ? ' answer-card--negative' : ''}`} onClick={() => { setDirective(message.response!.scene); setActiveStep(undefined); }} aria-label={`Show ${message.response.answer.title} on the model`}>
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
                    {message.response?.proposals?.length ? (
                      <ProposalCards
                        proposals={message.response.proposals}
                        act={act}
                        onEditPin={pin => { setReportDraft(pin); setSheet('report'); }}
                        onEditText={() => { setDraft(messages.findLast(m => m.role === 'user' && m.id < message.id)?.content ?? ''); input.current?.focus(); }}
                      />
                    ) : null}
                  </article>)}
              {busy && <div className="bubble bubble--thinking" role="status"><AgentAvatar thinking />Looking it up…</div>}
              <div ref={transcriptEnd} />
            </div>
          </section>
        )}

        <section className="dock" ref={dock}>
          {!started && <div className="hero">
            <AgentAvatar size="lg" />
            <p className="eyebrow">{building.building.name} · {building.floors.length} floors · {building.spaces.length} spaces</p>
            <h1>Ask me anything.</h1>
          </div>}
          {!started && <div className="chips">{suggestions.map(s => <button type="button" key={s.label} title={s.question} onClick={() => void ask(s.question)}>{s.label}</button>)}</div>}
          {profile && <PasserBy world={world} profile={profile} building={building} routes={directive.routes} act={act} />}
          {world && profile && mentionQuery(draft) !== undefined
            ? <MentionPicker players={world.players.filter(p => p.id !== profile.id)} draft={draft} onPick={text => { setDraft(text); input.current?.focus(); }} />
            : world && <SkillChips skills={world.skills} draft={draft} onUse={skill => void ask(skill.name, skill.id)} />}
          <form className="ask" onSubmit={submit}>
            <button type="button" className="ask-plus" onClick={() => { setReportDraft(undefined); setSheet('report'); }} disabled={!profile} aria-label="Report something">+</button>
            <input ref={input} value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} enterKeyHint="send" autoComplete="off" placeholder={started ? 'Ask a follow-up…' : 'Where is…? How do I get to…?'} aria-label="Ask about the building" />
            <MicButton onTranscript={addTranscript} onError={setVoiceError} />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Send">{busy ? '…' : '↑'}</button>
          </form>
          {voiceError && <p className="voice-error" role="alert">{voiceError}</p>}
        </section>
      </div>

      {profile && settings && <Inbox world={world} playerId={profile.id} building={building} pingFrom={settings.pingFrom} groups={profile.groups} top={insets.top + 8} act={act} onGo={routeTo} onMore={() => setSheet('messages')} />}
      {sheet === 'messages' && profile && settings && <MessagesSheet building={building} profile={profile} world={world} pingFrom={settings.pingFrom} act={act} onGo={routeTo} onClose={closeSheet} />}
      {openPerson && profile && <PersonCard key={openPerson.id} player={openPerson} building={building} profile={profile} world={world} act={act} onRoute={routeTo} onAsk={name => { setDraft(`@${name} `); input.current?.focus(); }} onClose={closePerson} />}
      {sheet === 'report' && profile && <ReportSheet key={JSON.stringify(reportDraft ?? null)} initial={reportDraft} building={building} profile={profile} world={world} floorId={focusedFloor} act={act} onPosted={focusFloor} onClose={closeSheet} />}
      {openPin && profile && <PinCard key={openPin.id} pin={openPin} building={building} profile={profile} world={world} act={act} onClose={closePin} />}
      {sheet === 'settings' && profile && <SettingsSheet building={building} profile={profile} world={world} category={category} act={act} onClose={closeSheet} onSwitchUser={supabaseBrowser() ? () => setSheet('account') : undefined} />}
      {sheet === 'account' && <DemoLoginSheet profile={profile} onClose={closeSheet} />}
      {supabaseBrowser() && signedIn === null && sheet !== 'account' && <DemoLoginSheet profile={profile} />}

      <footer className="attribution">{building.building.attribution} · {building.building.license}</footer>
    </main>
  );
}

function withoutDemo(world: WorldState): WorldState {
  const demo = new Set(world.players.filter(p => p.demo).map(p => p.id));
  return { ...world, players: world.players.filter(p => !demo.has(p.id)), presence: world.presence.filter(p => !demo.has(p.playerId)), pings: world.pings.filter(p => !demo.has(p.fromId)) };
}

/**
 * The building's assistant, drawn after Synera's agent robots: a glossy white head with a navy visor and a
 * glowing light-blue face. The face pulses while it thinks.
 */
function AgentAvatar({ thinking = false, size }: { thinking?: boolean; size?: 'lg' }) {
  return (
    <svg className={`agent-avatar${size === 'lg' ? ' agent-avatar--lg' : ''}${thinking ? ' agent-avatar--thinking' : ''}`} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <radialGradient id="agent-head" cx="40%" cy="28%" r="80%"><stop offset="0" stopColor="#ffffff" /><stop offset=".7" stopColor="#eef1f6" /><stop offset="1" stopColor="#cfd6e2" /></radialGradient>
        <linearGradient id="agent-visor" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1b2a6b" /><stop offset=".55" stopColor="#0b1440" /><stop offset="1" stopColor="#3a2c8f" /></linearGradient>
        <filter id="agent-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.1" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {/* head */}
      <rect x="4" y="5" width="56" height="52" rx="24" fill="url(#agent-head)" stroke="#d3dae6" strokeWidth="1" />
      {/* visor */}
      <rect x="11" y="17" width="42" height="25" rx="12.5" fill="url(#agent-visor)" />
      <ellipse cx="25" cy="21.5" rx="10" ry="2.2" fill="#ffffff" opacity=".18" />
      {/* face: Synera's glowing dot-and-bar pattern */}
      <g className="agent-face" fill="#bfe3ff" filter="url(#agent-glow)">
        <circle cx="20" cy="29.5" r="1.6" />
        <rect x="24" y="26" width="3" height="7" rx="1.5" />
        <rect x="29.5" y="23.5" width="3" height="12" rx="1.5" />
        <rect x="35" y="26" width="3" height="7" rx="1.5" />
        <circle cx="42.5" cy="29.5" r="1.6" />
      </g>
    </svg>
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
