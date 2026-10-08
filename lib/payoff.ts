// lib/payoff.ts
//
// Debt payoff planning, for the planner on the Accounts tab
// (components/DebtPayoff.tsx): how long a set of cards and loans takes to pay
// off, and what it costs in interest, paying a steady amount each month.
//
// The model. Every figure the planner shows rests on it, so it is stated once:
//
//   - Money is whole cents. Each month, every debt that still owes something is
//     charged interest of APR / 12 on what it owes, rounded to the cent (a half
//     cent rounds up), and is then paid. Counting in cents is what makes the
//     totals reconcile exactly: what is paid toward a debt is what it owed plus
//     the interest charged on it, to the cent, debt by debt and in total.
//   - That is monthly compounding. Card issuers charge interest daily (APR / 365
//     on each day's balance, added to the balance), which comes to a little
//     more, so a card's real interest runs slightly higher than shown here.
//     Rates are used to a thousandth of a percent.
//   - Each debt's payment stays at today's amount: a card's minimum, or a loan's
//     scheduled payment. A card's required minimum usually shrinks with the
//     balance, so paying only what is required would take longer still; a
//     steady payment is the plan being modelled.
//   - The first payment is a month from now, after a month of interest. New
//     charges, fees and promotional rates are not modelled.
//
// The three plans:
//
//   minimums   Each debt gets its own payment and nothing more, and a paid-off
//              debt's payment simply stops. The baseline the others are
//              measured against.
//   avalanche  The same total every month: every debt's payment plus the extra.
//              Each debt gets its own payment, and what is left goes to the debt
//              with the highest APR until it is cleared, then to the next. A
//              cleared debt's payment joins what is left (the snowball effect),
//              so the total stays the same until the final payment.
//   snowball   As avalanche, smallest balance first.
//
// Nothing here guesses a term. A debt whose APR or payment isn't known is not
// planned until the person types one (planRows), and the simulation refuses
// out-of-range input rather than clamping it.
//
// Imports only lib/balance.ts, which imports nothing: the planner is a client
// component, so everything here is bundled for the browser.

import { isOwedType } from './balance';

/**
 * How far ahead a plan is followed, in months (50 years). A plan that hasn't
 * cleared every debt by then is reported as not paying off rather than run on:
 * a payment that doesn't cover the interest never clears its debt, so the loop
 * needs an end.
 */
export const HORIZON_MONTHS = 600;

/** The highest APR accepted, as a percentage. Rates on cards and loans sit far
 *  below it, so a figure above it is a slip (2124 typed for 21.24) and is
 *  refused rather than planned. */
export const MAX_APR = 100;

/** The largest amount accepted (a balance, a payment, the extra), in cents:
 *  $1 trillion, the manual-account limit (MAX_BALANCE in lib/manual.ts). */
export const MAX_CENTS = 100_000_000_000_000;

export type Strategy = 'avalanche' | 'snowball';
export type PlanKind = Strategy | 'minimums';

/** A debt as the simulation takes it: every term known. */
export type Debt = {
  id: string;
  /** What is owed now, in cents. Zero means nothing is owed. */
  balanceCents: number;
  /** Annual percentage rate as a percentage: 21.24 means 21.24%. */
  apr: number;
  /** What it is paid each month on its own, in cents: a card's minimum or a
   *  loan's scheduled payment. */
  minimumCents: number;
};

export type DebtOutcome = {
  id: string;
  /**
   * The payment that clears it, counted from now: 1 is the first payment, a
   * month from now. 0 means nothing was owed. Null when it isn't cleared within
   * HORIZON_MONTHS.
   */
  months: number | null;
  /** That payment's calendar month (YYYY-MM), or null. */
  month: string | null;
  /**
   * Interest charged on it until it was cleared. Null when it never is: the
   * figure would only keep growing, and a number would read as a final cost.
   */
  interestCents: number | null;
  /** Everything paid toward it (up to the horizon, when it is never cleared). */
  paidCents: number;
  /** What it still owes at the end: 0 once cleared. */
  remainingCents: number;
};

export type Plan = {
  kind: PlanKind;
  /** Months until the last debt is cleared, or null when that isn't within HORIZON_MONTHS. */
  months: number | null;
  /** The debt-free month (YYYY-MM), or null. */
  month: string | null;
  /** Total interest, or null when the plan never finishes. */
  interestCents: number | null;
  /** Total paid, or null when the plan never finishes. */
  paidCents: number | null;
  /**
   * What the plan pays a month: every debt's payment, plus the extra in a
   * strategy. A strategy pays exactly this every month but the last; paying
   * minimums only, it falls as debts are cleared.
   */
  monthlyCents: number;
  /** Each debt, in the order it is cleared. Debts never cleared come last, in the order given. */
  debts: DebtOutcome[];
  /** Total owed now (index 0) and after each month's payments, until everything
   *  is cleared or the horizon ends. */
  owedByMonth: number[];
  /** Total paid in each month: index 0 is the first payment. */
  paidByMonth: number[];
};

export type Saving = {
  /** Interest saved against paying only the minimums. Null when either plan
   *  never finishes, since there is then no finite cost to subtract. */
  interestCents: number | null;
  /** How many months sooner the debts are cleared, or null likewise. */
  months: number | null;
};

export type StrategyPlan = Plan & { saved: Saving };

export type Comparison = {
  minimums: Plan;
  avalanche: StrategyPlan;
  snowball: StrategyPlan;
};

/** An amount in currency units as whole cents. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

// An APR of r percent charges r / 100 / 12 a month. Held as whole thousandths of
// a percent (21.24% is 21240), the month's rate is that number over 1,200,000,
// which keeps the interest calculation in integers.
const RATE_DIVISOR = 1_200_000;

function aprMilli(apr: number): number {
  return Math.round(apr * 1000);
}

/** n / d rounded to the nearest whole number, a half rounding up, for
 *  non-negative integers n (below 2^53) and d. The division itself is a float,
 *  so the quotient is checked against the remainder rather than trusted. */
function divideHalfUp(n: number, d: number): number {
  let q = Math.floor(n / d);
  let r = n - q * d;
  if (r < 0) {
    q -= 1;
    r += d;
  } else if (r >= d) {
    q += 1;
    r -= d;
  }
  return 2 * r >= d ? q + 1 : q;
}

/**
 * One month's interest on a balance, in cents: balance × APR / 12, a half cent
 * rounding up. Exact rather than floating-point, so a balance that lands on a
 * half cent rounds the same way every time instead of falling either side of it.
 * The balance is split into whole multiples of the divisor and a remainder, which
 * keeps every product an exact integer for any balance the simulation accepts.
 */
function monthInterest(balanceCents: number, milli: number): number {
  let whole = Math.floor(balanceCents / RATE_DIVISOR);
  let part = balanceCents - whole * RATE_DIVISOR;
  if (part < 0) {
    whole -= 1;
    part += RATE_DIVISOR;
  } else if (part >= RATE_DIVISOR) {
    whole += 1;
    part -= RATE_DIVISOR;
  }
  return whole * milli + divideHalfUp(part * milli, RATE_DIVISOR);
}

/** The interest a debt is charged in its first month, in cents. */
export function firstInterestCents(debt: Debt): number {
  return monthInterest(debt.balanceCents, aprMilli(debt.apr));
}

/**
 * Whether a debt's own payment more than covers its first month's interest.
 * When it doesn't, paying only that never clears it: the balance holds or grows,
 * and the interest grows with it. (One that does cover it can still take longer
 * than the horizon when it covers it by only a little.)
 */
export function coversInterest(debt: Debt): boolean {
  return debt.balanceCents === 0 || debt.minimumCents > firstInterestCents(debt);
}

function isCents(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_CENTS;
}

function isApr(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= MAX_APR;
}

/** Which of a debt's terms is out of range, or null when it can be planned. */
export function debtProblem(debt: Debt): 'balance' | 'apr' | 'minimum' | null {
  if (!isCents(debt.balanceCents)) return 'balance';
  if (!isApr(debt.apr)) return 'apr';
  if (!isCents(debt.minimumCents)) return 'minimum';
  return null;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The calendar month (YYYY-MM) `n` months after `month`. */
export function addMonths(month: string, n: number): string {
  const m = MONTH.exec(month);
  if (!m || !Number.isInteger(n)) throw new RangeError(`Not a month: ${month} + ${n}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** "11 months", "1 year", "2 years 5 months". */
export function durationLabel(months: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0) return unit(rest, 'month');
  if (rest === 0) return unit(years, 'year');
  return `${unit(years, 'year')} ${unit(rest, 'month')}`;
}

type Running = {
  id: string;
  /** Position in the input, the last tie-break everywhere. */
  index: number;
  milli: number;
  minimum: number;
  owed: number;
  interest: number;
  paid: number;
  months: number | null;
};

/**
 * Which debt a strategy pays down first, then next. Fixed at the start: the
 * snowball is ordered by the balances owed now, as the method is described, not
 * re-sorted as they change. Ties go to the debt that helps more: in avalanche
 * the smaller balance (cleared sooner, freeing its payment), in snowball the
 * higher rate (costing less).
 */
function targetOrder(running: Running[], kind: PlanKind): Running[] {
  const byIndex = (a: Running, b: Running) => a.index - b.index;
  if (kind === 'avalanche') {
    return [...running].sort((a, b) => b.milli - a.milli || a.owed - b.owed || byIndex(a, b));
  }
  if (kind === 'snowball') {
    return [...running].sort((a, b) => a.owed - b.owed || b.milli - a.milli || byIndex(a, b));
  }
  return [...running].sort(byIndex);
}

/**
 * Follows one plan month by month: interest on what is owed, then each debt's
 * own payment, then (in a strategy) what is left of the month's total to the
 * targets in order. Stops once every debt is cleared or at the horizon.
 *
 * Throws a RangeError on input out of range (see debtProblem). The planner only
 * builds debts through planRows, which applies the same limits, so a throw here
 * is a bug, not something a person can type.
 */
export function simulate(
  debts: Debt[],
  kind: PlanKind,
  opts: { startMonth: string; extraCents?: number; horizon?: number }
): Plan {
  for (const d of debts) {
    const problem = debtProblem(d);
    if (problem) throw new RangeError(`Debt ${d.id}: ${problem} out of range`);
  }
  // The baseline is the plan without an extra, whatever the caller passes.
  const extra = kind === 'minimums' ? 0 : opts.extraCents ?? 0;
  if (!isCents(extra)) throw new RangeError('Extra out of range');
  const horizon = opts.horizon ?? HORIZON_MONTHS;
  addMonths(opts.startMonth, 0); // throws on a malformed start

  const running: Running[] = debts.map((d, index) => ({
    id: d.id,
    index,
    milli: aprMilli(d.apr),
    minimum: d.minimumCents,
    owed: d.balanceCents,
    interest: 0,
    paid: 0,
    months: d.balanceCents === 0 ? 0 : null,
  }));
  // Nothing is due on a debt that is already clear, so its payment is no part
  // of the month's total.
  const monthly = running.reduce((sum, r) => sum + (r.owed > 0 ? r.minimum : 0), 0) + extra;
  const order = targetOrder(running, kind);
  const owedNow = () => running.reduce((sum, r) => sum + r.owed, 0);

  const owedByMonth = [owedNow()];
  const paidByMonth: number[] = [];
  let open = running.filter((r) => r.owed > 0).length;
  for (let month = 1; month <= horizon && open > 0; month++) {
    for (const r of running) {
      if (r.owed === 0) continue;
      const interest = monthInterest(r.owed, r.milli);
      r.owed += interest;
      r.interest += interest;
    }
    let paidThisMonth = 0;
    // Each debt's own payment first, the last one only as much as is owed.
    for (const r of running) {
      if (r.owed === 0) continue;
      const pay = Math.min(r.minimum, r.owed);
      r.owed -= pay;
      r.paid += pay;
      paidThisMonth += pay;
    }
    // Then the rest of the month's total, target by target. What a cleared debt
    // no longer needs (its whole payment, or the part a final payment left over)
    // is in this rest, which is the snowball. Never negative: the payments above
    // come to at most the sum of the payments counted in `monthly`.
    if (kind !== 'minimums') {
      let spare = monthly - paidThisMonth;
      for (const r of order) {
        if (spare === 0) break;
        if (r.owed === 0) continue;
        const pay = Math.min(spare, r.owed);
        r.owed -= pay;
        r.paid += pay;
        paidThisMonth += pay;
        spare -= pay;
      }
    }
    for (const r of running) {
      if (r.owed === 0 && r.months === null) {
        r.months = month;
        open--;
      }
    }
    owedByMonth.push(owedNow());
    paidByMonth.push(paidThisMonth);
  }

  const rank = new Map(order.map((r, i) => [r, i]));
  const cleared = [...running].sort((a, b) => {
    if (a.months === null || b.months === null) {
      if (a.months === null && b.months === null) return a.index - b.index;
      return a.months === null ? 1 : -1;
    }
    return a.months - b.months || rank.get(a)! - rank.get(b)!;
  });
  const done = open === 0;
  const months = done ? Math.max(0, ...running.map((r) => r.months ?? 0)) : null;
  return {
    kind,
    months,
    month: months === null ? null : addMonths(opts.startMonth, months),
    interestCents: done ? running.reduce((sum, r) => sum + r.interest, 0) : null,
    paidCents: done ? running.reduce((sum, r) => sum + r.paid, 0) : null,
    monthlyCents: monthly,
    debts: cleared.map((r) => ({
      id: r.id,
      months: r.months,
      month: r.months === null ? null : addMonths(opts.startMonth, r.months),
      interestCents: r.months === null ? null : r.interest,
      paidCents: r.paid,
      remainingCents: r.owed,
    })),
    owedByMonth,
    paidByMonth,
  };
}

/** How a strategy compares with paying only the minimums. */
function savingAgainst(plan: Plan, minimums: Plan): Saving {
  if (plan.months === null || minimums.months === null) return { interestCents: null, months: null };
  return {
    interestCents: minimums.interestCents! - plan.interestCents!,
    months: minimums.months - plan.months,
  };
}

/**
 * Both strategies with `extraCents` on top, beside paying only the minimums
 * (which never has the extra: it is the baseline the savings are measured from).
 */
export function comparePlans(
  debts: Debt[],
  opts: { startMonth: string; extraCents?: number; horizon?: number }
): Comparison {
  const minimums = simulate(debts, 'minimums', opts);
  const strategy = (kind: Strategy): StrategyPlan => {
    const plan = simulate(debts, kind, opts);
    return { ...plan, saved: savingAgainst(plan, minimums) };
  };
  return { minimums, avalanche: strategy('avalanche'), snowball: strategy('snowball') };
}

// ---------------------------------------------------------------------------
// From the Dashboard's accounts to debts.

/** A card or loan account as the Dashboard holds it (lib/networth.ts, and
 *  toInstitutions in lib/manual.ts): only the fields read here. */
export type DebtAccountInput = {
  account_id: string;
  name: string;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balance: number | null;
  currency: string | null;
  hidden?: boolean;
  /** Manual accounts: when the balance was last typed or pushed. */
  updated_at?: string;
  /** Plaid's terms (lib/liabilities.ts), where it serves them. */
  liability?: {
    kind: 'credit' | 'student' | 'mortgage';
    apr: number | null;
    apr_label: string | null;
    minimum_payment: number | null;
  };
};

export type DebtInstitutionInput = {
  institution_name: string;
  manual?: boolean;
  /** Plaid's liabilities product on this Item: 'on' | 'off' | 'loading' |
   *  'unavailable' (lib/networth.ts). Absent on an older cached payload. */
  liabilities?: string;
  /** Set when the institution couldn't be reached and its balances were
   *  recovered: the day they are from, and the instant when known. */
  stale_as_of?: string;
  stale_as_of_at?: string;
  accounts: DebtAccountInput[];
};

/** Why Plaid supplies no terms for an account, for the hint beside the inputs. */
export type NoTermsReason =
  /** Typed by hand: there is no bank connection to ask. */
  | 'manual'
  /** Plaid's liabilities product isn't on for the institution; it can be enabled. */
  | 'not-enabled'
  /** Enabled, and Plaid is still fetching. */
  | 'loading'
  /** Plaid answers but has nothing for this account (an auto or personal loan,
   *  which its liabilities product doesn't cover). */
  | 'not-reported';

export type DebtAccount = {
  id: string;
  name: string;
  mask: string | null;
  institution: string;
  type: 'credit' | 'loan';
  subtype: string | null;
  /** Plaid's kind of liability, where it reported terms. A mortgage's payment
   *  can include escrow, which the planner says. */
  kind: 'credit' | 'student' | 'mortgage' | null;
  /** What is owed, in cents. Zero or less means nothing is owed; null that no
   *  balance was reported. */
  owedCents: number | null;
  currency: string | null;
  manual: boolean;
  /** Plaid's APR as a percentage, and which rate it is ('Purchase APR',
   *  'Highest APR', 'Interest rate'), or null. */
  plaidApr: number | null;
  plaidAprLabel: string | null;
  /** Plaid's minimum payment (a mortgage's scheduled payment), in cents, or null. */
  plaidMinimumCents: number | null;
  /** Why Plaid has no terms for it at all, or null when it has a record (which
   *  may still lack one of the two). */
  noTerms: NoTermsReason | null;
  /** The day the balance is from (and the instant, when known), when its
   *  institution couldn't be reached and the balance was recovered. */
  staleAsOf: string | null;
  staleAsOfAt: string | null;
  /** When a manual balance was last set. */
  updatedAt: string | null;
};

function finite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Every credit and loan account that isn't hidden, with the terms Plaid supplies
 * for it, in the Accounts tab's order (institution, then name). Accounts that
 * owe nothing are kept, so the planner can say why they aren't in the plan.
 */
export function debtAccounts(institutions: DebtInstitutionInput[]): DebtAccount[] {
  const out: DebtAccount[] = [];
  for (const inst of institutions) {
    for (const a of inst.accounts) {
      if (a.hidden || !isOwedType(a.type)) continue;
      const l = a.liability;
      const balance = finite(a.balance);
      const minimum = finite(l?.minimum_payment);
      out.push({
        id: a.account_id,
        name: a.name,
        mask: a.mask ?? null,
        institution: inst.institution_name,
        type: a.type as 'credit' | 'loan',
        subtype: a.subtype ?? null,
        kind: l?.kind ?? null,
        owedCents: balance === null ? null : toCents(balance),
        currency: a.currency ?? null,
        manual: !!inst.manual,
        plaidApr: finite(l?.apr),
        plaidAprLabel: l?.apr_label ?? null,
        plaidMinimumCents: minimum === null ? null : toCents(minimum),
        noTerms: l
          ? null
          : inst.manual
            ? 'manual'
            : inst.liabilities === 'off'
              ? 'not-enabled'
              : inst.liabilities === 'loading'
                ? 'loading'
                : 'not-reported',
        staleAsOf: inst.stale_as_of ?? null,
        staleAsOfAt: inst.stale_as_of ? inst.stale_as_of_at ?? null : null,
        updatedAt: inst.manual ? a.updated_at ?? null : null,
      });
    }
  }
  return out.sort(
    (x, y) =>
      x.institution.localeCompare(y.institution) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id)
  );
}

/**
 * Accounts by currency, the currency with the most accounts first. Each group is
 * planned on its own: nothing in this app converts between currencies, so one
 * plan across two would add dollars to euros. A null currency (Plaid reports an
 * unofficial one) is a group of its own.
 */
export function byCurrency(accounts: DebtAccount[]): { currency: string | null; accounts: DebtAccount[] }[] {
  const groups = new Map<string | null, DebtAccount[]>();
  for (const a of accounts) groups.set(a.currency, [...(groups.get(a.currency) ?? []), a]);
  return [...groups.entries()]
    .map(([currency, list]) => ({ currency, accounts: list }))
    .sort(
      (x, y) =>
        y.accounts.length - x.accounts.length || (x.currency ?? '￿').localeCompare(y.currency ?? '￿')
    );
}

/**
 * What the person typed for a debt's terms, as typed. A field left undefined is
 * untouched (Plaid's value stands); an empty string was cleared, and the value
 * is needed again.
 */
export type TypedTerms = { apr?: string; minimum?: string };

export type Term = {
  /** The value used: an APR as a percentage, a payment in cents. Null while it is needed. */
  value: number | null;
  /** Where the value came from. A typed value equal to Plaid's counts as Plaid's. */
  source: 'plaid' | 'typed' | null;
  /** Why what was typed can't be used. */
  error: string | null;
};

/** A typed APR as a percentage: null when empty, 'invalid' outside 0 to MAX_APR. */
export function parseApr(text: string): number | 'invalid' | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return isApr(n) ? n : 'invalid';
}

/** A typed amount in currency units, as cents: null when empty, 'invalid' when
 *  negative, not a number, or past MAX_CENTS. */
export function parseCents(text: string): number | 'invalid' | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return 'invalid';
  const cents = toCents(n);
  return isCents(cents) ? cents : 'invalid';
}

const NEEDED: Term = { value: null, source: null, error: null };

function resolve(
  plaid: number | null,
  typed: string | undefined,
  valid: (n: number) => boolean,
  parse: (t: string) => number | 'invalid' | null,
  error: string
): Term {
  if (typed === undefined) {
    // Plaid's figure, unless it is out of range: that is no rate or payment
    // anyone has, and planning on it would present a broken number as a fact.
    return plaid !== null && valid(plaid) ? { value: plaid, source: 'plaid', error: null } : NEEDED;
  }
  const parsed = parse(typed);
  if (parsed === null) return NEEDED;
  if (parsed === 'invalid') return { value: null, source: 'typed', error };
  return { value: parsed, source: parsed === plaid ? 'plaid' : 'typed', error: null };
}

/** A debt's APR: what was typed, else Plaid's, else needed. */
export function resolveApr(plaidApr: number | null, typed: string | undefined): Term {
  return resolve(plaidApr, typed, isApr, parseApr, `Enter a rate from 0 to ${MAX_APR}%.`);
}

/** A debt's monthly payment in cents: what was typed, else Plaid's, else needed. */
export function resolveMinimum(plaidCents: number | null, typed: string | undefined): Term {
  return resolve(plaidCents, typed, isCents, parseCents, 'Enter an amount of 0 or more.');
}

export type RowStatus =
  /** Owes something, both terms known: in the plan. */
  | 'ready'
  /** Owes something, and its APR or payment is still needed (or typed wrong). */
  | 'needs-terms'
  /** The person left it out of the plan. */
  | 'left-out'
  /** Owes nothing (a zero or credit balance). */
  | 'nothing-owed'
  /** No usable balance: none was reported (or one past MAX_CENTS, which no
   *  account can hold), so there is nothing to plan from. */
  | 'no-balance';

export type PlanRow = { account: DebtAccount; apr: Term; minimum: Term; status: RowStatus };

/**
 * Each account's terms and where it stands, and the debts ready to plan. The
 * plan waits while any debt still in it lacks a term (`waiting`): planning the
 * rest without it would leave a debt out of the person's totals without saying
 * so, and assuming a rate (0%, say) would be a guess presented as a fact.
 */
export function planRows(
  accounts: DebtAccount[],
  typed: Record<string, TypedTerms>,
  leftOut: Record<string, boolean>
): { rows: PlanRow[]; debts: Debt[]; waiting: number } {
  const rows: PlanRow[] = [];
  const debts: Debt[] = [];
  let waiting = 0;
  for (const account of accounts) {
    const t = typed[account.id] ?? {};
    const apr = resolveApr(account.plaidApr, t.apr);
    const minimum = resolveMinimum(account.plaidMinimumCents, t.minimum);
    const owed = account.owedCents;
    let status: RowStatus;
    if (owed === null || owed > MAX_CENTS) status = 'no-balance';
    else if (owed <= 0) status = 'nothing-owed';
    else if (leftOut[account.id]) status = 'left-out';
    else if (apr.value === null || minimum.value === null) status = 'needs-terms';
    else status = 'ready';

    if (status === 'needs-terms') waiting++;
    // Every term is in range by now (the balance just above, the rest in
    // resolveApr and resolveMinimum), so simulate never throws on these.
    if (status === 'ready') debts.push({ id: account.id, balanceCents: owed!, apr: apr.value!, minimumCents: minimum.value! });
    rows.push({ account, apr, minimum, status });
  }
  return { rows, debts, waiting };
}
