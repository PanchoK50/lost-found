'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { Building } from '@/lib/buildings/types';
import { DirectionsPanel } from './directions-panel';
import type { ChatResponse, SceneDirective } from '@/lib/chat/contract';
import type { SceneInsets } from './building-scene';
import { detectCategory } from '@/lib/world/mode';
import { useProfile } from '@/lib/world/profile';
import { useWorld } from '@/lib/world/use-world';
import { WorldHud } from '@/components/world/world-hud';
import { SettingsSheet } from '@/components/world/settings-sheet';
import { ReportSheet, type ReportDraft } from '@/components/world/report-sheet';
import { ProposalCards } from '@/components/world/proposal-cards';
import { SkillChips } from '@/components/world/skill-chips';
import { Inbox } from '@/components/world/inbox';
import { PasserBy } from '@/components/world/passer-by';
import { settingsFor } from '@/lib/world/profile';
import type { WorldState } from '@/lib/world/types';
import { PinCard } from '@/components/world/pin-card';

const BuildingScene = dynamic(() => import('./building-scene'), { ssr: false, loading: () => <div className="scene-loading">Building the model…</div> });

type Message = { id: number; role: 'user' | 'assistant'; content: string; response?: ChatResponse; error?: boolean };

interface Props {
  building: Building;
  buildings: { id: string; name: string }[];
  suggestions: string[];
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
  // Multiplayer: the shared world of this building (docs/MULTIPLAYER.md).
  const profile = useProfile();
  const { world: fullWorld, act } = useWorld(building, profile);
  const settings = profile && fullWorld ? settingsFor(profile, fullWorld.mode) : undefined;
  // "Show demo players" off: hide the scripted people (docs/MULTIPLAYER.md §9).
  const hideDemo = settings?.demoPlayers === false;
  const world = useMemo(() => hideDemo && fullWorld ? withoutDemo(fullWorld) : fullWorld, [fullWorld, hideDemo]);
  const category = useMemo(() => detectCategory(building), [building]);
  const [sheet, setSheet] = useState<'settings' | 'report'>();
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
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buildingId: building.building.id, message, history, playerId: profile?.id, skillId }) });
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
      <div className="scene"><BuildingScene building={building} directive={directive} insets={insets} onFocusFloor={focusFloor} world={world} onPin={setPinId} onRoute={routeTo} /></div>

      <div className="hud-top" ref={header}>
        <header className="hud-bar">
          <Link className="brand" href="/" aria-label="lost & found home">◈ <span>lost & found</span></Link>
          <nav className="building-switch" aria-label="Building">
            {buildings.map(b => <Link key={b.id} href={`/?building=${b.id}`} className={b.id === building.building.id ? 'active' : ''} aria-current={b.id === building.building.id ? 'page' : undefined}>{b.name}</Link>)}
          </nav>
          <WorldHud world={world} playerId={profile?.id} onOpen={() => setSheet('settings')} />
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
          {!started && <div className="chips">{suggestions.map(s => <button type="button" key={s} onClick={() => void ask(s)}>{s}</button>)}</div>}
          {profile && <PasserBy world={world} profile={profile} building={building} routes={directive.routes} act={act} />}
          {world && <SkillChips skills={world.skills} draft={draft} onUse={skill => void ask(skill.name, skill.id)} />}
          <form className="ask" onSubmit={submit}>
            <button type="button" className="ask-plus" onClick={() => { setReportDraft(undefined); setSheet('report'); }} disabled={!profile} aria-label="Report something">+</button>
            <input ref={input} value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} enterKeyHint="send" autoComplete="off" placeholder={started ? 'Ask a follow-up…' : 'Where is…? How do I get to…?'} aria-label="Ask about the building" />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Send">{busy ? '…' : '↑'}</button>
          </form>
        </section>
      </div>

      {profile && settings && <Inbox world={world} playerId={profile.id} building={building} pingFrom={settings.pingFrom} groups={profile.groups} top={insets.top + 8} act={act} onGo={routeTo} onMore={() => setSheet('settings')} />}
      {sheet === 'report' && profile && <ReportSheet key={JSON.stringify(reportDraft ?? null)} initial={reportDraft} building={building} profile={profile} world={world} floorId={focusedFloor} act={act} onPosted={focusFloor} onClose={closeSheet} />}
      {openPin && profile && <PinCard key={openPin.id} pin={openPin} building={building} profile={profile} world={world} act={act} onClose={closePin} />}
      {sheet === 'settings' && profile && <SettingsSheet building={building} profile={profile} world={world} category={category} act={act} onGo={routeTo} onClose={closeSheet} />}

      <footer className="attribution">{building.building.attribution} · {building.building.license}</footer>
    </main>
  );
}

function withoutDemo(world: WorldState): WorldState {
  const demo = new Set(world.players.filter(p => p.demo).map(p => p.id));
  return { ...world, players: world.players.filter(p => !demo.has(p.id)), presence: world.presence.filter(p => !demo.has(p.playerId)), pings: world.pings.filter(p => !demo.has(p.fromId)) };
}

/** Benchmark replies end with an "Answer: …" line; the headline card already shows it. */
function withoutAnswerLine(reply: string) {
  return reply.replace(/\n*^\s*Answer:.*$/gim, '').trim();
}

function floorShort(level: number) {
  if (level === 0) return 'G';
  return level < 0 ? `B${-level}` : String(level);
}
