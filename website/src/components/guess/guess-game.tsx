'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Building, Space } from '@/lib/buildings/types';
import type { SceneDirective, SceneFocus } from '@/lib/chat/contract';
import type { SceneInsets } from '@/components/experience/building-scene';
import { WalkGraph } from '@/lib/buildings/walk';
import { representativePoint } from '@/lib/buildings/graph';
import { hashSeed, mulberry32, randomSeed } from '@/lib/guess/random';
import { pickRounds, roomName, type Difficulty } from '@/lib/guess/rooms';
import { emojiFor, guessDistance, MAX_POINTS, points, scoreScale } from '@/lib/guess/score';
import { detectiveClues, type Clue, type ClueKind } from '@/lib/guess/clues';
import { ClueSilhouette } from './clue-silhouette';
import { ClueDetective } from './clue-detective';
import { GameSummary, metres, RoundResult, type RoundOutcome } from './result-card';
import styles from './guess.module.css';

const BuildingScene = dynamic(() => import('@/components/experience/building-scene'), { ssr: false, loading: () => <div className="scene-loading">Building the map…</div> });
const ClueRoomView = dynamic(() => import('./clue-room-view'), { ssr: false, loading: () => <div className="scene-loading">Walking in…</div> });

type Phase = 'start' | 'round' | 'reveal' | 'end';
export type Mode = 'silhouette' | 'detective' | 'room';

const MODES: { id: Mode; icon: string; name: string; detail: string }[] = [
  { id: 'silhouette', icon: '▱', name: 'Silhouette', detail: 'Outline and doors' },
  { id: 'detective', icon: '🔎', name: 'Detective', detail: 'Clues cost points' },
  { id: 'room', icon: '👁️', name: 'Room view', detail: 'Look around' },
];

interface Props {
  building: Building;
  buildingName: string;
  buildings: { id: string; name: string }[];
  /** From `?seed=`: replay or challenge someone with the same five rooms. */
  seed?: string;
  difficulty?: Difficulty;
  mode?: Mode;
}

/** Building GeoGuessr: see a room, find it on the map, score by walking distance (docs/GEOGUESSR.md). */
export function GuessGame({ building, buildingName, buildings, seed: sharedSeed, difficulty: sharedDifficulty = 'easy', mode: sharedMode = 'silhouette' }: Props) {
  const router = useRouter();
  const id = building.building.id;
  const floors = useMemo(() => [...building.floors].sort((a, b) => a.level - b.level), [building]);
  const home = useMemo((): SceneFocus => floors.length === 1 ? { mode: 'floor', floorId: floors[0].id } : { mode: 'building' }, [floors]);
  const spaces = useMemo(() => new Map(building.spaces.map(s => [s.id, s])), [building]);
  const scale = useMemo(() => scoreScale(building), [building]);
  const graph = useRef<WalkGraph | null>(null);
  const floorName = useCallback((floorId: string) => floors.find(f => f.id === floorId)?.name ?? floorId, [floors]);

  const [phase, setPhase] = useState<Phase>('start');
  const [difficulty, setDifficulty] = useState<Difficulty>(sharedDifficulty);
  const [mode, setMode] = useState<Mode>(sharedMode);
  const [clues, setClues] = useState<Clue[]>([]);
  const [bought, setBought] = useState<ClueKind[]>([]);
  const [seed, setSeed] = useState(sharedSeed);
  const [rounds, setRounds] = useState<Space[]>([]);
  const [index, setIndex] = useState(0);
  const [guessId, setGuessId] = useState<string>();
  const [outcomes, setOutcomes] = useState<RoundOutcome[]>([]);
  const [reveal, setReveal] = useState<SceneDirective>();
  const [view, setView] = useState<SceneFocus>(home);
  const [bigMap, setBigMap] = useState(false);
  const [empty, setEmpty] = useState(false);
  const answer = rounds[index];
  const guess = guessId ? spaces.get(guessId) : undefined;
  const total = outcomes.reduce((sum, o) => sum + o.points, 0);
  const penalty = clues.filter(c => bought.includes(c.kind)).reduce((sum, c) => sum + c.cost, 0);
  const angle = useMemo(() => seed ? mulberry32(hashSeed(`${seed}|turn|${index}`))() * Math.PI * 2 : 0, [seed, index]);

  // Built on first use (event handlers only): up to ~0.7 s on the largest buildings.
  function walkGraph() {
    graph.current ??= new WalkGraph(building);
    return graph.current;
  }

  /** Fresh state for a round; detective clues are computed up front. */
  function enterRound(room: Space, roundMode: Mode) {
    setClues(roundMode === 'detective' ? detectiveClues(building, room, walkGraph()) : []);
    setBought([]); setGuessId(undefined); setReveal(undefined); setView(home); setPhase('round');
  }

  function start(nextSeed: string, level: Difficulty) {
    const picked = pickRounds(building, mulberry32(hashSeed(`${id}|${nextSeed}|${level}`)), level);
    setEmpty(!picked.length);
    if (!picked.length) return;
    setSeed(nextSeed); setDifficulty(level); setRounds(picked); setIndex(0); setOutcomes([]); setBigMap(false);
    enterRound(picked[0], mode);
    window.history.replaceState(null, '', gameUrl(id, nextSeed, level, mode));
  }

  function submitGuess() {
    if (phase !== 'round' || !answer || !guess) return;
    const distance = guessDistance(walkGraph(), building, guess, answer);
    const outcome: RoundOutcome = { answer, guess, distance, points: Math.max(0, points(distance.metres, scale) - penalty), penalty, sameFloor: guess.floor_id === answer.floor_id };
    setOutcomes(current => [...current, outcome]);
    setReveal(revealScene(outcome, walkGraph()));
    setPhase('reveal');
  }

  function next() {
    if (index + 1 >= rounds.length) { setPhase('end'); return; }
    setIndex(index + 1);
    enterRound(rounds[index + 1], mode);
  }

  // Enter or space places the guess, like GeoGuessr's space bar.
  const guessRef = useRef(submitGuess);
  useEffect(() => { guessRef.current = submitGuess; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === 'Enter' || event.key === ' ') && !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLSelectElement)) guessRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const directive = useMemo((): SceneDirective => {
    if (phase === 'reveal' && reveal) return reveal;
    if (phase === 'end') {
      // All answers at once, on the floors they are on.
      const used = floors.filter(f => outcomes.some(o => o.answer.floor_id === f.id)).map(f => f.id);
      const focus: SceneFocus = used.length === 1 ? { mode: 'floor', floorId: used[0] } : used.length ? { mode: 'stack', floorIds: used } : home;
      return { focus, highlights: outcomes.map((o, i) => ({ spaceId: o.answer.id, tone: 'primary' as const, label: `${i + 1} ${emojiFor(o.points)}` })) };
    }
    if (phase !== 'round') return { focus: home };
    // The guess is a pin plus a faint tint: no label, and a muted highlight keeps the camera where the player put it.
    if (!guess) return { focus: view };
    return {
      focus: view,
      highlights: [{ spaceId: guess.id, tone: 'muted' }],
      markers: [{ floorId: guess.floor_id, position: representativePoint(guess.polygon), label: '', tone: 'primary' }],
    };
  }, [phase, reveal, outcomes, floors, home, view, guess]);

  const select = useCallback((spaceId: string) => { if (phase === 'round') setGuessId(spaceId); }, [phase]);
  const focusFloor = useCallback((floorId: string) => { if (phase === 'round') setView({ mode: 'floor', floorId }); }, [phase]);

  // Frame the model in the part of the map the UI leaves free.
  const map = useRef<HTMLDivElement>(null);
  const hud = useRef<HTMLElement>(null);
  const rail = useRef<HTMLElement>(null);
  const panel = useRef<HTMLElement>(null);
  const insets = useInsets(map, [hud, rail], panel, `${phase}|${bigMap}`);

  const shareUrl = typeof window === 'undefined' || !seed ? '' : `${window.location.origin}${gameUrl(id, seed, difficulty, mode)}`;
  const focusedFloor = view.mode === 'floor' ? view.floorId : undefined;

  return (
    <main className={styles.game} data-phase={phase} data-mode={mode} data-big={bigMap || undefined}>
      <header className={styles.hud} ref={hud}>
        <Link className={styles.brand} href={`/?building=${id}`} aria-label="Back to lost & found">◈ <span>lost & found</span></Link>
        {phase === 'round' || phase === 'reveal'
          ? <div className={styles.stats}>
              <span><small>Building</small>{buildingName}</span>
              <span><small>Round</small>{index + 1} / {rounds.length}</span>
              <span><small>Score</small>{total.toLocaleString('en')}</span>
            </div>
          : <span className={styles.logo}>Geo<b>Guessr</b></span>}
      </header>

      {answer && (phase === 'round' || phase === 'reveal') && (
        <section className={styles.clue} aria-label="Your clue">
          <p className={styles.clueTitle}>
            <b>Where am I?</b>
            <span>{guess ? 'Happy with your pin? Hit Guess.' : floors.length > 1 && view.mode === 'building' ? 'Pick a floor, then tap the room.' : 'Tap the room on the map.'}</span>
            {mode === 'detective' && <em className={styles.maxPoints}>max {(MAX_POINTS - penalty).toLocaleString('en')}</em>}
          </p>
          {mode === 'silhouette' && <ClueSilhouette key={`${seed}-${index}`} building={building} space={answer} angle={angle} />}
          {mode === 'detective' && <ClueDetective clues={clues} bought={bought} onBuy={kind => phase === 'round' && setBought(current => current.includes(kind) ? current : [...current, kind])} />}
          {mode === 'room' && <ClueRoomView key={`${seed}-${index}`} building={building} space={answer} yaw={angle} />}
        </section>
      )}

      <section className={styles.mapCard} aria-label="Map">
        <div className={styles.map} ref={map}>
          <BuildingScene building={building} directive={directive} insets={insets} onFocusFloor={focusFloor} onSelect={select} hideLabels />
          {phase === 'round' && (
            <nav className={styles.rail} ref={rail} aria-label="Floors">
              {floors.length > 1 && <button type="button" className={view.mode === 'building' ? styles.active : ''} onClick={() => setView({ mode: 'building' })} aria-label="Whole building">⌂</button>}
              {floors.map(f => <button type="button" key={f.id} className={focusedFloor === f.id ? styles.active : ''} onClick={() => setView({ mode: 'floor', floorId: f.id })} aria-label={f.name} aria-pressed={focusedFloor === f.id}>{floorShort(f.level)}</button>)}
            </nav>
          )}
          {phase === 'round' && <button type="button" className={styles.grow} onClick={() => setBigMap(b => !b)} aria-label={bigMap ? 'Smaller map' : 'Bigger map'} aria-pressed={bigMap}>{bigMap ? '⤡' : '⤢'}</button>}
          <p className={styles.attribution}>{building.building.attribution} · {building.building.license}</p>
        </div>
        {phase === 'round' && (
          <button type="button" className={styles.guess} disabled={!guess} onClick={submitGuess}>
            {guess ? <>Guess <kbd>space</kbd></> : 'Place your pin on the map'}
          </button>
        )}
      </section>

      {phase === 'start' && (
        <section className={styles.panel} ref={panel}>
          <p className={styles.eyebrow}>Lost & Found presents</p>
          <h1 className={styles.title}>Building <b>GeoGuessr</b></h1>
          <p className={styles.lead}>You wake up somewhere in <b>{buildingName}</b>. All you see is the outline of the room around you. Find it on the map. Points go by <b>walking distance</b>: the wrong floor hurts.</p>
          <label className={styles.field}>
            <span>Building</span>
            <select value={id} onChange={event => router.push(`/guess?building=${encodeURIComponent(event.target.value)}`)}>
              {buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <div className={styles.field}>
            <span>Mode</span>
            <div className={styles.modes}>
              {MODES.map(m => (
                <button type="button" key={m.id} className={mode === m.id ? styles.modeOn : ''} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
                  <i>{m.icon}</i><b>{m.name}</b><small>{m.detail}</small>
                </button>
              ))}
            </div>
          </div>
          <div className={styles.field}>
            <span>Difficulty</span>
            <div className={styles.segmented} role="radiogroup">
              {(['easy', 'hard'] as const).map(level => (
                <button type="button" key={level} role="radio" aria-checked={difficulty === level} className={difficulty === level ? styles.active : ''} onClick={() => setDifficulty(level)}>
                  <b>{level === 'easy' ? 'Easy' : 'Hard'}</b><small>{level === 'easy' ? 'One-of-a-kind rooms' : 'Rooms with look-alikes'}</small>
                </button>
              ))}
            </div>
          </div>
          {empty && <p className={styles.warning}>This building has no rooms to guess. Try another one.</p>}
          <button type="button" className={styles.primary} onClick={() => start(seed ?? randomSeed(), difficulty)}>Play · 5 rounds</button>
          {sharedSeed && <p className={styles.seed}>Challenge seed <code>{sharedSeed}</code>: same rooms as your friend.</p>}
        </section>
      )}

      {phase === 'reveal' && outcomes[index] && (
        <aside className={styles.sheet} ref={panel}>
          <RoundResult key={index} outcome={outcomes[index]} round={index + 1} rounds={rounds.length} floorName={floorName} onNext={next} />
        </aside>
      )}

      {phase === 'end' && (
        <aside className={styles.panel} ref={panel}>
          <GameSummary outcomes={outcomes} buildingName={buildingName} shareUrl={shareUrl} onAgain={() => start(randomSeed(), difficulty)} onReplay={() => seed && start(seed, difficulty)} />
        </aside>
      )}
    </main>
  );
}

/** Camera on the answer (and the guess, if on another floor), the walk between them, and only now the names. */
function revealScene(o: RoundOutcome, graph: WalkGraph): SceneDirective {
  const bullseye = o.guess.id === o.answer.id;
  const focus: SceneFocus = o.sameFloor ? { mode: 'floor', floorId: o.answer.floor_id } : { mode: 'stack', floorIds: [o.guess.floor_id, o.answer.floor_id] };
  const name = roomName(o.answer);
  if (bullseye) return { focus, highlights: [{ spaceId: o.answer.id, tone: 'primary', label: `🎯 ${name}` }] };
  const highlights: SceneDirective['highlights'] = [
    { spaceId: o.answer.id, tone: 'primary', label: `It was: ${name}` },
    { spaceId: o.guess.id, tone: 'secondary', label: `Your guess · ${metres(o.distance.metres)} off` },
  ];
  const leg = graph.route(o.guess.id, o.answer.id);
  if (leg) return { focus, highlights, routes: [{ spacePath: leg.spacePath, points: leg.points }] };
  const at = (s: Space) => ({ floorId: s.floor_id, position: representativePoint(s.polygon) });
  return { focus, highlights, links: [{ from: at(o.guess), to: at(o.answer) }] };
}

function gameUrl(buildingId: string, seed: string, level: Difficulty, mode: Mode) {
  return `/guess?building=${encodeURIComponent(buildingId)}&seed=${encodeURIComponent(seed)}&level=${level}&mode=${mode}`;
}

function floorShort(level: number) {
  if (level === 0) return 'G';
  return level < 0 ? `B${-level}` : String(level);
}

/**
 * Pixels of the map covered by overlays: bars along the top, and a panel that either sits at the
 * bottom (phone sheet) or runs down the left side (desktop panel).
 */
function useInsets(map: RefObject<HTMLElement | null>, tops: RefObject<HTMLElement | null>[], panel: RefObject<HTMLElement | null>, layoutKey: string): SceneInsets {
  const [insets, setInsets] = useState<SceneInsets>({ top: 0, left: 0, bottom: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const m = map.current?.getBoundingClientRect();
      if (!m || !m.height) return;
      const covers = (r: DOMRect) => r.width > 0 && r.right > m.left && r.left < m.right && r.bottom > m.top && r.top < m.bottom;
      const top = Math.max(0, ...tops.map(t => t.current?.getBoundingClientRect()).filter((r): r is DOMRect => !!r && covers(r) && r.top < m.top + m.height / 2).map(r => r.bottom - m.top));
      const p = panel.current?.getBoundingClientRect();
      const side = p && covers(p) && p.height > m.height * 0.6;
      const next = {
        top,
        left: side ? Math.max(0, p.right - m.left) : 0,
        bottom: p && covers(p) && !side ? Math.max(0, m.bottom - p.top) : 0,
      };
      const round = (v: number) => Math.round(v / 8) * 8;
      setInsets(prev => (round(prev.top) === round(next.top) && round(prev.left) === round(next.left) && round(prev.bottom) === round(next.bottom) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    [map, ...tops, panel].forEach(ref => ref.current && observer.observe(ref.current));
    window.addEventListener('resize', measure);
    // The map card animates between layouts; measure again once it has settled.
    const settle = window.setTimeout(measure, 450);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.clearTimeout(settle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable; re-measure when the layout changes
  }, [layoutKey]);
  return insets;
}
