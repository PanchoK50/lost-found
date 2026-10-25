'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { SceneDirective } from '@/lib/chat/contract';
import { WalkGraph } from '@/lib/buildings/walk';
import { emojiFor, MAX_POINTS, points, scoreScale, shareText, spotDistance, verdict, type GuessDistance, BULLSEYE_M } from '@/lib/guess/score';
import { pickSpots, placeName, type PhotoSpot, type SpotPick } from '@/lib/guess/spots';
import { GuessMap } from './guess-map';
import { PhotoView } from './photo-view';
import { Confetti, CountUp, metres } from './ui';
import styles from './gg.module.css';

export const ROUNDS = 5;

interface Outcome { spot: PhotoSpot; pick: SpotPick; distance: GuessDistance; points: number }

interface Props {
  building: Building;
  buildingName: string;
  spots: PhotoSpot[];
  seed: string;
  /** Set for the daily challenge ("2026-10-25"). */
  day?: string;
  onHome(): void;
  onAgain(): void;
}

/** Classic GeoGuessr for one player: five community photos, guess where each was taken. */
export function SoloGame({ building, buildingName, spots, seed, day, onHome, onAgain }: Props) {
  // The photos are fixed when the game starts; new uploads don't reshuffle a running game.
  const [rounds] = useState(() => pickSpots(spots, seed, ROUNDS));
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<'round' | 'reveal' | 'end'>('round');
  const [pick, setPick] = useState<SpotPick>();
  const [mapOpen, setMapOpen] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [scene, setScene] = useState<SceneDirective>();
  const graph = useRef<WalkGraph | null>(null);
  const scale = useMemo(() => scoreScale(building), [building]);
  const floorName = useCallback((id: string) => building.floors.find(f => f.id === id)?.name ?? id, [building]);
  const spot = rounds[index];
  const total = outcomes.reduce((sum, o) => sum + o.points, 0);
  const panel = useRef<HTMLElement>(null);
  const panelHeight = useHeight(panel, phase);

  function guess() {
    if (phase !== 'round' || !pick || !spot) return;
    graph.current ??= new WalkGraph(building);
    const distance = spotDistance(graph.current, building, pick, spot);
    const outcome = { spot, pick, distance, points: points(distance.metres, scale) };
    setOutcomes(o => [...o, outcome]);
    setScene(revealScene(outcome, graph.current));
    setPhase('reveal');
  }
  function next() {
    if (index + 1 >= rounds.length) { setPhase('end'); return; }
    setIndex(index + 1); setPick(undefined); setScene(undefined); setMapOpen(false); setPhase('round');
  }

  // Space or Enter: guess, then next round (GeoGuessr's keyboard flow).
  const keys = useRef({ guess, next, phase });
  useEffect(() => { keys.current = { guess, next, phase }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== ' ' && e.key !== 'Enter') || e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      if (keys.current.phase === 'round') keys.current.guess(); else if (keys.current.phase === 'reveal') keys.current.next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!spot) return <main className={styles.gg}><div className={styles.centerCard}><h2 className={styles.h2}>No photos yet</h2><p>Be the first to add one from this building.</p><button type="button" className={styles.btn} onClick={onHome}>Back</button></div></main>;
  const last = outcomes[index];

  return (
    <main className={styles.gg} data-phase={phase}>
      {phase === 'round' && <PhotoView key={spot.id} src={spot.imageUrl} credit={`${spot.authorName}${spot.mock ? ' · sample photo' : ''}`} />}

      <header className={styles.gameTop}>
        <button type="button" className={styles.iconBtn} onClick={onHome} aria-label="Leave the game">✕</button>
        <div className={styles.status}>
          <span><small>Map</small>{buildingName}</span>
          <span><small>{day ? 'Daily · Round' : 'Round'}</small>{Math.min(index + 1, rounds.length)} / {rounds.length}</span>
          <span><small>Score</small>{total.toLocaleString('en')}</span>
        </div>
      </header>

      {phase !== 'end' && (
        <section className={styles.mapCard} data-size={phase === 'reveal' ? 'full' : mapOpen ? 'open' : 'mini'} aria-label="Map">
          <GuessMap building={building} scene={phase === 'reveal' ? scene : undefined} pick={pick} onPick={setPick} bottomInset={phase === 'reveal' ? panelHeight : 0}>
            {phase === 'round' && !mapOpen && <button type="button" className={styles.mapOpener} onClick={() => setMapOpen(true)} aria-label="Open the map">🗺️ <span>Open map</span></button>}
            {phase === 'round' && mapOpen && <button type="button" className={styles.mapClose} onClick={() => setMapOpen(false)} aria-label="Back to the photo">📷</button>}
          </GuessMap>
          {phase === 'round' && <button type="button" className={styles.guessBtn} disabled={!pick} onClick={guess}>{pick ? 'Guess' : 'Place your pin on the map'}</button>}
        </section>
      )}

      {phase === 'reveal' && last && (
        <aside className={styles.resultPanel} ref={panel} aria-live="polite">
          {last.distance.metres <= BULLSEYE_M && <Confetti />}
          <div className={styles.resultScore}><b><CountUp value={last.points} /></b><span>points</span></div>
          <div className={styles.yellowBar}><span style={{ width: `${(last.points / MAX_POINTS) * 100}%` }} /></div>
          <p className={styles.resultText}>
            {last.distance.metres <= BULLSEYE_M ? <>🎯 <b>Perfect!</b> You stood right there.</> : <>Your guess was <b>{metres(last.distance.metres)}</b> from the correct location{last.distance.walked ? ' (walking)' : ''}.</>}
          </p>
          <p className={styles.resultPlace}>📍 {placeName(building, last.spot.spaceId)} · {floorName(last.spot.floorId)}{last.spot.caption ? <> · “{last.spot.caption}”</> : null}</p>
          <p className={styles.quip}>🏢 {verdict({ points: last.points, metres: last.distance.metres, guessFloor: floorName(last.pick.floorId), answerFloor: floorName(last.spot.floorId), round: index })}</p>
          <button type="button" className={styles.btn} onClick={next} autoFocus>{index + 1 >= rounds.length ? 'View results' : 'Next round'}</button>
        </aside>
      )}

      {phase === 'end' && <Summary building={building} buildingName={buildingName} outcomes={outcomes} seed={seed} day={day} onAgain={onAgain} onHome={onHome} />}
    </main>
  );
}

/** Pin for the guess, pin for the photo, the walk between them; the place name only now. */
function revealScene(o: Outcome, graph: WalkGraph): SceneDirective {
  const answer = { floorId: o.spot.floorId, position: o.spot.position };
  const guess = { floorId: o.pick.floorId, position: o.pick.position };
  const focus: SceneDirective['focus'] = o.pick.floorId === o.spot.floorId ? { mode: 'floor', floorId: o.spot.floorId } : { mode: 'stack', floorIds: [o.pick.floorId, o.spot.floorId] };
  const markers: SceneDirective['markers'] = [{ ...answer, label: '📸 Taken here', tone: 'primary' }];
  const highlights: SceneDirective['highlights'] = [{ spaceId: o.spot.spaceId, tone: 'primary' }];
  if (o.distance.metres <= BULLSEYE_M) return { focus, highlights, markers };
  markers.push({ ...guess, label: `You · ${metres(o.distance.metres)}`, tone: 'secondary' });
  if (o.pick.spaceId !== o.spot.spaceId) highlights.push({ spaceId: o.pick.spaceId, tone: 'secondary' });
  const leg = o.pick.spaceId === o.spot.spaceId ? undefined : graph.route(o.pick.spaceId, o.spot.spaceId);
  if (leg) return { focus, highlights, markers, routes: [{ spacePath: leg.spacePath, points: [guess, ...leg.points, answer] }] };
  return { focus, highlights, markers, links: [{ from: guess, to: answer }] };
}

function Summary({ building, buildingName, outcomes, seed, day, onAgain, onHome }: { building: Building; buildingName: string; outcomes: Outcome[]; seed: string; day?: string; onAgain(): void; onHome(): void }) {
  const total = outcomes.reduce((sum, o) => sum + o.points, 0);
  const max = outcomes.length * MAX_POINTS;
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = `${window.location.origin}/guess?building=${encodeURIComponent(building.building.id)}&play=solo&seed=${encodeURIComponent(seed)}`;
    const text = shareText(buildingName, outcomes.map(o => o.points), url, day);
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); setCopied(true); } } catch { /* closed the share sheet */ }
  };
  return (
    <section className={styles.summary}>
      {total / max >= 0.7 && <Confetti count={60} />}
      <p className={styles.kicker}>{buildingName}{day ? ` · Daily ${day}` : ''}</p>
      <h1 className={styles.h1}>Game finished!</h1>
      <div className={styles.totalScore}><b><CountUp value={total} ms={1600} /></b><span> / {max.toLocaleString('en')}</span></div>
      <div className={styles.yellowBar}><span style={{ width: `${(total / max) * 100}%` }} /></div>
      <ol className={styles.roundList}>
        {outcomes.map((o, i) => (
          <li key={i}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={o.spot.imageUrl} alt="" />
            <span><b>{placeName(building, o.spot.spaceId)}</b><small>{o.distance.metres <= BULLSEYE_M ? 'Perfect!' : `${metres(o.distance.metres)} off`} · 📸 {o.spot.authorName}</small></span>
            <em>{emojiFor(o.points)} {o.points.toLocaleString('en')}</em>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={onAgain}>Play again</button>
        <button type="button" className={styles.btnBlue} onClick={() => void share()}>{copied ? 'Copied ✓' : 'Challenge a colleague'}</button>
        <button type="button" className={styles.btnGhost} onClick={onHome}>Home</button>
      </div>
    </section>
  );
}

/** Height of an element, kept up to date (for camera insets). */
export function useHeight(ref: React.RefObject<HTMLElement | null>, key: unknown) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(Math.round(el.getBoundingClientRect().height + 16)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key]);
  return height;
}
