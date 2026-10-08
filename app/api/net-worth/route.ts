import { backupProblem, type BackupProblem } from '@/lib/backup';
import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { computeNetWorth, recordFetch, isRecordable, type InstitutionResult } from '@/lib/networth';
import { readCache, writeCache, clearNetWorthCache, CacheKey } from '@/lib/cache';
import {
  getHistory,
  withTodayPoint,
  isBackfillDone,
  type HistoryPoint,
} from '@/lib/history';
import { applyHidden } from '@/lib/hidden';
import { getEffectiveHidden, recordDirectory, type HiddenForClient } from '@/lib/links';
import { fillFromLastKnown, rememberAccounts } from '@/lib/last-known';
import { itemsWithNewAccounts } from '@/lib/new-accounts';
import { loggable } from '@/lib/log-safe';

type NetWorthPayload = {
  institutions: InstitutionResult[];
  netWorth: number;
  history: HistoryPoint[];
  // The stored hidden set, not just the accounts that resolved: an erroring
  // institution returns no accounts, so without this its hidden accounts would
  // vanish from the Hidden card with no way to unhide them. `hidden_at` is stored
  // but not shipped (nothing renders it).
  hidden: HiddenForClient[];
  as_of: string;
};

// Whether the estimated layer was built by an older algorithm and should be
// recomputed. The client can't work this out itself: its only other trigger is
// "the chart looks empty", which is false for exactly the users who already have
// a stale layer.
//
// Deliberately NOT part of NetWorthPayload, so it can't be frozen into the
// 15-minute cache: cached true would re-POST /api/backfill on every load for the
// TTL, and cached false would swallow a recompute clearBackfillDone() just asked
// for. The backups' state rides along for the same reason: a frozen notice would
// outlive a backup that just recovered (lib/backup.ts).
async function staleFlag(ctx: Ctx): Promise<{ backfill_stale: boolean; backup_problem: BackupProblem | null }> {
  const [done, backup_problem] = await Promise.all([isBackfillDone(ctx), backupProblem()]);
  return { backfill_stale: !done, backup_problem };
}

/**
 * Marks the institutions where Plaid has found accounts the user hasn't added
 * (lib/new-accounts.ts). Applied to the response, never stored in the cache, for
 * the reason staleFlag isn't: a load in flight when the webhook sets the flag
 * (or the picker clears it) would freeze the old answer for the cache's TTL.
 */
function withNewAccounts(institutions: InstitutionResult[], items: Set<string>): InstitutionResult[] {
  if (items.size === 0) return institutions;
  return institutions.map((inst) => (items.has(inst.item_id) ? { ...inst, new_accounts_available: true } : inst));
}

/**
 * Starts a promise now, to be awaited later, without risking an unhandled
 * rejection in between.
 *
 * The Redis reads below start alongside the Plaid fetch but are awaited in their
 * original order, which preserves every gate. If computeNetWorth() throws,
 * control jumps to the catch and they are never awaited, and an unhandled
 * rejection takes down the process on Node's default setting. The no-op catch
 * marks the rejection handled; awaiting the original promise still rejects
 * normally, so the error surfaces where it always did.
 */
function eager<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    // Live Plaid balance calls take seconds; serve the (encrypted) cached
    // payload when it's fresh. The Refresh button passes ?refresh=1 to force
    // a live fetch.
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';

    // Wanted on both paths and dependent on neither, so it runs alongside
    // whichever one we take rather than adding a round trip to the end of it.
    const stalePromise = eager(staleFlag(ctx));
    const newAccountsPromise = itemsWithNewAccounts(ctx); // never throws: a failed read is "none"

    if (!refresh) {
      const cached = await readCache<NetWorthPayload>(ctx, CacheKey.NetWorth);
      if (cached) {
        return NextResponse.json({
          ...cached,
          institutions: withNewAccounts(cached.institutions, await newAccountsPromise),
          ...(await stalePromise),
          from_cache: true,
        });
      }
    }

    // The two reads below touch only Redis and depend on nothing the Plaid fetch
    // produces, so they're started HERE and awaited further down, in the order
    // they always ran. That order is load-bearing: the snapshot is still recorded
    // before the hidden set is awaited, so a hidden-read failure can't cost
    // today's point (see recordFetch below). Only the waiting overlaps. On
    // Upstash each is an HTTPS round trip (getHistory is several), which used to
    // queue behind a multi-second Plaid fetch.
    // Hidden accounts follow account links (lib/links.ts): every id an account
    // has had is hidden with it, and the client sees one current id each.
    const hiddenPromise = eager(getEffectiveHidden(ctx, { describe: true }));
    const historyPromise = eager(hiddenPromise.then((h) => getHistory(ctx, h.hidden)));

    const { institutions, netWorth } = await computeNetWorth(ctx);

    // Record today's snapshot only when every institution answered cleanly and at
    // least one is linked: a partial fetch would chart an artificial dip, and zero
    // institutions isn't a $0 net worth.
    //
    // This happens BEFORE the hidden set is AWAITED, and records the TRUE total
    // and the FULL account map. Storage never depends on what's hidden, which
    // makes unhiding symmetric and means a hidden-set failure below can't cost
    // today's point. (What the guarantee rests on is the await, not the issue: a
    // rejection surfaces where it is awaited.)
    const clean = institutions.every(isRecordable);
    // The date the point landed on, or null. Taken from recordFetch rather than a
    // second clock read, so the point charted below is labelled with the day
    // actually written even if the request straddles UTC midnight. When it didn't
    // land, the accounts that did answer are still recorded for their own charts.
    // Their positions go into holdings history the same way (lib/holdings-history.ts).
    const { date: snapshotDate } = await recordFetch(ctx, institutions, netWorth);

    // Capture how to render each account while its institution is answering, so a
    // later failure can still draw its card. Per institution, not gated on
    // `clean`: one broken bank shouldn't stop the others' records staying fresh.
    await rememberAccounts(ctx, institutions);
    // And in the account directory, which outlives a disconnect so a re-added
    // institution's accounts can be matched to the ones they replace. Awaited
    // before responding so it overlaps the reads below. It never throws.
    const directoryWrite = recordDirectory(ctx, institutions);

    // Everything from here down is display-only. `visibleNetWorth` excludes hidden
    // accounts and is what ships as `netWorth`: the client never gets the true
    // total, so the Home hero, Accounts tab and localStorage snapshot can't
    // disagree.

    // An institution that failed shows its last good balances rather than $0.00,
    // so the total isn't silently short by a whole bank. Runs HERE, below the two
    // gates above and never above them: `clean` comes from the live fetch, so a
    // recovered balance can't be written to history or frozen into the cache. See
    // lib/last-known.ts.
    const stale = await fillFromLastKnown(ctx, institutions);
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
    // browser's localStorage. Nor has the raw holdings answer recorded above:
    // the payload carries the holdings already, in the shape the client reads.
    for (const inst of institutions) {
      delete inst.holdings_observed;
      for (const a of inst.accounts) delete a.persistent_account_id;
    }
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

    // Don't cache payloads containing errors: an institution that needs reauth
    // (or hit a transient failure) should be re-checked on the next load, not
    // frozen for the TTL.
    //
    // Not caching isn't enough: an entry written before the failure survives its
    // TTL, so loads would alternate between this payload (stale balances,
    // disclosed) and that one (15-minute-old balances, no disclosure), showing two
    // net worths and hiding the problem every other load. Drop it so the next
    // load also sees the failure.
    if (clean) {
      await writeCache(ctx, CacheKey.NetWorth, payload);
    } else {
      await clearNetWorthCache(ctx);
    }

    return NextResponse.json({
      ...payload,
      institutions: withNewAccounts(payload.institutions, await newAccountsPromise),
      ...(await stalePromise),
      from_cache: false,
    });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to fetch net worth' }, { status: 500 });
  }
}
