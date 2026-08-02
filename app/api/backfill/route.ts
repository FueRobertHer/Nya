import { NextResponse } from 'next/server';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems } from '@/lib/storage';
import { readItemTransactions, LOOKBACK_DAYS } from '@/lib/transactions';
import { getManualAccounts, isOwedType } from '@/lib/manual';
import {
  replaceEstimated,
  replaceEstimatedAccounts,
  getRealSnapshotDates,
  isBackfillDone,
  markBackfillDone,
} from '@/lib/history';
import { clearCaches } from '@/lib/cache';

// Reconstructs up to a year of ESTIMATED history from transaction data --
// the same trick Monarch/Copilot use. Plaid has no historical balances, but
// it has transactions, so for cash and credit accounts we walk backward from
// today's balance, un-applying each day's transactions. Both the total
// net-worth series and each cash/credit account's own balance series are
// produced by the same walk. Investments and loans can't be reconstructed
// (market moves aren't transactions), so they contribute a flat amount to
// the total and get no per-account estimated series; the chart draws the
// estimated region dashed to make that honest.
//
// Plaid's sign convention: a positive amount is money leaving the account.
// For the net-worth total that makes every transaction's effect exactly
// -amount for both depository and credit accounts (a card purchase increases
// the owed balance, so the signed contribution -owed drops by the amount; a
// card payment nets to zero across the card and the funding account). For an
// account's RAW balance the walk is type-aware: depository balances go down
// by amount, credit balances (amount owed) go up.

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
        return { accounts: bal.data.accounts, txns, note };
      })
    );

    // Any institution still syncing / needing reauth: abort without marking
    // done so the next attempt can complete a full, consistent reconstruction.
    if (perItem.some((p) => p.note)) {
      return NextResponse.json({ skipped: true, reason: 'institutions not ready' });
    }

    let totalNow = 0; // current net worth across all accounts
    const cashType: Record<string, 'depository' | 'credit'> = {}; // reconstructable accounts
    const balances: Record<string, number> = {}; // running raw balances for the walk
    const dailyByAccount: Record<string, Record<string, number>> = {}; // date -> account -> txn sum
    let oldestTxn: string | null = null;

    for (const { accounts, txns } of perItem) {
      for (const a of accounts) {
        const current = a.balances.current ?? 0;
        totalNow += a.type === 'credit' || a.type === 'loan' ? -current : current;
        if (a.type === 'depository' || a.type === 'credit') {
          cashType[a.account_id] = a.type;
          balances[a.account_id] = current;
        }
      }
      for (const t of txns) {
        if (t.pending) continue; // unsettled amounts distort the walk
        if (!cashType[t.account_id]) continue;
        const day = (dailyByAccount[t.date] ??= {});
        day[t.account_id] = (day[t.account_id] ?? 0) + t.amount;
        if (!oldestTxn || t.date < oldestTxn) oldestTxn = t.date;
      }
    }

    // Manual accounts have no transactions, so they can't be walked backward.
    // They still have to land in totalNow or every estimated point would sit
    // short by their whole total, putting a visible step right at the
    // estimated/real seam. Because they never enter cashType they fall into
    // the flat-held `rest` below -- the same convention already used for
    // investments and loans, which does mean today's manual balance is applied
    // retroactively across the estimated range.
    for (const a of await getManualAccounts()) {
      totalNow += isOwedType(a.type) ? -a.balance : a.balance;
    }

    if (!oldestTxn) {
      await markBackfillDone();
      return NextResponse.json({ backfilled: 0, reason: 'no transaction history' });
    }

    const signedCash = () =>
      Object.entries(balances).reduce(
        (sum, [id, b]) => sum + (cashType[id] === 'credit' ? -b : b),
        0
      );

    // Everything that isn't cash/credit is held flat at today's value.
    const rest = totalNow - signedCash();

    // Walk backward one day at a time: un-applying day D's transactions
    // yields balances at the end of day D-1.
    const totalPoints: { date: string; value: number }[] = [];
    const accountPoints: { date: string; balances: Record<string, number> }[] = [];
    for (let back = 1; back <= LOOKBACK_DAYS; back++) {
      const dayTxns = dailyByAccount[isoDaysAgo(back - 1)] ?? {};
      for (const [id, amount] of Object.entries(dayTxns)) {
        balances[id] += cashType[id] === 'credit' ? -amount : amount;
      }
      const date = isoDaysAgo(back);
      if (date < oldestTxn) break; // beyond available data: stop, don't flatline
      totalPoints.push({ date, value: signedCash() + rest });
      accountPoints.push({ date, balances: { ...balances } });
    }

    // Real snapshots always win -- never overwrite one with an estimate.
    const realDates = await getRealSnapshotDates();
    const estimatedTotals = totalPoints.filter((p) => !realDates.has(p.date));
    const estimatedAccounts = accountPoints.filter((p) => !realDates.has(p.date));

    await replaceEstimated(estimatedTotals);
    await replaceEstimatedAccounts(estimatedAccounts);
    await markBackfillDone();
    await clearCaches(); // cached payloads don't include the new history yet

    return NextResponse.json({
      backfilled: estimatedTotals.length,
      from: estimatedTotals.length > 0 ? estimatedTotals[estimatedTotals.length - 1].date : null,
    });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
