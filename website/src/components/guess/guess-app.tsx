'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Building } from '@/lib/buildings/types';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { saveProfile, useProfile } from '@/lib/world/profile';
import { DemoLoginSheet, useSignedIn } from '@/components/auth/demo-login';
import { dailyDay, dailySeed, randomSeed } from '@/lib/guess/random';
import { deleteSpot, useSpots, type Me } from '@/lib/guess/use-guess';
import { SoloGame } from './solo-game';
import { DuelGame } from './duel-game';
import { UploadFlow } from './upload-flow';
import { Avatar, Logo, ago } from './ui';
import styles from './gg.module.css';

export type View =
  | { name: 'home' }
  | { name: 'solo'; seed: string }
  | { name: 'duels'; duel?: string }
  | { name: 'upload' };

interface Props {
  building: Building;
  buildingName: string;
  buildings: { id: string; name: string }[];
  initial: View;
}

function urlFor(buildingId: string, view: View) {
  const q = new URLSearchParams({ building: buildingId });
  if (view.name === 'solo') { q.set('play', 'solo'); q.set('seed', view.seed); }
  if (view.name === 'duels') { q.set('play', 'duels'); if (view.duel) q.set('duel', view.duel); }
  if (view.name === 'upload') q.set('play', 'upload');
  return `/guess?${q}`;
}

function viewFromUrl(): View {
  const q = new URLSearchParams(window.location.search);
  const play = q.get('play'), duel = q.get('duel') ?? undefined;
  if (duel || play === 'duels') return { name: 'duels', duel };
  if (play === 'solo' && q.get('seed')) return { name: 'solo', seed: q.get('seed')! };
  if (play === 'upload') return { name: 'upload' };
  return { name: 'home' };
}

/** Building GeoGuessr: community photos of the building, guessed on the 3D model, solo or in live duels. */
export function GuessApp({ building, buildingName, buildings, initial }: Props) {
  const id = building.building.id;
  const router = useRouter();
  const [view, setView] = useState<View>(initial);
  const { spots, reload } = useSpots(id);
  const profile = useProfile();
  const signedIn = useSignedIn();
  const needsAccount = Boolean(supabaseBrowser()) && signedIn === null;
  const [login, setLogin] = useState(false);
  const me: Me | undefined = useMemo(() => profile ? { id: profile.id, name: profile.name } : undefined, [profile]);

  const go = useCallback((next: View) => {
    window.history.pushState(null, '', urlFor(id, next));
    setView(next);
    window.scrollTo(0, 0);
  }, [id]);
  useEffect(() => {
    const onPop = () => setView(viewFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const home = useCallback(() => go({ name: 'home' }), [go]);
  // Duels and uploads are shared with the organisation: with accounts on, sign in first.
  const guarded = (next: View) => { if (needsAccount) setLogin(true); else go(next); };

  const loginSheet = login && <DemoLoginSheet profile={profile} onClose={() => setLogin(false)} />;

  if (view.name === 'solo') {
    if (!spots) return <main className={styles.gg}><p className={styles.loadingText}>Loading photos…</p></main>;
    return <SoloGame key={view.seed} building={building} buildingName={buildingName} spots={spots} seed={view.seed} day={dailyDay(view.seed, id)} onHome={home} onAgain={() => go({ name: 'solo', seed: randomSeed() })} />;
  }
  if (view.name === 'duels' && me && !needsAccount) return <DuelGame building={building} buildingName={buildingName} me={me} duelId={view.duel} onHome={home} onDuel={duel => go({ name: 'duels', duel })} />;
  if (view.name === 'upload' && me && !needsAccount) return <UploadFlow building={building} buildingName={buildingName} me={me} onDone={() => void reload()} onPlay={() => go({ name: 'solo', seed: randomSeed() })} onHome={home} />;

  const uploaded = (spots ?? []).filter(s => !s.mock);
  const people = new Set((spots ?? []).map(s => s.authorName)).size;

  return (
    <main className={styles.gg} data-screen="home">
      <header className={styles.homeTop}>
        <Link className={styles.backLink} href={`/?building=${encodeURIComponent(id)}`}>← Lost &amp; Found</Link>
        {me && <PlayerChip me={me} editable={!supabaseBrowser()} onRename={name => profile && saveProfile({ ...profile, name })} onLogin={() => setLogin(true)} accounts={Boolean(supabaseBrowser())} />}
      </header>

      <section className={styles.hero}>
        <Logo size="big" />
        <label className={styles.buildingPick}>
          <span>🏢</span>
          <select value={id} onChange={e => router.push(`/guess?building=${encodeURIComponent(e.target.value)}`)} aria-label="Building">
            {buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      </section>

      <section className={styles.modes}>
        <article className={`${styles.modeCard} ${styles.modeSolo}`}>
          <span className={styles.modeArt} aria-hidden>🧭</span>
          <h2>Single player</h2>
          <p>5 photos from your colleagues. Find where each was taken.</p>
          <div className={styles.modeActions}>
            <button type="button" className={styles.btn} onClick={() => go({ name: 'solo', seed: randomSeed() })}>Play</button>
            <button type="button" className={styles.btnGhostLight} onClick={() => go({ name: 'solo', seed: dailySeed(id) })}>📅 Daily</button>
          </div>
        </article>
        <article className={`${styles.modeCard} ${styles.modeDuel}`}>
          <span className={styles.modeArt} aria-hidden>⚔️</span>
          <h2>Duels</h2>
          <p>Live against your colleagues. First guess starts the 15 s countdown.</p>
          <div className={styles.modeActions}>
            <button type="button" className={styles.btn} onClick={() => guarded({ name: 'duels' })}>Play duels</button>
          </div>
        </article>
        <article className={`${styles.modeCard} ${styles.modeUpload}`}>
          <span className={styles.modeArt} aria-hidden>📸</span>
          <h2>Add a photo</h2>
          <p>{spots ? `${spots.length} photos by ${people} people so far.` : 'Snap a spot, tag it on the model.'} Add yours!</p>
          <div className={styles.modeActions}>
            <button type="button" className={styles.btn} onClick={() => guarded({ name: 'upload' })}>Snap a spot</button>
          </div>
        </article>
      </section>

      <section className={styles.community}>
        <h2 className={styles.h2}>Fresh from your colleagues</h2>
        <ul className={styles.gallery}>
          {(spots ?? []).slice(0, 18).map(s => (
            <li key={s.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- community photos (data URLs, Storage) */}
              <img src={s.imageUrl} alt="" loading="lazy" />
              <span className={styles.galleryMeta}><Avatar id={s.authorId === 'mock' ? s.authorName : s.authorId} name={s.authorName} size={22} /> {s.authorName}<small>{s.mock ? 'sample' : ago(s.createdAt)}</small></span>
              {me && s.authorId === me.id && <button type="button" className={styles.galleryDelete} onClick={() => void deleteSpot(id, s.id, me).then(reload)} aria-label="Remove my photo">✕</button>}
            </li>
          ))}
        </ul>
        {!uploaded.length && <p className={styles.empty}>These are sample photos. The first real one from {buildingName} could be yours.</p>}
      </section>

      <footer className={styles.footer}>{building.building.attribution} · Sample photos CC0</footer>
      {loginSheet}
    </main>
  );
}

function PlayerChip({ me, editable, accounts, onRename, onLogin }: { me: Me; editable: boolean; accounts: boolean; onRename(name: string): void; onLogin(): void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.name);
  if (editing) return (
    <form className={styles.playerChip} onSubmit={e => { e.preventDefault(); if (name.trim()) onRename(name.trim().slice(0, 24)); setEditing(false); }}>
      <Avatar id={me.id} name={me.name} size={30} />
      <input className={styles.nameInput} value={name} onChange={e => setName(e.target.value)} autoFocus maxLength={24} onBlur={() => { if (name.trim()) onRename(name.trim().slice(0, 24)); setEditing(false); }} aria-label="Your name" />
    </form>
  );
  return (
    <button type="button" className={styles.playerChip} onClick={() => editable ? setEditing(true) : accounts && onLogin()} title={editable ? 'Change your name' : 'Switch account'}>
      <Avatar id={me.id} name={me.name} size={30} />
      <span>{me.name}</span>{editable && <i>✎</i>}
    </button>
  );
}
