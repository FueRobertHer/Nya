// lib/api-cash-flow.ts
//
// The read-only API's cash flow (#41): what /api/v1/cash-flow and the MCP
// server's get_cash_flow answer. Read the way every answer built on
// transactions is read (lib/api-read.ts readActivity, the Activity tab's own
// assembly, hidden accounts left out unless asked for), and worked out by the
// flows the Activity tab's cash flow chart draws (lib/cash-flow.ts), so the
// chart, this answer and /api/v1/spending agree to the cent: money in and out
// are the same, and so is spending by category and by group, but for a row no
// category could be filed under (only past MAX_CATEGORIES), which this counts
// under the uncategorized category, as the Budgets tab does (lib/categories.ts
// filedId), where spending's categories keep its words and its groups leave it
// out. Unfolded: every payer and every category is listed; the chart's folds
// are only its own.
//
// STRICT, as the assembly is: hidden accounts or accounts' ends that can't be
// read fail the answer (lib/api-http.ts), and an institution or a manual
// account whose rows can't be read is named in sources and notes, so a short
// answer is never passed off as a period with nothing in it. It writes nothing.
//
// Its notes are spending's (what couldn't be read, and the connections that
// bring in no transactions, in the words under the month's totals), and, as
// under the month's totals and beside the chart, how many of the range's
// transactions were imported into linked accounts from the bank's files
// (#52, lib/history-import/view.ts importedRowsNote): rows that come through
// the same assembly, each only where no bank row stands for it.

import type { Ctx } from './containers';
import { firstDay, readActivity, withoutTransactionsNotes, type ApiSource } from './api-read';
import { cashFlow, inPeriod, lastDayOf } from './cash-flow';
import { monthName } from './rollover';
import { importedRowsNote } from './history-import/view';
import { totalsCurrency, type LeftOut } from './spending';
import { isProvisionalId, type CategoryKind } from './categories';

export type ApiCashFlow = {
  from: string;
  to: string;
  currency: string | null;
  money_in: number;
  money_out: number;
  net: number;
  left_over: number;
  from_savings_or_debt: number;
  payers: { name: string; amount: number; transactions: number; refund: boolean }[];
  groups: {
    id: string | null;
    name: string;
    kind: CategoryKind;
    amount: number;
    transactions: number;
    categories: { id: string | null; name: string; amount: number; transactions: number }[];
  }[];
  transactions: number;
  counted: number;
  transfers: number;
  excluded: number;
  hidden_by_rule: number;
  exclusion_unknown: number;
  left_out: LeftOut;
  left_out_text: string | null;
  sources: ApiSource[];
  notes: string[];
};

/** An id as the API shows it: null for one the app hasn't stored yet
 *  (lib/api-read.ts, CATEGORIES). */
const shownId = (id: string): string | null => (isProvisionalId(id) ? null : id);

/** The days a note speaks of: a whole month by its name ("September 2026"),
 *  as the chart names one, and any other range as this period. */
const rangeName = (from: string, to: string): string =>
  from.endsWith('-01') && to === lastDayOf(from.slice(0, 7)) ? monthName(from.slice(0, 7)) : 'this period';

/** Where money came from and went over [from, to], in one currency: by default
 *  the one most transactions are in, as the app's totals. */
export async function readCashFlow(ctx: Ctx, opts: { from: string; to: string; currency?: string; includeHidden?: boolean }): Promise<ApiCashFlow> {
  const activity = await readActivity(ctx, !!opts.includeHidden);
  const currency = opts.currency ?? totalsCurrency(activity.rows);
  const inRange = inPeriod(opts);
  const notes = [...activity.notes, ...withoutTransactionsNotes(activity.view, activity.rows.length, 'totals')];
  if (opts.from < firstDay()) notes.push(`Only transactions from ${firstDay()} on are read`);
  const imported = importedRowsNote(activity.rows.filter((t) => inRange(t.date)), rangeName(opts.from, opts.to));
  if (imported) notes.push(imported);
  const flow = cashFlow(activity.rows, inRange, currency, activity.ix);
  return {
    from: opts.from,
    to: opts.to,
    currency: flow.currency,
    money_in: flow.money_in,
    money_out: flow.money_out,
    net: flow.net,
    left_over: flow.left_over,
    from_savings_or_debt: flow.from_savings_or_debt,
    payers: flow.payers.map((p) => ({ name: p.name, amount: p.amount, transactions: p.transactions, refund: p.refund })),
    groups: flow.groups.map((g) => ({
      id: shownId(g.id),
      name: g.name,
      kind: g.kind,
      amount: g.amount,
      transactions: g.transactions,
      categories: g.categories.map((c) => ({ id: shownId(c.id), name: c.name, amount: c.amount, transactions: c.transactions })),
    })),
    transactions: flow.transactions,
    counted: flow.counted,
    transfers: flow.transfers,
    excluded: flow.excluded,
    hidden_by_rule: flow.hidden_by_rule,
    exclusion_unknown: flow.exclusion_unknown,
    left_out: flow.left_out,
    left_out_text: flow.left_out_text,
    sources: activity.sources,
    notes,
  };
}
