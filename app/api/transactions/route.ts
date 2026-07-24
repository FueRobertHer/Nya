import { NextResponse } from 'next/server';
import { getItems } from '@/lib/storage';
import { readCache, writeCache, TRANSACTIONS_CACHE_KEY } from '@/lib/cache';
import { getOverrides } from '@/lib/overrides';
import { getRenames } from '@/lib/renames';
import { syncItemTransactions, type Txn } from '@/lib/transactions';

type TransactionsPayload = {
  transactions: Txn[];
  notes: string[]; // per-institution problems, shown to the user
  as_of: string;
};

export async function GET(req: Request) {
  try {
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    if (!refresh) {
      const cached = await readCache<TransactionsPayload>(TRANSACTIONS_CACHE_KEY);
      if (cached) return NextResponse.json({ ...cached, from_cache: true });
    }

    const items = await getItems();
    const [results, overrides, renames] = await Promise.all([
      Promise.all(items.map((item) => syncItemTransactions(item))),
      getOverrides(),
      getRenames(),
    ]);

    // Newest first. Within a day the posting `date` is equal, so fall back to
    // the true event `datetime` when Plaid provides it for a precise order.
    const transactions = results
      .flatMap((r) => r.txns)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        const at = a.datetime ?? '';
        const bt = b.datetime ?? '';
        return at < bt ? 1 : at > bt ? -1 : 0;
      });

    // Manual overrides win over Plaid's data: recategorization by transaction,
    // vendor rename by vendor key (so it covers every row from that merchant).
    for (const t of transactions) {
      const manual = overrides[t.transaction_id];
      if (manual) t.category = manual;
      const renamed = renames[t.vendor_key];
      if (renamed) t.name = renamed;
    }
    const notes = results.map((r) => r.note).filter((n): n is string => n !== null);

    const payload: TransactionsPayload = { transactions, notes, as_of: new Date().toISOString() };

    // Same rule as net-worth: only cache clean payloads, so syncing/reauth
    // institutions get re-checked on the next load instead of hiding for
    // the TTL.
    if (notes.length === 0) {
      await writeCache(TRANSACTIONS_CACHE_KEY, payload);
    }

    return NextResponse.json({ ...payload, from_cache: false });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
  }
}
