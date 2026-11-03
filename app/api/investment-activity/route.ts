import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import { activityFromSync, cacheable, hasPlanFields } from '@/lib/investment-activity';
import { syncInvestments } from '@/lib/invstore';
import { readAccountCache, writeAccountCache } from '@/lib/cache';
import { loggable } from '@/lib/log-safe';

// Recent buys, sells, dividends and fees for one investment account, plus what
// the holder has put in this year and the per-day flows behind the chart's
// money-added line.
//
// Reads the Item's stored investment transactions (lib/invstore.ts), bringing
// them up to date first, so the list and the line reach past Plaid's window and
// keep showing what was stored when the institution is down.
//
// Takes item_id from the caller rather than resolving it from account_id: there
// is no reverse index (an Item's transaction store lists its accounts, but an
// investments-only Item never writes one). The Accounts tab renders each
// account inside its institution, so it passes the id it has.
//
// What it answers is worked out in lib/investment-activity.ts, which the
// Plan's inputs (app/api/plan-inputs) share.

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const params = new URL(req.url).searchParams;
    const account_id = params.get('id');
    const item_id = params.get('item_id');
    if (!account_id || !item_id) {
      return NextResponse.json({ error: 'Missing id or item_id' }, { status: 400 });
    }

    // Resolved before the cache read: the cache is keyed on account_id alone, so
    // checking the item afterwards would 404 an unknown item_id on a cold cache
    // and quietly succeed on a warm one. Costs one Redis read on a hit.
    const item = (await getItems(ctx)).find((i) => i.item_id === item_id);
    if (!item) return NextResponse.json({ error: 'Unknown item' }, { status: 404 });

    // Keyed on the pair, not account_id alone, so a mismatched item_id can't cache
    // an empty answer under the real account's field. (The cache key carries a
    // version, so payloads with an older meaning are not reachable.)
    const cacheField = `${item_id}:${account_id}`;
    const cached = await readAccountCache<Record<string, unknown>>(ctx, cacheField);
    if (cached && hasPlanFields(cached)) return NextResponse.json({ ...cached, from_cache: true });

    const sync = await syncInvestments(ctx, item);
    const payload = activityFromSync(sync, account_id);
    if (cacheable(sync)) await writeAccountCache(ctx, cacheField, payload);

    return NextResponse.json({ ...payload, from_cache: false });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to fetch investment activity' }, { status: 500 });
  }
}
