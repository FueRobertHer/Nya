import { attachmentSweepProblem, backupNotice, type AttachmentSweepProblem, type BackupProblem } from '@/lib/backup';
import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { computeNetWorth, recordFetch, isRecordable, type InstitutionResult } from '@/lib/networth';
import { holdsTotals, type TotalsHold } from '@/lib/user-restore/restored';
import { readCache, writeCache, clearNetWorthCache, CacheKey } from '@/lib/cache';
import {
  getHistoryWithSplit,
  readHistoryLayers,
  withTodayPoint,
  isBackfillDone,
  type ForeignAccounts,
  type HistoryPoint,
} from '@/lib/history';
import { signedContribution } from '@/lib/balance';
import { applyHidden } from '@/lib/hidden';
import { directoryCurrencies, getEffectiveHidden, linkOfferForDisplay, recordDirectory, type HiddenForClient } from '@/lib/links';
import { fillFromLastKnown, rememberAccounts } from '@/lib/last-known';
import { itemsWithNewAccounts } from '@/lib/new-accounts';
import { readHealthForDisplay, recordSyncs, withHealth, type HealthReads } from '@/lib/connection-health';
import { loggable } from '@/lib/log-safe';
import { readDrawState } from '@/lib/history-import/extend';
import { importedHistoryView, type ImportedHistoryView } from '@/lib/history-import/view';
import { getEffectiveLifecycle, lifecycleForClient, applyLifecycle, isLifecycleUnreadable, shortDays, type LifecycleForClient } from '@/lib/lifecycle';
import { holdMissingAccounts, askAboutZeroBalances, askAboutReportedEnds } from '@/lib/lifecycle-questions';
import { storeFailure } from '@/lib/store-failure';
import { readSettingsForDisplay } from '@/lib/fx/settings';
import type { HistorySplit, NetWorthBase } from '@/lib/fx/net-worth-base';
import { foreignFor, historySplit, lifecycleAccounts, listedAccounts, mainCurrency, readNetWorthBase, visibleRows } from '@/lib/fx/net-worth-read';

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
  // With a home currency (lib/fx/settings.ts): the chart's points split by
  // currency, unconverted, so a cached load converts them as a fresh one does
  // (lib/fx/net-worth-base.ts). Server only: never sent, never converted here.
  history_split?: HistorySplit;
  /** Why no total is recorded while a restore holds it (lib/user-restore/
   *  restored.ts totalsHold), said under the Home total: absent otherwise. */
  restore_hold?: TotalsHold;
};

/** The answer's figures in the home currency, when one is chosen, worked out
 *  after the cache on every answer (`base`), and why there are none when the
 *  settings can't be read (`currency_problem`). Additive: `netWorth` and
 *  `history` keep what they always meant, so a page from the release before,
 *  or this one's own snapshot in the browser, never shows a converted figure
 *  under another currency's label. */
async function baseFields(
  ctx: Ctx,
  institutions: InstitutionResult[],
  split: HistorySplit | undefined,
  known: Awaited<ReturnType<typeof readSettingsForDisplay>>
): Promise<{ base?: NetWorthBase; currency_problem?: string }> {
  if (known.problem) return { currency_problem: known.problem };
  if (!known.settings.home || !split) return {};
  const { base } = await readNetWorthBase(ctx, { institutions, split, now: Date.now(), known });
  return base ? { base } : {};
}

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
// out, nor what of an account that ended was drawn from its end day on: when
// the hidden set can't be read, the note says nothing.
async function staleFlag(
  ctx: Ctx
): Promise<{ backfill_stale: boolean; backup_problem: BackupProblem | null; attachments_problem: AttachmentSweepProblem | null; imported_history?: ImportedHistoryView }> {
  // The nightly clean-up of receipts and documents says so too, the same way
  // (lib/attachment-sweep.ts): a notice, never a reason to fail the load.
  // A backups record missing altogether is said too (backupNotice), and the
  // sweep pauses then, which it says.
  const [done, backup_problem, drawn, attachments_problem] = await Promise.all([isBackfillDone(ctx), backupNotice(), readDrawState(ctx), attachmentSweepProblem()]);
  // The accounts that ended too (lib/lifecycle.ts), which the chart leaves
  // out from their end day: an end that can't be read fails the load itself,
  // so here it only says nothing more.
  const seen = drawn
    ? await getEffectiveHidden(ctx, { readOnly: true }).then(
        async (h) => ({
          hidden: new Set(h.hidden.keys()),
          ended: await getEffectiveLifecycle(ctx, h.links).then(
            (l) => l.ended,
            () => new Map<string, { from: string }>()
          ),
        }),
        () => null
      )
    : { hidden: new Set<string>(), ended: new Map<string, { from: string }>() };
  const view = seen ? importedHistoryView(drawn, seen.hidden, seen.ended) : null;
  return { backfill_stale: !done || (!!drawn && drawn.built !== drawn.generation), backup_problem, attachments_problem, ...(view ? { imported_history: view } : {}) };
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
 * The reconnected accounts Settings > Connections suggests linking, by name,
 * for Home's row about them (lib/links.ts linkOfferForDisplay). Applied to the
 * response and never stored in the cache, for the reason health isn't: a link
 * or a decline would stay offered for the cache's TTL. Absent when there are
 * none.
 */
function linkOfferField(names: string[]) {
  return names.length > 0 ? { link_offer: names } : {};
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
    // Whether the person chose a home currency (lib/fx/settings.ts): only then
    // is anything converted, or anything more read. Lenient, for display.
    const settingsPromise = eager(readSettingsForDisplay(ctx));

    if (!refresh) {
      const [cached, known] = await Promise.all([readCache<NetWorthPayload>(ctx, CacheKey.NetWorth), settingsPromise]);
      // A payload cached before a home currency was chosen has no split to
      // convert the chart from: load afresh once, which caches one.
      if (cached && (!known.settings.home || cached.history_split)) {
        const { history_split, ...shown } = cached;
        // Never throws: a failed read is none. A live load reads it below,
        // once a reconnected account is in the directory.
        const linkOfferPromise = linkOfferForDisplay(ctx);
        // Begun now, beside the others, rather than once the stale flag (a
        // few round trips) is in.
        const basePromise = eager(baseFields(ctx, cached.institutions, history_split, known));
        return NextResponse.json({
          ...shown,
          // A cached payload holds only institutions that answered, when it was made.
          ...healthFields(withNewAccounts(cached.institutions, await newAccountsPromise), await healthPromise, cached.as_of),
          ...(await stalePromise),
          ...(await basePromise),
          ...linkOfferField(await linkOfferPromise),
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
    // With a home currency, the history is split by currency as it is read
    // (lib/history.ts getHistoryWithSplit), which needs the accounts in other
    // currencies: known once the fetch is in (`foreign`, settled below). So
    // its stored layers, the per-account maps with them, are read at once,
    // overlapping the fetch as the history's read always has, and only
    // working out the points waits for them. Without one, `foreign` is
    // settled at once and nothing changes.
    let settleForeign: (f: ForeignAccounts | null) => void = () => {};
    const foreignPromise = new Promise<ForeignAccounts | null>((resolve) => (settleForeign = resolve));
    settingsPromise.then(
      ({ settings }) => {
        if (!settings.home) settleForeign(null);
      },
      () => settleForeign(null)
    );
    const directoryPromise = eager(settingsPromise.then(({ settings }) => (settings.home ? directoryCurrencies(ctx) : [])));
    const layersPromise = eager(settingsPromise.then(({ settings }) => (settings.home ? readHistoryLayers(ctx, true) : undefined)));
    // The days known short of an account that came back after an assumed
    // closure are left out (lib/lifecycle.ts shortDays).
    const readHistory = () =>
      eager(
        Promise.all([hiddenPromise, lifecyclePromise, foreignPromise, layersPromise]).then(([h, l, f, layers]) =>
          getHistoryWithSplit(ctx, h.hidden, l.ended, shortDays(l, h.hidden), f, layers)
        )
      );
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
    const { date: snapshotDate, hold } = await recordFetch(ctx, institutions, netWorth);

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
    const linkOfferPromise = linkOfferForDisplay(ctx); // never throws

    // An account missing from a healthy answer is HELD at its last known
    // balance, with its question, and a zero for weeks is asked about
    // (lib/lifecycle-questions.ts). Display only, below the gates and after
    // the accounts were remembered: a held row is never recorded.
    await holdMissingAccounts(ctx, institutions, lifecycle, links ?? new Map());
    await askAboutZeroBalances(ctx, institutions, lifecycle, links ?? new Map(), hidden);
    // And one that ended but whose bank still returns it moving is asked
    // about again, from a copy of its row (`ended_reported`).
    await askAboutReportedEnds(ctx, institutions, lifecycle, links ?? new Map(), hidden);
    // Every account listed, with its currency, before those that ended leave
    // the list: what prices each one's part of the chart (lib/fx).
    const listed = listedAccounts(institutions);
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
    // With a home currency, the accounts in another currency than the main
    // one, by every id each has had: what the history's split reads, which
    // waits for them (see readHistory).
    const { settings } = await settingsPromise;
    const main = mainCurrency(institutions);
    let unknownCurrency = 0;
    if (settings.home) {
      const { foreign, unknown } = foreignFor([listed, lifecycleAccounts(lifecycle), await directoryPromise], links, main);
      unknownCurrency = unknown;
      settleForeign(foreign);
    }
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
    // The same points split by currency, and today's rows, for converting
    // after the cache: unconverted, a regrouping of what was stored.
    const currencyOfListed = new Map(listed.map((a) => [a.account_id, a.currency]));
    const split = settings.home
      ? historySplit({
          main,
          breaks: stored.breaks,
          raw: stored.raw,
          today: snapshotDate
            ? {
                date: snapshotDate,
                rows: [
                  ...visibleRows(institutions),
                  ...endedRows
                    .filter((r) => r.end > snapshotDate && r.type !== null)
                    .map((r) => ({ amount: signedContribution(r.type!, r.balance ?? 0), currency: currencyOfListed.get(r.account_id) ?? null })),
                ],
              }
            : null,
          unknown: unknownCurrency,
        })
      : undefined;

    const payload: NetWorthPayload = {
      institutions,
      netWorth: visibleNetWorth,
      history,
      hidden: hiddenList,
      lifecycle: lifecycleForClient(lifecycle),
      as_of: new Date().toISOString(),
      ...(split ? { history_split: split } : {}),
      ...(holdsTotals(hold) ? { restore_hold: hold } : {}),
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

    const { history_split, ...shown } = payload;
    return NextResponse.json({
      ...shown,
      ...healthFields(withNewAccounts(payload.institutions, await newAccountsPromise), await healthPromise, answeredAt),
      ...(await stalePromise),
      ...(await baseFields(ctx, payload.institutions, history_split, await settingsPromise)),
      ...linkOfferField(await linkOfferPromise),
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
