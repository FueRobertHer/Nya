import { NextResponse } from 'next/server';
import { decrypt } from '@/lib/crypto';
import { getItems } from '@/lib/storage';
import { fetchInvestmentTxns, isContribution, valueDelta } from '@/lib/investments';
import { readAccountCache, writeAccountCache } from '@/lib/cache';

// Recent buys, sells, dividends and fees for one investment account, plus what
// the holder has put in this year.
//
// Takes item_id from the caller rather than resolving it from account_id. There
// is no reverse index: getItemAccountIds reads the transaction store, which an
// investments-only Item never writes to, and the disconnect route works around
// that by unioning with the net-worth cache -- which is empty whenever it has
// expired or any institution is erroring. The Accounts tab already renders each
// account inside its institution, so it just passes the id it has.

const LOOKBACK_DAYS = 365;
const RECENT_LIMIT = 25;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const account_id = params.get('id');
    const item_id = params.get('item_id');
    if (!account_id || !item_id) {
      return NextResponse.json({ error: 'Missing id or item_id' }, { status: 400 });
    }

    // Resolved before the cache read, not after: the cache is keyed on
    // account_id alone, so checking the item afterwards would make an unknown
    // item_id 404 on a cold cache and quietly succeed on a warm one. Costs one
    // Redis read on a cache hit and keeps the endpoint's behaviour the same
    // either way.
    const item = (await getItems()).find((i) => i.item_id === item_id);
    if (!item) return NextResponse.json({ error: 'Unknown item' }, { status: 404 });

    // Keyed on the pair, not account_id alone. Plaid doesn't document that
    // options.account_ids errors on an id belonging to a different Item (unlike
    // the holdings endpoint, which does), so a mismatched request that came back
    // 200-with-nothing could otherwise cache an empty result under the real
    // account's field and blank its activity for the whole TTL.
    const cacheField = `${item_id}:${account_id}`;
    const cached = await readAccountCache(cacheField);
    if (cached) return NextResponse.json({ ...cached, from_cache: true });

    const access_token = await decrypt(item.encrypted_access_token);
    const { txns, note } = await fetchInvestmentTxns(
      access_token,
      isoDaysAgo(LOOKBACK_DAYS),
      isoDaysAgo(0),
      [account_id]
    );

    // account_ids already filters Plaid-side, and a mismatched item_id/
    // account_id pair is rejected by Plaid rather than silently answered with
    // the wrong Item's data. This is belt-and-braces on top of that, so a
    // future change to the request options can't widen what comes back.
    const mine = txns.filter((t) => t.account_id === account_id);

    const yearStart = `${new Date().getUTCFullYear()}-01-01`;
    const ytd_contributions = mine
      .filter((t) => t.date >= yearStart && isContribution(t))
      .reduce((sum, t) => sum + valueDelta(t), 0);

    const payload = {
      txns: mine.slice(0, RECENT_LIMIT), // Plaid returns newest first
      ytd_contributions,
      note,
    };

    // Don't cache a warming-up product: it would pin "still importing" for 15
    // minutes past the point where real data became available.
    if (!note) await writeAccountCache(cacheField, payload);

    return NextResponse.json({ ...payload, from_cache: false });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to fetch investment activity' }, { status: 500 });
  }
}
