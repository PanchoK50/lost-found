'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authHeader } from '@/lib/supabase/browser';
import { Sheet } from './sheet';

export interface BuildingRow { id: string; name: string; source: string; split: string | null; floors: number; spaces: number }

const sourceLabel: Record<string, string> = {
  osm_indoor: 'OpenStreetMap', procedural: 'Factory / campus', swiss_dwellings: 'Swiss Dwellings', resplan: 'ResPlan', upload: 'Uploaded',
};
const SHOWCASE = ['osm-way22744230', 'proc-factory-dev-003'];
const MAX_ROWS = 60;

interface UploadResult {
  id: string; name: string; floors: number; spaces: number; doors: number; connectors: number;
  issues: { issues: number; by_field: Record<string, number>; high: number };
  questions: string[];
}

/** All buildings (dataset + uploaded plans) with search, and "Add a building" from floor-plan SVGs. */
export function BuildingsSheet({ buildings, currentId, onClose }: { buildings: BuildingRow[]; currentId: string; onClose(): void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<UploadResult>();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = (b: BuildingRow) => (SHOWCASE.includes(b.id) ? 0 : b.source === 'upload' ? 1 : 2);
    return buildings
      .filter(b => !q || `${b.name} ${b.id} ${sourceLabel[b.source] ?? b.source}`.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [buildings, query]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !files.length || busy) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const form = new FormData();
      form.set('name', name.trim());
      files.forEach(file => form.append('files', file));
      const res = await fetch('/api/buildings/upload', { method: 'POST', headers: await authHeader(), body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Upload failed.');
      setResult(data);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  const fields = result ? Object.entries(result.issues.by_field).map(([field, n]) => `${n} ${field.replace('_', ' ')}`).join(', ') : '';

  return (
    <Sheet title="Buildings" onClose={onClose}>
      <input className="buildings-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${buildings.length} buildings`} aria-label="Search buildings" />
      <ul className="buildings-list">
        {shown.slice(0, MAX_ROWS).map(b => (
          <li key={b.id}>
            <Link href={`/?building=${b.id}`} className={b.id === currentId ? 'active' : ''} aria-current={b.id === currentId ? 'page' : undefined} onClick={onClose}>
              <strong>{b.name}</strong>
              <small>{sourceLabel[b.source] ?? b.source} · {b.floors} floor{b.floors === 1 ? '' : 's'} · {b.spaces} spaces</small>
            </Link>
          </li>
        ))}
      </ul>
      {shown.length > MAX_ROWS && <p className="sheet-hint">{shown.length - MAX_ROWS} more; type to narrow down.</p>}
      {!shown.length && <p className="sheet-hint">No building matches “{query}”.</p>}

      <section className="buildings-upload">
        <h3>Add a building</h3>
        <p className="sheet-hint">Upload one plan per floor (SVG or PNG), named <code>floor_0</code>, <code>floor_1</code>, … (basements <code>floor_-1</code>), or select all files of a building folder. Rooms, doors, stairs, room numbers and room types are read from the plans. Anything uncertain is checked with you in the chat. A ready-made <code>building.json</code> is imported as it is.</p>
        <form onSubmit={upload}>
          <label>Name<input value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="e.g. Hall 7" /></label>
          <label>Floor plans<input type="file" accept=".svg,image/svg+xml,.png,image/png,.json,application/json" multiple onChange={e => setFiles([...(e.target.files ?? [])])} /></label>
          <button type="submit" className="button button--primary" disabled={busy || !name.trim() || !files.length}>{busy ? 'Reading the plans…' : 'Create building'}</button>
        </form>
        {error && <p className="sheet-error" role="alert">{error}</p>}
        {result && (
          <div className="upload-result">
            <p><strong>{result.name}</strong>: {result.floors} floor{result.floors === 1 ? '' : 's'}, {result.spaces} spaces, {result.doors} doors, {result.connectors} stairs/lifts.</p>
            {result.issues.issues > 0 && <p className="sheet-hint">To check: {fields}.</p>}
            {result.questions.map(q => <p key={q} className="sheet-hint">• {q}</p>)}
            <Link className="button button--primary" href={`/?building=${result.id}&check=1`} onClick={onClose}>Open {result.name} and check it</Link>
          </div>
        )}
      </section>
    </Sheet>
  );
}
