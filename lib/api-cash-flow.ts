// lib/api-cash-flow.ts
//
// The read-only API's cash flow (#41): what /api/v1/cash-flow and the MCP
// server's get_cash_flow answer. Read the way every answer built on
// transactions is read (lib/api-read.ts readActivity, the Activity tab's own
// assembly, hidden accounts left out unless asked for), and worked out by the
// flows the Activity tab's cash flow chart draws (lib/cash-flow.ts), so the
// chart, this answer and /api/v1/spending agree to the cent: money in and out
// are the same, and so is spending by category and by group. Unfolded: every
// payer and every category is listed; the chart's folds are only its own.
//
// STRICT, as the assembly is: hidden accounts or accounts' ends that can't be
// read fail the answer (lib/api-http.ts), and an institution or a manual
// account whose rows can't be read is named in sources and notes, so a short
// answer is never passed off as a period with nothing in it. It writes nothing.

import type { Ctx } from './containers';
import { firstDay, readActivity, withoutTransactionsNotes, type ApiSource } from './api-read';
import { cashFlow, inPeriod } from './cash-flow';
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

/** Where money came from and went over [from, to], in one currency: by default
 *  the one most transactions are in, as the app's totals. */
export async function readCashFlow(ctx: Ctx, opts: { from: string; to: string; currency?: string; includeHidden?: boolean }): Promise<ApiCashFlow> {
  const activity = await readActivity(ctx, !!opts.includeHidden);
  const currency = opts.currency ?? totalsCurrency(activity.rows);
  const notes = [...activity.notes, ...withoutTransactionsNotes(activity.view, activity.rows.length, 'totals')];
  if (opts.from < firstDay()) notes.push(`Only transactions from ${firstDay()} on are read`);
  const flow = cashFlow(activity.rows, inPeriod(opts), currency, activity.ix);
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
