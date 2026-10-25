'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Building } from '@/lib/buildings/types';
import { floorCounts } from '@/components/world/world-anchors';
import { MicButton } from '@/components/mic-button';
import { DirectionsPanel } from './directions-panel';
import type { ChatResponse, SceneDirective } from '@/lib/chat/contract';
import type { SceneInsets } from './building-scene';
import { detectCategory } from '@/lib/world/mode';
import { saveProfile, useProfile } from '@/lib/world/profile';
import { LocationSheet } from '@/components/world/location-sheet';
import { BuildingsSheet, type BuildingRow } from '@/components/world/buildings-sheet';
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
import { HazardPanel, HazardPlayback } from '@/components/hazards/hazard-panel';
import { ReportDamage } from '@/components/hazards/report-damage';
import { ReadinessSheet } from '@/components/hazards/readiness-sheet';
import { hazardDirective, useHazard } from '@/components/hazards/use-hazard';
import { playAlarm, useIncidents } from '@/lib/hazards/incidents';
import { hazardMeta, type Incident } from '@/lib/hazards/types';

const BuildingScene = dynamic(() => import('./building-scene'), { ssr: false, loading: () => <div className="scene-loading">Building the model…</div> });

type Message = { id: number; role: 'user' | 'assistant'; content: string; response?: ChatResponse; error?: boolean };

interface Props {
  building: Building;
  buildings: BuildingRow[];
  suggestions: { label: string; question: string }[];
  /** Just created from plans: offer to go through what the importer was unsure about. */
  importIntro?: { checks: number; first?: string };
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

export function BuildingExperience({ building, buildings, suggestions, importIntro }: Props) {
  const router = useRouter();
  // Wake the Python agent while people read the start screen (cold starts on Vercel).
  useEffect(() => { void fetch('/api/health').catch(() => undefined); }, []);
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
  const [sheet, setSheet] = useState<'settings' | 'report' | 'account' | 'messages' | 'location' | 'buildings' | 'damage' | 'readiness'>();
  // Emergencies: a what-if simulation or a live incident, shown on the map with its side panel.
  const hazard = useHazard(building);
  const incidents = useIncidents(building.building.id);
  const [hazardRoom, setHazardRoom] = useState<string | null>(null);
  const [hazardFloor, setHazardFloor] = useState<string | null>(null);
  const hazardPanel = useRef<HTMLElement>(null);
  const hazardOpen = hazard.view !== null;
  const openIncident = useCallback((incident: Incident) => { setHazardRoom(null); setHazardFloor(null); void hazard.open(incident.spaceId, incident.hazard, 'incident', incident); }, [hazard]);
  // An incident raised on another screen: sound the alarm and show it.
  const { arrived, clearArrived } = incidents;
  useEffect(() => {
    if (!arrived || arrived.buildingId !== building.building.id) return;
    playAlarm();
    openIncident(arrived);
    clearArrived();
  }, [arrived, building.building.id, openIncident, clearArrived]);
  // Deep link for demos and the video: ?simulate=water:<space id> (or fire:, electrical:) opens that simulation.
  const openSimulation = hazard.open;
  useEffect(() => {
    const [kind, spaceId] = (new URLSearchParams(window.location.search).get('simulate') ?? '').split(':');
    if ((kind === 'fire' || kind === 'water' || kind === 'electrical') && building.spaces.some(s => s.id === spaceId)) void openSimulation(spaceId, kind);
  }, [building, openSimulation]);
  const shownDirective = useMemo(() => (hazard.view ? hazardDirective(building, hazard.view, hazardRoom, hazardFloor) : directive), [hazard.view, building, hazardRoom, hazardFloor, directive]);
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
  // The start block ("Ask me anything", suggestions) gives way once someone explores a floor, so the map gets the screen.
  const intro = !started && directive.focus.mode === 'building' && !hazard.view;
  const floors = [...building.floors].sort((a, b) => a.level - b.level);
  const focusedFloor = shownDirective.focus.mode === 'floor' ? shownDirective.focus.floorId : undefined;
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
      const panel = hazardPanel.current?.getBoundingClientRect();
      const next = wide
        ? { top, left: sheet ? sheet.right : 0, bottom: h - dockTop, right: panel ? window.innerWidth - panel.left : 0 }
        : { top, left: 0, bottom: h - Math.min(dockTop, sheet?.top ?? h, panel?.top ?? h) };
      const round = (v: number) => Math.round(v / 8) * 8;
      setInsets(prev => (round(prev.top) === round(next.top) && round(prev.left) === round(next.left) && round(prev.bottom) === round(next.bottom) && round(prev.right ?? 0) === round(next.right ?? 0) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    [header, transcript, dock, hazardPanel].forEach(ref => ref.current && observer.observe(ref.current));
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [wide, started, intro, hazardOpen]);
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
      if (event.key === 'Escape' && hazard.view) { hazard.close(); return; }
      // Arrow up/down (or Page up/down) step one floor at a time, unless the user is typing.
      const step = { ArrowUp: 1, PageUp: 1, ArrowDown: -1, PageDown: -1 }[event.key];
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (step && !typing && floors.length) {
        event.preventDefault();
        const current = floors.findIndex(f => f.id === focusedFloor);
        const next = current < 0 ? (step > 0 ? 0 : floors.length - 1) : Math.min(floors.length - 1, Math.max(0, current + step));
        focusFloor(floors[next].id);
        return;
      }
      if (event.key !== 'Escape') return;
      if (directive.focus.mode !== 'building') showOverview(); else startOver();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showOverview, startOver, directive.focus.mode, floors, focusedFloor, focusFloor, hazard]);

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
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ buildingId: building.building.id, message, history, sessionId: sessionId.current, conversationId: conversationId.current, playerId: profile?.id, skillId, location: profile?.rooms[building.building.id] }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
      const response = data as ChatResponse;
      sessionId.current = response.sessionId;
      // The building changed (new door, moved machine, renamed room): reload the plan for the viewer.
      if (response.edits?.length) router.refresh();
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
  // Location is picked by hand ("I'm here" on a room, or the location chip): the plans are not where we are.
  const setLocation = useCallback((spaceId: string | undefined) => {
    if (!profile) return;
    const rooms = { ...profile.rooms };
    if (spaceId) rooms[building.building.id] = spaceId; else delete rooms[building.building.id];
    saveProfile({ ...profile, rooms });
  }, [profile, building.building.id]);
  const routeTo = useCallback((spaceId: string) => {
    const from = building.spaces.find(s => s.id === myRoom), to = building.spaces.find(s => s.id === spaceId);
    if (!to) return;
    if (!from) { setSheet('settings'); return; }
    void askRef.current(from.id === to.id ? `Show ${to.name}` : `How do I get from ${from.name} to ${to.name}?`);
  }, [building, myRoom]);

  return (
    <main className={`experience${started ? ' experience--started' : ''}${hazard.view ? ' experience--hazard' : ''}`}>
      <div className="scene"><BuildingScene building={building} directive={shownDirective} insets={insets} onSimulate={(spaceId, kind) => { setHazardRoom(null); setHazardFloor(null); void hazard.open(spaceId, kind); }} onFocusFloor={focusFloor} world={world} onPin={setPinId} onPerson={setPersonId} onRoute={routeTo} onSetLocation={profile ? setLocation : undefined} myRoom={myRoom} /></div>

      <div className="hud-top" ref={header}>
        <header className="hud-bar">
          <Link className="brand" href={`/?building=${building.building.id}`} aria-label="lost & found: back to overview" onClick={event => { event.preventDefault(); startOver(); }}>◈ <span>lost & found</span></Link>
          {started && <button type="button" className="back-overview" onClick={startOver}>← Overview</button>}
          <nav className="building-switch" aria-label="Building">
            <button type="button" className="active" onClick={() => setSheet('buildings')} aria-label={`Building: ${buildings.find(b => b.id === building.building.id)?.name ?? building.building.name}. Choose another or add one`}>
              {buildings.find(b => b.id === building.building.id)?.name ?? building.building.name} ▾
            </button>
            <button type="button" onClick={() => setSheet('buildings')}>{buildings.length} buildings</button>
          </nav>
          <nav className="emergency-actions" aria-label="Emergencies">
            {hazard.view && <span className={`mode-badge${hazard.view.mode === 'incident' ? ' mode-badge--live' : ''}`}><i />{hazard.view.mode === 'incident' ? 'Live incident' : 'Simulation'}</span>}
            <button type="button" className="emergency-report" onClick={() => setSheet('damage')}>🚨 Report damage</button>
            <button type="button" onClick={() => setSheet('readiness')}>🛡 Readiness</button>
          </nav>
          <WorldHud world={world} playerId={profile?.id} unread={unread} onOpen={() => setSheet('settings')} onMessages={() => setSheet('messages')}
            location={profile ? building.spaces.find(s => s.id === myRoom)?.name ?? null : undefined} onLocation={() => setSheet('location')} />
        </header>
        <nav className="floor-rail" aria-label="Floors">
          <button type="button" className={(hazard.view ? !hazardFloor && !hazardRoom : directive.focus.mode === 'building') ? 'active' : ''} onClick={() => { if (hazard.view) { setHazardFloor(null); setHazardRoom(null); } else showOverview(); }} aria-label="Whole building">⌂</button>
          <div className="floor-list" ref={floorList}>
            {floors.map(floor => (
              <FloorButton key={floor.id} floor={floor} active={focusedFloor === floor.id} counts={withIncidents(floorCounts(world, floor.id), incidents.active, building, floor.id)} onClick={() => { if (hazard.view) { setHazardRoom(null); setHazardFloor(floor.id); } else focusFloor(floor.id); }} />
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
          {intro && <div className="hero">
            <h1>Ask me anything.</h1>
          </div>}
          {intro && importIntro && (
            <div className="import-intro">
              <strong>Built from your plans.</strong>
              <span>{importIntro.checks ? `${importIntro.checks} thing${importIntro.checks === 1 ? '' : 's'} to check, e.g. “${importIntro.first}”` : 'Nothing to check: ask me anything.'}</span>
              {importIntro.checks > 0 && <button type="button" className="button button--primary" onClick={() => void ask('Let’s check what you were unsure about in this building, one question at a time.')}>Check it with me</button>}
            </div>
          )}
          {intro && <div className="chips">{suggestions.map(s => <button type="button" key={s.label} title={s.question} onClick={() => void ask(s.question)}>{s.label}</button>)}</div>}
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

      {profile && settings && <Inbox world={world} playerId={profile.id} building={building} pingFrom={settings.pingFrom} groups={profile.groups} top={insets.top + 8} act={act} onGo={routeTo} onMore={() => setSheet('messages')} onShareLocation={() => {
        if (profile && settings?.share === 'off') saveProfile({ ...profile, settings: { ...profile.settings, share: 'team' } });
        setSheet('location');
      }} />}
      {sheet === 'messages' && profile && settings && <MessagesSheet building={building} profile={profile} world={world} pingFrom={settings.pingFrom} act={act} onGo={routeTo} onClose={closeSheet} />}
      {openPerson && profile && <PersonCard key={openPerson.id} player={openPerson} building={building} profile={profile} world={world} act={act} onRoute={routeTo} onAsk={name => { setDraft(`@${name} `); input.current?.focus(); }} onClose={closePerson} />}
      {sheet === 'report' && profile && <ReportSheet key={JSON.stringify(reportDraft ?? null)} initial={reportDraft} building={building} profile={profile} world={world} floorId={focusedFloor} act={act} onPosted={focusFloor} onClose={closeSheet} />}
      {openPin && profile && <PinCard key={openPin.id} pin={openPin} building={building} profile={profile} world={world} act={act} onClose={closePin} />}
      {sheet === 'settings' && profile && <SettingsSheet building={building} profile={profile} world={world} category={category} act={act} onClose={closeSheet} onSwitchUser={supabaseBrowser() ? () => setSheet('account') : undefined} />}
      {sheet === 'account' && <DemoLoginSheet profile={profile} onClose={closeSheet} />}
      {sheet === 'buildings' && <BuildingsSheet buildings={buildings} currentId={building.building.id} onClose={closeSheet} />}
      {incidents.active.length > 0 && (
        <div className="alarm-banners" style={{ top: insets.top + 8 }}>
          {incidents.active.slice(-2).map(incident => {
            const space = building.spaces.find(s => s.id === incident.spaceId);
            const floor = building.floors.find(f => f.id === space?.floor_id);
            return (
              <div key={incident.id} className={`alarm-banner alarm-banner--${incident.hazard}`} role="alert">
                <span className="alarm-icon" aria-hidden>{hazardMeta[incident.hazard].icon}</span>
                <span className="alarm-text"><strong>{hazardMeta[incident.hazard].label}</strong> · {space?.name}{floor ? ` · ${floor.name}` : ''} · <Ago at={incident.createdAt} /></span>
                <button type="button" onClick={() => openIncident(incident)}>View</button>
                <button type="button" onClick={() => { incidents.setStatus(incident.id, 'resolved'); if (hazard.view?.incident?.id === incident.id) hazard.close(); }}>Resolve</button>
              </div>
            );
          })}
        </div>
      )}
      {hazard.view && (
        <HazardPanel building={building} view={hazard.view} panelRef={hazardPanel} onStartResponse={hazard.startResponse}
          onRoom={spaceId => setHazardRoom(spaceId)} onShowModel={() => { setHazardRoom(null); setHazardFloor(null); }} onClose={() => { hazard.close(); setHazardRoom(null); setHazardFloor(null); }}
          onResolve={hazard.view.incident ? () => { incidents.setStatus(hazard.view!.incident!.id, 'resolved'); hazard.close(); } : undefined} />
      )}
      {hazard.view && <HazardPlayback view={hazard.view} onT={hazard.setT} onPlay={hazard.togglePlay} style={{ bottom: insets.bottom + 10, left: insets.left + 16, right: (insets.right ?? 0) + 16 }} />}
      {sheet === 'damage' && <ReportDamage building={building} myRoom={myRoom} reporter={profile?.name} onClose={closeSheet} onRaise={incident => {
        incidents.raise(incident);
        closeSheet();
        playAlarm();
        openIncident(incident);
      }} />}
      {sheet === 'readiness' && <ReadinessSheet building={building} onClose={closeSheet} onShow={finding => {
        closeSheet();
        hazard.close();
        const focus = building.spaces.find(s => s.id === (finding.focus ?? finding.space_ids[0]));
        setDirective({ focus: focus ? { mode: 'floor', floorId: focus.floor_id } : { mode: 'building' }, highlights: finding.space_ids.map((spaceId, i) => ({ spaceId, tone: spaceId === finding.focus || i === 0 ? 'primary' : 'secondary', label: spaceId === (finding.focus ?? finding.space_ids[0]) ? finding.title : undefined })) });
      }} />}
      {sheet === 'location' && profile && <LocationSheet building={building} room={myRoom} sharing={settings?.share !== 'off'} onChange={setLocation} onSettings={() => setSheet('settings')} onClose={closeSheet} />}
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

/** "2 min ago", refreshed every 20 s. */
function Ago({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 20_000); return () => clearInterval(timer); }, []);
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return <>{minutes < 1 ? 'just now' : `${minutes} min ago`}</>;
}

/** Live incidents count as alerts on the floor rail. */
function withIncidents(counts: ReturnType<typeof floorCounts>, active: Incident[], building: Building, floorId: string) {
  const here = active.filter(i => building.spaces.find(s => s.id === i.spaceId)?.floor_id === floorId).length;
  return here ? { ...counts, alerts: counts.alerts + here, summary: [counts.summary, `${here} incident${here > 1 ? 's' : ''}`].filter(Boolean).join(' · ') } : counts;
}

/** A floor on the rail, with fixed badges for alerts (red) and people (blue) instead of chips floating in the model. */
function FloorButton({ floor, active, counts, onClick }: { floor: Building['floors'][number]; active: boolean; counts: ReturnType<typeof floorCounts>; onClick(): void }) {
  const label = counts.summary ? `${floor.name}: ${counts.summary}` : floor.name;
  return (
    <button type="button" className={`floor-button${active ? ' active' : ''}`} onClick={onClick} aria-label={label} title={label} aria-pressed={active}>
      {floorShort(floor.level)}
      {counts.alerts > 0 && <span className="floor-badge floor-badge--alert">{counts.alerts}</span>}
      {counts.people > 0 && <span className="floor-badge floor-badge--people">{counts.people}</span>}
    </button>
  );
}

function floorShort(level: number) {
  if (level === 0) return 'G';
  return level < 0 ? `B${-level}` : String(level);
}
