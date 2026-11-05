'use client';

// The way into working tax out from your accounts (the tax plan's D5): one row in Year
// by year's place, then a sheet that says what changes, before and after, and what it
// reads, and nothing changes until Work it out. Shared by every plan, so a copy says
// where it is done. Saved by components/PlanTab.tsx, which reads your plans again after.

import { useState } from 'react';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import { Masked } from './HideAmounts';
import { fiWhen } from './plan-fi-when';
import { pct } from './plan-text';
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

/** When it reaches FI, as a line of the sheet says it. */
function whenWords(f: PlanFigures): string {
  const w = fiWhen(f);
  switch (w.kind) {
    case 'age':
      return `around ${w.age}`;
    case 'now':
      return 'now';
    case 'never':
      return 'not at this rate';
    case 'said':
      return w.text.charAt(0).toLowerCase() + w.text.slice(1);
    default:
      return 'not known';
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What moved the number further, as far as tax or health coverage can be told apart. */
function mostlyWords(before: PlanFigures, after: PlanFigures): string | null {
  const s = after.shares;
  if (!s || before.plan.fiNumber !== null) return null;
  const living = Math.max(0, s.spending - s.paid);
  const byTax = Math.abs(living / (1 - s.t) - living / (1 - before.plan.taxRate));
  const byHealth = s.h / (1 - s.t);
  if (byTax < 0.5 && byHealth < 0.5) return null;
  if (byHealth >= byTax) return after.view.spending.source === 'measured' ? 'Mostly health coverage: measured spending leaves out coverage through work, and after you stop it is a cost of its own.' : 'Mostly health coverage: after you stop it is a cost of its own.';
  return 'Mostly tax: what you draw from tax-deferred accounts, the gains you sell and Social Security all count as income.';
}

export function OptInSheet({
  before,
  after,
  working,
  coverageSet,
  money,
  lawYear,
  paused = null,
  onConfirm,
  onDone,
}: {
  /** Your plan as it stands. */
  before: PlanFigures | null;
  /** As it would be, once worked out. */
  after: PlanFigures | null;
  working: boolean;
  /** How you'd be covered before 65 is set. */
  coverageSet: boolean;
  money: (n: number) => string;
  lawYear: number;
  paused?: string | null;
  onConfirm: () => Promise<true | string>;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shares = after?.shares ?? null;
  const mostly = before && after ? mostlyWords(before, after) : null;
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
        {working && (
          <p className="plan-working-line" role="status">
            Working it out
          </p>
        )}
        {before && shares && after && !working && (
          <dl className="txn-detail txn-detail-wide">
            <div className="txn-detail-row">
              <dt>Your FI date</dt>
              <dd>{`${capital(whenWords(before))}, then ${whenWords(after)}`}</dd>
            </div>
            <div className="txn-detail-row">
              <dt>Your FI number</dt>
              <dd className="money">
                <Masked>{before.plan.fiNumber !== null ? `${money(before.plan.fiNumber)}, set by you` : `${before.view.fiNumber === null ? '--' : money(before.view.fiNumber)}, then ${after.view.fiNumber === null ? '--' : money(after.view.fiNumber)}`}</Masked>
              </dd>
            </div>
            <div className="txn-detail-row">
              <dt>Tax after you stop</dt>
              <dd>{`${pct(before.plan.taxRate)}, as set, then ${pct(shares.t, 1)}`}</dd>
            </div>
            <div className="txn-detail-row">
              <dt>Health coverage</dt>
              <dd className="money">
                <Masked>{`None, then ${money(shares.h)} a year${coverageSet ? '' : ' from Medicare'}`}</Masked>
              </dd>
            </div>
          </dl>
        )}
        {!working && !shares && <p className="helper">What it comes to can’t be worked out yet. You can still turn it on, and Drawdown will say what it needs.</p>}
        {before && after && !working && mostly && <p className="helper">{mostly}</p>}
        {shares && !working && !coverageSet && <p className="helper">Coverage before 65 is yours to set next, on Health coverage.</p>}
        <p className="helper">Drawdown works tax and health coverage out year by year, and your FI number, Home and every copy use them.</p>
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
