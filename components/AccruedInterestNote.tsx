'use client';

// The lines under the total on Home about student loans' accrued interest
// (lib/accrued-interest.ts): how much the total leaves out, which Plaid
// reports apart from the balances, and the loans whose interest isn't known
// on this load, why, and what to do when there is something, in amber as the
// total's other notes are. The total itself is the balances, as everywhere
// else, so nothing here moves it.

import { formatMoney } from '@/lib/format';
import { accruedLines, homeAccrued } from '@/lib/accrued-interest';
import { Masked } from './HideAmounts';

export default function AccruedInterestNote({
  institutions,
  currency,
}: {
  institutions: Parameters<typeof homeAccrued>[0];
  /** What the total is formatted in. */
  currency: string | null;
}) {
  const { leftOut, unread } = accruedLines(homeAccrued(institutions), (n) => formatMoney(n, currency));
  return (
    <>
      {leftOut && (
        <div className="as-of">
          <Masked>{leftOut}</Masked>
        </div>
      )}
      {unread.map((line) => (
        <div className="as-of stale" key={line}>
          <Masked>{line}</Masked>
        </div>
      ))}
    </>
  );
}
