'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Building } from '@/lib/buildings/types';
import { floorCounts } from '@/components/world/world-anchors';
import { MicButton } from '@/components/mic-button';
import { DirectionsPanel } from './directions-panel';
import type { ChatRequest, ChatResponse, SceneDirective } from '@/lib/chat/contract';
import type { SceneInsets } from './building-scene';
import type { SceneStyle } from './scene-detail';
import { detectCategory } from '@/lib/world/mode';
import { saveProfile, useProfile } from '@/lib/world/profile';
import { LocationSheet } from '@/components/world/location-sheet';
import { AddBuildingPanel, BuildingsSheet, type BuildingRow } from '@/components/world/buildings-sheet';
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
import { VoiceAgent, type VoiceActions } from '@/components/voice/voice-agent';
import { BrigadePanel, BrigadeTimeline, FactsStrip, brigadeChips, brigadeDirective, useBrigade } from '@/components/brigade/brigade';
import { ReportDamage } from '@/components/hazards/report-damage';
import { ReadinessSheet } from '@/components/hazards/readiness-sheet';
import { hazardDirective, useHazard } from '@/components/hazards/use-hazard';
import { playAlarm, useIncidents } from '@/lib/hazards/incidents';
import { hazardMeta, levelAt, type Incident } from '@/lib/hazards/types';

/** Multiplayer (people, pins, pings, skills) is kept in the code but hidden from the interface: docs/UI_INVENTORY.md. */
const SHOW_MULTIPLAYER = false;

const BuildingScene = dynamic(() => import('./building-scene'), { ssr: false, loading: () => <div className="scene-loading">Building the model…</div> });

type Message = { id: number; role: 'user' | 'assistant'; content: string; response?: ChatResponse; error?: boolean };

interface Props {
  building: Building;
  /** ?campus=<id>: the campus to open (members with their offsets); cross-building answers extend this at runtime. */
  campus?: { id: string; members: { buildingId: string; offset: [number, number] }[] };
  /** ?ask=<question>: asked automatically once the page is ready (the fixed cross-building chip navigates here). */
  autoAsk?: string;
  buildings: BuildingRow[];
  suggestions: { label: string; question: string }[];
  /** Just created from plans: offer to go through what the importer was unsure about. */
  importIntro?: { checks: number; first?: string };
}

const overview: SceneDirective = { focus: { mode: 'building' } };
/** The fixed cross-building example: always offered as the fourth chip, on every building. */
/** Matches the desktop breakpoint in globals.css. Phone layout is the default. */
const wideQuery = '(min-width: 900px)';

function useWide() {
  return useSyncExternalStore(
    notify => { const mq = window.matchMedia(wideQuery); mq.addEventListener('change', notify); return () => mq.removeEventListener('change', notify); },
    () => window.matchMedia(wideQuery).matches,
    () => false,
  );
}

export function BuildingExperience({ building, buildings, suggestions, importIntro, campus, autoAsk }: Props) {
  const router = useRouter();
  // Wake the Python agent while people read the start screen (cold starts on Vercel).
  useEffect(() => { void fetch('/api/health').catch(() => undefined); }, []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [directive, setDirective] = useState<SceneDirective>(() => campus
    ? { focus: { mode: 'campus', members: campus.members.map(m => ({ buildingId: m.buildingId, offset: m.offset })) } }
    : overview);
  // The other campus buildings (cross-building routes): loaded lazily, remembered for the session.
  const [site, setSite] = useState<Map<string, { building: Building; offset: [number, number] }>>(() => new Map());
  const ensureSite = useCallback(async (members: { buildingId: string; offset: [number, number] }[]) => {
    for (const member of members) {
      if (member.buildingId === building.building.id) continue;
      setSite(current => {
        if (current.has(member.buildingId)) {
          if (current.get(member.buildingId)!.offset[0] === member.offset[0] && current.get(member.buildingId)!.offset[1] === member.offset[1]) return current;
          const next = new Map(current); next.set(member.buildingId, { ...current.get(member.buildingId)!, offset: member.offset }); return next;
        }
        return current;
      });
      if (!site.has(member.buildingId)) {
        try {
          const res = await fetch(`/api/buildings/${encodeURIComponent(member.buildingId)}`);
          if (!res.ok) continue;
          const other = await res.json() as Building;
          setSite(current => current.has(member.buildingId) ? current : new Map(current).set(member.buildingId, { building: other, offset: member.offset }));
        } catch { /* the campus answer still works for the primary building */ }
      }
    }
  }, [building.building.id, site]);
  useEffect(() => { if (campus) void ensureSite(campus.members); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const autoAsked = useRef(false);
  useEffect(() => {
    if (!autoAsk || autoAsked.current) return;
    autoAsked.current = true;
    void ask(autoAsk);
  }, [autoAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (directive.focus.mode === 'campus') void ensureSite(directive.focus.members.map(m => ({ buildingId: m.buildingId, offset: m.offset }))); }, [directive.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Backend conversation id: follow-ups and edits (closed lifts, new doors) stay in one session.
  const sessionId = useRef<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  // The route step the camera is showing: `${messageId}:${leg}-${step}`.
  const [activeStep, setActiveStep] = useState<string>();
  const wide = useWide();
  // Multiplayer: the shared world of this building (docs/MULTIPLAYER.md).
  const profile = useProfile();
  const { world: fullWorld, act } = useWorld(building, profile);
  const settings = profile && fullWorld ? settingsFor(profile, fullWorld.mode) : undefined;
  // "Show demo players" off: hide the scripted people (docs/MULTIPLAYER.md §9).
  const hideDemo = settings?.demoPlayers === false;
  const world = useMemo(() => hideDemo && fullWorld ? withoutDemo(fullWorld) : fullWorld, [fullWorld, hideDemo]);
  const category = useMemo(() => detectCategory(building), [building]);
  // "+" in the top bar: the right panel shows the add-a-building form instead of the chat.
  const [adding, setAdding] = useState(false);
  const [sheet, setSheet] = useState<'settings' | 'report' | 'account' | 'messages' | 'location' | 'buildings' | 'damage' | 'readiness'>();
  // Emergencies: a what-if simulation or a live incident, shown on the map with its side panel.
  const hazard = useHazard(building);
  const incidents = useIncidents(building.building.id);
  const [hazardRoom, setHazardRoom] = useState<string | null>(null);
  const [hazardFloor, setHazardFloor] = useState<string | null>(null);
  const hazardPanel = useRef<HTMLElement>(null);
  const [mapStyle, setMapStyle] = useMapStyle();
  const simulateMenu = useRef<HTMLDetailsElement>(null);
  // Emergency mode: while a live incident is open and not yet fixed, the whole platform turns dark and vivid.
  const emergency = incidents.active.some(i => !i.fixedAt);
  // The room selected on the model: a report starts there.
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  // An object or door picked on the model, attached to the chat as a chip (like a file in an editor's chat).
  const [chatContext, setChatContext] = useState<{ kind: 'asset' | 'opening' | 'space'; id: string } | null>(null);
  const selectObject = useCallback((kind: 'asset' | 'opening', id: string) => {
    setChatContext({ kind, id });
    requestAnimationFrame(() => input.current?.focus());
  }, []);
  const contextChip = chatContext ? describeContext(building, chatContext) : null;
  const lastAnswerTitle = messages.findLast(m => m.response?.answer)?.response?.answer?.title;
  // The live voice agent drives the same actions as the UI (components/voice/voice-agent.tsx).
  const voiceActions: VoiceActions = {
    ask: question => ask(question, undefined, true),
    simulate: (kind, room) => {
      const hazardKind = /fire|feuer|smoke/i.test(kind) ? 'fire' : /water|leak|wasser|flood/i.test(kind) ? 'water' : /power|electric|strom/i.test(kind) ? 'electrical' : null;
      const space = findSpace(building, room);
      if (!hazardKind) return 'Say fire, water or power.';
      if (!space) return `No room "${room}" in the plans.`;
      setHazardRoom(null); setHazardFloor(null);
      void hazard.open(space.id, hazardKind);
      return `${hazardKind === 'electrical' ? 'Power fault' : hazardKind === 'fire' ? 'Fire' : 'Water'} in ${space.name}. On the map.`;
    },
    showFloor: floor => {
      const target = findFloor(building, floor);
      if (!target) return `No floor "${floor}".`;
      if (hazard.view) { setHazardRoom(null); setHazardFloor(target === 'all' ? ALL_FLOORS : target); }
      else if (target === 'all') showOverview(); else focusFloor(target);
      return target === 'all' ? 'Whole building.' : `${building.floors.find(f => f.id === target)?.name}.`;
    },
    reportIncident: (kind, room) => {
      const hazardKind = /fire|feuer|smoke/i.test(kind) ? 'fire' : /water|leak|wasser|flood/i.test(kind) ? 'water' : 'electrical';
      const space = findSpace(building, room);
      if (!space) return `No room "${room}" in the plans.`;
      const incident: Incident = { id: crypto.randomUUID(), buildingId: building.building.id, hazard: hazardKind, spaceId: space.id, severity: 2, source: 'report',
        title: `${hazardMeta[hazardKind].label} reported`, description: 'Reported by voice', reporter: profile?.name, createdAt: Date.now(), status: 'active' };
      incidents.raise(incident); playAlarm(); openIncident(incident);
      return `Alarm raised. ${hazardMeta[hazardKind].label} in ${space.name}.`;
    },
    callFireBrigade: () => {
      if (!hazard.view) return 'No open incident.';
      hazard.startResponse();
      return hazard.view.mode === 'incident' ? 'Fire brigade called.' : 'Fire brigade called. Drill.';
    },
    clearMap: () => clearAnswer(),
  };
  // An answer card: show its scene; for a move, fly back to what was moved, in its new place, and select it again.
  const showAnswer = (response: ChatResponse) => {
    const edit = (response.edits ?? []).map(e => e as { action?: string; asset_id?: string; opening_id?: string }).find(e => e.action === 'move_door' || e.action === 'move_asset');
    const target = edit?.action === 'move_door' ? { kind: 'opening' as const, id: edit.opening_id! } : edit?.action === 'move_asset' ? { kind: 'asset' as const, id: edit.asset_id! } : null;
    if (target) setChatContext(target);
    const context = target ?? chatContext;
    setDirective(context ? keepSelectionInView(response, building, context) : response.scene);
  };
  // One selection at a time: a tapped room replaces an object in the chat, and an object replaces the room.
  const selectRoom = useCallback((spaceId: string | null) => {
    setSelectedRoom(spaceId);
    setChatContext(current => (spaceId ? { kind: 'space', id: spaceId } : current?.kind === 'space' ? null : current));
  }, []);
  const openIncident = useCallback((incident: Incident) => { setHazardRoom(null); setHazardFloor(null); void hazard.open(incident.spaceId, incident.hazard, 'incident', incident); }, [hazard]);
  // An incident raised on another screen: sound the alarm and show it.
  const { arrived, clearArrived } = incidents;
  useEffect(() => {
    if (!arrived || arrived.buildingId !== building.building.id) return;
    playAlarm();
    setToast(arrived);
    clearArrived();
  }, [arrived, building.building.id, clearArrived]);
  // Deep link for demos and the video: ?simulate=water:<space id> (or fire:, electrical:) opens that simulation.
  const openSimulation = hazard.open;
  // B-roll (?broll=1): only the model. ?view=building | xray | <floor id> picks the hazard view.
  // B-roll is local only (recording the submission video), never on the hosted app.
  const broll = useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).get('broll') === '1' && ['localhost', '127.0.0.1'].includes(window.location.hostname), () => false);
  const viewHandled = useRef(false);
  useEffect(() => {
    if (viewHandled.current || !hazard.view) return;
    viewHandled.current = true;
    const view = new URLSearchParams(window.location.search).get('view');
    if (view === 'building') setHazardFloor(ALL_FLOORS);
    else if (view === 'xray') setHazardFloor('__xray__');
    else if (view && building.floors.some(f => f.id === view)) setHazardFloor(view);
  }, [hazard.view, building]);
  // ---------- Fire brigade simulation (?view=brigade; started from the Simulate menu) ----------
  const search = useSyncExternalStore(noSubscribe, () => window.location.search, () => '');
  const params = useMemo(() => new URLSearchParams(search), [search]);
  // Emergency mode only exists when an incident is reported (or a sensor fires) or a simulation is started.
  const brigade = params.get('view') === 'brigade';
  const tNow = Number(params.get('t') ?? 4) || 0;
  const eta = Number(params.get('eta') ?? 8) || 8;
  const brigadeOrigin = useMemo(() => {
    if (!brigade) return null;
    const [kind, id] = (params.get('alarm') ?? '').split(':');
    if (kind === 'fire' && building.spaces.some(sp => sp.id === id)) return id;
    if (building.spaces.some(sp => sp.id === 'proc-campus-test-005-F3-S025')) return 'proc-campus-test-005-F3-S025';
    return scenariosFor(building).find(sc => sc.hazard === 'fire')?.spaceId ?? null;
  }, [brigade, params, building]);
  const [rescueTarget, setRescueTarget] = useState<string | null>(params.get('crew1'));
  const [brigadeTab, setBrigadeTab] = useState<'situation' | 'people' | 'routes' | 'ask'>(params.get('crew1') || params.get('routes') ? 'routes' : 'situation');
  const brigadeStarted = useRef(false);
  useEffect(() => {
    if (!brigade || !brigadeOrigin || brigadeStarted.current) return;
    brigadeStarted.current = true;
    void hazard.open(brigadeOrigin, 'fire');
    hazard.setT(tNow);
  }, [brigade, brigadeOrigin, hazard, tNow]);
  const brigadeData = useBrigade(building, brigadeOrigin, tNow, eta, hazard.view?.t ?? tNow, rescueTarget);
  const simulateHandled = useRef(false);
  useEffect(() => {
    if (simulateHandled.current) return;
    simulateHandled.current = true;
    const [kind, spaceId] = (new URLSearchParams(window.location.search).get('simulate') ?? '').split(':');
    if ((kind === 'fire' || kind === 'water' || kind === 'electrical') && building.spaces.some(s => s.id === spaceId)) void openSimulation(spaceId, kind);
  }, [building, openSimulation]);
  // Start-screen entry points for the emergency side: a water leak on an upper floor, a fire in a busy room.
  const demoScenarios = useMemo(() => scenariosFor(building), [building]);
  // The open incident as stored now (ticket, fixed), and the map fading back to normal once it is fixed.
  const liveIncident = hazard.view?.incident ? incidents.all.find(i => i.id === hazard.view!.incident!.id) : undefined;
  const fade = useFade(liveIncident?.fixedAt);
  // While a scenario plays, each floor in the sidebar shows how many of its spaces are hit right now (a building section).
  const hazardByFloor = useMemo(() => {
    const out = new Map<string, { kind: 'fire' | 'water' | 'electrical'; count: number }>();
    const view = hazard.view;
    if (!view?.data || liveIncident?.fixedAt) return out;
    const floorOf = new Map(building.spaces.map(s => [s.id, s.floor_id]));
    for (const entry of view.data.simulation.spaces) {
      if (entry.kind !== view.hazard || levelAt(entry, view.t, view.data.simulation.ramp_min) < 0.15) continue;
      const floorId = floorOf.get(entry.space_id);
      if (!floorId) continue;
      out.set(floorId, { kind: view.hazard, count: (out.get(floorId)?.count ?? 0) + 1 });
    }
    return out;
  }, [hazard.view, building, liveIncident?.fixedAt]);
  const baseDirective = useMemo(() => (hazard.view ? hazardDirective(building, hazard.view, hazardRoom, hazardFloor, fade) : directive), [hazard.view, building, hazardRoom, hazardFloor, directive, fade]);
  // The chat's selected object lights up on the model, whatever the answer shows.
  const brigadeScene = useMemo(() => (brigade && hazard.view ? brigadeDirective(baseDirective, building, brigadeData.briefing, brigadeData.people, brigadeData.routes, brigadeTab === 'routes' || (hazard.view.t >= tNow + eta)) : baseDirective),
    [brigade, hazard.view, baseDirective, building, brigadeData.briefing, brigadeData.people, brigadeData.routes, brigadeTab, tNow, eta]);
  const shownDirective = useMemo(() => (chatContext?.kind === 'asset' ? { ...brigadeScene, assets: [...new Set([...(brigadeScene.assets ?? []), chatContext.id])] } : brigadeScene), [brigadeScene, chatContext]);
  // A pushed alert (another screen raised it, or ?notify= for the video): tap to open.
  const [toast, setToast] = useState<Incident | null>(null);
  // Deep links for demos and the video: ?incident=<kind>:<space id> raises and opens a live incident;
  // ?notify=<kind>:<space id> raises it and shows the alert only. Press "f" to mark the open incident fixed.
  const raiseIncident = incidents.raise;
  const linkHandled = useRef(false);
  useEffect(() => {
    if (linkHandled.current) return;
    linkHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    for (const key of ['incident', 'notify'] as const) {
      const [kind, spaceId] = (params.get(key) ?? '').split(':');
      const space = building.spaces.find(s => s.id === spaceId);
      if (!space || !(kind === 'fire' || kind === 'water' || kind === 'electrical')) continue;
      const incident: Incident = { id: crypto.randomUUID(), buildingId: building.building.id, hazard: kind, spaceId, severity: 2, source: 'sensor',
        title: kind === 'electrical' ? 'Power loss' : kind === 'water' ? 'Water detected' : 'Smoke detected', description: `${kind === 'electrical' ? 'Power monitor' : kind === 'water' ? 'Leak sensor' : 'Smoke detector'} in ${space.name}`, createdAt: Date.now(), status: 'active' };
      raiseIncident(incident);
      if (key === 'incident') openIncident(incident);
      else window.setTimeout(() => { playAlarm(); setToast(incident); }, 1500);
    }
  }, [building, raiseIncident, openIncident]);
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
  const focusedFloor = shownDirective.focus.mode === 'floor' ? shownDirective.focus.floorId : undefined;
  // On phones the sheet shows only the latest exchange until expanded.
  const showAll = wide || expanded;
  const lastUser = messages.findLastIndex(m => m.role === 'user');
  const visible = showAll ? messages : messages.slice(Math.max(0, busy ? lastUser : messages.length - 1));

  // The model has its own area in the platform layout: nothing covers it, so the camera needs no insets.
  const insets: SceneInsets = ZERO_INSETS;
  useEffect(() => {
    const list = floorList.current;
    if (!list) return;
    // Scroll only the floor strip itself (scrollIntoView would also shift the page on phones).
    const strip = list.closest('.shell-side') ?? list;
    const active = list.querySelector<HTMLElement>('.active');
    if (active && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: active.offsetLeft - strip.clientWidth / 2 + active.offsetWidth / 2, behavior: 'smooth' });
  }, [focusedFloor]);
  // Show the latest question with its answer card at the top, not the end of a long step list.
  useEffect(() => {
    // Scroll the conversation pane only, never the page.
    const pane = transcript.current;
    const target = busy ? transcriptEnd.current : latestQuestion.current ?? transcriptEnd.current;
    if (!pane || !target) return;
    // Twice: now, and once the answer (card, directions) has laid out, which can move the question.
    const go = () => {
      const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 8;
      pane.scrollTo({ top: busy ? pane.scrollHeight : top });
    };
    go();
    const timer = window.setTimeout(go, 350);
    return () => window.clearTimeout(timer);
  }, [messages, busy, expanded]);

  // Whole building, keeping the current answer's highlights and route.
  const showOverview = useCallback(() => setDirective(current => ({ ...current, focus: { mode: 'building' } })), []);
  // Dismiss the answer on the map (route, highlights, markers) and stay where the camera is; the chat stays.
  const clearAnswer = useCallback(() => setDirective(current => ({ focus: current.focus.mode === 'floor' ? { mode: 'floor', floorId: current.focus.floorId } : current.focus })), []);
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
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (event.key === 'f' && !typing && liveIncident && liveIncident.ticket && !liveIncident.fixedAt) { incidents.update(liveIncident.id, { fixedAt: Date.now() }); return; }
      if (event.key === 'Escape' && hazard.view) { hazard.close(); return; }
      if (event.key === 'Escape' && (directive.routes?.length || directive.highlights?.length || directive.markers?.length)) { clearAnswer(); return; }
      // Arrow up/down (or Page up/down) step one floor at a time, unless the user is typing.
      const step = { ArrowUp: 1, PageUp: 1, ArrowDown: -1, PageDown: -1 }[event.key];
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
  }, [showOverview, startOver, directive, floors, focusedFloor, focusFloor, hazard, liveIncident, incidents, clearAnswer]);

  /** Send a question to the building agent; resolves to its reply (the voice agent reads it back). */
  // The emergency on screen goes with every question, so "the fire" and "where is it" resolve for the agent.
  function incidentContext(): ChatRequest['incident'] {
    const view = hazard.view;
    if (!view) return undefined;
    const data = view.data;
    const affected = data ? data.simulation.spaces.filter(e => e.kind === view.hazard && levelAt(e, view.t, data.simulation.ramp_min) > 0.5).map(e => e.space_id) : [];
    return { hazard: view.hazard, origin: view.spaceId, t: Math.round(view.t), affected };
  }

  async function ask(text: string, skillId?: string, voice = false): Promise<string> {
    const message = text.trim();
    if (!message || busy) return busy ? 'Still on the last one.' : '';
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages(current => [...current, { id: nextId.current++, role: 'user', content: message }]);
    setDraft('');
    setBusy(true);
    setExpanded(false);
    // Close the phone keyboard so the answer and the model are visible.
    if (!wide) input.current?.blur();
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ buildingId: building.building.id, message, history, sessionId: sessionId.current, conversationId: conversationId.current, playerId: profile?.id, skillId, location: profile?.rooms[building.building.id], selection: chatContext ? { ...chatContext, view_right: (window as unknown as { __lfViewRight?: [number, number] }).__lfViewRight } : undefined, incident: incidentContext() }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
      const response = data as ChatResponse;
      sessionId.current = response.sessionId;
      // The building changed (new door, moved machine, renamed room): reload the plan for the viewer.
      if (response.edits?.length) router.refresh();
      conversationId.current = response.conversationId ?? conversationId.current;
      setMessages(current => [...current, { id: nextId.current++, role: 'assistant', content: response.reply, response }]);
      setDirective(chatContext ? keepSelectionInView(response, building, chatContext) : response.scene);
      setActiveStep(undefined);
      return voice ? voiceBrief(response) : withoutAnswerLine(response.reply);
    } catch (error) {
      setMessages(current => [...current, { id: nextId.current++, role: 'assistant', content: error instanceof Error ? error.message : 'Something went wrong.', error: true }]);
      return error instanceof Error ? error.message : 'Something went wrong.';
    } finally {
      setBusy(false);
      if (wide) input.current?.focus();
    }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); if (brigade) setBrigadeTab('ask'); void ask(draft); };
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
    <main className={`experience shell${started ? ' experience--started' : ''}${hazard.view ? ' experience--hazard' : ''}${broll ? ' shell--broll' : ''}${emergency && !brigade ? ' shell--emergency' : ''}${brigade ? ' shell--brigade' : ''}`}>
      <header className="shell-top" ref={header}>
        <Link className="brand" href={`/?building=${building.building.id}`} aria-label="lost & found: back to overview" onClick={event => { event.preventDefault(); startOver(); }}>◈ <span>lost & found</span></Link>
        <button type="button" className="shell-add-building" onClick={() => { if (sheet === 'damage') setSheet(undefined); setAdding(open => !open); }} aria-label="Add a building" aria-pressed={adding} title="Add a building">+</button>
        <button type="button" className="shell-building" onClick={() => setSheet('buildings')} aria-label={`Building: ${buildings.find(b => b.id === building.building.id)?.name ?? building.building.name}. Choose another`}>
          {buildings.find(b => b.id === building.building.id)?.name ?? building.building.name}<span aria-hidden>▾</span>
        </button>
        <span className="shell-spacer" />
        {brigade && <span className="brigade-tag">FIRE BRIGADE · SIMULATED</span>}
        {brigade && <button type="button" className="shell-button" onClick={() => router.push(`/?building=${encodeURIComponent(building.building.id)}`)}>End simulation</button>}
        {!brigade && <div className="shell-lamps" aria-label="Active incidents">
          {(['fire', 'water', 'electrical'] as const).map(kind => {
            const active = incidents.active.filter(i => i.hazard === kind && !i.fixedAt);
            return (
              <button type="button" key={kind} className={`shell-lamp shell-lamp--${kind}${active.length ? ' is-lit' : ''}`} disabled={!active.length} onClick={() => active[0] && openIncident(active.at(-1)!)} aria-label={`${hazardMeta[kind].label}: ${active.length} active`}>
                <i />{kind === 'fire' ? 'Fire' : kind === 'water' ? 'Water' : 'Power'}<b>{active.length}</b>
              </button>
            );
          })}
        </div>}
        {!brigade && <details className="simulate-menu" ref={simulateMenu}>
          <summary className="shell-button">Simulate</summary>
          <div className="simulate-list" role="menu">
            {demoScenarios.filter(sc => sc.hazard === 'fire').map(scenario => (
              <button type="button" role="menuitem" key="brigade" onClick={() => { simulateMenu.current?.removeAttribute('open'); router.push(`/?view=brigade&building=${encodeURIComponent(building.building.id)}&alarm=fire:${encodeURIComponent(building.spaces.some(sp => sp.id === 'proc-campus-test-005-F3-S025') ? 'proc-campus-test-005-F3-S025' : scenario.spaceId)}&t=4&eta=8`); }}>
                <i className="hazard-dot hazard-dot--fire" /><span><strong>Fire brigade drill</strong><em>Alarm, spread, people, crew routes</em></span>
              </button>
            ))}
            {demoScenarios.map(scenario => (
              <button type="button" role="menuitem" key={scenario.hazard} onClick={() => { simulateMenu.current?.removeAttribute('open'); setHazardRoom(null); setHazardFloor(null); void hazard.open(scenario.spaceId, scenario.hazard); }}>
                <i className={`hazard-dot hazard-dot--${scenario.hazard}`} /><span><strong>{scenario.hazard === 'fire' ? 'Fire' : 'Water leak'}</strong><em>{building.spaces.find(sp => sp.id === scenario.spaceId)?.name}</em></span>
              </button>
            ))}
            <p>Or select any room on the model and pick Fire, Water or Power.</p>
          </div>
        </details>}
        {!brigade && <button type="button" className="shell-button" onClick={() => setSheet('readiness')}>Readiness</button>}
        {!brigade && <button type="button" className="shell-button shell-button--primary" onClick={() => { setAdding(false); setSheet(open => (open === 'damage' ? undefined : 'damage')); }}>Report incident</button>}
        <button type="button" className="shell-account" onClick={() => setSheet('account')} aria-label={profile ? `Signed in as ${profile.name}. Switch account` : 'Sign in'}>{profile ? initials(profile.name) : 'Sign in'}</button>
        {SHOW_MULTIPLAYER && <WorldHud world={world} playerId={profile?.id} unread={unread} onOpen={() => setSheet('settings')} onMessages={() => setSheet('messages')}
          location={profile ? building.spaces.find(s => s.id === myRoom)?.name ?? null : undefined} onLocation={() => setSheet('location')} />}
      </header>


      <section className="shell-main">
        <div className="scene"><BuildingScene building={building} site={site} buildUp={params.get('reveal') === '1'} directive={shownDirective} insets={insets} mapStyle={mapStyle} emergency={emergency} onSelectRoom={selectRoom} onSelectObject={selectObject} selectedObject={chatContext} onSimulate={(spaceId, kind) => {
            if (brigade) { router.push(`/?view=brigade&building=${encodeURIComponent(building.building.id)}&alarm=fire:${encodeURIComponent(spaceId)}&t=0&eta=${eta}&open=1`); return; }
            setHazardRoom(null); setHazardFloor(null); void hazard.open(spaceId, kind);
          }} onFocusFloor={focusFloor} world={SHOW_MULTIPLAYER ? world : undefined} onPin={setPinId} onPerson={setPersonId} onRoute={routeTo} onSetLocation={profile ? setLocation : undefined} myRoom={myRoom} /></div>
        {!hazard.view && (directive.routes?.length || directive.highlights?.length || directive.markers?.length) ? (
          <div className="answer-pill" role="status">
            <span>{lastAnswerTitle ?? 'Answer on the map'}</span>
            <button type="button" onClick={clearAnswer} aria-label="Clear from the map (Esc)">×</button>
          </div>
        ) : null}
        {/* Toolbar along the top of the model: floors (bottom to top, left to right) and the map style. */}
        <div className="model-toolbar">
          <nav className="floor-picker" ref={floorList} aria-label="Floors">
          <button type="button" className={(hazard.view ? hazardFloor === ALL_FLOORS : directive.focus.mode === 'building') ? 'active' : ''} onClick={() => { if (hazard.view) { setHazardRoom(null); setHazardFloor(ALL_FLOORS); } else showOverview(); }} aria-label="Whole building" title="Whole building">⌂</button>
          {floors.map(floor => (
            <FloorButton key={floor.id} floor={floor} active={focusedFloor === floor.id} counts={withIncidents(floorCounts(SHOW_MULTIPLAYER ? world : undefined, floor.id), incidents.active, building, floor.id)} hazard={hazardByFloor.get(floor.id)} onClick={() => { if (hazard.view) { setHazardRoom(null); setHazardFloor(floor.id); } else focusFloor(floor.id); }} />
          ))}
        </nav>
          <span className="model-toolbar-gap" />
          <div className="view-switch" role="group" aria-label="Map style">
          {(['blocks', 'detailed'] as const).map(option => <button type="button" key={option} aria-pressed={mapStyle === option} onClick={() => setMapStyle(option)}>{option === 'blocks' ? 'Blocks' : 'Detailed'}</button>)}
        </div>
        </div>
        {building.building.license !== 'CC0-1.0' && <footer className="model-credit">{building.building.attribution} · {building.building.license}</footer>}
        {brigade && hazard.view && <FactsStrip briefing={brigadeData.briefing} t={hazard.view.t} />}
        {hazard.view && (brigade
          ? <BrigadeTimeline briefing={brigadeData.briefing} t={hazard.view.t} playing={hazard.view.playing} onT={hazard.setT} onPlay={hazard.togglePlay} />
          : <HazardPlayback view={hazard.view} onT={hazard.setT} onPlay={hazard.togglePlay} />)}
        {!broll && <VoiceAgent actions={voiceActions} />}
      </section>

      <aside className={`shell-panel${adding || sheet === 'damage' ? ' shell-panel--task' : ''}`} aria-label="Assistant">
        {adding && sheet !== 'damage' && <AddBuildingPanel onClose={() => setAdding(false)} />}
        {sheet === 'damage' && <ReportDamage building={building} myRoom={selectedRoom ?? myRoom} reporter={profile?.name} onClose={closeSheet} onRaise={incident => {
          incidents.raise(incident);
          closeSheet();
          playAlarm();
          openIncident(incident);
        }} />}
        {brigade && hazard.view && (
          <BrigadePanel briefing={brigadeData.briefing} people={brigadeData.people} routes={brigadeData.routes} tab={brigadeTab} onTab={setBrigadeTab}
            onRoom={spaceId => setHazardRoom(spaceId)} onRescue={spaceId => { setRescueTarget(spaceId); setBrigadeTab('routes'); }} />
        )}
        {!brigade && hazard.view && (
          <HazardPanel building={building} view={hazard.view} panelRef={hazardPanel} onStartResponse={hazard.startResponse}
            onRoom={spaceId => setHazardRoom(spaceId)} onShowModel={() => { setHazardRoom(null); setHazardFloor(null); }} onShowFloor={floorId => { setHazardRoom(null); setHazardFloor(floorId); }} onClose={() => { hazard.close(); setHazardRoom(null); setHazardFloor(null); }}
            incident={liveIncident}
          onDispatch={contact => liveIncident && incidents.update(liveIncident.id, { ticket: { name: contact.name, role: contact.role, phone: contact.phone, etaMin: contact.eta_min, at: Date.now() } })}
          onFixed={() => liveIncident && incidents.update(liveIncident.id, { fixedAt: Date.now() })}
          onResolve={hazard.view.incident ? () => { incidents.setStatus(hazard.view!.incident!.id, 'resolved'); hazard.close(); } : undefined} />
        )}
        {started && !hazard.view && (
          <div className="chat-head">
            <span>Conversation</span>
            <button type="button" className="chat-new" onClick={startOver}>＋ New chat</button>
          </div>
        )}
        <section ref={transcript} className={`shell-chat${hazard.view && !brigade ? ' shell-chat--compact' : ''}`} hidden={brigade ? brigadeTab !== 'ask' : Boolean(hazard.view) && !started} aria-label="Conversation" aria-live="polite">
          {!started && !hazard.view && (
            <div className="shell-intro">
              <h1>Your fire co-pilot</h1>
              <p>For fire crews: the way in, the fastest route to the fire, the nearest exit, what is above, below and next to it.</p>
              {importIntro && (
                <div className="import-intro">
                  <strong>Built from your plans.</strong>
                  <span>{importIntro.checks ? `${importIntro.checks} thing${importIntro.checks === 1 ? '' : 's'} to check, e.g. “${importIntro.first}”` : 'Nothing to check: ask me anything.'}</span>
                  {importIntro.checks > 0 && <button type="button" className="button button--primary" onClick={() => void ask('Let’s check what you were unsure about in this building, one question at a time.')}>Check it with me</button>}
                </div>
              )}
              <div className="shell-examples">
                {suggestions.slice(0, 4).map(s => <button type="button" key={s.label} onClick={() => void ask(s.question)}>{s.question}</button>)}
              </div>
            </div>
          )}
          {started && (
            <div className="transcript-scroll">
              {visible.map(message => message.role === 'user'
                ? <p key={message.id} ref={message.id === messages[lastUser]?.id ? latestQuestion : undefined} className="bubble bubble--user">{message.content}</p>
                : <article key={message.id} className={`bubble bubble--assistant${message.error ? ' bubble--error' : ''}`}>
                    <AgentAvatar />
                    {message.response?.answer && (
                      <button type="button" className={`answer-card${message.response.answer.negative ? ' answer-card--negative' : ''}`} onClick={() => { showAnswer(message.response!); setActiveStep(undefined); }} aria-label={`Show ${message.response.answer.title} on the model`}>
                        <span className="answer-title">{message.response.answer.title}</span>
                        {message.response.answer.value && <span className="answer-value">{message.response.answer.value}</span>}
                        {message.response.answer.detail && <span className="answer-detail">{message.response.answer.detail}</span>}
                      </button>
                    )}
                    <Reply text={withoutAnswerLine(message.content)} />
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
                          setDirective({ ...message.response!.scene, ...(step.at.floorId ? { focus: { mode: 'floor' as const, floorId: step.at.floorId, around: step.at.position } } : {}) });
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
          )}
        </section>
        <section className="shell-ask" ref={dock}>
          {brigade && hazard.view && brigadeTab === 'ask' && (
            <details className="brigade-chips" open>
              <summary>Ask the building</summary>
              <div>
                {brigadeChips(brigadeData.briefing, brigadeData.people).slice(0, 4).map(chip => <button type="button" key={chip.label} onClick={() => { setBrigadeTab('ask'); void ask(chip.question); }}>{chip.label}</button>)}
                <details className="brigade-more"><summary>More</summary>
                  {brigadeChips(brigadeData.briefing, brigadeData.people).slice(4).map(chip => <button type="button" key={chip.label} onClick={() => { setBrigadeTab('ask'); void ask(chip.question); }}>{chip.label}</button>)}
                </details>
              </div>
            </details>
          )}
          {SHOW_MULTIPLAYER && profile && <PasserBy world={world} profile={profile} building={building} routes={directive.routes} act={act} />}
          {SHOW_MULTIPLAYER && (world && profile && mentionQuery(draft) !== undefined
            ? <MentionPicker players={world.players.filter(p => p.id !== profile.id)} draft={draft} onPick={text => { setDraft(text); input.current?.focus(); }} />
            : world && <SkillChips skills={world.skills} draft={draft} onUse={skill => void ask(skill.name, skill.id)} />)}
          {contextChip && (
            <div className="ask-actions" aria-label="Suggestions for the selection">
              {contextChip.actions.map(action => (
                <button type="button" key={action.label} onClick={() => {
                  if (action.send) { void ask(action.message); return; }
                  setDraft(action.message);
                  requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
                }}>{action.label}</button>
              ))}
            </div>
          )}
          <form className={`ask${contextChip ? ' ask--context' : ''}`} onSubmit={submit}>
            {contextChip && (
              <div className="ask-context">
                <span className={`ask-chip ask-chip--${chatContext!.kind}`} title={contextChip.detail}>
                  <i aria-hidden />{contextChip.label}<em>{contextChip.where}</em>
                  <button type="button" onClick={() => setChatContext(null)} aria-label={`Remove ${contextChip.label} from the chat`}>×</button>
                </span>
              </div>
            )}
            {SHOW_MULTIPLAYER && <button type="button" className="ask-plus" onClick={() => { setReportDraft(undefined); setSheet('report'); }} disabled={!profile} aria-label="Report something">+</button>}
            <input ref={input} value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} enterKeyHint="send" autoComplete="off" placeholder={contextChip ? `Ask about this ${chatContext!.kind === 'opening' ? 'door' : chatContext!.kind === 'space' ? 'room' : 'object'}…` : hazard.view ? 'Ask or coordinate…' : started ? 'Ask a follow-up…' : 'Where is the fire? Which entrance? Nearest exit?'} aria-label="Ask about the building" />
            <MicButton onTranscript={addTranscript} onError={setVoiceError} />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Send">{busy ? '…' : '↑'}</button>
          </form>
          {voiceError && <p className="voice-error" role="alert">{voiceError}</p>}
        </section>
      </aside>

      {SHOW_MULTIPLAYER && profile && settings && <Inbox world={world} playerId={profile.id} building={building} pingFrom={settings.pingFrom} groups={profile.groups} top={insets.top + 8} act={act} onGo={routeTo} onMore={() => setSheet('messages')} onShareLocation={() => {
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
      {toast && (
        <button type="button" className="incident-toast" onClick={() => { openIncident(toast); setToast(null); }}>
          <i className={`hazard-dot hazard-dot--${toast.hazard}`} />
          <span><strong>{toast.title} · {building.building.name}</strong><em>{building.spaces.find(s => s.id === toast.spaceId)?.name} · {building.floors.find(f => f.id === building.spaces.find(s => s.id === toast.spaceId)?.floor_id)?.name}</em></span>
          <time>now</time>
        </button>
      )}
      {sheet === 'readiness' && <ReadinessSheet building={building} onClose={closeSheet} onShow={finding => {
        closeSheet();
        hazard.close();
        // A finding about whole floors (nothing on them yet): light up every room on those floors, building in view.
        if (!finding.space_ids.length && finding.floor_ids?.length) {
          const floorIds = new Set(finding.floor_ids);
          setDirective({ focus: { mode: 'building' }, highlights: building.spaces.filter(s => floorIds.has(s.floor_id)).map(s => ({ spaceId: s.id, tone: 'secondary' as const })) });
          return;
        }
        const focus = building.spaces.find(s => s.id === (finding.focus ?? finding.space_ids[0]));
        setDirective({ focus: focus ? { mode: 'floor', floorId: focus.floor_id } : { mode: 'building' }, highlights: finding.space_ids.map((spaceId, i) => ({ spaceId, tone: spaceId === finding.focus || i === 0 ? 'primary' : 'secondary', label: spaceId === (finding.focus ?? finding.space_ids[0]) ? finding.title : undefined })) });
      }} />}
      {sheet === 'location' && profile && <LocationSheet building={building} room={myRoom} sharing={settings?.share !== 'off'} onChange={setLocation} onSettings={() => setSheet('settings')} onClose={closeSheet} />}
      {supabaseBrowser() && signedIn === null && sheet !== 'account' && <DemoLoginSheet profile={profile} />}
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
/** The agent writes light markdown: paragraphs, "- " lists and **bold**. Render exactly that, nothing more. */
function Reply({ text }: { text: string }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of text.replace(/ - (?=\*\*|[A-Z0-9])/g, '\n- ').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const list = /^[-•]\s+/.test(line);
    const last = blocks.at(-1);
    if (last && last.list === list && list) last.lines.push(line.replace(/^[-•]\s+/, ''));
    else blocks.push({ list, lines: [list ? line.replace(/^[-•]\s+/, '') : line] });
  }
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
  return <div className="reply">{blocks.map((block, i) => block.list
    ? <ul key={i}>{block.lines.map((line, j) => <li key={j}>{inline(line)}</li>)}</ul>
    : <p key={i}>{inline(block.lines[0])}</p>)}</div>;
}

function withoutAnswerLine(reply: string) {
  return reply.replace(/\n*^\s*Answer:.*$/gim, '').trim();
}

/** Sentinel for the hazard view's floor: the whole building instead of one floor. */
const ALL_FLOORS = '__all__';
const noSubscribe = () => () => {};
const ZERO_INSETS: SceneInsets = { top: 0, left: 0, bottom: 0, right: 0 };
const STYLE_KEY = 'lf-scene-style';
const styleListeners = new Set<() => void>();
/** Blocks or Detailed, remembered per browser (an external store: no hydration mismatch, no effect). */
function useMapStyle(): [SceneStyle, (style: SceneStyle) => void] {
  const style = useSyncExternalStore(
    listener => { styleListeners.add(listener); return () => { styleListeners.delete(listener); }; },
    () => (localStorage.getItem(STYLE_KEY) === 'detailed' ? 'detailed' : 'blocks'),
    () => 'blocks',
  );
  const set = useCallback((next: SceneStyle) => { localStorage.setItem(STYLE_KEY, next); styleListeners.forEach(l => l()); }, []);
  return [style as SceneStyle, set];
}

/**
 * While something is selected (a chip in the chat), answers about it keep the camera on it: a clarifying question or
 * an edit doesn't jump back to the whole building, and after a move the camera follows it to where it went.
 * Answers that show something else on purpose (a route, another room on another floor) keep their own view.
 */
function keepSelectionInView(response: ChatResponse, building: Building, context: { kind: 'asset' | 'opening' | 'space'; id: string }): SceneDirective {
  const scene = response.scene;
  const moved = (response.edits ?? []).map(e => e as { action?: string; asset_id?: string; opening_id?: string; position?: [number, number] })
    .find(e => (e.action === 'move_door' && e.opening_id === context.id) || (e.action === 'move_asset' && e.asset_id === context.id));
  let floorId: string | undefined, position: [number, number] | undefined;
  if (context.kind === 'asset') {
    const asset = building.assets.find(a => a.id === context.id);
    floorId = asset?.floor_id; position = moved?.position ?? asset?.position;
  } else if (context.kind === 'opening') {
    const opening = building.openings.find(o => o.id === context.id);
    floorId = opening?.floor_id; position = moved?.position ?? opening?.position;
  } else {
    const space = building.spaces.find(sp => sp.id === context.id);
    floorId = space?.floor_id;
    if (space) position = [space.polygon.reduce((a, p) => a + p[0], 0) / space.polygon.length, space.polygon.reduce((a, p) => a + p[1], 0) / space.polygon.length];
  }
  if (!floorId || !position) return scene;
  const ownView = Boolean(scene.routes?.length) || (scene.focus.mode === 'floor' && scene.focus.floorId !== floorId && !response.edits?.length);
  if (ownView) return scene;
  return { ...scene, focus: { mode: 'floor', floorId, around: position } };
}

/** A room by spoken name: exact name, then the room number ("3.25", "N2301"), then a word match. */
function findSpace(building: Building, text: string) {
  const q = text.trim().toLowerCase();
  const spaces = building.spaces.filter(sp => sp.type !== 'stair' && sp.type !== 'lift');
  const number = q.match(/[a-z]?-?\d+(\.\d+)?[a-z]?/i)?.[0];
  return spaces.find(sp => sp.name.toLowerCase() === q)
    ?? (number ? spaces.find(sp => sp.name.toLowerCase().endsWith(` ${number}`) || sp.name.toLowerCase().split(' ').includes(number)) : undefined)
    ?? spaces.find(sp => sp.name.toLowerCase().includes(q) || q.includes(sp.name.toLowerCase()));
}

/** A floor by spoken name: "3", "floor 3", "ground floor", "basement", "whole building". */
function findFloor(building: Building, text: string): string | 'all' | undefined {
  const q = text.trim().toLowerCase();
  if (/whole|building|all|overview/.test(q)) return 'all';
  if (/ground|erdgeschoss|^g$|^eg$/.test(q)) return building.floors.find(f => f.level === 0)?.id;
  if (/basement|keller|^b\d?$|underground/.test(q)) return building.floors.find(f => f.level === (Number(q.match(/\d+/)?.[0] ?? 1) * -1))?.id ?? building.floors.find(f => f.level < 0)?.id;
  const n = q.match(/-?\d+/)?.[0];
  return n !== undefined ? building.floors.find(f => f.level === Number(n))?.id : building.floors.find(f => f.name.toLowerCase() === q)?.id;
}

/**
 * What the voice co-pilot says back: the answer in a few words ("Lab 4.10, floor 4. Route is on the map."), not the
 * whole chat reply. The full answer stays in the chat and on the map.
 */
function voiceBrief(response: ChatResponse): string {
  const routed = Boolean(response.scene?.routes?.length);
  const tail = routed ? ' Route is on the map.' : '';
  if (response.answer) {
    const { title, value, detail } = response.answer;
    const parts = [title, value, detail && detail.length <= 32 ? detail : undefined].filter(Boolean).join(', ');
    return `${parts.replace(/\s*→\s*/g, ' to ').replace(/\s*↔\s*/g, ' and ')}.${tail}`.replace(/\.\./g, '.');
  }
  const plain = withoutAnswerLine(response.reply).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  const first = plain.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? plain;
  const words = first.split(' ');
  return `${words.length > 18 ? `${words.slice(0, 18).join(' ')}.` : first}${tail}`;
}

/** The chat chip for a selection: what it is, where, and the edits that make sense for it. */
function describeContext(building: Building, context: { kind: 'asset' | 'opening' | 'space'; id: string }) {
  const spaceName = (id: string) => building.spaces.find(s => s.id === id)?.name ?? (id === 'outside' ? 'outside' : id);
  if (context.kind === 'asset') {
    const asset = building.assets.find(a => a.id === context.id);
    if (!asset) return null;
    return {
      label: asset.name, where: spaceName(asset.space_id), detail: `${asset.type.replaceAll('_', ' ')} · ${asset.category}`,
      actions: [
        { label: 'Move it to…', message: 'Move this to ', send: false },
        { label: 'What is it used for?', message: 'What is this and which room is it in?', send: true },
        { label: 'Nearest exit from here', message: 'What is the nearest way out from where this is?', send: true },
      ],
    };
  }
  if (context.kind === 'opening') {
    const opening = building.openings.find(o => o.id === context.id);
    if (!opening) return null;
    const [a, b] = opening.space_ids.map(spaceName);
    return {
      label: opening.kind === 'entrance' ? 'Entrance' : opening.kind === 'opening' ? 'Opening' : 'Door', where: `${a} ↔ ${b}`,
      detail: `${opening.width_m.toFixed(2)} m wide · ${opening.step_free ? 'step-free' : 'with a step'}`,
      actions: [
        { label: 'Close this door', message: 'Close this door.', send: true },
        { label: 'Reopen it', message: 'Reopen this door.', send: true },
        { label: 'Set width…', message: 'Make this door ', send: false },
      ],
    };
  }
  const space = building.spaces.find(s => s.id === context.id);
  return space ? { label: space.name, where: building.floors.find(f => f.id === space.floor_id)?.name ?? '', detail: space.room_type, actions: [] } : null;
}

/** Two ready-made simulations for the start screen, picked from the building's own rooms (works on any building). */
function scenariosFor(building: Building): { hazard: 'water' | 'fire'; spaceId: string; label: string }[] {
  const levels = new Map(building.floors.map(f => [f.id, f.level]));
  const lowest = Math.min(...building.floors.map(f => f.level));
  const wet = building.spaces.filter(s => ['kitchen', 'bathroom', 'toilet', 'canteen'].includes(s.room_type) && (levels.get(s.floor_id) ?? 0) > lowest)
    .sort((a, b) => (levels.get(b.floor_id) ?? 0) - (levels.get(a.floor_id) ?? 0));
  const rooms = building.spaces.filter(s => s.type === 'room').map(s => ({ s, seats: building.assets.filter(a => a.space_id === s.id && /chair|seating/.test(a.type)).length }))
    .sort((a, b) => b.seats - a.seats);
  const out: { hazard: 'water' | 'fire'; spaceId: string; label: string }[] = [];
  if (rooms[0]) out.push({ hazard: 'fire', spaceId: rooms[0].s.id, label: `Simulate a fire in ${rooms[0].s.name}` });
  if (wet[0]) out.push({ hazard: 'water', spaceId: wet[0].id, label: `Simulate a leak in ${wet[0].name}` });
  return out;
}

function initials(name: string) {
  return name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
}

/** 1 → 0 over a second after `since` (a fixed incident clearing from the map); 1 when unset. */
function useFade(since?: number) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!since) return;
    let frame = 0;
    const tick = () => { setNow(Date.now()); if (Date.now() - since < 1200) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [since]);
  return since ? Math.max(0, 1 - (now - since) / 1000) : 1;
}

/** Live incidents count as alerts on the floor rail. */
function withIncidents(counts: ReturnType<typeof floorCounts>, active: Incident[], building: Building, floorId: string) {
  const here = active.filter(i => building.spaces.find(s => s.id === i.spaceId)?.floor_id === floorId).length;
  return here ? { ...counts, alerts: counts.alerts + here, summary: [counts.summary, `${here} incident${here > 1 ? 's' : ''}`].filter(Boolean).join(' · ') } : counts;
}

/** A floor on the rail, with fixed badges for alerts (red) and people (blue) instead of chips floating in the model. */
function FloorButton({ floor, active, counts, hazard, onClick }: { floor: Building['floors'][number]; active: boolean; counts: ReturnType<typeof floorCounts>; hazard?: { kind: string; count: number }; onClick(): void }) {
  const label = counts.summary ? `${floor.name}: ${counts.summary}` : floor.name;
  return (
    <button type="button" className={`floor-button${active ? ' active' : ''}`} onClick={onClick} aria-label={label} title={label} aria-pressed={active}>
      <span className="floor-button-short">{floorShort(floor.level)}</span><span className="floor-button-name">{floor.name}</span>
      {hazard && <span className={`floor-hazard floor-hazard--${hazard.kind}`} title={`${hazard.count} spaces affected`}>{hazard.count}</span>}
      {counts.alerts > 0 && <span className="floor-badge floor-badge--alert">{counts.alerts}</span>}
      {counts.people > 0 && <span className="floor-badge floor-badge--people">{counts.people}</span>}
    </button>
  );
}

function floorShort(level: number) {
  if (level === 0) return 'G';
  return level < 0 ? `B${-level}` : String(level);
}
