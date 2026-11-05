'use client';

// The way into working tax out from your accounts (the tax plan's D5): one row in Year
// by year's place, then a sheet that says what changes and what it reads, and nothing
// changes until Work it out. T4 brings the before and after figures, when the FI number
// moves with it; T3 can only say so. Shared by every plan, so a copy says where it is
// done. Saved by components/PlanTab.tsx, which reads your plans again after.

import { useState } from 'react';
import { Notice } from './TotalCaveats';

const CHEVRON = (
  <svg className="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const OPT_IN_TITLE = 'Work it out from your accounts';

export function OptInRow({
  copy,
  noAge,
  held,
  onOpen,
  rowRef,
}: {
  /** A copy is open: this is done on your plan. */
  copy: boolean;
  /** Detailed tax can't run without an age: the row opens Household instead. */
  noAge: boolean;
  held: boolean;
  onOpen: (row: HTMLButtonElement) => void;
  rowRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <section className="card" aria-label="Tax and health coverage, year by year">
      {copy ? (
        <p className="helper">{OPT_IN_TITLE} is the same in every plan: change it on your plan.</p>
      ) : (
        <ul className="list-rows">
          <li>
            <button
              ref={rowRef}
              type="button"
              className="list-row"
              aria-haspopup="dialog"
              aria-disabled={held ? 'true' : undefined}
              onClick={(e) => {
                if (!held) onOpen(e.currentTarget);
              }}
            >
              <span className="list-row-text">
                <span className="list-row-title">{OPT_IN_TITLE}</span>
                <span className="list-row-sub">{noAge ? 'It needs your age: add it on Household, and until then your flat rate stays' : 'Tax and health coverage, year by year, in place of one flat rate'}</span>
              </span>
              {CHEVRON}
            </button>
          </li>
        </ul>
      )}
    </section>
  );
}

export function OptInSheet({ moves, lawYear, paused = null, onConfirm, onDone }: { /** The drawdown can already move this plan's FI date. */ moves: boolean; lawYear: number; paused?: string | null; onConfirm: () => Promise<true | string>; onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setSaving(true);
    setError(null);
    const r = await onConfirm();
    setSaving(false);
    if (r === true) onDone();
    else setError(r);
  };
  return (
    <div className="stack loose">
      <div className="stack tight">
        <h3 className="section-label">What changes</h3>
        <p className="helper">Drawdown works tax and health coverage out year by year, and Will it last? runs on them. Your FI number changes when this reaches it, in a later version.</p>
        {moves && <p className="helper">Your plan has a year that spends more than it saves, or a milestone on a balance. Tax reaches those now, so your FI date can move.</p>}
      </div>
      <div className="stack tight">
        <h3 className="section-label">What it reads</h3>
        <p className="helper">Each account’s tax bucket, owner and cost basis; what you put into Roth; how you’ll be covered before 65; your household and state. Anything not set is counted the cautious way and says so.</p>
      </div>
      <p className="helper">Hypothetical, {lawYear} tax law. Not tax advice. Use a flat rate instead takes you back at any time.</p>
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
      {paused && <p className="helper plan-paused">{paused}</p>}
      <div className="button-pair">
        <button type="button" className="secondary" onClick={onDone} disabled={saving}>
          Not now
        </button>
        <button type="button" onClick={confirm} disabled={saving || paused !== null}>
          {saving ? 'Saving…' : 'Work it out'}
        </button>
      </div>
    </div>
  );
}
