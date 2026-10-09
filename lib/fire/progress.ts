// lib/fire/progress.ts
//
// The FI figures from the Plan's automatic inputs, in one place, for the two
// screens that show them: the Plan tab (components/PlanTab.tsx) and the FI
// card on Home (components/FiProgressCard.tsx). Both get their inputs from
// the same hook (components/plan-inputs.ts) and their figures from here, on
// the same plan as the Plan tab repairs it (lib/fire/plan.ts repairPlan), so
// Home and the Plan always agree.
//
// The savings rate is new here, and Home's: the share of a year's income
// that was saved, over the same trailing year as the spending and savings
// figures. Contributions to workplace plans count on both sides, since they
// are income that never reached a bank account: (income + contributions -
// spending) / (income + contributions). It is an estimate, as the savings
// figure is: pre-tax contributions to a plan Nya can't see, and an
// employer's match, are in neither.
//
// Arithmetic only: no engine, no market history.

import { fiView, type FirePlan, type FiView, type Measured } from './plan';
import type { InvestedAssets, TrailingFlows, UnreadTransactions, WorkplaceSavings } from './inputs';
import { missingWhat, noSpending, withoutNote, type NoSpending, type NoTransactionsView } from '@/lib/no-transactions';
import { leftOutText } from '@/lib/spending';

/** What the Plan measures from, as the hook gathers it. */
export type FiInputs = {
  flows: TrailingFlows | null;
  /** Workplace plan contributions, null while they load. */
  workplace: WorkplaceSavings | null;
  assets: InvestedAssets;
};

/** The measured inputs a plan's figures start from (each can be typed over
 *  in the plan): spending and savings from a year of transactions, savings
 *  with workplace plan contributions added, and invested assets. */
export function measuredInputs({ flows, workplace, assets }: FiInputs): Measured {
  return {
    spending: flows?.spending ?? null,
    savings: flows ? flows.savings + (workplace?.total ?? 0) : null,
    assets: assets.total,
  };
}

/** The trailing year's savings rate (see the top of this file), or null
 *  with no year of transactions or no income to take a share of. */
export function savingsRate({ flows, workplace }: Pick<FiInputs, 'flows' | 'workplace'>): number | null {
  if (!flows) return null;
  const contributions = workplace?.total ?? 0;
  const income = flows.income + contributions;
  if (!(income > 0)) return null;
  return (flows.savings + contributions) / income;
}

/** The currency plan amounts are shown in: the accounts' own, or the
 *  transactions', or the dashboard's. */
export function planCurrency({ flows, assets }: Pick<FiInputs, 'flows' | 'assets'>, fallback: string | null): string | null {
  return assets.currency ?? flows?.currency ?? fallback;
}

/** What the figures can't compare, in a sentence, or null. Nothing is
 *  converted between currencies in this app: investments in one and spending
 *  in another can't be compared. Within either, only amounts in one currency
 *  are added up (lib/fire/inputs.ts), and the notes beside them name the
 *  rest (spendingLeftOut, assetsLeftOut). */
export function currencyNote({ flows, assets }: Pick<FiInputs, 'flows' | 'assets'>): string | null {
  if (assets.currency && flows?.currency && assets.currency !== flows.currency) {
    return `Your investments are in ${assets.currency} and your spending in ${flows.currency}. Nya doesn't convert currencies, so the FI number and your assets can't be compared.`;
  }
  return null;
}

/** What the year's spending and income leave out, as the Plan's label says
 *  it: transactions the person excluded from budgets and reports, and those
 *  in another currency, by currency. Null for each when there are none. */
export function spendingLeftOut(flows: TrailingFlows | null): { excluded: string | null; otherCurrencies: string | null } {
  if (!flows) return { excluded: null, otherCurrencies: null };
  const n = flows.excludedCount;
  return {
    excluded: n > 0 ? `Leaves out ${n} transaction${n === 1 ? '' : 's'} you excluded from budgets and reports.` : null,
    otherCurrencies: leftOutText(flows.leftOut, flows.currency, { where: 'your spending or savings' }),
  };
}

/** The invested accounts left out for being in another currency, in a
 *  sentence, or null: "1 account in CAD isn't in this figure, which is in
 *  USD." `where` names the figure, plural or not. */
export function assetsLeftOut(assets: InvestedAssets, where = 'this figure', plural = false): string | null {
  return leftOutText(assets.leftOut, assets.currency, { noun: 'account', where, plural });
}

/** What the connections that bring in no transactions mean for the figures
 *  measured from transactions (lib/no-transactions.ts), worked out the same
 *  way for the Plan tab and for Home. */
export type TransactionCoverage = {
  /** What spending lacks because a connection's bank account or card doesn't
   *  bring its transactions in ("transactions Plaid doesn't provide"), or
   *  null. */
  missing: string | null;
  /** No connection can bring spending in, and no transaction came from
   *  anywhere else: what to say in place of the figures, never "yet". */
  noSpending: NoSpending | null;
  /** With transactions entered by hand only: the connections that hold no
   *  bank account or card, named beside the figures (nothing is missing). */
  named: string | null;
};

/** The coverage from what /api/transactions says about the connections, and
 *  how many transactions there are (entered by hand included). */
export function transactionCoverage(without: NoTransactionsView, transactionCount: number): TransactionCoverage {
  return { missing: missingWhat(without), noSpending: noSpending(without, transactionCount), named: withoutNote(without, transactionCount) };
}

/** What the year's transactions are missing, for "spending is missing ...":
 *  transactions that couldn't be read, and otherwise those a connection
 *  doesn't bring in. Null when neither. */
export function transactionsMissing(unread: UnreadTransactions[], coverage: TransactionCoverage): string | null {
  return unread.length > 0 ? "transactions that couldn't be read" : coverage.missing;
}

export type FiFigures = {
  view: FiView;
  savingsRate: number | null;
  currency: string | null;
  currencyNote: string | null;
};

/** Every figure the Plan tab and Home show from a plan and its inputs. */
export function fiFigures(plan: FirePlan, inputs: FiInputs, fallbackCurrency: string | null): FiFigures {
  return {
    view: fiView(plan, measuredInputs(inputs)),
    savingsRate: savingsRate(inputs),
    currency: planCurrency(inputs, fallbackCurrency),
    currencyNote: currencyNote(inputs),
  };
}
