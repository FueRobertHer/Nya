// lib/fire/inputs.ts
//
// The Plan tab's automatic inputs, measured from what Nya already has, each
// with what it was measured from and what may be missing from it, for the
// label beside it. The person can override every one (lib/fire/plan.ts).
//
// SPENDING starts from the Activity tab's rule (components/MonthBreakdown.tsx
// isTransfer, unchanged there) and puts back what that rule leaves out for a
// reason that doesn't hold for planning. The Activity tab drops every loan
// payment and every ATM withdrawal so that paying a card off isn't counted as
// spending twice; but a mortgage, car or student loan payment, or cash taken
// out and spent, is money the person needs every year, and nothing else
// counts it. So here (planFlow):
//   - a payment on a loan that isn't a card counts as spending. Its principal
//     is really saving, but it is spending until the loan ends, which is the
//     year a plan starting today has to fund; the label says so.
//   - a card payment still doesn't count: it settles purchases already
//     counted on the card. A loan payment Plaid gives no detail for can't be
//     told from one, so it is left out and reported, never guessed.
//   - the loan account's side of a payment (money in, negative) stays out, so
//     a payment from a linked checking account to a linked loan counts once.
//   - cash withdrawals count (an ATM, or Plaid's "withdrawal" with no code),
//     and so do bank charges, which the Activity rule files with transfers.
//   - refunds (money back outside income) are taken off spending rather than
//     counted as income, which would overstate both.
// Pending rows count, as they do on the Activity tab; a pending row whose
// posted row has arrived was already dropped by /api/transactions
// (lib/transactions.ts supersededPendingIds), so nothing counts twice.
//
// SAVINGS is a year of income minus spending from bank data, plus what was
// contributed to workplace retirement plans (401(k) and the like), which
// usually comes out of a paycheck before it reaches a bank, measured from
// Nya's verified investment transactions. Contributions to brokerages and
// IRAs are not added: they are usually paid from a bank account, where
// income minus spending has already counted them.
//
// INVESTED ASSETS are the balances of investment accounts (and, if asked,
// checking and savings), not hidden, as the Accounts tab shows them, with
// what is stale or missing named.

import { isTransfer, type Txn } from '@/components/MonthBreakdown';
import { isInvestmentType } from '@/lib/balance';
import { dominantCurrency } from '@/lib/format';

/** The trailing window, in days (today included). */
export const TRAILING_DAYS = 365;
/** Less history than this is too little to estimate a year from. */
export const MIN_DAYS = 28;

/** How a transaction counts toward the plan's yearly figures. */
export type PlanFlow =
  /** Goods, services, bills and bank charges. */
  | 'spending'
  /** A payment on a mortgage, car, student or other loan that isn't a card. */
  | 'loan'
  /** Cash taken out, at an ATM or a teller. */
  | 'cash'
  /** Money back on spending: taken off spending. */
  | 'refund'
  | 'income'
  /** Pays a card off, settling spending already counted on the card. */
  | 'card-payment'
  /** A loan payment Plaid gives no detail for: it may be a card payment. */
  | 'unclear-loan'
  /** Between your own accounts. */
  | 'transfer';

/** How one transaction counts for planning (see the top of this file). */
export function planFlow(t: Txn): PlanFlow {
  const category = t.category ?? null;
  const sub = (t.subcategory ?? '').toLowerCase();
  if (category === 'loan payments') {
    if (t.amount <= 0) return 'transfer'; // the loan's side of a payment
    if (sub === 'credit card payment') return 'card-payment';
    return sub ? 'loan' : 'unclear-loan';
  }
  if (t.amount > 0) {
    // Plaid's transaction code, where the institution reports one, is the
    // better signal; without one, its category "transfer out" with the detail
    // "withdrawal" is cash taken out.
    if (t.transaction_code === 'atm') return 'cash';
    if (t.transaction_code === 'bank charge') return 'spending';
    if (!t.transaction_code && category === 'transfer out' && sub === 'withdrawal') return 'cash';
  }
  if (isTransfer(t)) return 'transfer';
  if (category === 'income') return 'income';
  if (t.amount > 0) return 'spending';
  // Money in that isn't income or a transfer is money back on something
  // bought. With no category at all there is no telling: it stays income.
  return category === null ? 'income' : 'refund';
}

export type TrailingFlows = {
  /** A year's spending: spending, loan payments and cash, less refunds. */
  spending: number;
  /** A year's income. */
  income: number;
  /** income - spending, from bank data alone. */
  savings: number;
  /** Parts of `spending`, a year's: loan payments and cash withdrawals
   *  included, refunds taken off. */
  loanPayments: number;
  cash: number;
  refunds: number;
  /** Loan payments NOT counted because they can't be told from card payments. */
  unclearLoans: number;
  /** The earliest transaction in the window, and today. */
  from: string;
  to: string;
  /** Days of history behind the figures, the first one and today included. */
  days: number;
  /** True when that history was under a year and the totals were scaled up. */
  scaled: boolean;
  /** Transactions counted (transfers and card payments left out). */
  count: number;
  /** The currency most of them are in, and whether others were summed with it. */
  currency: string | null;
  mixedCurrency: boolean;
};

const DAY_MS = 86_400_000;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const isoDay = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/**
 * Spending, income and savings over the trailing year, from the transactions
 * the dashboard loaded. `today` is the viewer's local calendar day
 * (lib/local-date.ts). History shorter than a year (measured from its
 * earliest row) is scaled up to a year and flagged. Null when there is too
 * little to go on: no countable transaction, or under MIN_DAYS of history.
 */
export function trailingFlows(txns: Txn[], today: string): TrailingFlows | null {
  const end = dayNumber(today);
  const start = end - (TRAILING_DAYS - 1);
  const sums: Record<PlanFlow, number> = {
    spending: 0,
    loan: 0,
    cash: 0,
    refund: 0,
    income: 0,
    'card-payment': 0,
    'unclear-loan': 0,
    transfer: 0,
  };
  let count = 0;
  let earliest = end;
  const counted: Txn[] = [];
  for (const t of txns) {
    const d = dayNumber(t.date);
    if (!(d >= start && d <= end)) continue; // also skips a malformed date
    if (d < earliest) earliest = d;
    const flow = planFlow(t);
    sums[flow] += t.amount;
    if (flow === 'transfer' || flow === 'card-payment' || flow === 'unclear-loan') continue;
    count++;
    counted.push(t);
  }
  const days = end - earliest + 1;
  if (count === 0 || days < MIN_DAYS) return null;
  const scale = days < TRAILING_DAYS ? TRAILING_DAYS / days : 1;
  // Plaid's sign: positive is money out. Refunds and income are negative.
  const spending = Math.max(0, sums.spending + sums.loan + sums.cash + sums.refund);
  const income = -sums.income;
  const currencies = new Set(counted.map((t) => t.iso_currency_code).filter((c): c is string => !!c));
  return {
    spending: spending * scale,
    income: income * scale,
    savings: (income - spending) * scale,
    loanPayments: sums.loan * scale,
    cash: sums.cash * scale,
    refunds: -sums.refund * scale,
    unclearLoans: sums['unclear-loan'] * scale,
    from: isoDay(earliest),
    to: today,
    days,
    scaled: scale !== 1,
    count,
    currency: dominantCurrency(counted),
    mixedCurrency: currencies.size > 1,
  };
}

/** An institution whose transactions could not all be read, from
 *  /api/transactions' notes ("Chase: needs to be reconnected"). A note that
 *  names no institution ("Could not load transactions.") has none. */
export type UnreadTransactions = { institution: string | null; reason: string };

export function unreadTransactions(notes: string[]): UnreadTransactions[] {
  return notes.map((note) => {
    const at = note.indexOf(': ');
    return at > 0 ? { institution: note.slice(0, at), reason: note.slice(at + 2) } : { institution: null, reason: note };
  });
}

/** The account fields this needs, as the dashboard has them. */
export type AssetAccount = {
  account_id: string;
  name: string;
  type: string;
  subtype?: string | null;
  balance: number | null;
  currency: string | null;
  hidden?: boolean;
};

/** An institution as the dashboard last loaded it, with what went wrong. */
export type AssetInstitution = {
  name: string;
  /** Plaid's Item id, for its investment activity; null for manual accounts. */
  item_id: string | null;
  /** Its last fetch failed (an error, or it needs reconnecting). */
  error: boolean;
  /** When its shown balances were last observed, if they were recovered after
   *  a failed fetch: a UTC day, and the instant when the server knew it. */
  staleAsOf: string | null;
  staleAsOfAt: string | null;
  /** Accounts it is known to have that could not be shown: recovered short,
   *  or stopped reporting. */
  missing: number;
  accounts: AssetAccount[];
};

export type CountedAccount = AssetAccount & { institution: string; item_id: string | null; balance: number };

/** Why invested assets may be short or out of date. */
export type AssetCaveat =
  /** It failed and nothing was recovered, so none of it is counted. */
  | { kind: 'unreachable'; institution: string }
  /** It failed and is counted at its last-known balances. */
  | { kind: 'stale'; institution: string; asOf: string; at: string | null }
  /** Some of its accounts could not be shown. */
  | { kind: 'missing'; institution: string; count: number };

export type InvestedAssets = {
  /** Null when no account counts. */
  total: number | null;
  /** The accounts summed, for the list under the figure. */
  accounts: CountedAccount[];
  /** Accounts that would count but have no balance to count. */
  unknown: number;
  /** Institutions whose problems may make the total short or old. */
  caveats: AssetCaveat[];
  currency: string | null;
  mixedCurrency: boolean;
};

const counts = (a: AssetAccount, includeCash: boolean) => isInvestmentType(a.type) || (includeCash && a.type === 'depository');

/**
 * Invested assets: every investment account that is not hidden, plus
 * checking and savings when `includeCash`. Credit and loan balances are not
 * subtracted: the FI number is about what can be invested and drawn on, not
 * net worth.
 *
 * An institution that failed with nothing recovered might hold investments,
 * so it is named whatever it holds, unless its accounts are known and none of
 * them would count; one counted at last-known balances is named with their
 * date.
 */
export function investedAssets(institutions: AssetInstitution[], includeCash: boolean): InvestedAssets {
  const counted: CountedAccount[] = [];
  const caveats: AssetCaveat[] = [];
  let unknown = 0;
  for (const inst of institutions) {
    const relevant = inst.accounts.filter((a) => !a.hidden && counts(a, includeCash));
    for (const a of relevant) {
      if (a.balance === null || !Number.isFinite(a.balance)) {
        unknown++;
        continue;
      }
      counted.push({ ...a, institution: inst.name, item_id: inst.item_id, balance: a.balance });
    }
    const mightHold = relevant.length > 0 || inst.accounts.length === 0;
    if (inst.error && !inst.staleAsOf && mightHold) caveats.push({ kind: 'unreachable', institution: inst.name });
    if (inst.staleAsOf && relevant.length > 0) caveats.push({ kind: 'stale', institution: inst.name, asOf: inst.staleAsOf, at: inst.staleAsOfAt });
    if (inst.missing > 0 && mightHold) caveats.push({ kind: 'missing', institution: inst.name, count: inst.missing });
  }
  const currencies = new Set(counted.map((a) => a.currency).filter((c): c is string => !!c));
  return {
    total: counted.length > 0 ? counted.reduce((s, a) => s + a.balance, 0) : null,
    accounts: counted,
    unknown,
    caveats,
    currency: dominantCurrency(counted.map((a) => ({ iso_currency_code: a.currency }))),
    mixedCurrency: currencies.size > 1,
  };
}

// Workplace retirement plans, by Plaid's account subtype: contributions to
// these are usually taken from pay before it reaches a bank account (and an
// employer's match never does), so bank income minus spending misses them.
// IRAs, brokerages and HSAs are left out: money paid into them usually comes
// from a bank account, where it has already been counted as saved.
const WORKPLACE_PLAN_SUBTYPES = new Set([
  '401a',
  '401k',
  'roth 401k',
  '403b',
  '457b',
  'thrift savings plan',
  'tsp',
  'simple ira',
  'sarsep',
  'profit sharing plan',
]);

export function isWorkplacePlan(subtype: string | null | undefined): boolean {
  return WORKPLACE_PLAN_SUBTYPES.has((subtype ?? '').toLowerCase());
}

/** One workplace plan's contributions over the trailing year, as
 *  /api/investment-activity measured them (contributions_12m). */
export type PlanContributions = {
  account_id: string;
  name: string;
  institution: string;
  /** Null when they couldn't be measured (the request failed, or Nya has
   *  no verified activity for the account). */
  amount: number | null;
  /** The first day the amount covers: a year ago, or later when Nya's
   *  verified activity starts later. */
  from: string | null;
  /** A problem reading its activity (lib/invstore.ts), shown as is. */
  note: string | null;
};

export type WorkplaceSavings = {
  /** What was measured, summed. */
  total: number;
  /** Plans measured, by "institution name". */
  measured: string[];
  /** Plans measured over less than the whole year, with the day they start. */
  partial: { name: string; from: string }[];
  /** Plans measured, but whose activity was read with a problem: may be short. */
  problems: { name: string; note: string }[];
  /** Plans that couldn't be measured at all. */
  unmeasured: string[];
};

/** The trailing year's contributions to workplace plans, summed, with what
 *  is short named. `yearAgo` is the first day of the trailing year. */
export function workplaceSavings(plans: PlanContributions[], yearAgo: string): WorkplaceSavings {
  const out: WorkplaceSavings = { total: 0, measured: [], partial: [], problems: [], unmeasured: [] };
  for (const p of plans) {
    const label = `${p.institution} ${p.name}`;
    if (p.amount === null || !Number.isFinite(p.amount)) {
      out.unmeasured.push(label);
      continue;
    }
    out.total += Math.max(0, p.amount);
    out.measured.push(label);
    if (p.note) out.problems.push({ name: label, note: p.note });
    if (p.from && p.from > yearAgo) out.partial.push({ name: label, from: p.from });
  }
  return out;
}
