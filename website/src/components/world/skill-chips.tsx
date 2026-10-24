'use client';

import type { Skill } from '@/lib/world/types';

/**
 * Skills as one-tap shortcuts (docs/MULTIPLAYER.md §7): skills whose phrases match what is being typed,
 * otherwise the three most used in this building.
 */
export function SkillChips({ skills, draft, onUse }: { skills: Skill[]; draft: string; onUse(skill: Skill): void }) {
  const text = draft.toLowerCase();
  const matching = text.trim() ? skills.filter(s => s.phrases.some(p => new RegExp(`(?<![\\w])${escape(p)}`).test(text))) : [];
  const shown = (matching.length ? matching : [...skills].sort((a, b) => b.uses - a.uses || b.votes - a.votes)).slice(0, 3);
  if (!shown.length) return null;
  return (
    <div className={`skill-chips${matching.length ? ' skill-chips--match' : ''}`} aria-label="Skills">
      {shown.map(s => <button type="button" key={s.id} onClick={() => onUse(s)} title={s.phrases.join(', ')}>⚡ {s.name}</button>)}
    </div>
  );
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
