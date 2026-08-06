import { NextResponse } from 'next/server';
import { computeNetWorth, accountBalanceMap, type InstitutionResult } from '@/lib/networth';
import { readCache, writeCache, NET_WORTH_CACHE_KEY } from '@/lib/cache';
import { recordSnapshot, getHistory, isBackfillDone, type HistoryPoint } from '@/lib/history';
import { getHiddenAccounts, applyHidden } from '@/lib/hidden';

type NetWorthPayload = {
  institutions: InstitutionResult[];
  netWorth: number;
  history: HistoryPoint[];
  // The stored hidden set, not just the accounts that resolved. An
  // institution that's erroring returns no accounts, so without this its
  // hidden accounts would vanish from the Hidden card and there'd be no way
  // to unhide them. `hidden_at` is stored but not shipped -- nothing renders it.
  hidden: { account_id: string; type: string }[];
  as_of: string;
};

// Whether the estimated layer was built by an older algorithm and should be
// recomputed. The client can't work this out for itself: its only other trigger
// is "the chart looks empty", which is false for exactly the users who already
// have a stale layer.
//
// Deliberately NOT part of NetWorthPayload, so it can't be frozen into the
// 15-minute cache. Cached true would re-POST /api/backfill on every load for
// the rest of the TTL; cached false would swallow a recompute that a
// clearBackfillDone() elsewhere had just asked for.
async function staleFlag(): Promise<{ backfill_stale: boolean }> {
  return { backfill_stale: !(await isBackfillDone()) };
}

export async function GET(req: Request) {
  try {
    // Live Plaid balance calls take seconds; serve the (encrypted) cached
    // payload when it's fresh. The Refresh button passes ?refresh=1 to force
    // a live fetch.
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    if (!refresh) {
      const cached = await readCache<NetWorthPayload>(NET_WORTH_CACHE_KEY);
      if (cached) {
        return NextResponse.json({ ...cached, ...(await staleFlag()), from_cache: true });
      }
    }

    const { institutions, netWorth } = await computeNetWorth();
    const balances = accountBalanceMap(institutions);

    // Record today's snapshot only when every institution answered cleanly
    // and at least one is linked -- a partial fetch would chart an
    // artificial dip, and zero institutions isn't a $0 net worth.
    //
    // This happens BEFORE the hidden set is read, and records the TRUE total
    // and the FULL account map. Storage never depends on what's hidden, which
    // is what makes unhiding perfectly symmetric and means a hidden-set failure
    // below can't cost today's point.
    const clean = institutions.every((i) => !i.error);
    if (clean && institutions.length > 0) {
      await recordSnapshot(netWorth, balances);
    }

    // Everything from here down is display-only. `visibleNetWorth` excludes
    // hidden accounts and is what ships as `netWorth` -- the client is never
    // sent the true total, so the Home hero, the Accounts tab and the
    // localStorage snapshot can't disagree with each other.
    const hidden = await getHiddenAccounts();
    const visibleNetWorth = applyHidden(institutions, hidden);
    const history = await getHistory(hidden);

    const payload: NetWorthPayload = {
      institutions,
      netWorth: visibleNetWorth,
      history,
      hidden: [...hidden.entries()].map(([account_id, { type }]) => ({ account_id, type })),
      as_of: new Date().toISOString(),
    };

    // Don't cache payloads containing errors: an institution that needs
    // reauth (or hit a transient Plaid failure) should be re-checked on the
    // next load, not frozen for the TTL.
    if (clean) {
      await writeCache(NET_WORTH_CACHE_KEY, payload);
    }

    return NextResponse.json({ ...payload, ...(await staleFlag()), from_cache: false });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to fetch net worth' }, { status: 500 });
  }
}
