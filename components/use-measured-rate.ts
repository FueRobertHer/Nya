'use client';

// An account's own rate of return for its level in the Plan's Invested assets
// (components/PlanBuckets.tsx), loaded when the level opens: its balance
// history (app/api/account-history) and its investment activity, through the
// cache the Investments views share (components/InvestmentActivity.tsx), so a
// level opened after the account's sheet asks for nothing again. Counted by
// lib/fire/measured-rate.ts. Kept out of components/PlanTab.tsx, which fetches
// nothing itself (test/plan-savers.test.ts).

import { useEffect, useState } from 'react';
import { loadInvestmentActivity } from './InvestmentActivity';
import { measuredRate, type MeasuredRate } from '@/lib/fire/measured-rate';
import type { BalancePoint } from '@/lib/growth';

export type RateState = { kind: 'off' } | { kind: 'loading' } | MeasuredRate;

/**
 * The rate for `accountId`, or `off` when nothing is to be asked (`ask`
 * false). An account with no item has no investment activity, so none.
 */
export function useMeasuredRate(accountId: string, itemId: string | null, ask: boolean): RateState {
  const [state, setState] = useState<{ key: string; rate: RateState } | null>(null);
  const key = `${itemId ?? ''}:${accountId}`;
  useEffect(() => {
    if (!ask || !itemId) return;
    let cancelled = false;
    const history = fetch(`/api/account-history?id=${encodeURIComponent(accountId)}`).then((res) => {
      if (!res.ok) throw new Error(`account-history ${res.status}`);
      return res.json() as Promise<{ points?: BalancePoint[] }>;
    });
    Promise.all([history, loadInvestmentActivity(accountId, itemId)])
      .then(([h, activity]) => {
        // Vanguard's months are in dollars, and the Plan's rows don't carry an
        // account's own currency: null reads as US dollars.
        if (!cancelled) setState({ key, rate: measuredRate(h.points ?? [], activity, null) });
      })
      .catch(() => {
        if (!cancelled) setState({ key, rate: { kind: 'failed' } });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, itemId, ask, key]);
  if (!ask) return { kind: 'off' };
  if (!itemId) return { kind: 'none' };
  return state?.key === key ? state.rate : { kind: 'loading' };
}
