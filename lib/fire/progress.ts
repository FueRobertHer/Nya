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

import { fiView, unmeasuredOf, type FirePlan, type FiView, type Measured, type Missing } from './plan';
import type { FlowSide, InvestedAssets, SideVolume, TrailingFlows, UnreadTransactions, WorkplaceSavings } from './inputs';
import { missingWhat, noSpending, withoutNote, type NoSpending, type NoTransactionsView } from '@/lib/no-transactions';
import { leftOutText, type LeftOut } from '@/lib/spending';
import { assumedText, leftOutWhy } from '@/lib/fx/totals';
import { reasonText } from '@/lib/fx/words';

/** What the Plan measures from, as the hook gathers it. */
export type FiInputs = {
  flows: TrailingFlows | null;
  /** Workplace plan contributions, null while they load. */
  workplace: WorkplaceSavings | null;
  assets: InvestedAssets;
  /** The ECB's newest rates, without a home currency, only for weighing what
   *  is left out (ShareRates); absent or null weighs by count. */
  rates?: ShareRates | null;
};

/** More than this share of what would count left out for its currency, and
 *  a measured figure isn't measured from the rest (CurrencyGap). */
export const MATERIAL_SHARE = 0.1;

/** The ECB's newest rates as the page has them (GET /api/currency `ecb.rates`:
 *  units of each currency per euro), even without a home currency. Only for
 *  weighing a share; never to show or work out a figure. Empty is none to
 *  hand (never fetched, or unusable). */
export type ShareRates = Record<string, string>;

/** A measured figure that, without a home currency, would rest on a part of
 *  what it measures: more than a tenth of what would count is in another
 *  currency than the figure's, which nothing converts. The year is weighed
 *  on each side apart, money out against the year's spending and money in
 *  against its income, and isn't measured when either is (`sides` names
 *  which), so a large income can't hide spending in another currency. A
 *  share is a matter of money, so it is weighed by amount where the ECB's
 *  newest rates price every currency in it (`judged: 'amount'`): the rates
 *  weigh the share and nothing else. Otherwise by count of transactions or
 *  accounts (`judged: 'count'`): `unrated` names the currencies the ECB
 *  publishes no rate for, and `ratesAtHand` is false when Nya has none of
 *  its rates to hand (never fetched, unusable, or still loading). With a
 *  home currency what has a rate is converted, and what has none is named
 *  (convertedNote). */
export type CurrencyGap = {
  what: 'spending' | 'assets';
  counted: number;
  leftOut: LeftOut;
  into: string | null;
  judged: 'amount' | 'count';
  unrated: string[];
  ratesAtHand: boolean;
  /** The year's sides more than a tenth of which is left out (`spending`
   *  only, and only where the year is weighed on each side). */
  sides?: FlowSide[];
};

/** Units of `currency` per euro, from the ECB's rates, or NaN. */
const perEuro = (rates: ShareRates, currency: string) => (currency === 'EUR' ? 1 : Object.hasOwn(rates, currency) ? Number(rates[currency]) : NaN);

/** What is weighed: transactions or accounts counted, and those left out by
 *  currency; with `money`, what they moved or hold, each in its own. */
type Share = { counted: number; leftOut: LeftOut; money: { counted: number; leftOut: { currency: string; amount: number }[] } | null };

const leftCount = (leftOut: LeftOut) => leftOut.reduce((n, l) => n + l.count, 0);

function gapOf<K extends string>(what: CurrencyGap['what'], shares: Record<K, Share>, into: string | null, rates: ShareRates | null | undefined): { gap: CurrencyGap; over: K[] } | null {
  const parts = Object.entries(shares) as [K, Share][];
  if (parts.every(([, s]) => leftCount(s.leftOut) === 0)) return null;
  // An empty set of rates is none to hand: the ECB publishes many.
  const at = rates && Object.keys(rates).length > 0 ? rates : null;
  const currencies = [...new Set(parts.flatMap(([, s]) => s.leftOut.map((l) => l.currency)))];
  const unrated = at && into ? [into, ...currencies].filter((c) => !(perEuro(at, c) > 0)) : [];
  const byAmount = at !== null && into !== null && unrated.length === 0 && parts.every(([, s]) => s.money !== null);
  const isOver = (s: Share) => {
    const left = leftCount(s.leftOut);
    if (left === 0) return false;
    if (byAmount) {
      // Each currency left out, in the figure's at the newest rates: weighed,
      // never added to it.
      const away = s.money!.leftOut.reduce((n, l) => n + (l.amount * perEuro(at!, into!)) / perEuro(at!, l.currency), 0);
      const total = s.money!.counted + away;
      return total > 0 && away > MATERIAL_SHARE * total;
    }
    return left > MATERIAL_SHARE * (s.counted + left);
  };
  const over = parts.filter(([, s]) => isOver(s));
  if (over.length === 0) return null;
  const byCurrency = new Map<string, number>();
  for (const [, s] of over) for (const l of s.leftOut) byCurrency.set(l.currency, (byCurrency.get(l.currency) ?? 0) + l.count);
  const leftOut = [...byCurrency].map(([currency, count]) => ({ currency, count })).sort((a, b) => b.count - a.count || (a.currency < b.currency ? -1 : 1));
  return {
    gap: {
      what,
      counted: over.reduce((n, [, s]) => n + s.counted, 0),
      leftOut,
      into,
      judged: byAmount ? 'amount' : 'count',
      unrated: byAmount ? [] : [...new Set(unrated)],
      ratesAtHand: at !== null,
    },
    over: over.map(([k]) => k),
  };
}

/** The year's spending, income and savings, when they would rest on a part:
 *  more than a tenth of its money out, or of its money in, left out. */
export function spendingGap(flows: TrailingFlows | null, rates?: ShareRates | null): CurrencyGap | null {
  if (!flows || flows.conversion) return null;
  const v = flows.volume;
  if (!v) return gapOf('spending', { year: { counted: flows.count, leftOut: flows.leftOut, money: null } }, flows.currency, rates)?.gap ?? null;
  const side = (s: SideVolume): Share => ({ counted: s.count, leftOut: s.leftOut.map((l) => ({ currency: l.currency, count: l.count })), money: { counted: s.counted, leftOut: s.leftOut } });
  const found = gapOf('spending', { spending: side(v.spending), income: side(v.income) }, flows.currency, rates);
  return found ? { ...found.gap, sides: found.over } : null;
}

/** Invested assets, when they would rest on a part. */
export function assetsGap(assets: InvestedAssets, rates?: ShareRates | null): CurrencyGap | null {
  if (assets.conversion) return null;
  const money = assets.leftOutBalances ? { counted: assets.total ?? 0, leftOut: assets.leftOutBalances } : null;
  return gapOf('assets', { assets: { counted: assets.accounts.length, leftOut: assets.leftOut, money } }, assets.currency, rates)?.gap ?? null;
}

const joinAnd = (parts: readonly string[]) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** Why a figure isn't measured, and what to do: never an amount. `as`:
 *  the year's figures said for savings and the savings rate (`year`), or the
 *  savings rate alone (`rate`, savings typed), rather than for spending, so
 *  the words never point at a spending figure that was typed. */
export function gapText(g: CurrencyGap, as: 'figure' | 'year' | 'rate' = 'figure'): string {
  const left = g.leftOut.reduce((n, l) => n + l.count, 0);
  const noun = g.what === 'spending' ? 'transaction' : 'account';
  const these = joinAnd(g.leftOut.map((l, i) => (i === 0 ? `${l.count} ${noun}${l.count === 1 ? '' : 's'}` : `${l.count}`) + ` in ${l.currency}`));
  const when = g.what === 'spending' ? ' this year' : '';
  const them = left === 1 ? 'it' : 'them';
  const judged =
    g.judged === 'amount'
      ? ', by amount at the ECB’s newest rates (used only to weigh it)'
      : g.unrated.length > 0
        ? `, by count, as the ECB publishes no rate for ${joinAnd(g.unrated)}`
        : !g.ratesAtHand
          ? ', by count, as Nya doesn’t have the ECB’s rates at hand'
          : ', by count';
  // Which side of the year is left out, where it was weighed on each.
  const sides = g.what === 'spending' ? (g.sides ?? []) : [];
  const onlyIncome = sides.length === 1 && sides[0] === 'income';
  const whole = sides.length === 0 ? 'what would count' : sides.length === 2 ? 'both the year’s spending and its income' : `the year’s ${sides[0]}`;
  const share = `more than a tenth of ${whole}${judged}, is in another currency than ${g.into ? `the Plan’s, ${g.into}` : 'the rest'} (${these}${when})`;
  const convert = `Choose a home currency on the Currency card under Manage on the Accounts tab to convert ${them}`;
  if (g.what === 'spending' && as === 'rate') {
    return `The savings rate isn’t measured: ${share}. Without a home currency nothing is converted, so a rate from the rest would leave that much of the year out. ${convert}.`;
  }
  if (g.what === 'spending' && as === 'year') {
    return `The year’s income and savings aren’t measured: ${share}. Without a home currency nothing is converted, so figures from the rest would leave that much of the year out. ${convert}, or type your savings.`;
  }
  const of = g.what === 'assets' ? 'your investments' : sides.length === 2 ? 'your spending and income' : onlyIncome ? 'your income' : 'your spending';
  // Only the income left out: the spending figure is the year's, measured
  // with it, so the year's figures are what would leave it out.
  const from = onlyIncome ? 'the year’s figures from the rest' : 'a figure from the rest';
  const type = g.what === 'spending' ? 'your spending' : 'your invested assets';
  return `Not measured: ${share}. Without a home currency nothing is converted, so ${from} would leave that much of ${of} out. ${convert}, or type ${type}.`;
}

/** What isn't worked out because an input isn't measured, and why: the
 *  figures that rest on it are left out, never worked out from zero. */
export function notWorkedOutText(view: Pick<FiView, 'spending' | 'savings' | 'assets'>, where: 'below' | 'above'): string | null {
  const what = notMeasuredWhat(view);
  return what ? `Not worked out: ${what} measured (${where}), and a figure that isn’t measured is never counted as zero.` : null;
}

/** "your invested assets aren’t", "your savings aren’t", or both: what a
 *  figure resting on them waits for, or null. */
export function notMeasuredWhat(view: Pick<FiView, 'spending' | 'savings' | 'assets'>): string | null {
  const off = unmeasuredOf(view).filter((k) => k !== 'spending');
  if (off.length === 0) return null;
  return off.length === 2 ? 'your invested assets and savings aren’t' : off[0] === 'assets' ? 'your invested assets aren’t' : 'your savings aren’t';
}

/** What the simulation needs (enginePlan's `missing`) when it is there but
 *  isn't measured, in words ("your invested assets, which aren’t
 *  measured"), or null when it is simply not there. Said alike on the
 *  simulation card and in compare mode, never as none to count. */
export function unmeasuredNeed(missing: Missing, view: Pick<FiView, 'spending' | 'assets'>): string | null {
  if (missing === 'assets' && view.assets.source === 'unmeasured') return 'your invested assets, which aren’t measured';
  if (missing === 'spending' && view.spending.source === 'unmeasured') return 'your annual spending, which isn’t measured';
  return null;
}

/** The measured inputs a plan's figures start from (each can be typed over
 *  in the plan): spending and savings from a year of transactions, savings
 *  with workplace plan contributions added, and invested assets. None from
 *  a part of what it measures (spendingGap, assetsGap): the FI number,
 *  progress and years to FI then wait for a home currency or a typed figure. */
export function measuredInputs({ flows, workplace, assets, rates }: FiInputs): Measured {
  const yearGap = spendingGap(flows, rates) !== null;
  const assetsOff = assetsGap(assets, rates) !== null;
  const unmeasured = [...(yearGap ? (['spending', 'savings'] as const) : []), ...(assetsOff ? (['assets'] as const) : [])];
  return {
    spending: flows && !yearGap ? flows.spending : null,
    savings: flows && !yearGap ? flows.savings + (workplace?.total ?? 0) : null,
    assets: assetsOff ? null : assets.total,
    ...(unmeasured.length > 0 ? { unmeasured } : {}),
  };
}

/** The trailing year's savings rate (see the top of this file), or null
 *  with no year of transactions or no income to take a share of, or when
 *  the year would rest on a part of it (spendingGap). */
export function savingsRate({ flows, workplace, rates }: Pick<FiInputs, 'flows' | 'workplace' | 'rates'>): number | null {
  if (!flows || spendingGap(flows, rates)) return null;
  const contributions = workplace?.total ?? 0;
  const income = flows.income + contributions;
  if (!(income > 0)) return null;
  return (flows.savings + contributions) / income;
}

/** The currency plan amounts are shown in: the Plan's own once recorded
 *  (the inputs are then all in it, lib/fire/plan-currency.ts), else the
 *  accounts' own, or the transactions', or the dashboard's. A home currency
 *  doesn't change it: what is in other currencies is converted into it
 *  (lib/fire/inputs.ts), so what the person typed is never relabelled. */
export function planCurrency({ flows, assets }: Pick<FiInputs, 'flows' | 'assets'>, fallback: string | null): string | null {
  return assets.currency ?? flows?.currency ?? fallback;
}

/** What the figures can't compare, in a sentence, or null. Without a home
 *  currency the Plan converts nothing: investments in one currency and
 *  spending in another can't be compared. Within either, only amounts in one
 *  currency are added up (lib/fire/inputs.ts), and the notes beside them
 *  name the rest (spendingLeftOut, assetsLeftOut). With one, both are in the
 *  Plan's currency, and convertedNote says what was converted. */
export function currencyNote({ flows, assets }: Pick<FiInputs, 'flows' | 'assets'>): string | null {
  if (assets.currency && flows?.currency && assets.currency !== flows.currency) {
    return `Your investments are in ${assets.currency} and your spending in ${flows.currency}. Without a home currency the Plan doesn't convert between them, so the FI number and your assets can't be compared. Choose one on the Currency card under Manage on the Accounts tab to convert them.`;
  }
  return null;
}

const join = (parts: readonly string[]) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const counted = (list: { currency: string; count: number }[], noun: string) =>
  join(list.map((f, i) => (i === 0 ? `${f.count} ${noun}${f.count === 1 ? '' : 's'} in ${f.currency}` : `${f.count} in ${f.currency}`)));

/** What the Plan converted into its currency, with a home currency, in a
 *  sentence, or null when nothing was: "The Plan is in USD, so what is in
 *  other currencies is converted into it: spending and income at each day's
 *  ECB rate (40 transactions in EUR), and invested assets at the ECB's
 *  newest rates (2 accounts in EUR)." Never an amount. */
export function convertedNote({ flows, assets }: Pick<FiInputs, 'flows' | 'assets'>): string | null {
  const fc = flows?.conversion ?? null;
  const ac = assets.conversion ?? null;
  const parts: string[] = [];
  if (fc && fc.from.length > 0) {
    const own = fc.own.length > 0 ? `, and your own rate for ${join(fc.own)},` : '';
    parts.push(`spending and income at each day's ECB rate${own} (${counted(fc.from, 'transaction')})`);
  }
  if (ac && ac.from.length > 0) {
    const own = ac.own.length > 0 ? `, and your own rate for ${join(ac.own)},` : '';
    parts.push(`invested assets at the ECB's newest rates${own} (${counted(ac.from, 'account')})`);
  }
  // Rows that say no currency, counted in the main one: said too.
  const assumed = assumedText(fc);
  if (parts.length === 0) return assumed;
  const into = fc?.into ?? ac?.into;
  return `The Plan is in ${into}, so what is in other currencies is converted into it: ${join(parts)}.${assumed ? ` ${assumed}` : ''}`;
}

/** What the year's spending and income leave out, as the Plan's label says
 *  it: transactions the person excluded from budgets and reports, those a
 *  rule hides, as the Activity tab tells them apart, and those in another
 *  currency, by currency. Null for each when there are none. */
export function spendingLeftOut(flows: TrailingFlows | null): { excluded: string | null; otherCurrencies: string | null } {
  if (!flows) return { excluded: null, otherCurrencies: null };
  const byRule = flows.hiddenCount ?? 0;
  const byYou = flows.excludedCount - byRule;
  const words = (n: number) => `${n} transaction${n === 1 ? '' : 's'}`;
  const parts = [...(byYou > 0 ? [`${words(byYou)} you excluded from budgets and reports`] : []), ...(byRule > 0 ? [byYou > 0 ? `${byRule} a rule hides` : `${words(byRule)} a rule hides`] : [])];
  return {
    excluded: parts.length > 0 ? `Leaves out ${parts.join(' and ')}.` : null,
    otherCurrencies: leftOutWhy(leftOutText(flows.leftOut, flows.currency, { where: 'your spending or savings' }), flows.conversion ?? null),
  };
}

/** The invested accounts left out for being in another currency, in a
 *  sentence, or null: "1 account in CAD isn't in this figure, which is in
 *  USD." `where` names the figure, plural or not. */
export function assetsLeftOut(assets: InvestedAssets, where = 'this figure', plural = false): string | null {
  const text = leftOutText(assets.leftOut, assets.currency, { noun: 'account', where, plural });
  const c = assets.conversion ?? null;
  // With a home currency, why each has no rate (lib/fx/words.ts).
  if (text === null || !c || c.unrated.length === 0) return text;
  return `${text.replace(/\.$/, '')}: ${c.unrated.map((u) => reasonText(u.currency, u.why, u.unrated, c.into)).join('; ')}.`;
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
  /** What was converted into the Plan's currency (convertedNote). */
  convertedNote: string | null;
};

/** Every figure the Plan tab and Home show from a plan and its inputs. */
export function fiFigures(plan: FirePlan, inputs: FiInputs, fallbackCurrency: string | null): FiFigures {
  return {
    view: fiView(plan, measuredInputs(inputs)),
    savingsRate: savingsRate(inputs),
    currency: planCurrency(inputs, fallbackCurrency),
    currencyNote: currencyNote(inputs),
    convertedNote: convertedNote(inputs),
  };
}
