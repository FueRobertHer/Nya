'use client';

// An investment account's deposits and withdrawals on its sheet (components/
// AccountSheet.tsx), under the balance, above the chart. Drawn by
// AccountSparkline, which holds the two things it reads: the account's
// activity (with the totals the person set, lib/money-in-out.ts) and its
// balance history.
//
//   - Totals set and carried (lib/growth.ts usableTotals): one line saying
//     where all time counts from (the chart's All reads all time, components/
//     NetWorthChart.tsx `allTime`), and Change deposits and withdrawals.
//   - None set: one line saying what setting them shows, and that returns
//     count from the start of the range shown for now (the chart's own
//     explanations name the day), with Set deposits and withdrawals (its one
//     place).
//   - Set but no longer carried (their day is before the activity Nya now
//     has for the account): an information notice saying so, since no figure
//     is wrong; the chart counts from the start of each range again.
//
// Nothing while the account has no activity Nya can carry them through.

import { formatDay, formatMoney, roundsToNothing } from '@/lib/format';
import { sinceStarted, usableTotals, type BalancePoint, type Flow } from '@/lib/growth';
import type { MoneyInOut } from '@/lib/money-in-out';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';

/** What the form needs to open on an account (components/MoneyInOutSheet.tsx). */
export type MoneyInOutTarget = {
  account_id: string;
  item_id: string;
  /** "Individual ••4421 · Vanguard" */
  label: string;
  currency: string | null;
  totals: MoneyInOut | null;
  flows: Flow[];
  flows_from: string;
};

const day = (iso: string) => formatDay(iso, { sentence: true });

/** "$2,000.00 deposited", "$500.00 withdrawn", or both: what moved since
 *  the totals. */
function movedWords(m: { in: number; out: number }, currency: string | null): string | null {
  const parts = [
    ...(roundsToNothing(m.in, currency) ? [] : [`${formatMoney(m.in, currency)} deposited`]),
    ...(roundsToNothing(m.out, currency) ? [] : [`${formatMoney(m.out, currency)} withdrawn`]),
  ];
  return parts.length ? parts.join(' and ') : null;
}

/** What the chart does without totals: the line starts with each range
 *  (lib/growth.ts contributionBaseline), so no one day can be named here. */
const FOR_NOW = 'For now, returns count from the start of the range shown.';

export default function MoneyInOutFigures({
  target,
  unreadable,
  flowsTo,
  balance,
  points,
  onEdit,
}: {
  /** The account, its activity and its totals, as the form takes them. */
  target: MoneyInOutTarget;
  /** The totals couldn't be read. */
  unreadable: boolean;
  flowsTo: string | null | undefined;
  /** The live balance. */
  balance: number | null | undefined;
  /** Its balance history, null while it loads. */
  points: BalancePoint[] | null;
  onEdit: (target: MoneyInOutTarget) => void;
}) {
  const { totals, flows, flows_from, currency } = target;
  const edit = (words: string) => (
    <div>
      <button type="button" className="btn ghost" onClick={() => onEdit(target)}>
        {words}
      </button>
    </div>
  );

  if (unreadable) {
    return (
      <Notice level="caution" role="status">
        Your deposits and withdrawals for this account can’t be read just now, so its returns count from the start of the range shown.
      </Notice>
    );
  }

  if (!totals) {
    return (
      <div className="stack tight">
        <p className="helper">Set your deposits and withdrawals to see your all-time returns. {FOR_NOW}</p>
        {edit('Set deposits and withdrawals')}
      </div>
    );
  }

  if (!usableTotals(totals, flows_from)) {
    return (
      <div className="stack tight">
        <Notice level="info">
          Change deposits and withdrawals to see your all-time returns again: your totals are for {day(totals.as_of)}, and Nya’s activity for this account now starts {day(flows_from)}. {FOR_NOW}
        </Notice>
        {edit('Change deposits and withdrawals')}
      </div>
    );
  }

  // What moved since the totals, to the day all time is measured on.
  const f = sinceStarted(totals, flows, flowsTo, balance, points);
  const moved = movedWords(f.since, currency);
  return (
    <div className="stack tight">
      <p className="helper">
        <Masked>{`All time counts from your totals for ${day(totals.as_of)}${moved ? `, and ${moved} since` : ''}.`}</Masked>
      </p>
      {edit('Change deposits and withdrawals')}
    </div>
  );
}

/** Its space while the account's activity loads, on its own classes. */
export function MoneyInOutSkeleton() {
  return (
    <div className="stack tight" aria-hidden="true">
      <p className="helper">
        <span className="skeleton lines-skeleton-line" />
      </p>
    </div>
  );
}
