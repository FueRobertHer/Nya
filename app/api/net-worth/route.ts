import { backupProblem, type BackupProblem } from '@/lib/backup';
import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { computeNetWorth, recordFetch, isRecordable, type InstitutionResult } from '@/lib/networth';
import { readCache, writeCache, clearNetWorthCache, CacheKey } from '@/lib/cache';
import {
  getHistoryWithBreaks,
  withTodayPoint,
  isBackfillDone,
  type HistoryPoint,
} from '@/lib/history';
import { signedContribution } from '@/lib/balance';
import { applyHidden } from '@/lib/hidden';
import { getEffectiveHidden, recordDirectory, type HiddenForClient } from '@/lib/links';
import { fillFromLastKnown, rememberAccounts } from '@/lib/last-known';
import { itemsWithNewAccounts } from '@/lib/new-accounts';
import { readHealthForDisplay, recordSyncs, withHealth, type HealthReads } from '@/lib/connection-health';
import { loggable } from '@/lib/log-safe';
import { readDrawState } from '@/lib/history-import/extend';
import { importedHistoryView, type ImportedHistoryView } from '@/lib/history-import/view';
import { getEffectiveLifecycle, lifecycleForClient, applyLifecycle, isLifecycleUnreadable, shortDays, type LifecycleForClient } from '@/lib/lifecycle';
import { holdMissingAccounts, askAboutZeroBalances, askAboutReportedEnds } from '@/lib/lifecycle-questions';
import { storeFailure } from '@/lib/store-failure';

type NetWorthPayload = {
  institutions: InstitutionResult[];
  netWorth: number;
  history: HistoryPoint[];
  // The stored hidden set, not just the accounts that resolved: an erroring
  // institution returns no accounts, so without this its hidden accounts would
  // vanish from the Hidden card with no way to unhide them. `hidden_at` is stored
  // but not shipped (nothing renders it).
  hidden: HiddenForClient[];
  // The accounts that ended (lib/lifecycle.ts): closed, left or untracked,
  // one per account, for the Accounts tab's own section. Like `hidden`, the
  // stored set, so one whose institution is gone is still listed.
  lifecycle: LifecycleForClient[];
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
//
// The estimated history drawn back through imported transactions (#52) rides
// along the same way: whether it is marked to draw again (one more reason to
// ask /api/backfill), and what it covers, for the chart to say which stretch
// comes from imported rows and what it couldn't draw (imported_history),
// never naming a hidden account (any id it has had), which the chart leaves
// out: when the hidden set can't be read, the note says nothing.
async function staleFlag(
  ctx: Ctx
): Promise<{ backfill_stale: boolean; backup_problem: BackupProblem | null; imported_history?: ImportedHistoryView }> {
  const [done, backup_problem, drawn] = await Promise.all([isBackfillDone(ctx), backupProblem(), readDrawState(ctx)]);
  const hidden = drawn
    ? await getEffectiveHidden(ctx, { readOnly: true }).then(
        (h) => new Set(h.hidden.keys()),
        () => null
      )
    : new Set<string>();
  const view = hidden ? importedHistoryView(drawn, hidden) : null;
  return { backfill_stale: !done || (!!drawn && drawn.built !== drawn.generation), backup_problem, ...(view ? { imported_history: view } : {}) };
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
 * Each connection's health (lib/connection-health.ts), applied to the response
 * and never stored in the cache, for the same reason as new_accounts_available:
 * Plaid's warning arrives by webhook, and a load in flight when it lands would
 * freeze the old answer for the cache's TTL. `health_unavailable` says the
 * warnings and sync times could not be read, so the view doesn't present an
 * unknown as healthy.
 */
function healthFields(institutions: InstitutionResult[], reads: HealthReads | null, answeredAt: string) {
  return {
    institutions: withHealth(institutions, reads, answeredAt),
    ...(reads === null ? { health_unavailable: true } : {}),
  };
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
    const healthPromise = readHealthForDisplay(ctx); // never throws: a failed read is null, and said

    if (!refresh) {
      const cached = await readCache<NetWorthPayload>(ctx, CacheKey.NetWorth);
      if (cached) {
        return NextResponse.json({
          ...cached,
          // A cached payload holds only institutions that answered, when it was made.
          ...healthFields(withNewAccounts(cached.institutions, await newAccountsPromise), await healthPromise, cached.as_of),
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
    // Which accounts ended (lib/lifecycle.ts), through the same links, read
    // strictly: an entry that can't be read fails this load (409, below)
    // rather than count an account the person closed. Awaited below the
    // snapshot like the hidden set, so it can't cost today's point.
    const readLifecycle = () => eager(hiddenPromise.then((h) => getEffectiveLifecycle(ctx, h.links)));
    let lifecyclePromise = readLifecycle();
    // The days known short of an account that came back after an assumed
    // closure are left out (lib/lifecycle.ts shortDays).
    const readHistory = () =>
      eager(Promise.all([hiddenPromise, lifecyclePromise]).then(([h, l]) => getHistoryWithBreaks(ctx, h.hidden, l.ended, shortDays(l, h.hidden))));
    let historyPromise = readHistory();

    const { institutions, netWorth, lifecycleChanged } = await computeNetWorth(ctx);
    // The fetch recorded or lifted an assumed closure (lib/vanished.ts): what
    // was read before it is out of date.
    if (lifecycleChanged) {
      lifecyclePromise = readLifecycle();
      historyPromise = readHistory();
    }
    // When the institutions that answered did: their last good sync.
    const answeredAt = new Date().toISOString();

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
    // And when each connection last answered, for the connection health view
    // and the daily notices (lib/connection-health.ts). It never throws.
    const syncWrite = recordSyncs(ctx, institutions, Date.parse(answeredAt));

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

    const { hidden, forClient: hiddenList, links } = await hiddenPromise;
    const lifecycle = await lifecyclePromise;
    await directoryWrite;
    await syncWrite;

    // An account missing from a healthy answer is HELD at its last known
    // balance, with its question, and a zero for weeks is asked about
    // (lib/lifecycle-questions.ts). Display only, below the gates and after
    // the accounts were remembered: a held row is never recorded.
    await holdMissingAccounts(ctx, institutions, lifecycle, links ?? new Map());
    await askAboutZeroBalances(ctx, institutions, lifecycle, links ?? new Map(), hidden);
    // And one that ended but whose bank still returns it moving is asked
    // about again, from a copy of its row (`ended_reported`).
    await askAboutReportedEnds(ctx, institutions, lifecycle, links ?? new Map(), hidden);
    // And an account that ended leaves the live accounts (and with them every
    // total) for the Accounts tab's own section, unless it is hidden too: the
    // Hidden card lists it, and every total leaves it out already.
    const endedRows = applyLifecycle(institutions, lifecycle, hidden);
    // Plaid's cross-Item account identity is for matching on the server only
    // (lib/links.ts); it has no business in the payload, the cache or the
    // browser's localStorage. Nor has the raw holdings answer recorded above:
    // the payload carries the holdings already, in the shape the client reads.
    for (const inst of institutions) {
      delete inst.holdings_observed;
      delete inst.missing_ids;
      for (const a of inst.accounts) delete a.persistent_account_id;
    }
    const visibleNetWorth = applyHidden(institutions, hidden);
    // Started before the fetch, so it predates this request's snapshot: today's
    // point comes from the live figures instead. See withTodayPoint.
    const stored = await historyPromise;
    // An end on the person's today can be the UTC day after (lib/lifecycle.ts
    // lastEndDay): it leaves the live total at once, but today's point is the
    // UTC day, before that end, where the account still counts, as the day
    // reads once recorded.
    const notYet = snapshotDate
      ? endedRows.filter((r) => r.end > snapshotDate && r.type !== null).reduce((n, r) => n + signedContribution(r.type!, r.balance ?? 0), 0)
      : 0;
    const history = snapshotDate ? withTodayPoint(stored.points, snapshotDate, visibleNetWorth + notYet, stored.breaks) : stored.points;

    const payload: NetWorthPayload = {
      institutions,
      netWorth: visibleNetWorth,
      history,
      hidden: hiddenList,
      lifecycle: lifecycleForClient(lifecycle),
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
      ...healthFields(withNewAccounts(payload.institutions, await newAccountsPromise), await healthPromise, answeredAt),
      ...(await stalePromise),
      from_cache: false,
    });
  } catch (err: any) {
    // No container: 503. Account closures that can't be read: 409, flagged,
    // with the ids (lib/store-failure.ts), never a total that counts an
    // account the person closed; `repair` tells the Accounts tab it may offer
    // to remove the damaged ones (app/api/account-lifecycle). Anything else: 500.
    return storeFailure(err, 'Failed to fetch net worth', isLifecycleUnreadable(err) ? { repair: 'account-lifecycle' } : undefined);
  }
}
