// lib/budget-suggestions.ts
//
// Budget suggestions from history: beside each budget in the editor on the
// Budgets tab, and for a category or group without one, what was spent there
// on average over the last three complete months, rounded up to a round
// figure, with one tap to apply it (components/BudgetSuggestion.tsx). Pure,
// safe to import from client code; worked out on the server with the month's
// budgets (app/api/budgets/month, lib/budget-month.ts), from the stored
// history it reads anyway.
//
// BY THE SHARED SPENDING RULE. A month's spending by category is
// spendingByCategory (lib/totals.ts), as the meters count it: outflows that
// count in totals (lib/spending.ts countsInTotals), in the one currency the
// budgets are in, so transfers, cash and loan payments, what was excluded and
// what a rule hides are left out, and what is in another currency is named,
// never added. A row is filed by the category it is under now
// (lib/categories.ts filedId), a group's by the categories in it now, as a
// group's budget counts it. The average is over the months counted, a month
// with nothing spent counting as nothing, to the cent (the currency's minor
// unit), and the suggestion is that rounded up: to the unit under 100, then
// to a 5, a 50, a 500 as the average grows (from 100 up, at most 5% over it).
//
// ONLY WHAT THE STORED HISTORY REACHES. The three months before this one are
// considered. One the stored history doesn't reach whole is never counted:
// before the first month with any transaction, the month the history begins
// in (from a day after its first), or one in which a bank's stored history
// begins after it began (lib/rollover.ts MonthGap `begins`). With fewer than
// three, the suggestion is from those there are, and says which; with none,
// there is none. A month counted that may be missing transactions otherwise
// (a connection that stopped syncing, rows that couldn't be read) is
// counted, and named with why, as the budgets' notes name it: the
// suggestion may be low.
//
// WITH ROLLOVER, the suggestion is still the plain monthly average: what
// rolled over in or out is not spending (the editor says so).

import { addMonths, monthName, monthsText, type MonthGap } from './rollover';
import { spendingByCategory, type TotalsRow } from './totals';
import { leftOutByCurrency, leftOutText, type LeftOut } from './spending';
import { filedId, type CategoryIndex } from './categories';
import { minorDigits } from './manual-txn-input';
import { MAX_BUDGET_AMOUNT } from './budget-set';

/** How many complete months before this one a suggestion averages. */
export const SUGGESTION_MONTHS = 3;

export type Suggestion = {
  /** The monthly average, to the currency's minor unit. */
  average: number;
  /** The amount suggested: the average rounded up to a round figure. */
  amount: number;
};

/** Why a month the stored history doesn't reach whole isn't counted. */
export type Unreached =
  /** Before the first month with any transaction (that month, `first`). */
  | { month: string; kind: 'before'; first: string }
  /** The month the history begins in, on `first`, a day after its first. */
  | { month: string; kind: 'starts'; first: string }
  /** A bank's stored history begins after the month began. */
  | { month: string; kind: 'begins'; gaps: MonthGap[] };

export type BudgetSuggestions = {
  /** The month they are for: this month. */
  month: string;
  /** The currency every figure is in: the budgets'. */
  currency: string | null;
  /** The months averaged, oldest first. */
  months: string[];
  /** The months considered and not counted, oldest first. */
  unreached: Unreached[];
  /** Of the months averaged, those that may be incomplete, and why. */
  incomplete: { month: string; gaps: MonthGap[] }[];
  /** By category id, for each that had spending in a month averaged. */
  categories: Record<string, Suggestion>;
  /** By id, for each spending group that had spending in a month averaged. */
  groups: Record<string, Suggestion>;
  /** What the months averaged left out for being in another currency. */
  left_out: LeftOut;
};

/** The average, rounded up to a round figure (see the header): to the unit
 *  under 100, then to 5, 50, 500... (half a step of two figures). */
export function roundUp(average: number): number {
  if (!(average > 0)) return 0;
  const digits = Math.max(1, Math.floor(Math.log10(average)) + 1);
  const step = Math.max(1, 5 * 10 ** (digits - 3));
  // A hair's tolerance, so an average already on a step stays on it.
  return Math.min(Math.ceil(average / step - 1e-9) * step, MAX_BUDGET_AMOUNT);
}

/** The months a suggestion considers: the SUGGESTION_MONTHS before `month`,
 *  oldest first. */
export const consideredMonths = (month: string): string[] => Array.from({ length: SUGGESTION_MONTHS }, (_, i) => addMonths(month, i - SUGGESTION_MONTHS));

/**
 * The suggestions for `month` (see the header). `rows` are the stored rows
 * as the Activity tab assembles them, back far enough to hold the months
 * considered; `earliest` the first month with any transaction (null with
 * none); `gaps` why a month may be incomplete (lib/rollover.ts monthGapsOf).
 */
export function suggestBudgets(input: {
  month: string;
  rows: readonly (TotalsRow & { date: string })[];
  currency: string | null;
  ix: CategoryIndex;
  earliest: string | null;
  gaps: (month: string) => MonthGap[];
}): BudgetSuggestions {
  const { month, currency, ix } = input;
  const unreached: Unreached[] = [];
  const incomplete: { month: string; gaps: MonthGap[] }[] = [];
  const months: string[] = [];
  // The first day with a transaction, which only says where the history
  // begins when it is in the first month with any (lib/budget-month.ts
  // reads them from then on).
  const firstDay = input.rows.reduce<string | null>((d, t) => (d === null || t.date < d ? t.date : d), null);
  for (const m of consideredMonths(month)) {
    if (input.earliest === null || m < input.earliest) {
      unreached.push({ month: m, kind: 'before', first: input.earliest ?? month });
      continue;
    }
    if (m === input.earliest && firstDay !== null && firstDay.slice(0, 7) === m && firstDay > `${m}-01`) {
      unreached.push({ month: m, kind: 'starts', first: firstDay });
      continue;
    }
    const gaps = input.gaps(m);
    const begins = gaps.filter((g) => g.kind === 'begins');
    if (begins.length > 0) {
      unreached.push({ month: m, kind: 'begins', gaps: begins });
      continue;
    }
    months.push(m);
    if (gaps.length > 0) incomplete.push({ month: m, gaps });
  }

  const scale = 10 ** minorDigits(currency ?? 'USD');
  const counted = new Set(months);
  const inMonths = input.rows.filter((t) => counted.has(t.date.slice(0, 7)));
  const all = () => true;
  // Each month's spending by category, and by group, in minor units.
  const byCategory = new Map<string, number>();
  const byGroup = new Map<string, number>();
  for (const m of months) {
    const spent = spendingByCategory(
      inMonths.filter((t) => t.date.slice(0, 7) === m),
      all,
      currency,
      (t) => filedId(ix, t)
    );
    for (const [id, amount] of Object.entries(spent)) {
      const c = ix.byId.get(id);
      const group = c ? ix.groupById.get(c.group) : undefined;
      if (!c || !group || group.kind !== 'expense') continue;
      const minor = Math.round(amount * scale);
      byCategory.set(id, (byCategory.get(id) ?? 0) + minor);
      byGroup.set(group.id, (byGroup.get(group.id) ?? 0) + minor);
    }
  }
  const suggest = (total: number): Suggestion | null => {
    if (months.length === 0 || total <= 0) return null;
    const average = Math.round(total / months.length) / scale;
    return average > 0 ? { average, amount: roundUp(average) } : null;
  };
  const out = (m: Map<string, number>) =>
    Object.fromEntries([...m].flatMap(([id, total]) => {
      const s = suggest(total);
      return s ? [[id, s] as const] : [];
    }));
  return {
    month,
    currency,
    months,
    unreached,
    incomplete,
    categories: out(byCategory),
    groups: out(byGroup),
    left_out: leftOutByCurrency(inMonths.filter((t) => t.amount > 0), currency),
  };
}

/** What a suggestion says, for a budget in the editor or one about to be
 *  added: its line, and the notes under it. `money` writes an amount, `day`
 *  names a day or an instant ("Aug 12"). */
export function suggestionWords(
  s: BudgetSuggestions,
  target: { kind: 'category' | 'group'; id: string },
  opts: { money: (n: number) => string; day: (isoOrDay: string) => string; rolling?: boolean; gapText: (g: MonthGap) => string }
): { line: string; amount: number | null; notes: string[] } {
  const thisMonth = s.month;
  const names = (ms: readonly string[]) => monthsText(ms, thisMonth);
  const notes: string[] = [];
  const counted = s.months.length;
  if (counted === 0) {
    const first = s.unreached[0];
    const why =
      first && first.kind !== 'begins'
        ? `Nya’s transactions begin ${first.kind === 'before' ? `in ${monthName(first.first, thisMonth)}` : `on ${opts.day(first.first)}`}`
        : first
          ? first.gaps.map(opts.gapText).join('; ')
          : '';
    return { line: `No suggestion yet: there isn’t a complete month of transactions to go by${why ? ` (${why})` : ''}.`, amount: null, notes };
  }
  const found = (target.kind === 'category' ? s.categories : s.groups)[target.id];
  if (!found) return { line: `Nothing was spent here in ${names(s.months)}, so there’s no suggestion.`, amount: null, notes };
  const line = `Suggested: ${opts.money(found.amount)}, from ${counted === 1 ? `${names(s.months)} alone` : `the average of ${names(s.months)}`} (${opts.money(found.average)} a month).`;

  if (counted < SUGGESTION_MONTHS) {
    // Why the others aren't counted, once per reason: where the history
    // begins, to the day when that is known (it says the month too).
    const reasons = new Set<string>();
    const starts = s.unreached.find((u) => u.kind === 'starts');
    for (const u of s.unreached) {
      if (u.kind === 'before' && !starts) reasons.add(`Nya’s transactions begin in ${monthName(u.first, thisMonth)}`);
      else if (u.kind === 'starts') reasons.add(`Nya’s transactions begin on ${opts.day(u.first)}`);
      else if (u.kind === 'begins') for (const g of u.gaps) reasons.add(opts.gapText(g));
    }
    const left = s.unreached.map((u) => u.month);
    notes.push(`${capital(names(left))} ${left.length === 1 ? 'isn’t' : 'aren’t'} counted, as Nya’s history doesn’t reach ${left.length === 1 ? 'it' : 'them'} whole: ${[...reasons].join('; ')}.`);
  }
  for (const m of s.incomplete) {
    notes.push(`${monthName(m.month, thisMonth)} may be incomplete (${m.gaps.map(opts.gapText).join('; ')}), so this may be low.`);
  }
  const left = leftOutText(s.left_out, s.currency, { where: 'this average', plural: false });
  if (left) notes.push(left);
  if (opts.rolling) notes.push('Rollover is on: this is still the plain monthly average, with nothing that rolled over in it.');
  return { line, amount: found.amount, notes };
}

const capital = (s: string) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);
