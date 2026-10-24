'use client';

import { useState } from 'react';
import type { Proposal } from '@/lib/chat/contract';
import type { WorldAction } from '@/lib/world/types';
import type { WorldActions } from './world-hud';

type NewPin = Extract<WorldAction, { type: 'pin.create' }>['pin'];

/**
 * The agent's proposed world changes as preview cards (docs/MULTIPLAYER.md §11). Nothing is posted
 * before Confirm (U8). Edit opens the report sheet for pins, and puts the message back in the input otherwise.
 */
export function ProposalCards({ proposals, act, onEditPin, onEditText }: {
  proposals: Proposal[];
  act: WorldActions['act'];
  onEditPin(pin: NewPin): void;
  onEditText(): void;
}) {
  const [state, setState] = useState<Record<number, 'posting' | 'posted' | { error: string }>>({});
  const confirm = async (i: number, proposal: Proposal) => {
    setState(s => ({ ...s, [i]: 'posting' }));
    const result = await act(proposal.action);
    setState(s => ({ ...s, [i]: result.ok ? 'posted' : { error: result.error } }));
  };
  return (
    <div className="proposals">
      {proposals.map((proposal, i) => {
        const status = state[i];
        const action = proposal.action;
        return (
          <div key={i} className={`proposal${status === 'posted' ? ' proposal--posted' : ''}`}>
            <span className="proposal-text">
              <strong>{proposal.label}</strong>
              {proposal.detail && <small>{proposal.detail}</small>}
              {typeof status === 'object' && <small className="proposal-error">{status.error}</small>}
            </span>
            {status === 'posted'
              ? <span className="proposal-done">Posted ✓</span>
              : <span className="proposal-actions">
                  <button type="button" className="button" disabled={status === 'posting'} onClick={() => action.type === 'pin.create' ? onEditPin(action.pin) : onEditText()}>Edit</button>
                  <button type="button" className="button button--primary" disabled={status === 'posting'} onClick={() => void confirm(i, proposal)}>{status === 'posting' ? '…' : 'Confirm'}</button>
                </span>}
          </div>
        );
      })}
    </div>
  );
}
