'use client';

import { useState, type ChangeEvent } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { PhotoSpot, SpotPick } from '@/lib/guess/spots';
import { shrinkPhoto, uploadSpot, type Me } from '@/lib/guess/use-guess';
import { GuessMap } from './guess-map';
import styles from './gg.module.css';

interface Props {
  building: Building;
  buildingName: string;
  me: Me;
  onDone(spot: PhotoSpot): void;
  onPlay(): void;
  onHome(): void;
}

/** Community: take a photo, tag the exact spot on the 3D model, share it with everyone in the building. */
export function UploadFlow({ building, buildingName, me, onDone, onPlay, onHome }: Props) {
  const [step, setStep] = useState<'photo' | 'tag' | 'done'>('photo');
  const [image, setImage] = useState<string>();
  const [pick, setPick] = useState<SpotPick>();
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(undefined);
    try { setImage(await shrinkPhoto(file)); setStep('tag'); } catch { setError('That file could not be read as a photo.'); }
  }

  async function upload() {
    if (!image || !pick) return;
    setBusy(true); setError(undefined);
    try {
      const spot = await uploadSpot({ buildingId: building.building.id, pick, caption: caption.trim() || undefined, image, player: me });
      onDone(spot);
      setStep('done');
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(false); }
  }

  const reset = () => { setImage(undefined); setPick(undefined); setCaption(''); setStep('photo'); };

  return (
    <main className={styles.gg} data-screen={step === 'tag' ? 'tag' : 'menu'}>
      <header className={styles.gameTop}>
        <button type="button" className={styles.iconBtn} onClick={step === 'tag' ? reset : onHome} aria-label="Back">←</button>
        <span className={styles.topTitle}>Add a photo · {buildingName}</span>
      </header>

      {step === 'photo' && (
        <section className={styles.menu}>
          <div className={styles.duelHero}>
            <span className={styles.vsBadge}>📸</span>
            <h1 className={styles.h1}>Snap a spot</h1>
            <p className={styles.sub}>A window, a corner, the coffee machine, a weird poster: take a photo, tag where you took it on the 3D model, and everyone in <b>{buildingName}</b> can play with it.</p>
          </div>
          <div className={styles.menuButtons}>
            <label className={styles.btn}>📷 Take photo<input type="file" accept="image/*" capture="environment" onChange={e => void choose(e)} hidden /></label>
            <label className={styles.btnBlue}>🖼️ From gallery<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => void choose(e)} hidden /></label>
          </div>
          <ul className={styles.tips}>
            <li>👀 Show something you can recognise, but make it a little tricky.</li>
            <li>🙈 No faces, screens or papers with private details.</li>
            <li>📍 Tag the exact spot you stood on, not the thing you photographed.</li>
          </ul>
          {error && <p className={styles.error}>{error}</p>}
        </section>
      )}

      {step === 'tag' && image && (
        <>
          <section className={styles.mapCard} data-size="full" aria-label="Tag the spot">
            <GuessMap building={building} pick={pick} onPick={setPick} bottomInset={150} />
          </section>
          {/* eslint-disable-next-line @next/next/no-img-element -- local preview from a data URL */}
          <img className={styles.tagThumb} src={image} alt="Your photo" />
          <aside className={styles.tagPanel}>
            <p className={styles.tagTitle}>{pick ? 'Got it! Move the pin if needed.' : 'Where did you stand when you took it?'}</p>
            <input className={styles.input} value={caption} onChange={e => setCaption(e.target.value)} maxLength={80} placeholder="Caption, shown after the reveal (optional)" />
            <button type="button" className={styles.btn} disabled={!pick || busy} onClick={() => void upload()}>{busy ? 'Uploading…' : 'Share with everyone'}</button>
            {error && <p className={styles.error}>{error}</p>}
          </aside>
        </>
      )}

      {step === 'done' && image && (
        <section className={styles.menu}>
          <div className={styles.doneCard}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt="Your photo" />
            <h1 className={styles.h1}>It&apos;s live!</h1>
            <p className={styles.sub}>Everyone in {buildingName} can now get this photo in their games and duels.</p>
          </div>
          <div className={styles.menuButtons}>
            <button type="button" className={styles.btn} onClick={onPlay}>Play now</button>
            <button type="button" className={styles.btnBlue} onClick={reset}>Add another</button>
          </div>
        </section>
      )}
    </main>
  );
}
