'use client';

import { useEffect, type ReactNode } from 'react';

/** Glass sheet: slides up from the bottom on phones, floats on the right on desktop. Escape or the backdrop closes it. */
export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return <>
    <div className="sheet-backdrop" onClick={onClose} />
    <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button type="button" className="sheet-close" onClick={onClose} aria-label="Close">✕</button></header>
      {children}
    </div>
  </>;
}
