import { NextResponse } from 'next/server';
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

// Reconstructs up to a year of ESTIMATED history from transaction data --
// the same trick Monarch/Copilot use. Plaid has no historical balances, but
// it has transactions, so we walk backward from today's balance, un-applying
// each day's transactions. Both the total net-worth series and each walked
// account's own balance series come out of the same walk.
//
// Three tiers of fidelity, and the chart draws the whole estimated region
// dashed because even the best of them is a reconstruction:
//
//   depository / credit  Fully walked. Every balance change is a transaction.
//   investment           Partially walked: external flows (deposits,
//                        withdrawals, dividends, fees) are un-applied, but
//                        market movement isn't a transaction and can't be
//                        recovered, so within a day the price is held. This is
//                        still much better than holding the whole balance flat,
//                        which retroactively applied a year of contributions to
//                        every past point. Falls back to flat only for an Item
//                        whose investments product isn't available; an account
//                        whose flows out-run its balance is floored at zero
//                        rather than dropped (see reconstruct in
//                        lib/backfill.ts).
//   loans / manual       Flat at today's value. Amortization isn't in the
//                        transaction stream and typed balances have no stream.
//
// Plaid's sign convention: a positive amount is money leaving the account.
// For the net-worth total that makes every transaction's effect exactly
// -amount for both depository and credit accounts (a card purchase increases
// the owed balance, so the signed contribution -owed drops by the amount; a
// card payment nets to zero across the card and the funding account). For an
// account's RAW balance the walk is type-aware: depository balances go down
// by amount, credit balances (amount owed) go up. Investment transactions use
// the same convention (positive = cash debited), so they need no new branch --
// see valueDelta in lib/investments.ts for which of them move value at all.

// How many runs in a row will wait for an Item's investment data before
// accepting the reconstruction without it. PRODUCT_NOT_READY clears in minutes,
// so a handful of app opens is generous; the cap exists because an extraction
// that never finishes would otherwise re-run every institution's full pull on
// every open, forever, where before the wait existed the user got a cached load.
const MAX_PENDING_RUNS = 5;

/**
 * Records the run as complete unless an Item's investment data is still
 * importing, in which case it leaves the flag unset so the client's next load
 * rebuilds with the flows. Returns whether it is still waiting.
 *
 * The wait is capped. Held flat and marked done, a not-yet-ready Item's
 * accounts keep that gap forever (nothing retries a completed backfill), which
 * is how a rollover ends up in the activity list and nowhere on the chart. Held
 * open indefinitely, a wedged extraction costs a full multi-institution Plaid
 * pull on every app open. The cap takes the first and bounds the second.
 */
async function settleDoneFlag(invPending: boolean): Promise<boolean> {
  if (invPending && !(await backfillPendingExhausted(MAX_PENDING_RUNS))) return true;
  await markBackfillDone();
  await clearBackfillPending();
  return false;
}

export async function POST() {
  try {
    if (await isBackfillDone()) {
      return NextResponse.json({ skipped: true, reason: 'already backfilled' });
    }

    const items = await getItems();
    if (items.length === 0) {
      return NextResponse.json({ skipped: true, reason: 'no linked institutions' });
    }

    // Fetch every institution's balances + transactions concurrently.
    // Transactions come from the shared cursor-based store (lib/transactions),
    // so this reuses the same Plaid pull the Activity tab warms rather than
    // re-fetching. A balance read that fails (decrypt/reauth) rejects the whole
    // Promise.all and we abort in the catch without marking done; a transaction
    // read that isn't clean comes back as a `note`, handled just below. Either
    // way a partial reconstruction is never persisted, and the next attempt
    // retries.
    const perItem = await Promise.all(
      items.map(async (item) => {
        const access_token = await decrypt(item.encrypted_access_token);
        const bal = await plaidClient.accountsBalanceGet({ access_token });
        const { txns, note } = await readItemTransactions(item, LOOKBACK_DAYS);

        // Investment activity, but only where there's an investment account to
        // explain and only as a bonus: its failure is NOT a `note`. Most Items
        // can't serve /investments/transactions/get at all, and because the
        // abort below returns without marking done -- while the only automatic
        // retry is the client noticing history is thin -- treating that as a
        // note would mean one plain checking account permanently blocks
        // backfill for everything else.
        const investmentIds = bal.data.accounts
          .filter((a) => isInvestmentType(a.type))
          .map((a) => a.account_id);
        const hasInvestment = investmentIds.length > 0;
        // From the Item's stored investment transactions (lib/invstore.ts),
        // brought up to date first. Which accounts are walked, whether to wait,
        // and which rows to walk: see investmentReadiness in lib/backfill.ts.
        // The walk judges paycheck trades over every row it is given and walks
        // only the window.
        const inv = hasInvestment
          ? await loadItemInvestments((opts) => syncInvestments(item, opts), investmentIds, {
              windowStart: isoDaysAgo(LOOKBACK_DAYS),
              yesterday: isoDaysAgo(1),
              today: isoDaysAgo(0),
            })
          : null;

        return {
          accounts: bal.data.accounts,
          txns,
          note,
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
    // below is still worth persisting -- the cash history in it is complete --
    // but it must not be marked done: those accounts are held flat only because
    // the data hadn't arrived, and the done-flag would freeze that in place
    // with nothing to retry it. This is how a rollover ends up in the activity
    // list (fetched live, later, when the product is ready) and missing from
    // the chart. Left unset, the client's next load recomputes.
    const invPending = perItem.some((p) => p.invPending);

    for (const { accounts, txns, invTxns, invCoveredIds } of perItem) {
      for (const a of accounts) {
        const current = a.balances.current ?? 0;
        totalNow += signedContribution(a.type, current);
        if (a.type === 'depository' || a.type === 'credit') {
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
        // transactionsSync as well, and an investment account present in both
        // streams would have every flow applied twice.
        if (!cashIds.has(t.account_id)) continue;
        const day = (dailyByAccount[t.date] ??= {});
        day[t.account_id] = (day[t.account_id] ?? 0) + t.amount;
        if (!oldestTxn || t.date < oldestTxn) oldestTxn = t.date;
      }
      // Deliberately NOT folded into oldestTxn. That marker stops the TOTAL
      // series at the edge of the cash data; extending it would keep walking
      // with every cash balance frozen, publishing a flatline as history.
      // Tracked separately because an investment account's own series has
      // real data out there and is drawn over it -- which is where a rollover
      // older than the cash window lives. See reconstruct in lib/backfill.ts.
      const oldestHere = addInvestmentFlows(dailyByAccount, invTxns, walkType, isoDaysAgo(LOOKBACK_DAYS));
      if (oldestHere && (!oldestInvTxn || oldestHere < oldestInvTxn)) oldestInvTxn = oldestHere;
    }

    // A brokerage-only user has no cash horizon to preserve, so the hazard the
    // comment above describes -- freezing cash balances past their data -- can't
    // arise: there are no cash balances. Their investment history is the whole
    // series, totals included.
    //
    // Gated on having no cash ACCOUNTS, not on `!oldestTxn`. Those differ: a
    // dormant checking account with no activity all year also leaves oldestTxn
    // null, and walking a real cash balance past its horizon would freeze it.
    // That case gets today as its cash horizon instead: no total points, but
    // the investment accounts still get their own series rather than nothing.
    if (!oldestTxn && cashIds.size === 0) oldestTxn = oldestInvTxn;
    else if (!oldestTxn && oldestInvTxn) oldestTxn = isoDaysAgo(0);

    // Manual accounts have no transactions, so they can't be walked backward.
    // They still have to land in totalNow or every estimated point would sit
    // short by their whole total, putting a visible step right at the
    // estimated/real seam. Because they never enter cashType they fall into
    // the flat-held `rest` below -- the same convention already used for
    // investments and loans, which does mean today's manual balance is applied
    // retroactively across the estimated range.
    // Read once and reuse below: two reads could disagree, and an account
    // created between them would land in the flat record without being in
    // totalNow, so hiding it later would subtract a contribution these points
    // never contained.
    const manualAccounts = await getManualAccounts();
    for (const a of manualAccounts) {
      totalNow += signedContribution(a.type, a.balance);
    }

    if (!oldestTxn) {
      await settleDoneFlag(invPending);
      // Clears the cached payload too, or its `backfill_stale: true` would
      // outlive the flag and re-POST this route on every load for the TTL.
      await clearCaches();
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
    // estimated points don't name them (they only carry per-date cash
    // balances), so without this there'd be no way to work out how much of
    // `rest` a given account contributed. Hiding an account needs exactly that
    // number to subtract it from the estimated layer: its balance today could
    // be wildly different, and an account linked after this run contributed
    // nothing at all. Stored separately from the per-account estimated series
    // so investments still get no fabricated flat sparkline.
    const flat: Record<string, number> = {};
    for (const { accounts } of perItem) {
      for (const a of accounts) {
        if (!walkType[a.account_id]) flat[a.account_id] = a.balances.current ?? 0;
      }
    }
    // Manual accounts are checked against walkType too, but note that the loop
    // above only ever populates it from *Plaid* accounts -- so a manual account
    // typed 'depository' or 'investment' always lands here, however cash-like it
    // looks. That asymmetry is intentional (a typed balance has no transaction
    // stream to walk); don't "fix" it for symmetry.
    for (const a of manualAccounts) {
      if (!walkType[a.account_id]) flat[a.account_id] = a.balance;
    }

    // The walk itself (lib/backfill.ts): the per-account series can reach back
    // past the cash horizon where an investment account's own flows do, while
    // the totals stop there.
    const { accountPoints, totalPoints, floored } = reconstruct({
      balances,
      walkType,
      dailyByAccount,
      oldestTxn,
      oldestInvTxn,
      lookbackDays: LOOKBACK_DAYS,
    });

    // Real snapshots always win -- never overwrite one with an estimate.
    const realDates = await getRealSnapshotDates();
    const estimatedTotals = totalPoints
      .filter((p) => !realDates.has(p.date))
      .map((p) => ({ date: p.date, value: p.walked + rest }));
    const estimatedAccounts = accountPoints.filter((p) => !realDates.has(p.date));

    await replaceEstimated(estimatedTotals);
    // Two layers, because the run speaks for these dates differently. Within
    // the cash horizon every account was walked and each date is the breakdown
    // of that date's estimated total, which is what the hidden-account
    // subtraction reads it as. Past the horizon only the investment accounts
    // were walked and there is no total at all, so those dates go to the
    // extension layer -- which feeds the per-account chart and nothing else.
    await replaceEstimatedAccounts(estimatedAccounts.filter((p) => p.date >= oldestTxn));
    await replaceEstimatedExtension(
      estimatedAccounts.filter((p) => p.date < oldestTxn),
      oldestTxn
    );
    // One map per date, over exactly the dates this run wrote. The balances are
    // identical across them -- what varies is which run a date belongs to, and
    // that's the whole point: a date retained from an earlier run keeps that
    // run's flat balances rather than being reinterpreted with these.
    await replaceEstimatedFlat(estimatedTotals.map((p) => ({ date: p.date, balances: flat })));
    const waiting = await settleDoneFlag(invPending);
    await clearCaches(); // cached payloads don't include the new history yet

    return NextResponse.json({
      backfilled: estimatedTotals.length,
      from: estimatedTotals.length > 0 ? estimatedTotals[estimatedTotals.length - 1].date : null,
      // Investment accounts whose flows out-ran their balance and were floored
      // at zero partway back. Reported rather than silent: a number that stays
      // high run after run means the flow data is systematically incomplete,
      // which is worth knowing.
      floored: floored.length,
      // Still importing somewhere AND still worth waiting for, so the
      // done-flag was left unset and the client re-POSTs on its next load.
      // False once the wait is spent, even though the data is still missing.
      investments_pending: waiting,
    });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
