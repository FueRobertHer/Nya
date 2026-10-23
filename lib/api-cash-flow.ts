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
// Its notes are spending's (what couldn't be read, the connections that
// bring in no transactions, in the words under the month's totals, and, as
// under the month's totals and beside the chart, how many of the range's
// transactions were imported into linked accounts from files (the bank's,
// or another app's export):
// #52, lib/api-read.ts importedNote), rows that come through the same
// assembly, each only where no bank row stands for it.
//
// WITH A HOME CURRENCY, `base` is the same answer over the rows converted
// into it, each at its own day's rate (lib/fx/totals.ts), as the app's chart
// draws it, with what was converted and what was left out for having no
// rate; version 1's own fields keep their meaning (one currency, the rest
// named).

import type { Ctx } from './containers';
import { firstDay, importedNote, readActivity, withoutTransactionsNotes, type ApiSource } from './api-read';
import { coveredOutOfDays } from './no-transactions';
import { cashFlow, inPeriod } from './cash-flow';
import { historyCount, totalsCurrency, type LeftOut } from './spending';
import { isProvisionalId, type CategoryIndex, type CategoryKind } from './categories';
import type { Txn } from './transactions';
import { readFlowFx } from './fx/read';
import { conversionIn, totalsIn } from './fx/totals';
import { flowsConverted, flowsNotes, type ApiFlowsConverted } from './fx/api-base';

/** The flows in one currency (readCashFlow). */
type Flows = {
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
};

/** The same in base_currency (see ApiCashFlow.base). */
export type ApiCashFlowBase = Omit<Flows, 'currency' | 'left_out' | 'left_out_text'> & ApiFlowsConverted;

export type ApiCashFlow = Flows & {
  from: string;
  to: string;
  /** The person's home currency, or null when they haven't chosen one. */
  base_currency: string | null;
  /** With one: the same flows converted into it, each transaction at its own
   *  day's ECB rate (or the person's own), with what was converted and what
   *  was left out for having no rate. Null without one. */
  base: ApiCashFlowBase | null;
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
  const inRange = inPeriod(opts);
  // As the app's chart has them (app/api/transactions): never the tags'
  // note, since tags change no figure here, and a bank whose files cover the
  // range in its place is counted.
  const notes = [
    ...activity.notes.filter((n) => n !== activity.tags_note),
    ...withoutTransactionsNotes(coveredOutOfDays(activity.view, opts.from, opts.to), historyCount(activity.rows), 'totals'),
  ];
  if (opts.from < firstDay()) notes.push(`Only transactions from ${firstDay()} on are read`);
  const imported = importedNote(activity.rows, opts);
  if (imported) notes.push(imported);
  const fx = await readFlowFx(ctx, activity.rows);
  let base: ApiCashFlowBase | null = null;
  if (fx) {
    const counting = totalsIn(activity.rows, fx);
    const { currency: _home, left_out, left_out_text: _text, ...flows } = flowsOf(counting.rows, inRange, fx.home, activity.ix);
    const c = conversionIn(
      counting.rows.filter((t) => inRange(t.date)),
      counting.conversion
    );
    base = { ...flows, ...flowsConverted(c!, fx, left_out) };
    notes.push(...flowsNotes(base, fx.home!));
  }
  return {
    from: opts.from,
    to: opts.to,
    ...flowsOf(activity.rows, inRange, currency, activity.ix),
    base_currency: fx?.home ?? null,
    base,
    sources: activity.sources,
    notes,
  };
}

/** The flows over rows in one currency, as the chart has them. */
function flowsOf(rows: readonly Txn[], inRange: (d: string) => boolean, currency: string | null, ix: CategoryIndex): Flows {
  const flow = cashFlow(rows, inRange, currency, ix);
  return {
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
  };
}
