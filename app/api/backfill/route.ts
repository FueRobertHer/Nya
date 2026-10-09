import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems } from '@/lib/storage';
import { readItemTransactions, LOOKBACK_DAYS } from '@/lib/transactions';
import { syncInvestments } from '@/lib/invstore';
import { getManualAccounts } from '@/lib/manual';
import { isInvestmentType, signedContribution } from '@/lib/balance';
import { addInvestmentFlows, isoDaysAgo, loadItemInvestments, reconstruct, type WalkType } from '@/lib/backfill';
import {
  backfillPendingExhausted,
  clearBackfillPending,
  replaceEstimated,
  replaceEstimatedAccounts,
  replaceEstimatedExtension,
  replaceEstimatedFlat,
  getRealSnapshotDates,
  isBackfillDone,
  markBackfillDone,
} from '@/lib/history';
import { clearCaches } from '@/lib/cache';
import { loggable } from '@/lib/log-safe';

// Reconstructs up to a year of ESTIMATED history from transaction data, the same
// trick Monarch/Copilot use. Plaid has no historical balances, but it has
// transactions, so we walk backward from today's balance, un-applying each day's
// transactions. The total net-worth series and each walked account's own series
// come out of the same walk.
//
// Three tiers of fidelity; the chart draws the whole estimated region dashed
// because even the best is a reconstruction:
//
//   depository / credit  Fully walked. Every balance change is a transaction.
//   investment           Partially walked: external flows (deposits, withdrawals,
//                        dividends, fees) are un-applied, but market movement
//                        isn't a transaction and can't be recovered. Still much
//                        better than holding the balance flat, which applied a
//                        year of contributions to every past point. Flat only for
//                        an Item whose investments product isn't available; an
//                        account whose flows out-run its balance is floored at
//                        zero rather than dropped (see reconstruct in
//                        lib/backfill.ts).
//   loans / manual       Flat at today's value: amortization isn't in the
//                        transaction stream and typed balances have no stream.
//   depository / credit  Flat too, on an Item with no Transactions at all (one
//   without a stream     linked as a brokerage, see lib/item-products.ts): there
//                        is nothing to walk. It still counts as a cash account
//                        for where the total series may stop (below).
//
// An Item with no Transactions is not a reason to wait: readItemTransactions
// answers it with no rows and no note, and its investment accounts are walked
// from their own flows like any other.
//
// Plaid's sign convention: a positive amount is money leaving the account. For
// the net-worth total every transaction's effect is exactly -amount for both
// depository and credit accounts (a card purchase raises the owed balance, so
// the signed contribution drops by the amount; a card payment nets to zero across
// the card and the funding account). For an account's RAW balance the walk is
// type-aware: depository balances go down by amount, credit balances (amount
// owed) go up. Investment transactions use the same convention, so they need no
// new branch (see valueDelta in lib/investments.ts).

// How many runs in a row will wait for an Item's investment data before
// accepting the reconstruction without it. PRODUCT_NOT_READY clears in minutes,
// so a handful of app opens is generous; the cap stops a wedged extraction from
// re-running every institution's full pull on every open, forever.
const MAX_PENDING_RUNS = 5;

/**
 * Records the run as complete unless an Item's investment data is still
 * importing, in which case it leaves the flag unset so the client's next load
 * rebuilds with the flows. Returns whether it is still waiting.
 *
 * The wait is capped. Held flat and marked done, a not-yet-ready Item's accounts
 * keep that gap forever (nothing retries a completed backfill), which is how a
 * rollover ends up in the activity list and nowhere on the chart. Held open
 * indefinitely, a wedged extraction costs a full Plaid pull on every app open.
 */
async function settleDoneFlag(ctx: Ctx, invPending: boolean): Promise<boolean> {
  if (invPending && !(await backfillPendingExhausted(ctx, MAX_PENDING_RUNS))) return true;
  await markBackfillDone(ctx);
  await clearBackfillPending(ctx);
  return false;
}

export async function POST() {
  try {
    const ctx = await dataCtx();
    if (await isBackfillDone(ctx)) {
      return NextResponse.json({ skipped: true, reason: 'already backfilled' });
    }

    const items = await getItems(ctx);
    if (items.length === 0) {
      return NextResponse.json({ skipped: true, reason: 'no linked institutions' });
    }

    // Fetch every institution's balances + transactions concurrently.
    // Transactions come from the shared cursor-based store (lib/transactions), so
    // this reuses the pull the Activity tab warms. A failed balance read rejects
    // the Promise.all and aborts in the catch without marking done; a transaction
    // read that isn't clean comes back as a `note` (handled below). Either way a
    // partial reconstruction is never persisted, and the next attempt retries.
    const perItem = await Promise.all(
      items.map(async (item) => {
        const access_token = await decrypt(item.encrypted_access_token);
        // Stored balances, not the billed live balance call: see lib/networth.ts.
        const bal = await plaidClient.accountsGet({ access_token });
        // The accounts just fetched decide whether an Item Plaid doesn't bill
        // Transactions on is worth a first call (lib/item-products.ts).
        const { txns, note, hasTransactions } = await readItemTransactions(ctx, item, LOOKBACK_DAYS, bal.data.accounts);

        // Investment activity, only where there's an investment account to
        // explain, and only as a bonus: its failure is NOT a `note`. Most Items
        // can't serve /investments/transactions/get, and the only automatic
        // retry is the client noticing thin history, so treating that as a note
        // would let one plain checking account block backfill for everything.
        const investmentIds = bal.data.accounts
          .filter((a) => isInvestmentType(a.type))
          .map((a) => a.account_id);
        const hasInvestment = investmentIds.length > 0;
        // From the Item's stored investment transactions (lib/invstore.ts),
        // brought up to date first. Which accounts are walked, whether to wait
        // and which rows to walk: see investmentReadiness in lib/backfill.ts. The
        // walk judges paycheck trades over every row and walks only the window.
        const inv = hasInvestment
          ? await loadItemInvestments((opts) => syncInvestments(ctx, item, opts), investmentIds, {
              windowStart: isoDaysAgo(LOOKBACK_DAYS),
              yesterday: isoDaysAgo(1),
              today: isoDaysAgo(0),
            })
          : null;

        return {
          accounts: bal.data.accounts,
          txns,
          note,
          hasTransactions,
          invTxns: inv?.walkRows ?? [],
          invCoveredIds: inv?.coveredIds ?? new Set<string>(),
          invPending: inv?.pending ?? false,
        };
      })
    );

    // Any institution still syncing / needing reauth: abort without marking
    // done so the next attempt can complete a full, consistent reconstruction.
    if (perItem.some((p) => p.note)) {
      return NextResponse.json({ skipped: true, reason: 'institutions not ready' });
    }

    let totalNow = 0; // current net worth across all accounts
    const walkType: Record<string, WalkType> = {}; // reconstructable
    const cashIds = new Set<string>(); // depository/credit only -- see the txn loop below
    const balances: Record<string, number> = {}; // running raw balances for the walk
    const dailyByAccount: Record<string, Record<string, number>> = {}; // date -> account -> txn sum
    let oldestTxn: string | null = null;
    let oldestInvTxn: string | null = null;

    // Whether any Item's investment data was still importing. The reconstruction
    // is still worth persisting (its cash history is complete) but must not be
    // marked done: those accounts are held flat only because the data hadn't
    // arrived, and the flag would freeze that with nothing to retry it. Left
    // unset, the client's next load recomputes.
    const invPending = perItem.some((p) => p.invPending);

    // Whether some cash account had no stream to walk (an Item with no
    // Transactions): held flat, and never given a series of its own, since an
    // empty stream would read as a balance that didn't move.
    let streamlessCash = false;

    for (const { accounts, txns, hasTransactions, invTxns, invCoveredIds } of perItem) {
      for (const a of accounts) {
        const current = a.balances.current ?? 0;
        totalNow += signedContribution(a.type, current);
        if (a.type === 'depository' || a.type === 'credit') {
          // Not walked, so it falls into the flat-held `rest` below.
          if (!hasTransactions) {
            streamlessCash = true;
            continue;
          }
          walkType[a.account_id] = a.type;
          cashIds.add(a.account_id);
          balances[a.account_id] = current;
        } else if (isInvestmentType(a.type) && invCoveredIds.has(a.account_id)) {
          walkType[a.account_id] = 'investment';
          balances[a.account_id] = current;
        }
      }
      for (const t of txns) {
        if (t.pending) continue; // unsettled amounts distort the walk
        // cashIds, not walkType: some brokerages expose a cash sweep through
        // transactionsSync too, and an account present in both streams would have
        // every flow applied twice.
        if (!cashIds.has(t.account_id)) continue;
        const day = (dailyByAccount[t.date] ??= {});
        day[t.account_id] = (day[t.account_id] ?? 0) + t.amount;
        if (!oldestTxn || t.date < oldestTxn) oldestTxn = t.date;
      }
      // Deliberately NOT folded into oldestTxn: that marker stops the TOTAL
      // series at the edge of the cash data, and extending it would keep walking
      // with every cash balance frozen, publishing a flatline as history. Tracked
      // separately because an investment account's own series has real data past
      // it (where a rollover older than the cash window lives). See reconstruct
      // in lib/backfill.ts.
      const oldestHere = addInvestmentFlows(dailyByAccount, invTxns, walkType, isoDaysAgo(LOOKBACK_DAYS));
      if (oldestHere && (!oldestInvTxn || oldestHere < oldestInvTxn)) oldestInvTxn = oldestHere;
    }

    // A brokerage-only user has no cash balances to freeze past their data, so
    // their investment history is the whole series, totals included.
    //
    // Gated on having no cash ACCOUNTS, not on `!oldestTxn`: a dormant checking
    // account with no activity all year also leaves oldestTxn null, and walking
    // a real cash balance past its horizon would freeze it. That case gets today
    // as its cash horizon: no total points, but the investment accounts still get
    // their own series. So does a cash account with no stream at all, for the
    // same reason: its past balance is just as unknown.
    if (!oldestTxn && cashIds.size === 0 && !streamlessCash) oldestTxn = oldestInvTxn;
    else if (!oldestTxn && oldestInvTxn) oldestTxn = isoDaysAgo(0);

    // Manual accounts have no transactions, so they can't be walked backward, but
    // they must land in totalNow or every estimated point would sit short by
    // their whole total, with a visible step at the estimated/real seam. Never
    // entering cashType, they fall into the flat-held `rest` below (as
    // investments and loans do), so today's manual balance applies retroactively
    // across the estimated range.
    // Read once and reused: two reads could disagree, and an account created
    // between them would land in the flat record without being in totalNow, so
    // hiding it later would subtract a contribution these points never contained.
    const manualAccounts = await getManualAccounts(ctx);
    for (const a of manualAccounts) {
      totalNow += signedContribution(a.type, a.balance);
    }

    if (!oldestTxn) {
      await settleDoneFlag(ctx, invPending);
      // Clears the cached payload too, or its `backfill_stale: true` would
      // outlive the flag and re-POST this route on every load for the TTL.
      await clearCaches(ctx);
      return NextResponse.json({ backfilled: 0, reason: 'no transaction history' });
    }

    // Everything not being walked is held flat at today's value.
    const rest =
      totalNow -
      Object.entries(balances).reduce(
        (sum, [id, b]) => sum + signedContribution(walkType[id], b),
        0
      );

    // Record WHICH accounts make up that flat term, and at what balance. The
    // estimated points don't name them, so without this there'd be no way to
    // work out how much of `rest` a given account contributed. Hiding needs
    // exactly that number: the balance today could be wildly different, and an
    // account linked after this run contributed nothing. Stored apart from the
    // per-account estimated series so investments get no fabricated flat sparkline.
    const flat: Record<string, number> = {};
    for (const { accounts } of perItem) {
      for (const a of accounts) {
        if (!walkType[a.account_id]) flat[a.account_id] = a.balances.current ?? 0;
      }
    }
    // Manual accounts are checked against walkType too, but the loop above only
    // populates it from *Plaid* accounts, so a manual account typed 'depository'
    // or 'investment' always lands here (a typed balance has no stream to walk).
    // Intentional; don't "fix" it for symmetry.
    for (const a of manualAccounts) {
      if (!walkType[a.account_id]) flat[a.account_id] = a.balance;
    }

    // The walk itself (lib/backfill.ts): per-account series can reach back past
    // the cash horizon where an investment account's own flows do, totals stop there.
    const { accountPoints, totalPoints, floored } = reconstruct({
      balances,
      walkType,
      dailyByAccount,
      oldestTxn,
      oldestInvTxn,
      lookbackDays: LOOKBACK_DAYS,
    });

    // Real snapshots always win -- never overwrite one with an estimate.
    const realDates = await getRealSnapshotDates(ctx);
    const estimatedTotals = totalPoints
      .filter((p) => !realDates.has(p.date))
      .map((p) => ({ date: p.date, value: p.walked + rest }));
    const estimatedAccounts = accountPoints.filter((p) => !realDates.has(p.date));

    // An institution disconnected while this ran (the Plaid pulls are slow) may
    // have had an account forgotten since, and writing its balances back would
    // put it into the chart. Not done, so the next load rebuilds.
    const stillConnected = new Set((await getItems(ctx)).map((i) => i.item_id));
    if (items.some((i) => !stillConnected.has(i.item_id))) {
      return NextResponse.json({ skipped: true, reason: 'institutions changed' });
    }

    // Breakdowns before totals (the order recordSnapshot keeps, for the same
    // reason): a forget of a hidden account reading between the writes must see
    // new breakdowns beside old totals, never the reverse.
    //
    // Two layers, because the run speaks for these dates differently. Within the
    // cash horizon every account was walked and each date is the breakdown of that
    // date's estimated total (what hidden-account subtraction reads it as). Past
    // it only investment accounts were walked and there is no total, so those go
    // to the extension layer, which feeds the per-account chart only.
    await replaceEstimatedAccounts(ctx, estimatedAccounts.filter((p) => p.date >= oldestTxn));
    await replaceEstimatedExtension(ctx, 
      estimatedAccounts.filter((p) => p.date < oldestTxn),
      oldestTxn
    );
    // One map per date, over exactly the dates this run wrote. The balances are
    // identical across them; what varies is which run a date belongs to, so a
    // date retained from an earlier run keeps that run's flat balances.
    await replaceEstimatedFlat(ctx, estimatedTotals.map((p) => ({ date: p.date, balances: flat })));
    await replaceEstimated(ctx, estimatedTotals);
    const waiting = await settleDoneFlag(ctx, invPending);
    await clearCaches(ctx); // cached payloads don't include the new history yet

    return NextResponse.json({
      backfilled: estimatedTotals.length,
      from: estimatedTotals.length > 0 ? estimatedTotals[estimatedTotals.length - 1].date : null,
      // Investment accounts whose flows out-ran their balance and were floored at
      // zero partway back. Reported, not silent: a number that stays high run
      // after run means the flow data is systematically incomplete.
      floored: floored.length,
      // Still importing somewhere AND still worth waiting for: the done-flag was
      // left unset and the client re-POSTs on its next load. False once the wait
      // is spent, even though the data is still missing.
      investments_pending: waiting,
    });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
