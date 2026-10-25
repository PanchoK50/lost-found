'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { SceneDirective } from '@/lib/chat/contract';
import { GUESS_WINDOW_MS, REVEAL_MS, START_HP, type DuelView } from '@/lib/guess/duel';
import { placeName, type SpotPick } from '@/lib/guess/spots';
import { openDuels, postDuel, useDuel, useTick, type Me } from '@/lib/guess/use-guess';
import { GuessMap } from './guess-map';
import { PhotoView } from './photo-view';
import { Avatar, Confetti, CountUp, HealthBar, metres } from './ui';
import { useHeight } from './solo-game';
import styles from './gg.module.css';

interface Props {
  building: Building;
  buildingName: string;
  me: Me;
  duelId?: string;
  onHome(): void;
  /** Open a duel (or the lobby list with undefined); the app keeps it in the URL. */
  onDuel(id: string | undefined): void;
}

/** Duels like GeoGuessr's: live against colleagues (or a bot), health bars, 15 s after the first guess. */
export function DuelGame(props: Props) {
  return props.duelId ? <DuelRoom key={props.duelId} {...props} id={props.duelId} /> : <DuelLobby {...props} />;
}

// ---------- lobby list ----------

function DuelLobby({ building, buildingName, me, onHome, onDuel }: Props) {
  const buildingId = building.building.id;
  const [open, setOpen] = useState<Awaited<ReturnType<typeof openDuels>>>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = async () => { try { const list = await openDuels(buildingId); if (alive) setOpen(list); } catch { /* retry next tick */ } };
    void load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [buildingId]);

  async function run(label: string, steps: () => Promise<string>) {
    setBusy(label); setError(undefined);
    try { onDuel(await steps()); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); setBusy(undefined); }
  }
  const create = () => run('create', async () => (await postDuel({ type: 'create', buildingId }, me)).duel.id);
  const practise = () => run('bot', async () => {
    const { duel } = await postDuel({ type: 'create', buildingId }, me);
    await postDuel({ type: 'bot', id: duel.id }, me);
    await postDuel({ type: 'start', id: duel.id }, me);
    return duel.id;
  });
  const join = (id: string) => run(id, async () => { await postDuel({ type: 'join', id }, me); return id; });

  return (
    <main className={styles.gg} data-screen="menu">
      <header className={styles.gameTop}>
        <button type="button" className={styles.iconBtn} onClick={onHome} aria-label="Back">←</button>
        <span className={styles.topTitle}>Duels · {buildingName}</span>
      </header>
      <section className={styles.menu}>
        <div className={styles.duelHero}>
          <span className={styles.vsBadge}>⚔️</span>
          <h1 className={styles.h1}>Duels</h1>
          <p className={styles.sub}>Same photo for everyone. The first guess starts a <b>15 second</b> countdown for the rest. Closest guess deals damage: last one standing wins.</p>
        </div>
        <div className={styles.menuButtons}>
          <button type="button" className={styles.btn} disabled={!!busy} onClick={() => void create()}>{busy === 'create' ? 'Creating…' : 'Create duel'}</button>
          <button type="button" className={styles.btnBlue} disabled={!!busy} onClick={() => void practise()}>{busy === 'bot' ? 'Starting…' : '🤖 Practise vs bot'}</button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        <h2 className={styles.h2}>Open duels in this building</h2>
        {open.length ? (
          <ul className={styles.openList}>
            {open.map(d => {
              const host = d.players.find(p => p.id === d.hostId) ?? d.players[0];
              const mine = d.players.some(p => p.id === me.id);
              return (
                <li key={d.id}>
                  <span className={styles.openAvatars}>{d.players.slice(0, 4).map(p => <Avatar key={p.id} id={p.id} name={p.name} bot={p.bot} size={36} />)}</span>
                  <span className={styles.openText}><b>{host?.name}&apos;s duel</b><small>{d.players.length} player{d.players.length === 1 ? '' : 's'} waiting · #{d.id}</small></span>
                  <button type="button" className={styles.btnSmall} disabled={!!busy} onClick={() => mine ? onDuel(d.id) : void join(d.id)}>{mine ? 'Open' : busy === d.id ? '…' : 'Join'}</button>
                </li>
              );
            })}
          </ul>
        ) : <p className={styles.empty}>Nobody is waiting right now. Create a duel and send the link to a colleague!</p>}
      </section>
    </main>
  );
}

// ---------- one duel ----------

type Phase = 'lobby' | 'intro' | 'guess' | 'reveal' | 'over';

function DuelRoom({ building, buildingName, me, id, onHome, onDuel }: Props & { id: string }) {
  const { duel, error, act, offset } = useDuel(id, me);
  const tick = useTick(200);
  const t = tick + offset;
  const joined = duel?.players.some(p => p.id === me.id);
  // Opened from an invite link: join automatically.
  const shouldJoin = duel?.status === 'lobby' && !joined;
  useEffect(() => { if (shouldJoin) void act({ type: 'join', id }); }, [shouldJoin, act, id]);

  if (!duel) return (
    <main className={styles.gg} data-screen="menu">
      <div className={styles.centerCard}>{error ? <><h2 className={styles.h2}>Duel not found</h2><p>{error}</p><button type="button" className={styles.btn} onClick={() => onDuel(undefined)}>All duels</button></> : <p className={styles.loadingText}>Joining the duel…</p>}</div>
    </main>
  );

  const round = duel.rounds.at(-1);
  const phase: Phase = duel.status === 'lobby' ? 'lobby'
    : !round ? 'intro'
    : round.resolvedAt === undefined ? (t < round.startsAt ? 'intro' : 'guess')
    : duel.status === 'over' ? (t < round.resolvedAt + 5000 ? 'reveal' : 'over')
    : t < round.resolvedAt + REVEAL_MS ? 'reveal' : 'intro';
  const introRound = round && round.resolvedAt === undefined ? duel.rounds.length : duel.rounds.length + 1;

  if (phase === 'lobby') return <WaitingRoom duel={duel} me={me} buildingName={buildingName} act={act} error={error} onLeave={async () => { await act({ type: 'leave', id }); onDuel(undefined); }} />;
  if (phase === 'over') return <GameOver duel={duel} me={me} building={building} onHome={onHome} onRematch={async () => {
    const { duel: fresh } = await postDuel({ type: 'create', buildingId: building.building.id }, me);
    for (let i = 0; i < duel.players.filter(p => p.bot).length; i++) await postDuel({ type: 'bot', id: fresh.id }, me);
    onDuel(fresh.id);
  }} />;

  return (
    <main className={styles.gg} data-phase={phase === 'reveal' ? 'reveal' : 'round'}>
      <DuelHud duel={duel} me={me} round={phase === 'intro' ? introRound : duel.rounds.length} />
      {phase === 'intro' && <RoundSplash n={introRound} />}
      {phase === 'guess' && round && <GuessPhase key={duel.rounds.length} building={building} duel={duel} me={me} t={t} onGuess={pick => act({ type: 'guess', id, pick })} />}
      {phase === 'reveal' && round && <RevealPhase key={duel.rounds.length} building={building} duel={duel} me={me} t={t} />}
      {error && <p className={styles.toastError}>{error}</p>}
      <button type="button" className={`${styles.iconBtn} ${styles.leaveBtn}`} onClick={() => { if (confirm('Leave the duel? You lose all your health.')) { void act({ type: 'leave', id }); onHome(); } }} aria-label="Leave the duel">✕</button>
    </main>
  );
}

function DuelHud({ duel, me, round }: { duel: DuelView; me: Me; round: number }) {
  const mine = duel.players.find(p => p.id === me.id);
  const others = duel.players.filter(p => p.id !== me.id);
  const current = duel.rounds.at(-1);
  const guessed = (pid: string) => !!current && current.resolvedAt === undefined && !!current.guesses[pid];
  const multiplier = current && duel.rounds.length === round ? current.multiplier : undefined;
  return (
    <header className={styles.duelHud}>
      {mine ? <HealthBar {...mine} max={START_HP} side="left" guessed={guessed(mine.id)} out={mine.hp <= 0} /> : <span />}
      <div className={styles.roundBadge}><small>Round</small><b>{round}</b>{multiplier && multiplier > 1 && <em>×{multiplier} damage</em>}</div>
      <div className={styles.opponents}>
        {others.map(p => <HealthBar key={p.id} {...p} max={START_HP} side="right" guessed={guessed(p.id)} out={p.hp <= 0} />)}
      </div>
    </header>
  );
}

function RoundSplash({ n }: { n: number }) {
  return <div className={styles.splash} key={n}><span>Round</span><b>{n}</b></div>;
}

function GuessPhase({ building, duel, me, t, onGuess }: { building: Building; duel: DuelView; me: Me; t: number; onGuess(pick: SpotPick): void }) {
  const round = duel.rounds.at(-1)!;
  const mine = round.guesses[me.id];
  const alive = duel.players.find(p => p.id === me.id)?.hp ?? 0;
  const [pick, setPick] = useState<SpotPick>();
  const [mapOpen, setMapOpen] = useState(false);
  const shown = mine ?? pick;
  const left = round.firstGuessAt !== undefined ? Math.max(0, Math.ceil((round.firstGuessAt + GUESS_WINDOW_MS - t) / 1000)) : undefined;
  const firstGuesser = round.firstGuessAt !== undefined ? duel.players.find(p => round.guesses[p.id]?.at === round.firstGuessAt) : undefined;
  return (
    <>
      <PhotoView src={round.spot.imageUrl} credit={`${round.spot.authorName}${round.spot.mock ? ' · sample photo' : ''}`} />
      {left !== undefined && (
        <div className={`${styles.timer} ${left <= 5 ? styles.timerHot : ''}`} role="timer" aria-live="polite">
          <b>{left}</b>
          {firstGuesser && firstGuesser.id !== me.id && !mine && <span>{firstGuesser.name} guessed!</span>}
        </div>
      )}
      <section className={styles.mapCard} data-size={mapOpen ? 'open' : 'mini'} aria-label="Map">
        <GuessMap building={building} pick={shown} onPick={mine || alive <= 0 ? undefined : setPick}>
          {!mapOpen && <button type="button" className={styles.mapOpener} onClick={() => setMapOpen(true)} aria-label="Open the map">🗺️ <span>Open map</span></button>}
          {mapOpen && <button type="button" className={styles.mapClose} onClick={() => setMapOpen(false)} aria-label="Back to the photo">📷</button>}
        </GuessMap>
        <button type="button" className={styles.guessBtn} disabled={!pick || !!mine || alive <= 0} onClick={() => pick && onGuess(pick)}>
          {alive <= 0 ? 'You are out: watching' : mine ? 'Waiting for the others…' : pick ? 'Guess' : 'Place your pin on the map'}
        </button>
      </section>
    </>
  );
}

function RevealPhase({ building, duel, me, t }: { building: Building; duel: DuelView; me: Me; t: number }) {
  const round = duel.rounds.at(-1)!;
  const panel = useRef<HTMLElement>(null);
  const height = useHeight(panel, round.resolvedAt);
  const floorName = (fid: string) => building.floors.find(f => f.id === fid)?.name ?? fid;
  const scene = useMemo(() => duelScene(building, duel), [building, duel]);
  const rows = duel.players.filter(p => round.scores?.[p.id]).sort((a, b) => (round.scores![b.id].points - round.scores![a.id].points));
  const best = rows[0]?.id;
  const next = Math.max(0, Math.ceil(((round.resolvedAt ?? 0) + REVEAL_MS - t) / 1000));
  return (
    <>
      <section className={styles.mapCard} data-size="full" aria-label="Map">
        <GuessMap building={building} scene={scene} bottomInset={height} />
      </section>
      <aside className={styles.resultPanel} ref={panel} aria-live="polite">
        {best === me.id && <Confetti count={30} />}
        <p className={styles.resultPlace}>📍 {placeName(building, round.spot.spaceId)} · {floorName(round.spot.floorId)}{round.spot.caption ? <> · “{round.spot.caption}”</> : null} · 📸 {round.spot.authorName}</p>
        <ol className={styles.duelRows}>
          {rows.map(p => {
            const s = round.scores![p.id], dmg = round.damage?.[p.id] ?? 0;
            return (
              <li key={p.id} className={p.id === me.id ? styles.meRow : ''}>
                <Avatar id={p.id} name={p.name} bot={p.bot} size={36} />
                <span className={styles.rowName}><b>{p.id === best ? '🏆 ' : ''}{p.name}</b><small>{round.guesses[p.id] ? `${metres(s.metres)} away` : 'no guess'}</small></span>
                <span className={styles.rowPoints}><CountUp value={s.points} /></span>
                <span className={dmg ? styles.damage : styles.noDamage}>{dmg ? `−${dmg.toLocaleString('en')}` : '0'}</span>
              </li>
            );
          })}
        </ol>
        <p className={styles.nextIn}>{duel.status === 'over' ? 'And that\'s the duel…' : `Next round in ${next}`}</p>
      </aside>
    </>
  );
}

/** The photo's spot, everyone's pin with name and distance, a line from each pin to the spot. */
function duelScene(building: Building, duel: DuelView): SceneDirective {
  const round = duel.rounds.at(-1)!;
  const answer = { floorId: round.spot.floorId, position: round.spot.position };
  const guesses = duel.players.filter(p => round.guesses[p.id]?.spaceId).map(p => ({ p, g: round.guesses[p.id] }));
  const levels = new Map(building.floors.map(f => [f.id, f.level]));
  const floorIds = [...new Set([answer.floorId, ...guesses.map(x => x.g.floorId)])].sort((a, b) => (levels.get(a) ?? 0) - (levels.get(b) ?? 0));
  return {
    focus: floorIds.length === 1 ? { mode: 'floor', floorId: floorIds[0] } : { mode: 'stack', floorIds },
    highlights: [{ spaceId: round.spot.spaceId, tone: 'primary' }],
    markers: [
      { ...answer, label: '📸 Taken here', tone: 'primary' },
      ...guesses.map(({ p, g }) => ({ floorId: g.floorId, position: g.position, label: `${p.name} · ${metres(round.scores?.[p.id]?.metres ?? Infinity)}`, tone: 'secondary' as const })),
    ],
    links: guesses.map(({ g }) => ({ from: { floorId: g.floorId, position: g.position }, to: answer })),
  };
}

function WaitingRoom({ duel, me, buildingName, act, error, onLeave }: { duel: DuelView; me: Me; buildingName: string; act: ReturnType<typeof useDuel>['act']; error?: string; onLeave(): void }) {
  const host = duel.players.find(p => p.id === duel.hostId);
  const isHost = duel.hostId === me.id;
  const [copied, setCopied] = useState(false);
  const link = typeof window === 'undefined' ? '' : `${window.location.origin}/guess?building=${encodeURIComponent(duel.buildingId)}&duel=${duel.id}`;
  const invite = useCallback(async () => {
    const text = `⚔️ Duel me in Building GeoGuessr (${buildingName})!\n${link}`;
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(link); setCopied(true); } } catch { /* closed */ }
  }, [link, buildingName]);
  const slots = Math.max(2, duel.players.length + (duel.players.length < 8 ? 1 : 0));
  return (
    <main className={styles.gg} data-screen="menu">
      <header className={styles.gameTop}>
        <button type="button" className={styles.iconBtn} onClick={onLeave} aria-label="Leave">←</button>
        <span className={styles.topTitle}>Duel #{duel.id} · {buildingName}</span>
      </header>
      <section className={styles.menu}>
        <h1 className={styles.h1}>Duel lobby</h1>
        <div className={styles.vsGrid}>
          {Array.from({ length: slots }, (_, i) => {
            const p = duel.players[i];
            return p ? (
              <div key={p.id} className={styles.playerCard}>
                <Avatar id={p.id} name={p.name} bot={p.bot} size={72} />
                <b>{p.name}{p.id === me.id ? ' (you)' : ''}</b>
                <small>{p.id === duel.hostId ? '👑 Host' : p.bot ? 'Bot' : 'Ready'}</small>
              </div>
            ) : <div key={`empty-${i}`} className={`${styles.playerCard} ${styles.playerEmpty}`}><span className={styles.waitingDots}>…</span><b>Waiting</b><small>for a colleague</small></div>;
          })}
          {duel.players.length === 2 && <span className={styles.vs}>VS</span>}
        </div>
        <div className={styles.inviteBox}>
          <span>Invite colleagues: they join with this link</span>
          <code>{link.replace(/^https?:\/\//, '')}</code>
          <button type="button" className={styles.btnSmall} onClick={() => void invite()}>{copied ? 'Copied ✓' : 'Share link'}</button>
        </div>
        {isHost ? (
          <div className={styles.menuButtons}>
            <button type="button" className={styles.btnBlue} onClick={() => void act({ type: 'bot', id: duel.id })} disabled={duel.players.length >= 8}>🤖 Add bot</button>
            <button type="button" className={styles.btn} onClick={() => void act({ type: 'start', id: duel.id })} disabled={duel.players.length < 2}>Start duel</button>
          </div>
        ) : <p className={styles.empty}>Waiting for {host?.name ?? 'the host'} to start…</p>}
        {error && <p className={styles.error}>{error}</p>}
      </section>
    </main>
  );
}

function GameOver({ duel, me, building, onHome, onRematch }: { duel: DuelView; me: Me; building: Building; onHome(): void; onRematch(): Promise<void> }) {
  const won = duel.winnerId === me.id;
  const winner = duel.players.find(p => p.id === duel.winnerId);
  const [busy, setBusy] = useState(false);
  const ranking = [...duel.players].sort((a, b) => b.hp - a.hp);
  return (
    <main className={styles.gg} data-screen="menu">
      {won && <Confetti count={80} />}
      <section className={styles.overScreen}>
        <h1 className={won ? styles.victory : styles.defeat}>{won ? 'Victory!' : duel.players.some(p => p.id === me.id) ? 'Defeat' : `${winner?.name ?? 'Nobody'} wins`}</h1>
        <p className={styles.sub}>{duel.rounds.length} rounds in {building.building.name}</p>
        <ol className={styles.ranking}>
          {ranking.map((p, i) => (
            <li key={p.id} className={p.id === me.id ? styles.meRow : ''}>
              <span className={styles.rank}>{i + 1}</span>
              <Avatar id={p.id} name={p.name} bot={p.bot} size={44} />
              <b>{p.name}{p.id === duel.winnerId ? ' 👑' : ''}</b>
              <span className={styles.rankHp}>{p.hp.toLocaleString('en')} HP</span>
            </li>
          ))}
        </ol>
        <div className={styles.menuButtons}>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => { setBusy(true); void onRematch(); }}>{busy ? 'Setting up…' : 'Rematch'}</button>
          <button type="button" className={styles.btnGhost} onClick={onHome}>Home</button>
        </div>
      </section>
    </main>
  );
}

