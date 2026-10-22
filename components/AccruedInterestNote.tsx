'use client';

// The lines under the total on Home about student loans' accrued interest
// (lib/accrued-interest.ts): how much the total leaves out, which Plaid
// reports apart from the balances, and the loans whose interest isn't known
// on this load, why, and what to do when there is something, in amber as the
// total's other notes are. The total itself is the balances, as everywhere
// else, so nothing here moves it. The interest is said in the loans' own
// currency, or, with a home currency chosen, in it, as the total is.

import { formatMoney } from '@/lib/format';
import { accruedAmountsText, accruedLines, homeAccrued } from '@/lib/accrued-interest';
import type { PageFx } from '@/lib/fx/view';
import { Masked } from './HideAmounts';

export default function AccruedInterestNote({
  institutions,
  main,
  fx = null,
}: {
  institutions: Parameters<typeof homeAccrued>[0];
  /** The currency of a loan whose account says none: the accounts' main one. */
  main: string | null;
  /** With a home currency chosen, what the page converts with (NetWorthBase.fx). */
  fx?: PageFx | null;
}) {
  const { leftOut, unread } = accruedLines(homeAccrued(institutions), (amounts) => accruedAmountsText(amounts, fx, main, (n, c) => formatMoney(n, c)));
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
