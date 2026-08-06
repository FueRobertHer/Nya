import { NextResponse } from 'next/server';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems } from '@/lib/storage';
import { readItemTransactions, LOOKBACK_DAYS } from '@/lib/transactions';
import { fetchInvestmentTxns, valueDelta } from '@/lib/investments';
import { getManualAccounts, isOwedType } from '@/lib/manual';
import {
  replaceEstimated,
  replaceEstimatedAccounts,
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
//                        every past point. Falls back to flat for any Item whose
//                        investments product isn't available, and for any
//                        account whose flows drive it below zero -- see the
//                        reconciliation check before the walk.
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

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Plaid still returns the legacy 'brokerage' type alongside 'investment' at
// some institutions; both are walkable the same way.
function isInvestmentType(type: string): boolean {
  return type === 'investment' || type === 'brokerage';
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
        const hasInvestment = bal.data.accounts.some((a) => isInvestmentType(a.type));
        const inv = hasInvestment
          ? await fetchInvestmentTxns(access_token, isoDaysAgo(LOOKBACK_DAYS), isoDaysAgo(0))
          : { txns: [], note: 'no investment accounts', truncated: false };

        return {
          accounts: bal.data.accounts,
          txns,
          note,
          invTxns: inv.txns,
          // Tracked separately from `invTxns.length`: an account whose product
          // works but simply had no activity all year IS covered, and walking
          // it correctly yields a flat series. Conflating the two would push it
          // into the flat term, where hiding it later subtracts the wrong
          // number from every estimated point.
          //
          // `truncated` also disqualifies it. Plaid returns newest first, so a
          // capped fetch is missing its OLDEST rows -- the walk would run to the
          // left edge with flows silently absent and publish a curve that looks
          // fine and isn't.
          invCovered: hasInvestment && !inv.note && !inv.truncated,
        };
      })
    );

    // Any institution still syncing / needing reauth: abort without marking
    // done so the next attempt can complete a full, consistent reconstruction.
    if (perItem.some((p) => p.note)) {
      return NextResponse.json({ skipped: true, reason: 'institutions not ready' });
    }

    let totalNow = 0; // current net worth across all accounts
    const walkType: Record<string, 'depository' | 'credit' | 'investment'> = {}; // reconstructable
    const cashIds = new Set<string>(); // depository/credit only -- see the txn loop below
    const balances: Record<string, number> = {}; // running raw balances for the walk
    const dailyByAccount: Record<string, Record<string, number>> = {}; // date -> account -> txn sum
    let oldestTxn: string | null = null;
    let oldestInvTxn: string | null = null;

    for (const { accounts, txns, invTxns, invCovered } of perItem) {
      for (const a of accounts) {
        const current = a.balances.current ?? 0;
        totalNow += a.type === 'credit' || a.type === 'loan' ? -current : current;
        if (a.type === 'depository' || a.type === 'credit') {
          walkType[a.account_id] = a.type;
          cashIds.add(a.account_id);
          balances[a.account_id] = current;
        } else if (isInvestmentType(a.type) && invCovered) {
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
      for (const t of invTxns) {
        if (walkType[t.account_id] !== 'investment') continue;
        const delta = valueDelta(t);
        if (delta === 0) continue; // internal reallocation: buys, sells, corporate actions
        const day = (dailyByAccount[t.date] ??= {});
        // Back into the walk's convention (positive = value left the account),
        // which is what the shared loop below un-applies.
        day[t.account_id] = (day[t.account_id] ?? 0) + -delta;
        // Deliberately NOT folded into oldestTxn. That marker stops the walk at
        // the edge of the cash data; extending it to a brokerage's longer
        // history would keep walking with every cash balance frozen, which is
        // the flatlining the `break` below exists to prevent. Where investment
        // history outlasts cash history the extra span is simply not drawn.
        // Tracked separately for the no-cash-at-all case just below.
        if (!oldestInvTxn || t.date < oldestInvTxn) oldestInvTxn = t.date;
      }
    }

    // A brokerage-only user has no cash horizon to preserve, so the hazard the
    // comment above describes -- freezing cash balances past their data -- can't
    // arise: there are no cash balances. Without this they'd fall through the
    // `!oldestTxn` early return below and get no estimated history at all,
    // which is precisely the case this feature was built for.
    //
    // Gated on having no cash ACCOUNTS, not on `!oldestTxn`. Those differ: a
    // dormant checking account with no activity all year also leaves oldestTxn
    // null, and walking past its horizon would freeze a real balance -- exactly
    // what the guard above refuses to do.
    if (!oldestTxn && cashIds.size === 0) oldestTxn = oldestInvTxn;

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
      totalNow += isOwedType(a.type) ? -a.balance : a.balance;
    }

    if (!oldestTxn) {
      await markBackfillDone();
      // Clears the cached payload too, or its `backfill_stale: true` would
      // outlive the flag and re-POST this route on every load for the TTL.
      await clearCaches();
      return NextResponse.json({ backfilled: 0, reason: 'no transaction history' });
    }

    // Sanity-check each investment account before trusting its reconstruction.
    //
    // The walk assumes the flow stream and the current balance describe the
    // same account over the same period. When they don't, un-applying the flows
    // drives the balance through zero -- and a brokerage account cannot hold
    // less than nothing, so that isn't an imprecise estimate, it's a statement
    // known to be false. It happens for real reasons: a broker that only
    // reports 90 days of activity against a year-long window, an account opened
    // mid-window, or a position transferred in-kind and reported at notional
    // value.
    //
    // Where that happens, drop the account back to the flat term rather than
    // publishing the impossible number. Flat is what it got before any of this
    // existed, so the fallback is a known-good behaviour, not a new one. Done
    // here, before `rest` and `flat` are computed, so every downstream figure
    // sees one consistent membership.
    const distrusted: string[] = [];
    for (const id of Object.keys(walkType)) {
      if (walkType[id] !== 'investment') continue;
      let running = balances[id];
      let negative = false;
      for (let back = 1; back <= LOOKBACK_DAYS; back++) {
        running += dailyByAccount[isoDaysAgo(back - 1)]?.[id] ?? 0;
        if (isoDaysAgo(back) < oldestTxn) break; // same horizon the real walk stops at
        if (running < 0) {
          negative = true;
          break;
        }
      }
      if (negative) {
        distrusted.push(id);
        delete walkType[id];
        delete balances[id];
      }
    }
    // Their flows must go too, or the shared walk below would still apply them
    // to an account it no longer tracks.
    if (distrusted.length > 0) {
      for (const day of Object.values(dailyByAccount)) {
        for (const id of distrusted) delete day[id];
      }
    }

    const signedWalked = () =>
      Object.entries(balances).reduce(
        (sum, [id, b]) => sum + (walkType[id] === 'credit' ? -b : b),
        0
      );

    // Everything not being walked is held flat at today's value.
    const rest = totalNow - signedWalked();

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

    // Walk backward one day at a time: un-applying day D's transactions
    // yields balances at the end of day D-1.
    const totalPoints: { date: string; value: number }[] = [];
    const accountPoints: { date: string; balances: Record<string, number> }[] = [];
    for (let back = 1; back <= LOOKBACK_DAYS; back++) {
      const dayTxns = dailyByAccount[isoDaysAgo(back - 1)] ?? {};
      for (const [id, amount] of Object.entries(dayTxns)) {
        balances[id] += walkType[id] === 'credit' ? -amount : amount;
      }
      const date = isoDaysAgo(back);
      if (date < oldestTxn) break; // beyond available data: stop, don't flatline
      totalPoints.push({ date, value: signedWalked() + rest });
      accountPoints.push({ date, balances: { ...balances } });
    }

    // Real snapshots always win -- never overwrite one with an estimate.
    const realDates = await getRealSnapshotDates();
    const estimatedTotals = totalPoints.filter((p) => !realDates.has(p.date));
    const estimatedAccounts = accountPoints.filter((p) => !realDates.has(p.date));

    await replaceEstimated(estimatedTotals);
    await replaceEstimatedAccounts(estimatedAccounts);
    // One map per date, over exactly the dates this run wrote. The balances are
    // identical across them -- what varies is which run a date belongs to, and
    // that's the whole point: a date retained from an earlier run keeps that
    // run's flat balances rather than being reinterpreted with these.
    await replaceEstimatedFlat(estimatedTotals.map((p) => ({ date: p.date, balances: flat })));
    await markBackfillDone();
    await clearCaches(); // cached payloads don't include the new history yet

    return NextResponse.json({
      backfilled: estimatedTotals.length,
      from: estimatedTotals.length > 0 ? estimatedTotals[estimatedTotals.length - 1].date : null,
      // Investment accounts whose flows didn't reconcile with their balance and
      // were held flat instead. Reported rather than silent: a number that
      // stays high run after run means the flow data is systematically
      // incomplete, which is worth knowing.
      held_flat: distrusted.length,
    });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
