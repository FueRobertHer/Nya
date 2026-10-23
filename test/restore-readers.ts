// test/restore-readers.ts
//
// A month's money out as every reader counts it, for the restore's tests of
// what counts (test/user-restore-counted.test.ts and the answers'): Activity,
// the API's transactions, spending, cash flow, a report, the food budget in
// November (the restored grocery is food, its split's parts too), and what a
// share of the restored checking account shows. Imports the readers, so a
// test file imports it dynamically, after mocking lib/storage.

import { TEST_CTX } from './fake-redis';
import { taxonomyStore } from '@/lib/category-store';
import { importedForShare } from '@/lib/history-import/read';
import { queryTransactions, readSpending, readBudgets } from '@/lib/api-read';
import { readCashFlow } from '@/lib/api-cash-flow';
import { readReport } from '@/lib/report/read';
import { resolvePeriod } from '@/lib/report/period';
import { activity, rowsOf } from './restore-run';

const ctx = TEST_CTX;

export const NOV = { from: '2025-11-01', to: '2025-11-30' };
export const JAN = { from: '2026-01-01', to: '2026-01-31' };
export const cents = (n: number) => Math.round(n * 100) / 100;

export async function foodId(): Promise<string> {
  const taxonomy = (await taxonomyStore.get(ctx))!;
  return taxonomy.categories.find((c) => c.provider_keys.some((k) => k.key === 'FOOD_AND_DRINK'))!.id;
}

export async function month(range: { from: string; to: string }) {
  const shown = rowsOf(await activity()).filter((r) => r[1] >= range.from && r[1] <= range.to);
  const page = await queryTransactions(ctx, { ...range, limit: 100 });
  const spending = await readSpending(ctx, range);
  const flow = await readCashFlow(ctx, range);
  const period = resolvePeriod({ kind: 'range', start: range.from, end: range.to }, 'UTC', Date.now());
  if ('error' in period) throw new Error(period.error);
  const report = await readReport(ctx, period);
  const out = {
    activity: cents(shown.reduce((s, r) => s + Number(r[2]), 0)),
    api: cents(page.transactions.reduce((s, t) => s + t.amount, 0)),
    spending: cents(spending.money_out),
    cash_flow: cents(flow.money_out),
    report: cents(report.totals.money_out),
  };
  if (range !== NOV) return out;
  const food = await foodId();
  const budgets = await readBudgets(ctx, { month: '2025-11' });
  return { ...out, budget: cents(budgets.budgets.find((b) => b.category_id === food)?.spent ?? 0) };
}

export const every = (n: number, range = NOV) => ({ activity: n, api: n, spending: n, cash_flow: n, report: n, ...(range === NOV ? { budget: n } : {}) });

/** What a share of the restored checking account shows of a month. */
export async function shared(range: { from: string; to: string }) {
  const read = await importedForShare(ctx, new Set(['acc_chk']), range.from);
  return cents([...(read.rows.get('acc_chk') ?? [])].filter((r) => r.date <= range.to).reduce((s, r) => s + r.amount, 0));
}
