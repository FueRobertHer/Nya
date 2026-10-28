'use client';

// Activity's In, Out and Net (the screen review after step 5): one strip at
// the top of the panel, under the bar, on the page rather than in a card, in
// place of the three places the same figures were said (a card over the list,
// the Cash flow card's own row, and an In and out card on Spending). On
// Transactions it sums the bar's month; on Spending the period every card
// there sums (components/MonthBreakdown.tsx), naming it when it is more than
// the bar's month. Money in has its plus and money out its minus, so the sign
// and the label carry which is which, never the color alone. What qualifies
// the figures (what they leave out, what may be missing) follows them, as
// the caller writes it, in its words.
//
// With no figures yet (the transactions still loading), the same strip with
// placeholders where the figures go, so nothing moves when they arrive
// (components/LoadingSkeletons.tsx); the loading view's one status says it
// is loading, so the strip itself is hidden from a screen reader then.

import type { ReactNode } from 'react';
import { signedMoney, toMinorUnits } from '@/lib/format';
import { Masked } from './HideAmounts';

/** What came in and went out, both as positive sums, in `currency`. */
export type MonthTotals = { moneyIn: number; moneyOut: number; currency: string | null };

/** The three figures as they are written: each rounded to the currency's
 *  minor unit first (none named: in cents), and Net worked out from the two
 *  rounded, so it is their difference to the unit, and its sign and color
 *  come from what is written: a net that rounds to nothing is "$0.00", never
 *  "+$0.00" in green. */
export function shownFigures({ moneyIn, moneyOut, currency }: MonthTotals): { in: number; out: number; net: number } {
  const unit = currency || 'USD';
  const inflow = toMinorUnits(moneyIn, unit);
  const outflow = toMinorUnits(moneyOut, unit);
  return { in: inflow || 0, out: outflow || 0, net: toMinorUnits(inflow - outflow, unit) || 0 };
}

const LABELS = ['In', 'Out', 'Net'] as const;
const MONTH_FIGURES_TITLE = 'month-figures-title';

export default function MonthFigures({
  totals,
  title,
  caption = null,
  children,
}: {
  /** The sums, or null while they are on their way (placeholders). */
  totals: MonthTotals | null;
  /** What the strip is, said to a screen reader as its heading: "In and
   *  out, October 2026", or "In and out" while the month is still coming. */
  title: string;
  /** The span it sums, shown over the figures when it isn't the bar's month
   *  (a longer period on Spending); null to leave it to the heading. */
  caption?: string | null;
  /** What qualifies the figures, under them. */
  children?: ReactNode;
}) {
  const shown = totals ? shownFigures(totals) : null;
  const c = totals?.currency ?? null;
  const values: [string, string][] = shown
    ? [
        [' inflow', signedMoney(shown.in, c)],
        ['', signedMoney(-shown.out, c)],
        [shown.net < 0 ? ' negative' : shown.net > 0 ? ' inflow' : '', signedMoney(shown.net, c)],
      ]
    : [];
  return (
    <section className="month-figures" aria-labelledby={MONTH_FIGURES_TITLE} aria-hidden={shown ? undefined : true}>
      {/* Its heading: the span shown when it is more than the bar's month,
          else read alone (the bar names the month). */}
      {caption ? (
        <h2 id={MONTH_FIGURES_TITLE} className="month-figures-caption">
          <span className="visually-hidden">In and out, </span>
          {caption}
        </h2>
      ) : (
        <h2 id={MONTH_FIGURES_TITLE} className="visually-hidden">
          {title}
        </h2>
      )}
      <div className="summary-row">
        {LABELS.map((label, i) => (
          <div key={label}>
            <div className="total-label">{label}</div>
            {shown ? (
              <div className={`summary-value${values[i][0]}`}>
                <Masked>{values[i][1]}</Masked>
              </div>
            ) : (
              <div className="summary-value">
                <span className="skeleton activity-skeleton-figure" />
              </div>
            )}
          </div>
        ))}
      </div>
      {children}
    </section>
  );
}
