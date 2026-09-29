import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import {
  contributedAmount,
  countedTrades,
  dailyFlows,
  isContribution,
  isIncomingRollover,
} from '@/lib/investments';
import { syncInvestments } from '@/lib/invstore';
import { readAccountCache, writeAccountCache } from '@/lib/cache';

// Recent buys, sells, dividends and fees for one investment account, plus what
// the holder has put in this year and the per-day flows behind the chart's
// money-added line.
//
// Reads the Item's stored investment transactions (lib/invstore.ts), bringing
// them up to date first, so the list and the line reach past Plaid's window and
// keep showing what was stored when the institution is down.
//
// Takes item_id from the caller rather than resolving it from account_id: there
// is no reverse index (getItemAccountIds reads the transaction store, which an
// investments-only Item never writes, and the disconnect route's workaround
// unions with the net-worth cache, empty whenever it has expired or any
// institution is erroring). The Accounts tab renders each account inside its
// institution, so it passes the id it has.

const RECENT_LIMIT = 25;

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
    const cached = await readAccountCache(ctx, cacheField);
    if (cached) return NextResponse.json({ ...cached, from_cache: true });

    const sync = await syncInvestments(ctx, item);
    // Newest first, explicitly: the store has no order of its own.
    const mine = sync.rows
      .filter((t) => t.account_id === account_id)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // Decided over every row the account has, the same set the backfill hands
    // the walk, so the two can't disagree about a paycheck (see countedTrades).
    const counted = countedTrades(mine);
    const yearStart = `${new Date().getUTCFullYear()}-01-01`;
    const thisYear = mine.filter((t) => t.date >= yearStart);
    const sum = (rows: typeof thisYear) =>
      rows.reduce((total, t) => total + contributedAmount(t, counted), 0);

    // Reported as two figures: a rollover is retirement money that already existed
    // moving between accounts, so folding it into contributions makes a $60k 401k
    // transfer read as a year of saving, while dropping it would leave a large
    // arrival in the activity list that no line accounts for.
    const ytd_contributions = sum(thisYear.filter((t) => isContribution(t, counted)));
    const ytd_rollovers = sum(thisYear.filter((t) => isIncomingRollover(t, counted)));

    // The money-added line, only across dates the store has VERIFIED for this
    // account, ending where they end: a contribution after `through` isn't known
    // yet (an outage, or an unverified last sync), so drawing past it would book it
    // as growth.
    //
    // It starts at the later of the verified start and the account's oldest row:
    // an institution can keep less history than was asked for, and every
    // contribution before its oldest row would read as growth. No rows at all
    // proves nothing about how far the feed reaches, so no line.
    const cov = sync.coverage[account_id];
    const oldest = mine.length ? mine[mine.length - 1].date : null;
    const flowsKnown = !!cov && !!oldest;
    const flows = flowsKnown
      ? dailyFlows(
          mine.filter((t) => t.date >= cov!.from && t.date <= cov!.through),
          counted
        )
      : null;
    const flows_from = flowsKnown ? (oldest! > cov!.from ? oldest! : cov!.from) : null;
    const flows_to = flowsKnown ? cov!.through : null;

    // Said in full here so the client can print it as is. A fetch failure
    // serves what is stored (and says so only if there is any); a storage
    // problem serves what was just fetched. Both can happen at once.
    const fetchNote = sync.note ? (mine.length ? `${sync.note}; showing saved activity` : sync.note) : null;
    // Another sync is mid-way through the first download: nothing is saved yet,
    // and "no activity" would be wrong.
    const loadingNote = sync.busy && mine.length === 0 ? 'Investment activity is still loading' : null;
    const note = [fetchNote, loadingNote, sync.storeNote].filter(Boolean).join('. ') || null;
    const payload = {
      txns: mine.slice(0, RECENT_LIMIT),
      ytd_contributions,
      ytd_rollovers,
      flows,
      flows_from,
      flows_to,
      note,
    };

    // Not cached after a Plaid failure (re-check next load), nor while another
    // sync held the store (that answer is whatever was stored, which on a first
    // link is nothing). A storage-only problem IS cached: the rows were just
    // fetched live, and otherwise an unwritable store would re-run the full fetch
    // every load.
    if (!sync.note && !sync.busy) await writeAccountCache(ctx, cacheField, payload);

    return NextResponse.json({ ...payload, from_cache: false });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to fetch investment activity' }, { status: 500 });
  }
}
