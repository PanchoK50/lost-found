'use client';

import { useEffect, type ReactNode } from 'react';

/** A short task in the right panel (in place of the chat, which stays mounted underneath): add a building, report damage. Escape closes it. */
export function SidePanel({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <section className="side-panel" aria-label={title}>
      <div className="chat-head">
        <span>{title}</span>
        <button type="button" className="chat-new" onClick={onClose}>Close</button>
      </div>
      <div className="side-panel-body">{children}</div>
    </section>
  );
}
