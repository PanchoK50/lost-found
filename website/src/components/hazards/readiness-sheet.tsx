'use client';

import { useEffect, useState } from 'react';
import type { Building } from '@/lib/buildings/types';
import type { Readiness, ReadinessFinding } from '@/lib/hazards/types';
import { Sheet } from '@/components/world/sheet';

const CATEGORY_ICON: Record<string, string> = { fire: '🔥', water: '💧', electrical: '⚡', safety: '❤️' };

/** Building readiness: weak spots to fix before anything happens; each finding shows its rooms on the map. */
export function ReadinessSheet({ building, onShow, onClose }: { building: Building; onShow(finding: ReadinessFinding): void; onClose(): void }) {
  const [report, setReport] = useState<Readiness>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/hazards/readiness?building_id=${encodeURIComponent(building.building.id)}`)
      .then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.detail ?? data.error ?? 'Could not check the building.'); return data; })
      .then(data => { if (!cancelled) setReport(data); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not check the building.'); });
    return () => { cancelled = true; };
  }, [building.building.id]);
  return (
    <Sheet title="Readiness check" onClose={onClose}>
      {error && <p className="hazard-error">{error}</p>}
      {!report && !error && <p className="hazard-loading">Checking extinguishers, escape routes and wet rooms…</p>}
      {report && (
        <div className="readiness">
          <div className="readiness-score"><strong>{report.score}</strong><span>/100 readiness · {report.counts.high} high · {report.counts.medium} medium · {report.counts.low} low</span></div>
          <ul className="hazard-list">
            {report.findings.map(finding => (
              <li key={finding.id}><button type="button" className={`readiness-finding readiness-finding--${finding.severity}`} onClick={() => onShow(finding)} disabled={!finding.space_ids.length}>
                <span aria-hidden>{CATEGORY_ICON[finding.category] ?? '•'}</span>
                <div><strong>{finding.title}</strong><span>{finding.detail}</span><em>{finding.rule}</em></div>
              </button></li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}
