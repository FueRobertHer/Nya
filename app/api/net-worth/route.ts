import { NextResponse } from 'next/server';
import { computeNetWorth, recordFetch, isRecordable, type InstitutionResult } from '@/lib/networth';
import { readCache, writeCache, clearNetWorthCache, NET_WORTH_CACHE_KEY } from '@/lib/cache';
import {
  getHistory,
  withTodayPoint,
  isBackfillDone,
  type HistoryPoint,
} from '@/lib/history';
import { applyHidden } from '@/lib/hidden';
import { getEffectiveHidden, recordDirectory } from '@/lib/links';
import { fillFromLastKnown, rememberAccounts } from '@/lib/last-known';

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

/**
 * Starts a promise now, to be awaited later, without risking an unhandled
 * rejection in between.
 *
 * The Redis reads below are kicked off alongside the Plaid fetch but awaited in
 * the same order they used to run in, which is what preserves every gate. The
 * gap that opens up is the problem: if computeNetWorth() throws, control jumps
 * to the catch and these are never awaited, and an unhandled rejection takes
 * down the process on Node's default setting. The no-op catch marks the
 * rejection handled; awaiting the original promise still rejects normally, so
 * the error surfaces exactly where it did before.
 */
function eager<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

export async function GET(req: Request) {
  try {
    // Live Plaid balance calls take seconds; serve the (encrypted) cached
    // payload when it's fresh. The Refresh button passes ?refresh=1 to force
    // a live fetch.
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';

    // Wanted on both paths and dependent on neither, so it runs alongside
    // whichever one we take rather than adding a round trip to the end of it.
    const stalePromise = eager(staleFlag());

    if (!refresh) {
      const cached = await readCache<NetWorthPayload>(NET_WORTH_CACHE_KEY);
      if (cached) {
        return NextResponse.json({ ...cached, ...(await stalePromise), from_cache: true });
      }
    }

    // The two reads below touch only Redis and depend on nothing the Plaid
    // fetch produces, so they're started HERE and awaited further down, in the
    // exact order they used to RUN in. That ordering is load-bearing, not
    // stylistic: the snapshot is still recorded before the hidden set is
    // awaited, so a hidden-read failure still cannot cost today's point (see
    // the comment on recordFetch below). Only the waiting overlaps.
    //
    // On Upstash each of these is an HTTPS round trip (getHistory is several),
    // and they used to queue up behind a multi-second Plaid fetch that was
    // sitting idle on the network the whole time.
    // Hidden accounts follow account links (lib/links.ts): every id an account
    // has had is hidden with it, and the client sees one current id each.
    const hiddenPromise = eager(getEffectiveHidden());
    const historyPromise = eager(hiddenPromise.then((h) => getHistory(h.hidden)));

    const { institutions, netWorth } = await computeNetWorth();

    // Record today's snapshot only when every institution answered cleanly
    // and at least one is linked -- a partial fetch would chart an
    // artificial dip, and zero institutions isn't a $0 net worth.
    //
    // This happens BEFORE the hidden set is AWAITED, and records the TRUE total
    // and the FULL account map. Storage never depends on what's hidden, which
    // is what makes unhiding perfectly symmetric and means a hidden-set failure
    // below can't cost today's point. (The read is now issued earlier, above --
    // awaited, not issued, is what the guarantee rests on, because a rejection
    // surfaces where it is awaited.)
    const clean = institutions.every(isRecordable);
    // The date the point landed on, or null if it didn't. Taken from
    // recordFetch rather than read from the clock again, so the point this
    // route charts below is labelled with the day that was actually written
    // even if the request straddles UTC midnight. When it didn't land, the
    // accounts that did answer are still recorded for their own charts.
    const snapshotDate = await recordFetch(institutions, netWorth);

    // Capture how to render each account while its institution is answering, so
    // a later failure can still draw its card. Per institution, not gated on
    // `clean`: one broken bank shouldn't stop the others' records staying
    // fresh. Writes only, so the broken one's record survives.
    await rememberAccounts(institutions);
    // And in the account directory, which outlives a disconnect so a re-added
    // institution's accounts can be matched to the ones they replace. Started
    // here and awaited before responding, so it overlaps the reads below
    // instead of adding a round trip to every live load. It never throws.
    const directoryWrite = recordDirectory(institutions);

    // Everything from here down is display-only. `visibleNetWorth` excludes
    // hidden accounts and is what ships as `netWorth` -- the client is never
    // sent the true total, so the Home hero, the Accounts tab and the
    // localStorage snapshot can't disagree with each other.

    // An institution that failed shows its last good balances rather than
    // $0.00, so the total isn't silently short by an entire bank. It runs HERE,
    // below the two gates above, and never above them: `clean` is computed from
    // the live fetch, so a recovered balance can't be mistaken for a measured
    // one and written to history or frozen into the cache. See lib/last-known.ts.
    const stale = await fillFromLastKnown(institutions);
    if (stale.length > 0) {
      // Counts and a date, not ids. Item and account ids are encrypted at rest
      // everywhere else in this codebase, so writing them to a log would be the
      // one place they sit in plaintext.
      console.warn(
        `net-worth: showing last-known balances for ${stale.length} institution(s), as of ${stale[0].as_of}`
      );
    }

    const { hidden, forClient: hiddenList } = await hiddenPromise;
    await directoryWrite;
    // Plaid's cross-Item account identity is for matching on the server only
    // (lib/links.ts); it has no business in the payload, the cache or the
    // browser's localStorage.
    for (const inst of institutions) for (const a of inst.accounts) delete a.persistent_account_id;
    const visibleNetWorth = applyHidden(institutions, hidden);
    // Started before the fetch, so it predates this request's snapshot: today's
    // point comes from the live figures instead. See withTodayPoint.
    const stored = await historyPromise;
    const history = snapshotDate
      ? withTodayPoint(stored, snapshotDate, visibleNetWorth)
      : stored;

    const payload: NetWorthPayload = {
      institutions,
      netWorth: visibleNetWorth,
      history,
      hidden: hiddenList,
      as_of: new Date().toISOString(),
    };

    // Don't cache payloads containing errors: an institution that needs
    // reauth (or hit a transient Plaid failure) should be re-checked on the
    // next load, not frozen for the TTL.
    //
    // Not caching isn't enough on its own -- an entry written before the
    // failure survives its full TTL, so loads would alternate between this
    // payload (stale balances, disclosed) and that one (15-minute-old live
    // balances, no disclosure at all), showing two different net worths and
    // hiding the problem on every other load. Drop it so the next load also
    // sees the failure.
    if (clean) {
      await writeCache(NET_WORTH_CACHE_KEY, payload);
    } else {
      await clearNetWorthCache();
    }

    return NextResponse.json({ ...payload, ...(await stalePromise), from_cache: false });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to fetch net worth' }, { status: 500 });
  }
}
