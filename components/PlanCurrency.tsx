'use client';

// components/PlanCurrency.tsx
//
// What the Plan tab says about the currency its typed figures are in
// (lib/fire/plan-currency.ts): the question when that isn't known (a plan
// saved before it was recorded, or whose record no longer fits it), with a
// button for each currency in sight, and, once it is recorded and the
// accounts or spending are in another, that the figures stay in theirs, with
// a way to say they were typed in that other currency after all. Nothing
// here converts or relabels on its own: each button is the person's word.

import { useState } from 'react';
import type { PlanCurrencyState } from '@/lib/fire/plan-currency';

export function PlanCurrencyCard({
  state,
  ask,
  kept,
  offer,
  relabelTo,
  failure = null,
  onAnswer,
}: {
  state: PlanCurrencyState;
  /** The question, while the currency isn't known (null while it waits on
   *  the accounts, or when it is known). */
  ask: string | null;
  /** That the figures stay in their currency (lib/fire/plan-currency.ts
   *  keptText), once it is recorded and something measured is in another. */
  kept: string | null;
  /** The currencies to offer as the answer. */
  offer: string[];
  /** Once recorded: the accounts' currency, to say the figures were typed in
   *  it after all. */
  relabelTo: string | null;
  /** Why the tab couldn't record it itself, when it tried. */
  failure?: string | null;
  /** Records the answer; true once it is recorded, or why not. */
  onAnswer: (currency: string) => Promise<true | string>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answer = async (c: string) => {
    setBusy(true);
    setError('');
    const r = await onAnswer(c);
    setBusy(false);
    if (r !== true) setError(r);
  };
  if (state.kind === 'unknown') {
    if (!ask) return null;
    return (
      <div className="card" role="region" aria-label="Your plan’s currency">
        <div className="inst-header">
          <div className="inst-name">Which currency are your plan’s figures in?</div>
        </div>
        <p className="panel-note">{ask}</p>
        {failure && <div className="error">{failure}</div>}
        {state.problem !== 'newer' && offer.length > 0 && (
          <div className="action-row" style={{ marginTop: 12 }}>
            {offer.map((c) => (
              <button key={c} className="secondary" disabled={busy} onClick={() => void answer(c)}>
                They’re in {c}
              </button>
            ))}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    );
  }
  if (state.kind !== 'recorded' || !kept) return null;
  return (
    <div className="card" role="region" aria-label="Your plan’s currency">
      <p className="panel-note" style={{ marginTop: 0 }}>
        {kept}
      </p>
      {relabelTo && relabelTo !== state.currency && (
        <>
          <p className="panel-note">
            If the figures you typed are in fact in {relabelTo}, say so: they are then read in {relabelTo} as you typed them, and nothing is converted.
          </p>
          <button className="secondary" style={{ marginTop: 8 }} disabled={busy} onClick={() => void answer(relabelTo)}>
            They’re in {relabelTo}
          </button>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
