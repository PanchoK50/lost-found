'use client';

import { useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import { hazardMeta, type Assessment, type HazardKind, type Incident } from '@/lib/hazards/types';
import { authHeader } from '@/lib/supabase/browser';
import { Sheet } from '@/components/world/sheet';
import { SpaceSelect } from '@/components/world/space-select';

/** Downscale a photo to at most `max` px on the long side, as a JPEG data URL. */
async function downscale(file: File, max = 800): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

/**
 * "Report damage" for employees: a photo and/or a few words, checked by AI (fire, water or electrical, how bad),
 * then the room, then the alarm. Phone first: the camera opens directly.
 */
export function ReportDamage({ building, myRoom, reporter, onRaise, onClose }: {
  building: Building;
  myRoom?: string;
  reporter?: string;
  onRaise(incident: Incident): void;
  onClose(): void;
}) {
  const [photo, setPhoto] = useState<string>();
  const [text, setText] = useState('');
  const [place, setPlace] = useState(myRoom ?? '');
  const [assessment, setAssessment] = useState<Assessment>();
  const [hazard, setHazard] = useState<HazardKind>();
  const [severity, setSeverity] = useState<1 | 2 | 3>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function check() {
    setBusy(true); setError(undefined);
    try {
      const res = await fetch('/api/hazards/classify', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ photo, text }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? 'The check failed.');
      setAssessment(data);
      if (data.hazard !== 'none') setHazard(data.hazard);
      setSeverity(data.severity);
      if (!place && data.place_hint) {
        const hint = data.place_hint.toLowerCase();
        const match = building.spaces.find(s => hint.includes(s.name.toLowerCase()));
        if (match) setPlace(match.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The check failed.');
    } finally {
      setBusy(false);
    }
  }

  function raise() {
    if (!hazard) { setError('Choose fire, water or electrical.'); return; }
    if (!place) { setError('Pick the room.'); return; }
    onRaise({
      id: crypto.randomUUID(), buildingId: building.building.id, hazard, spaceId: place, severity,
      source: photo ? 'photo' : 'report', title: assessment?.title || `${hazardMeta[hazard].label} reported`,
      description: assessment?.description || text || 'Reported without details.', photo, reporter, createdAt: Date.now(), status: 'active',
    });
  }

  return (
    <Sheet title="Report damage" onClose={onClose}>
      <div className="report-damage">
        <label className="report-photo">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, nothing to optimise */}
          {photo ? <img src={photo} alt="Your photo" /> : <span>Add a photo</span>}
          <input type="file" accept="image/*" capture="environment" onChange={async event => {
            const file = event.target.files?.[0];
            if (file) { setPhoto(await downscale(file)); setAssessment(undefined); }
          }} />
        </label>
        <textarea value={text} onChange={event => setText(event.target.value)} placeholder="What do you see? e.g. “Water dripping from the ceiling in the kitchen”" rows={2} maxLength={500} />
        <button type="button" className="button" onClick={() => void check()} disabled={busy || (!photo && !text.trim())}>{busy ? 'Checking…' : 'Check with AI'}</button>

        {assessment && (
          <div className={`report-assessment${assessment.immediate_danger ? ' report-assessment--danger' : ''}`}>
            <strong>{assessment.hazard === 'none' ? 'No damage recognised' : assessment.title}</strong>
            <p>{assessment.description}</p>
            {assessment.hazard !== 'none' && <span>Severity {assessment.severity}/3 · {Math.round(assessment.confidence * 100)}% sure{assessment.immediate_danger ? ' · danger to people' : ''}</span>}
          </div>
        )}

        <label className="report-field">What is it?
          <div className="report-kinds" role="group">
            {(['fire', 'water', 'electrical'] as const).map(kind => (
              <button type="button" key={kind} className={`hazard-chip hazard-chip--${kind}`} aria-pressed={hazard === kind} onClick={() => setHazard(kind)}>{hazardMeta[kind].label}</button>
            ))}
          </div>
        </label>
        <label className="report-field">How bad?
          <div className="report-kinds" role="group">
            {([1, 2, 3] as const).map(level => (
              <button type="button" key={level} className="hazard-chip" aria-pressed={severity === level} onClick={() => setSeverity(level)}>{level === 1 ? 'Minor' : level === 2 ? 'Spreading' : 'Danger'}</button>
            ))}
          </div>
        </label>
        <label className="report-field">Where?
          <SpaceSelect building={building} value={place} onChange={setPlace} empty="Pick the room" />
        </label>
        {error && <p className="hazard-error">{error}</p>}
        <button type="button" className="button button--danger" onClick={raise} disabled={!hazard || !place}>Raise the alarm</button>
      </div>
    </Sheet>
  );
}
