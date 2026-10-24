'use client';

// The lines under the total on Home about student loans' accrued interest
// (lib/accrued-interest.ts): how much the total leaves out, which Plaid
// reports apart from the balances, and the loans whose interest isn't known
// on this load, why, and what to do when there is something. Caveats on the
// total (components/TotalCaveats.tsx): what it leaves out is neutral, as it
// always was; what couldn't be read is amber. The total itself is the
// balances, as everywhere else, so nothing here moves it. The interest is
// said in the loans' own currency, or, with a home currency chosen, in it, as
// the total is. Built while rendering, so hide amounts masks it at once.

import { formatMoney } from '@/lib/format';
import { accruedAmountsText, accruedLines, homeAccrued } from '@/lib/accrued-interest';
import type { PageFx } from '@/lib/fx/view';
import { Masked } from './HideAmounts';
import type { Caveat } from './TotalCaveats';

export function accruedCaveats(
  institutions: Parameters<typeof homeAccrued>[0],
  /** The currency of a loan whose account says none: the accounts' main one. */
  main: string | null,
  /** With a home currency chosen, what the page converts with (NetWorthBase.fx). */
  fx: PageFx | null = null
): Caveat[] {
  const { leftOut, unread } = accruedLines(homeAccrued(institutions), (amounts) => accruedAmountsText(amounts, fx, main, (n, c) => formatMoney(n, c)));
  const out: Caveat[] = [];
  if (leftOut) out.push({ key: 'accrued', severity: 'info', summary: 'accrued interest left out', body: <Masked>{leftOut}</Masked> });
  for (const line of unread) out.push({ key: `accrued-unread:${line}`, severity: 'caution', summary: 'accrued interest not known', body: <Masked>{line}</Masked> });
  return out;
}
