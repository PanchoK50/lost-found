'use client';

import type { Player } from '@/lib/world/types';

/** The "@name" being typed at the end of the draft, if any. */
export function mentionQuery(draft: string): string | undefined {
  return draft.match(/(?:^|\s)@([\p{L}\w-]*)$/u)?.[1];
}

/** Suggestions while typing "@…": people in the building, tap to insert "@Name ". */
export function MentionPicker({ players, draft, onPick }: { players: Player[]; draft: string; onPick(text: string): void }) {
  const query = mentionQuery(draft);
  if (query === undefined) return null;
  const q = query.toLowerCase();
  const matches = players.filter(p => p.name.toLowerCase().split(/\s+/).some(part => part.startsWith(q)) || p.name.toLowerCase().startsWith(q)).slice(0, 6);
  if (!matches.length) return null;
  return (
    <div className="mention-picker" role="listbox" aria-label="People">
      {matches.map(p => (
        <button type="button" role="option" aria-selected={false} key={p.id} onClick={() => onPick(draft.replace(/@[\p{L}\w-]*$/u, `@${p.name.split(/\s+/)[0]} `))}>
          <span className={`person-dot${p.demo ? ' person-dot--demo' : ''}`}>{p.initials}</span>{p.name}
        </button>
      ))}
    </div>
  );
}
