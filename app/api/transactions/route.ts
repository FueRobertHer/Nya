import { NextResponse } from 'next/server';
import { plaidClient } from '@/lib/plaid';
import { decrypt } from '@/lib/crypto';
import { getItems, type StoredItem } from '@/lib/storage';
import { readCache, writeCache, TRANSACTIONS_CACHE_KEY } from '@/lib/cache';
import { getOverrides } from '@/lib/overrides';

type Txn = {
  transaction_id: string;
  date: string; // YYYY-MM-DD
  name: string;
  amount: number; // Plaid convention: positive = money leaving the account
  pending: boolean;
  account_name: string;
  institution_name: string;
  category: string | null;
};

type TransactionsPayload = {
  transactions: Txn[];
  notes: string[]; // per-institution problems, shown to the user
  as_of: string;
};

// Twelve months back, so the Activity tab's monthly breakdown can scroll
// through a full year of spending.
const LOOKBACK_DAYS = 365;

async function fetchTransactions(item: StoredItem): Promise<{ txns: Txn[]; note: string | null }> {
  let access_token: string;
  try {
    access_token = await decrypt(item.encrypted_access_token);
  } catch {
    return { txns: [], note: `${item.institution_name}: could not decrypt stored credentials` };
  }

  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  try {
    const accountNames: Record<string, string> = {};
    const txns: Txn[] = [];

    // Paginate through the whole window.
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const res = await plaidClient.transactionsGet({
        access_token,
        start_date: iso(start),
        end_date: iso(end),
        options: { count: 500, offset },
      });
      total = res.data.total_transactions;
      res.data.accounts.forEach((a) => (accountNames[a.account_id] = a.name));
      for (const t of res.data.transactions) {
        txns.push({
          transaction_id: t.transaction_id,
          date: t.date,
          name: t.merchant_name || t.name,
          amount: t.amount,
          pending: t.pending,
          account_name: accountNames[t.account_id] || '',
          institution_name: item.institution_name,
          category: t.personal_finance_category?.primary?.replace(/_/g, ' ').toLowerCase() ?? null,
        });
      }
      if (res.data.transactions.length === 0) break;
      offset += res.data.transactions.length;
    }
    return { txns, note: null };
  } catch (err: any) {
    const code = err?.response?.data?.error_code;
    if (code === 'PRODUCT_NOT_READY') {
      // Plaid is still doing the initial transaction pull for a freshly
      // linked Item -- expected for a minute or two after connecting.
      return { txns: [], note: `${item.institution_name}: transactions are still syncing — try again in a minute` };
    }
    if (code === 'ITEM_LOGIN_REQUIRED') {
      return { txns: [], note: `${item.institution_name}: needs to be reconnected` };
    }
    console.error(err?.response?.data || err);
    return { txns: [], note: `${item.institution_name}: could not fetch transactions` };
  }
}

export async function GET(req: Request) {
  try {
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    if (!refresh) {
      const cached = await readCache<TransactionsPayload>(TRANSACTIONS_CACHE_KEY);
      if (cached) return NextResponse.json({ ...cached, from_cache: true });
    }

    const items = await getItems();
    const [results, overrides] = await Promise.all([
      Promise.all(items.map(fetchTransactions)),
      getOverrides(),
    ]);

    const transactions = results
      .flatMap((r) => r.txns)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // Manual recategorizations win over Plaid's auto-categorization.
    for (const t of transactions) {
      const manual = overrides[t.transaction_id];
      if (manual) t.category = manual;
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
