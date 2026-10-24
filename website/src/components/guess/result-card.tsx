'use client';

import { useEffect, useState } from 'react';
import type { Space } from '@/lib/buildings/types';
import { roomName } from '@/lib/guess/rooms';
import { emojiFor, MAX_POINTS, shareText, verdict, type GuessDistance } from '@/lib/guess/score';
import styles from './guess.module.css';

export interface RoundOutcome {
  answer: Space;
  guess: Space;
  distance: GuessDistance;
  /** Points after the clues bought this round. */
  points: number;
  /** Points spent on detective clues. */
  penalty: number;
  sameFloor: boolean;
}

/** Counts from 0 up to `target`, GeoGuessr style. */
function useCountUp(target: number, ms = 1100) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

export function metres(m: number) {
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m).toLocaleString('en')} m`;
}

interface RoundProps {
  outcome: RoundOutcome;
  round: number;
  rounds: number;
  floorName(floorId: string): string;
  onNext(): void;
}

export function RoundResult({ outcome, round, rounds, floorName, onNext }: RoundProps) {
  const shown = useCountUp(outcome.points);
  const bullseye = outcome.distance.metres === 0;
  const last = round === rounds;
  return (
    <section className={styles.result} aria-live="polite">
      {bullseye && <Confetti />}
      <p className={styles.resultPoints}><strong>{shown.toLocaleString('en')}</strong> points</p>
      <div className={styles.bar} aria-hidden><span style={{ width: `${(shown / MAX_POINTS) * 100}%` }} /></div>
      {outcome.penalty > 0 && <p className={styles.penalty}>🔎 −{outcome.penalty.toLocaleString('en')} for clues</p>}
      <p className={styles.resultLine}>
        {bullseye
          ? <>🎯 <b>Bullseye!</b> You were right there.</>
          : <>Your guess was <b>{metres(outcome.distance.metres)}</b> {outcome.distance.walked ? 'away on foot' : 'away (no walking route, 1.5× straight line)'}.</>}
      </p>
      <p className={styles.resultAnswer}>It was <b>{roomName(outcome.answer)}</b> · {floorName(outcome.answer.floor_id)}</p>
      <blockquote className={styles.quip}>“{verdict(outcome.points, outcome.distance.metres, outcome.sameFloor, outcome.penalty > 0)}” <cite>— the building</cite></blockquote>
      <button type="button" className={styles.primary} onClick={onNext} autoFocus>{last ? 'See results' : 'Next round'} <kbd>↵</kbd></button>
    </section>
  );
}

interface SummaryProps {
  outcomes: RoundOutcome[];
  buildingName: string;
  shareUrl: string;
  onAgain(): void;
  onReplay(): void;
}

export function GameSummary({ outcomes, buildingName, shareUrl, onAgain, onReplay }: SummaryProps) {
  const total = outcomes.reduce((sum, o) => sum + o.points, 0);
  const max = outcomes.length * MAX_POINTS;
  const shown = useCountUp(total, 1600);
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const text = shareText(buildingName, outcomes.map(o => o.points), shareUrl);
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); setCopied(true); }
    } catch { /* the user closed the share sheet */ }
  };
  return (
    <section className={styles.summary} aria-live="polite">
      <p className={styles.eyebrow}>{buildingName} · game over</p>
      <p className={styles.total}><strong>{shown.toLocaleString('en')}</strong><span> / {max.toLocaleString('en')}</span></p>
      <div className={styles.bar} aria-hidden><span style={{ width: `${(shown / max) * 100}%` }} /></div>
      <p className={styles.rank}>{rank(total / max)}</p>
      <ol className={styles.rounds}>
        {outcomes.map((o, i) => (
          <li key={i}>
            <span className={styles.roundNo}>{i + 1}</span>
            <span className={styles.roundRoom}>{roomName(o.answer)}<small>{o.distance.metres === 0 ? 'bullseye' : `${metres(o.distance.metres)} off`}</small></span>
            <span className={styles.roundPoints}>{emojiFor(o.points)} {o.points.toLocaleString('en')}</span>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={onAgain}>Play again</button>
        <button type="button" className={styles.secondary} onClick={() => void share()}>{copied ? 'Copied ✓' : 'Challenge a friend'}</button>
        <button type="button" className={styles.ghost} onClick={onReplay}>Replay these rooms</button>
      </div>
    </section>
  );
}

function rank(share: number) {
  if (share >= 0.9) return '🏆 Building whisperer';
  if (share >= 0.7) return '🧭 Seasoned facility manager';
  if (share >= 0.45) return '🗺️ Knows the coffee route';
  if (share >= 0.2) return '🚶 First week on the job';
  return '🌀 Lost, not yet found';
}

const CONFETTI = ['#f05c03', '#004fab', '#75c6ff', '#8a3fc4', '#e04f9a', '#f26b4f'];

/** A small burst for a bullseye; positions come from the index so rendering stays pure. */
function Confetti() {
  return (
    <div className={styles.confetti} aria-hidden>
      {Array.from({ length: 28 }, (_, i) => (
        <i key={i} style={{ '--x': `${((i * 37) % 100) - 50}vw`, '--r': `${(i * 83) % 360}deg`, '--d': `${(i % 7) * 60}ms`, background: CONFETTI[i % CONFETTI.length] } as React.CSSProperties} />
      ))}
    </div>
  );
}
