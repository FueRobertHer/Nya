import { NextResponse } from 'next/server';
import { computeNetWorth, accountBalanceMap, type InstitutionResult } from '@/lib/networth';
import { readCache, writeCache, NET_WORTH_CACHE_KEY } from '@/lib/cache';
import { recordSnapshot, getHistory, type HistoryPoint } from '@/lib/history';

type NetWorthPayload = {
  institutions: InstitutionResult[];
  netWorth: number;
  history: HistoryPoint[];
  as_of: string;
};

export async function GET(req: Request) {
  try {
    // Live Plaid balance calls take seconds; serve the (encrypted) cached
    // payload when it's fresh. The Refresh button passes ?refresh=1 to force
    // a live fetch.
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    if (!refresh) {
      const cached = await readCache<NetWorthPayload>(NET_WORTH_CACHE_KEY);
      if (cached) return NextResponse.json({ ...cached, from_cache: true });
    }

    const { institutions, netWorth } = await computeNetWorth();

    // Record today's snapshot only when every institution answered cleanly
    // and at least one is linked -- a partial fetch would chart an
    // artificial dip, and zero institutions isn't a $0 net worth.
    const clean = institutions.every((i) => !i.error);
    if (clean && institutions.length > 0) {
      await recordSnapshot(netWorth, accountBalanceMap(institutions));
    }
    const history = await getHistory();

    const payload: NetWorthPayload = {
      institutions,
      netWorth,
      history,
      as_of: new Date().toISOString(),
    };

    // Don't cache payloads containing errors: an institution that needs
    // reauth (or hit a transient Plaid failure) should be re-checked on the
    // next load, not frozen for the TTL.
    if (clean) {
      await writeCache(NET_WORTH_CACHE_KEY, payload);
    }

    return NextResponse.json({ ...payload, from_cache: false });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to fetch net worth' }, { status: 500 });
  }
}
