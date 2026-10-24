'use client';

import type { Clue, ClueKind } from '@/lib/guess/clues';
import styles from './guess.module.css';

interface Props {
  clues: Clue[];
  bought: ClueKind[];
  onBuy(kind: ClueKind): void;
}

/** Clue cards: the first is free, every further one costs points (docs/GEOGUESSR.md §2). Any order, so the floor is a gamble. */
export function ClueDetective({ clues, bought, onBuy }: Props) {
  const open = clues.filter(c => c.cost === 0 || bought.includes(c.kind));
  const locked = clues.filter(c => !open.includes(c));
  return (
    <div className={styles.detective}>
      <ol className={styles.clueCards}>
        {open.map(c => <li key={c.kind}><i aria-hidden>{c.icon}</i><p>{emphasis(c.text)}</p></li>)}
      </ol>
      {locked.length > 0 && (
        <div className={styles.locked}>
          {locked.map(c => (
            <button type="button" key={c.kind} onClick={() => onBuy(c.kind)} aria-label={`Reveal clue: ${c.title}, costs ${c.cost} points`}>
              <i aria-hidden>{c.icon}</i><b>{c.title}</b><span>−{c.cost.toLocaleString('en')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** `**…**` → bold. */
function emphasis(text: string) {
  return text.split('**').map((part, i) => i % 2 ? <b key={i}>{part}</b> : part);
}
