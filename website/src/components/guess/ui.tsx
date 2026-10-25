'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { hashSeed } from '@/lib/guess/random';
import styles from './gg.module.css';

/** The game's wordmark: small "Building" over a big italic "GeoGuessr". */
export function Logo({ size = 'small' }: { size?: 'small' | 'big' }) {
  return (
    <span className={size === 'big' ? styles.logoBig : styles.logo} aria-label="Building GeoGuessr">
      <span className={styles.logoPin} aria-hidden>📍</span>
      <span className={styles.logoText}><small>Building</small><b>GeoGuessr</b></span>
    </span>
  );
}

const AVATARS = ['🦊', '🐼', '🐸', '🦁', '🐙', '🐧', '🦄', '🐯', '🐨', '🐵', '🦉', '🐳'];
const AVATAR_BG = ['#ff8a3d', '#4ec3ff', '#7ed957', '#ffcf3d', '#c38bff', '#ff6b9a', '#3de0c0', '#ffa94d'];

/** A cartoon avatar picked from the player id, so everyone looks the same to everyone. */
export function Avatar({ id, name, bot, size = 44, ring }: { id: string; name: string; bot?: boolean; size?: number; ring?: string }) {
  const h = hashSeed(id);
  return (
    <span className={styles.avatar} title={name} style={{ width: size, height: size, fontSize: size * 0.55, background: AVATAR_BG[h % AVATAR_BG.length], borderColor: ring } as CSSProperties}>
      {bot ? '🤖' : AVATARS[(h >>> 4) % AVATARS.length]}
    </span>
  );
}

/** Duel health bar: fills from the avatar side, shows the number. */
export function HealthBar({ hp, max, side, name, id, bot, guessed, out }: { hp: number; max: number; side: 'left' | 'right'; name: string; id: string; bot?: boolean; guessed?: boolean; out?: boolean }) {
  const shown = useCountTo(hp, 900);
  return (
    <div className={`${styles.health} ${side === 'right' ? styles.healthRight : ''} ${out ? styles.healthOut : ''}`}>
      <Avatar id={id} name={name} bot={bot} size={48} ring={side === 'left' ? '#3fa7ff' : '#ff5470'} />
      <div className={styles.healthBody}>
        <span className={styles.healthName}>{name}{guessed && <i className={styles.guessedTag}>✓ guessed</i>}</span>
        <span className={styles.healthTrack}><span style={{ width: `${(Math.max(0, shown) / max) * 100}%` }} /></span>
      </div>
      <b className={styles.healthHp}>{Math.round(shown).toLocaleString('en')}</b>
    </div>
  );
}

/** Animates a number towards `target` (count-up for scores, drain for health). */
export function useCountTo(target: number, ms = 1100) {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    let frame = 0;
    const from = current.current, begin = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - begin) / ms);
      current.current = from + (target - from) * (1 - (1 - t) ** 3);
      setValue(current.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

/** Counts up from 0 once mounted. */
export function CountUp({ value, ms = 1200 }: { value: number; ms?: number }) {
  const [target, setTarget] = useState(0);
  useEffect(() => { const t = setTimeout(() => setTarget(value), 60); return () => clearTimeout(t); }, [value]);
  const shown = useCountTo(target, ms);
  return <>{Math.round(shown).toLocaleString('en')}</>;
}

export function metres(m: number) {
  if (!Number.isFinite(m)) return '—';
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m).toLocaleString('en')} m`;
}

export function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function floorShort(level: number) {
  if (level === 0) return 'G';
  return level < 0 ? `B${-level}` : String(level);
}

const CONFETTI = ['#fecd19', '#6cb928', '#3fa7ff', '#ff5470', '#c38bff', '#ff8a3d'];

/** A burst of confetti; positions come from the index so rendering stays pure. */
export function Confetti({ count = 40 }: { count?: number }) {
  return (
    <div className={styles.confetti} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ '--x': `${((i * 37) % 100) - 50}vw`, '--r': `${(i * 83) % 360}deg`, '--d': `${(i % 9) * 50}ms`, background: CONFETTI[i % CONFETTI.length] } as CSSProperties} />
      ))}
    </div>
  );
}
