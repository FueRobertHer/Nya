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
  /** Interest saved against the plan compared with. Null when either plan
   *  never finishes, since there is then no finite cost to subtract. */
  interestCents: number | null;
  /** How many months sooner the debts are cleared, or null likewise. */
  months: number | null;
};

export type StrategyPlan = Plan & {
  /** Against paying only the minimums: the extra and the rollover together. */
  saved: Saving;
  /** What the extra alone buys: this order with the extra against the same
   *  order without it. Null when there is no extra. */
  extraSaved: Saving | null;
};

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

/** How a plan compares with another: what it saves in interest and months. */
function savingAgainst(plan: Plan, base: Plan): Saving {
  if (plan.months === null || base.months === null) return { interestCents: null, months: null };
  return {
    interestCents: base.interestCents! - plan.interestCents!,
    months: base.months - plan.months,
  };
}

/**
 * Both strategies with `extraCents` on top, beside paying only the minimums
 * (which never has the extra: it is the baseline the savings are measured from).
 * With an extra, each strategy is also followed without it, so what the extra
 * alone buys can be told apart from what rolling payments over buys.
 */
export function comparePlans(
  debts: Debt[],
  opts: { startMonth: string; extraCents?: number; horizon?: number }
): Comparison {
  const minimums = simulate(debts, 'minimums', opts);
  const extra = opts.extraCents ?? 0;
  const strategy = (kind: Strategy): StrategyPlan => {
    const plan = simulate(debts, kind, opts);
    const withoutExtra = extra > 0 ? simulate(debts, kind, { ...opts, extraCents: 0 }) : null;
    return {
      ...plan,
      saved: savingAgainst(plan, minimums),
      extraSaved: withoutExtra ? savingAgainst(plan, withoutExtra) : null,
    };
  };
  return { minimums, avalanche: strategy('avalanche'), snowball: strategy('snowball') };
}

/**
 * `total` split in proportion to `weights`, in whole units that add up to
 * exactly `total`: each part is its share rounded down, and the units left over
 * go one each to the largest remainders (the earlier part on a tie). Integer
 * arithmetic throughout (BigInt, since total × weight can pass 2^53), so the
 * parts never drift from the total. Weights must be non-negative integers with
 * a positive sum.
 */
export function splitByWeight(total: number, weights: number[]): number[] {
  const t = BigInt(total);
  const sum = weights.reduce((s, w) => s + BigInt(w), BigInt(0));
  const parts = weights.map((w) => (t * BigInt(w)) / sum);
  const remainders = weights.map((w, i) => t * BigInt(w) - parts[i] * sum);
  let left = total - parts.reduce((s, p) => s + Number(p), 0);
  const byRemainder = weights
    .map((_, i) => i)
    .sort((a, b) => (remainders[b] > remainders[a] ? 1 : remainders[b] < remainders[a] ? -1 : a - b));
  const out = parts.map(Number);
  for (const i of byRemainder) {
    if (left === 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

/**
 * A fixed-rate loan's scheduled payment, in cents: the amortization payment
 * r × P / (1 - (1 + r)^-n) for its original amount, rate and term in months,
 * rounded to the cent (at 0%, the amount over the term, rounded up).
 */
export function scheduledPaymentCents(principal: number, apr: number, months: number): number {
  if (apr === 0) return Math.ceil(toCents(principal) / months);
  const r = apr / 1200;
  return Math.round(((r * principal) / (1 - Math.pow(1 + r, -months))) * 100);
}

/**
 * A loan term in months, or null. Plaid's example is "30 year", but the field
 * comes from the servicer as written, so "30-year", "30 years", "30yr" and
 * "360 months" are read too.
 */
export function termMonths(term: string | null | undefined): number | null {
  const m = typeof term === 'string' ? /^\s*(\d+)[\s-]*(year|yr|month|mo)s?\b/i.exec(term) : null;
  if (!m) return null;
  const months = /^y/i.test(m[2]) ? Number(m[1]) * 12 : Number(m[1]);
  return months > 0 && months <= HORIZON_MONTHS ? months : null;
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
    last_statement_balance?: number | null;
    last_statement_issue_date?: string | null;
    last_payment_amount?: number | null;
    last_payment_date?: string | null;
    outstanding_interest?: number | null;
    escrow_balance?: number | null;
    apr_balances?: { type: string | null; rate: number; balance: number }[];
    origination_principal_amount?: number | null;
    loan_term?: string | null;
    interest_rate_type?: string | null;
  };
};

export type DebtInstitutionInput = {
  institution_name: string;
  /** Plaid's institution id; absent on manual and older cached institutions. */
  institution_id?: string | null;
  manual?: boolean;
  /** Plaid's liabilities product on this Item: 'on' | 'off' | 'loading' |
   *  'unavailable' (lib/networth.ts). Absent on an older cached payload. */
  liabilities?: string;
  /** Set when the institution couldn't be loaded this time (lib/networth.ts). */
  error?: string | null;
  /** Set when the institution couldn't be reached and its balances were
   *  recovered: the day they are from, and the instant when known. */
  stale_as_of?: string;
  stale_as_of_at?: string;
  /** Set instead when the last balances are too old to show. */
  stale_too_old?: string;
  stale_too_old_at?: string;
  /** Accounts that couldn't be recovered with the rest (lib/last-known.ts). */
  stale_missing?: number;
  /** Accounts missing from an otherwise good answer (lib/vanished.ts). */
  unconfirmed_missing?: number;
  accounts: DebtAccountInput[];
};

/** Why Plaid supplies no terms for an account, for the hint beside the inputs. */
export type NoTermsReason =
  /** Typed by hand: there is no bank connection to ask. */
  | 'manual'
  /** The institution couldn't be reached, and its balances were recovered
   *  (lib/last-known.ts): recovered accounts carry no terms. */
  | 'unreachable'
  /** Plaid's liabilities product isn't on for the institution; it can be enabled. */
  | 'not-enabled'
  /** Enabled, and Plaid is still fetching. */
  | 'loading'
  /** Plaid answered with nothing for this account: a loan its liabilities
   *  product doesn't cover (auto, personal), or a fetch that failed this time. */
  | 'not-reported';

/** Why Plaid's minimum isn't planned on as it is. */
export type MinimumHold =
  /** A mortgage whose payment includes escrow (Plaid reports a positive escrow
   *  balance). Taxes and insurance don't pay down the loan, and planned as part
   *  of the payment they would roll into the next debt once it is cleared. */
  | 'escrow'
  /** A mortgage whose payment may include escrow: Plaid reports the whole
   *  payment and no split, so it can't be planned on until the person says. */
  | 'escrow-unknown'
  /** Plaid shows $0, which is more often a reporting artifact than a payment:
   *  autopay at some servicers (Plaid names Navient and Firstmark), nothing due
   *  this cycle, or a deferment. */
  | 'zero'
  /** Student loans showing the same minimum at a servicer Plaid doesn't name
   *  as billing one payment across loans: whether it is one payment or one
   *  each is the person's to say (PlanChoices.sharedSplit). */
  | 'shared';

export type DebtAccount = {
  id: string;
  name: string;
  mask: string | null;
  institution: string;
  type: 'credit' | 'loan';
  subtype: string | null;
  /** Plaid's kind of liability, where it reported terms. */
  kind: 'credit' | 'student' | 'mortgage' | null;
  /** The balance as reported, in cents. Zero or less means nothing is owed;
   *  null that none was reported. For a loan it is principal only (Sallie Mae's
   *  student loans aside), so a student loan's accrued interest is apart. */
  balanceCents: number | null;
  /**
   * A student loan's accrued interest (Plaid's outstanding_interest_amount), in
   * cents, which the person owes on top of the balance and which is planned as
   * owed unless they leave it out. Null when there is none, or when it is in
   * the balance already: Plaid says Sallie Mae's balances include it and return
   * no separate figure, and the institution id is checked as well.
   */
  accruedInterestCents: number | null;
  currency: string | null;
  manual: boolean;
  /** The APR the plan uses unless something is typed, as a percentage, and
   *  which rate it is ('Purchase APR', 'Highest APR', 'Interest rate', or
   *  'Blended APR' for a card with balances at several rates). */
  plaidApr: number | null;
  plaidAprLabel: string | null;
  /** The rates a blended APR is made of, each with what it applied to. */
  aprParts: { type: string | null; rate: number; balance: number }[] | null;
  /** Plaid's minimum (a mortgage's whole monthly payment) as reported, in cents. */
  plaidMinimumCents: number | null;
  /**
   * The payment the plan uses unless something is typed, in cents: Plaid's
   * minimum, or a share of one payment Plaid shows on several loans
   * (sharedMinimum). Null while it is needed, including when Plaid's figure
   * can't be planned on as it is (minimumHold).
   */
  defaultMinimumCents: number | null;
  minimumHold: MinimumHold | null;
  /**
   * One minimum Plaid shows on two or more student loans at this institution.
   * Plaid documents that some servicers bill one payment across all of an
   * account's loans and show it on each loan, and names them (`named`): there
   * it is split across the loans by balance (`shareCents` is this loan's part)
   * rather than counted once per loan. Elsewhere the same figure on several
   * loans may be either, so the payment is held until the person says which,
   * for the whole group at once (`group`).
   */
  sharedMinimum: { totalCents: number; loans: number; shareCents: number; group: string; named: boolean } | null;
  /** A fixed-rate mortgage's principal-and-interest payment worked out from its
   *  original amount, term and rate: offered when the payment is needed, never
   *  assumed. */
  workedOut: { cents: number; principal: number; months: number; apr: number } | null;
  /** A mortgage's escrow balance as reported, in cents, for the reason shown. */
  escrowCents: number | null;
  /**
   * A card whose last payment covered its last statement and came on or after
   * it: paid in full at that statement, so no interest is charged while that
   * continues. It starts out of the plan, and the person can put it in.
   */
  paidInFull: boolean;
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

/** Plaid's institution id for Sallie Mae, whose student loan balances already
 *  include accrued interest (Plaid's AccountBalance.current documentation). */
const SALLIE_MAE = 'ins_116944';

function finite(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** A YYYY-MM-DD date, which then compares correctly as a string. */
function isDay(d: unknown): d is string {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

/**
 * A card's rates weighted by the part of the balance each applied to last
 * statement, when it reports two or more: a 0% promotional balance beside a
 * purchase balance would otherwise be charged the purchase APR in full. With
 * one, creditApr's pick stands (lib/liabilities.ts): a lone cash balance says
 * nothing about the rate new purchases will be charged.
 */
function blendedApr(
  parts: { type: string | null; rate: number; balance: number }[] | undefined
): { rate: number; parts: { type: string | null; rate: number; balance: number }[] } | null {
  if (!parts || parts.length < 2) return null;
  const total = parts.reduce((s, p) => s + p.balance, 0);
  if (!(total > 0)) return null;
  const rate = Math.round((parts.reduce((s, p) => s + p.rate * p.balance, 0) / total) * 1000) / 1000;
  return isApr(rate) ? { rate, parts } : null;
}

function toDebtAccount(inst: DebtInstitutionInput, a: DebtAccountInput): DebtAccount {
  const l = a.liability;
  const kind = l?.kind ?? null;
  const balance = finite(a.balance);
  const balanceCents = balance === null ? null : toCents(balance);
  const minimum = finite(l?.minimum_payment);
  const plaidMinimumCents = minimum === null ? null : toCents(minimum);

  const accrued = kind === 'student' && inst.institution_id !== SALLIE_MAE ? finite(l?.outstanding_interest) : null;
  const blend = kind === 'credit' ? blendedApr(l?.apr_balances) : null;
  const escrow = kind === 'mortgage' ? finite(l?.escrow_balance) : null;

  let hold: MinimumHold | null = null;
  if (plaidMinimumCents === 0 && balanceCents !== null && balanceCents > 0) hold = 'zero';
  else if (kind === 'mortgage' && plaidMinimumCents !== null) hold = escrow !== null && escrow > 0 ? 'escrow' : 'escrow-unknown';

  let workedOut: DebtAccount['workedOut'] = null;
  const months = termMonths(l?.loan_term);
  const original = finite(l?.origination_principal_amount);
  const rate = finite(l?.apr);
  if (
    kind === 'mortgage' &&
    months !== null &&
    original !== null &&
    original > 0 &&
    rate !== null &&
    isApr(rate) &&
    l?.interest_rate_type?.toLowerCase() === 'fixed'
  ) {
    const cents = scheduledPaymentCents(original, rate, months);
    if (isCents(cents)) workedOut = { cents, principal: original, months, apr: rate };
  }

  // Paid in full: the last payment covered the last statement and came on or
  // after it. A payment before the statement was on an earlier one, and a
  // card carrying a balance can make a large one of those and still revolve.
  // Without both dates it can't be told, so the card is planned with interest.
  const lastPayment = finite(l?.last_payment_amount);
  const lastStatement = finite(l?.last_statement_balance);
  const paidOn = isDay(l?.last_payment_date) ? l!.last_payment_date! : null;
  const issuedOn = isDay(l?.last_statement_issue_date) ? l!.last_statement_issue_date! : null;
  const paidInFull =
    kind === 'credit' &&
    lastPayment !== null &&
    lastStatement !== null &&
    lastStatement >= 0 &&
    lastPayment >= lastStatement &&
    paidOn !== null &&
    issuedOn !== null &&
    paidOn >= issuedOn;

  return {
    id: a.account_id,
    name: a.name,
    mask: a.mask ?? null,
    institution: inst.institution_name,
    type: a.type as 'credit' | 'loan',
    subtype: a.subtype ?? null,
    kind,
    balanceCents,
    accruedInterestCents: accrued !== null && accrued > 0 ? toCents(accrued) : null,
    currency: a.currency ?? null,
    manual: !!inst.manual,
    plaidApr: blend ? blend.rate : finite(l?.apr),
    plaidAprLabel: blend ? 'Blended APR' : l?.apr_label ?? null,
    aprParts: blend ? blend.parts : null,
    plaidMinimumCents,
    defaultMinimumCents: hold ? null : plaidMinimumCents,
    minimumHold: hold,
    sharedMinimum: null,
    workedOut,
    escrowCents: escrow === null ? null : toCents(escrow),
    paidInFull,
    noTerms: l
      ? null
      : inst.manual
        ? 'manual'
        : inst.stale_as_of
          ? 'unreachable'
          : inst.liabilities === 'off'
            ? 'not-enabled'
            : inst.liabilities === 'loading'
              ? 'loading'
              : 'not-reported',
    staleAsOf: inst.stale_as_of ?? null,
    staleAsOfAt: inst.stale_as_of ? inst.stale_as_of_at ?? null : null,
    updatedAt: inst.manual ? a.updated_at ?? null : null,
  };
}

/**
 * One institution's student loans that show the same minimum: Plaid documents
 * that some servicers (Great Lakes, Firstmark and others) bill one payment
 * across all of an account's loans and show that payment on each loan. Counted
 * once per loan, four loans sharing $400 would be planned at $1,600 a month.
 * At the servicers Plaid names, the payment is split across them by balance
 * (the person can type each loan's own payment if they are billed
 * separately). Anywhere else a matching figure may just be loans with the same
 * minimum, so the payment is held until the person says which it is.
 */
function splitSharedMinimums(accounts: DebtAccount[], institutionId: string | null | undefined): void {
  const named = !!institutionId && SHARED_MINIMUM_SERVICERS.has(institutionId);
  const byMinimum = new Map<number, DebtAccount[]>();
  for (const a of accounts) {
    const m = a.defaultMinimumCents;
    if (a.kind !== 'student' || m === null || !isCents(m) || m <= 0) continue;
    if (a.balanceCents === null || a.balanceCents <= 0 || !isCents(a.balanceCents)) continue;
    byMinimum.set(m, [...(byMinimum.get(m) ?? []), a]);
  }
  for (const [total, loans] of byMinimum) {
    if (loans.length < 2) continue;
    const shares = splitByWeight(
      total,
      loans.map((l) => l.balanceCents!)
    );
    // The loans themselves name the group, so a choice made for it applies
    // to exactly these loans, and lapses if one of them stops matching.
    const group = loans
      .map((l) => l.id)
      .sort()
      .join(' ');
    loans.forEach((l, i) => {
      l.sharedMinimum = { totalCents: total, loans: loans.length, shareCents: shares[i], group, named };
      if (named) {
        l.defaultMinimumCents = shares[i];
      } else {
        l.defaultMinimumCents = null;
        l.minimumHold = 'shared';
      }
    });
  }
}

/**
 * The servicers Plaid names as showing one minimum, due across all of an
 * account's loans, on each loan (StudentLoan.minimum_payment_amount in Plaid's
 * API reference): Great Lakes, Firstmark, Commonbond Firstmark Services,
 * Granite State and the Oklahoma Student Loan Authority.
 */
const SHARED_MINIMUM_SERVICERS = new Set(['ins_116861', 'ins_116295', 'ins_116950', 'ins_116308', 'ins_116945']);

/**
 * Every credit and loan account that isn't hidden, with the terms Plaid supplies
 * for it, in the Accounts tab's order (institution, then name). Accounts that
 * owe nothing are kept, so the planner can say why they aren't in the plan.
 */
export function debtAccounts(institutions: DebtInstitutionInput[]): DebtAccount[] {
  const out: DebtAccount[] = [];
  for (const inst of institutions) {
    const here = inst.accounts.filter((a) => !a.hidden && isOwedType(a.type)).map((a) => toDebtAccount(inst, a));
    splitSharedMinimums(here, inst.institution_id);
    out.push(...here);
  }
  return out.sort(
    (x, y) =>
      x.institution.localeCompare(y.institution) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id)
  );
}

/**
 * Accounts by currency, the currency with the most accounts first (then by
 * code, and no code last). Each group is planned on its own: nothing in this app
 * converts between currencies, so one plan across two would add dollars to
 * euros. Accounts with no code (Plaid reports an unofficial currency, which
 * lib/networth.ts doesn't keep) are one group, which may mix currencies.
 */
export function byCurrency(accounts: DebtAccount[]): { currency: string | null; accounts: DebtAccount[] }[] {
  const groups = new Map<string | null, DebtAccount[]>();
  for (const a of accounts) groups.set(a.currency, [...(groups.get(a.currency) ?? []), a]);
  const byCode = (x: string | null, y: string | null) =>
    x === y ? 0 : x === null ? 1 : y === null ? -1 : x.localeCompare(y);
  return [...groups.entries()]
    .map(([currency, list]) => ({ currency, accounts: list }))
    .sort((x, y) => y.accounts.length - x.accounts.length || byCode(x.currency, y.currency));
}

/** Something the plan can't see, or can only see as it was. */
export type BlindSpot =
  /** The institution couldn't be loaded, and nothing was recovered. */
  | { kind: 'unloaded'; institution: string }
  /** It couldn't be loaded, and its last balances are too old to use. */
  | { kind: 'too-old'; institution: string; date: string; at: string | null }
  /** Recovered short: some of its accounts couldn't be shown. */
  | { kind: 'missing'; institution: string; count: number }
  /** It answered without accounts it used to report. */
  | { kind: 'vanished'; institution: string; count: number }
  /** Its balances in the plan are recovered ones, from this day. */
  | { kind: 'dated'; institution: string; date: string; at: string | null };

/**
 * What the plan can't see, said as the Home total says it (Dashboard.tsx): an
 * institution that couldn't be loaded may hold cards or loans the plan leaves
 * out, one recovered short or answering without accounts it used to report is
 * missing some, and recovered balances are dated. A date is given only where
 * the institution has a card or loan in the plan's view; on a bank holding none
 * it says nothing about the plan.
 */
export function blindSpots(institutions: DebtInstitutionInput[]): BlindSpot[] {
  const out: BlindSpot[] = [];
  for (const inst of institutions) {
    const institution = inst.institution_name;
    if (inst.error && !inst.stale_as_of) {
      out.push(
        inst.stale_too_old
          ? { kind: 'too-old', institution, date: inst.stale_too_old, at: inst.stale_too_old_at ?? null }
          : { kind: 'unloaded', institution }
      );
      continue;
    }
    if (inst.stale_as_of && inst.accounts.some((a) => !a.hidden && isOwedType(a.type))) {
      out.push({ kind: 'dated', institution, date: inst.stale_as_of, at: inst.stale_as_of_at ?? null });
    }
    if (inst.stale_missing) out.push({ kind: 'missing', institution, count: inst.stale_missing });
    if (inst.unconfirmed_missing && !inst.error) {
      out.push({ kind: 'vanished', institution, count: inst.unconfirmed_missing });
    }
  }
  return out;
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
  /**
   * Where the value came from. A typed value equal to the default counts as
   * the default's ('plaid'), one equal to a mortgage's worked-out payment as
   * 'worked-out', and Plaid's mortgage payment typed back after saying it has
   * no escrow as 'plaid'.
   */
  source: 'plaid' | 'typed' | 'worked-out' | null;
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

/** A debt's APR: what was typed, else Plaid's (out of range is no rate anyone
 *  has, so it is needed instead), else needed. */
export function resolveApr(plaidApr: number | null, typed: string | undefined): Term {
  if (typed === undefined) return plaidApr !== null && isApr(plaidApr) ? { value: plaidApr, source: 'plaid', error: null } : NEEDED;
  const parsed = parseApr(typed);
  if (parsed === null) return NEEDED;
  if (parsed === 'invalid') return { value: null, source: 'typed', error: `Enter a rate from 0 to ${MAX_APR}%.` };
  return { value: parsed, source: parsed === plaidApr ? 'plaid' : 'typed', error: null };
}

/** A debt's monthly payment in cents: what was typed, else the default
 *  (defaultMinimumCents), else needed. */
export function resolveMinimum(
  account: Pick<DebtAccount, 'defaultMinimumCents' | 'plaidMinimumCents' | 'minimumHold' | 'workedOut'>,
  typed: string | undefined
): Term {
  const fallback = account.defaultMinimumCents;
  if (typed === undefined) {
    return fallback !== null && isCents(fallback) ? { value: fallback, source: 'plaid', error: null } : NEEDED;
  }
  const parsed = parseCents(typed);
  if (parsed === null) return NEEDED;
  if (parsed === 'invalid') return { value: null, source: 'typed', error: 'Enter an amount of 0 or more.' };
  const source =
    parsed === fallback
      ? 'plaid'
      : parsed === account.workedOut?.cents
        ? 'worked-out'
        : account.minimumHold === 'escrow-unknown' && parsed === account.plaidMinimumCents
          ? 'plaid'
          : 'typed';
  return { value: parsed, source, error: null };
}

export type RowStatus =
  /** Owes something, both terms known: in the plan. */
  | 'ready'
  /** Owes something, and its APR or payment is still needed (or typed wrong). */
  | 'needs-terms'
  /** The person left it out of the plan. */
  | 'left-out'
  /** A card paid in full at its last statement, out of the plan until the
   *  person puts it in: no interest is charged while it is paid in full. */
  | 'paid-in-full'
  /** Owes nothing (a zero or credit balance). */
  | 'nothing-owed'
  /** No usable balance: none was reported (or one past MAX_CENTS, which no
   *  account can hold), so there is nothing to plan from. */
  | 'no-balance';

export type PlanRow = {
  /** The account as planned: its default payment and hold reflect what the
   *  person said about a shared minimum (PlanChoices.sharedSplit). */
  account: DebtAccount;
  /** What is planned as owed, in cents: the balance, plus a student loan's
   *  accrued interest unless the person left it out. */
  owedCents: number | null;
  /** Whether owedCents includes accrued interest. */
  accruedIncluded: boolean;
  apr: Term;
  minimum: Term;
  status: RowStatus;
  /**
   * For a loan in a shared-minimum group: whether the shared figure is split
   * across the loans ('split': a servicer Plaid names, or the person said it is
   * one payment), paid on each ('separate'), or still the person's to say
   * ('ask'). Null outside such a group.
   */
  shared: 'split' | 'separate' | 'ask' | null;
};

/** What the person has chosen in the planner, beyond the terms. */
export type PlanChoices = {
  typed: Record<string, TypedTerms>;
  /** true leaves a debt out; false keeps in one that starts out of the plan (a
   *  card paid in full). Absent is the default. */
  leftOut: Record<string, boolean>;
  /** Student loans planned on the balance alone, without their accrued interest. */
  withoutAccrued: Record<string, boolean>;
  /** By shared-minimum group (DebtAccount.sharedMinimum.group): true when the
   *  figure is one payment for all of them, false when each loan pays it.
   *  Asked only where Plaid doesn't name the servicer. */
  sharedSplit: Record<string, boolean>;
};

/**
 * Each account's terms and where it stands, and the debts ready to plan. The
 * plan waits while any debt still in it lacks a term (`waiting`): planning the
 * rest without it would leave a debt out of the person's totals without saying
 * so, and assuming a rate (0%, say) would be a guess presented as a fact.
 */
export function planRows(
  accounts: DebtAccount[],
  choices: PlanChoices
): { rows: PlanRow[]; debts: Debt[]; waiting: number } {
  const rows: PlanRow[] = [];
  const debts: Debt[] = [];
  let waiting = 0;
  for (const reported of accounts) {
    // A shared minimum the person has answered for: one payment split by
    // balance, or the figure on each loan. Either way it is no longer held.
    const s = reported.sharedMinimum;
    const answer = s && !s.named ? choices.sharedSplit[s.group] : undefined;
    const account: DebtAccount =
      s && answer !== undefined
        ? { ...reported, minimumHold: null, defaultMinimumCents: answer ? s.shareCents : s.totalCents }
        : reported;
    const shared = !s ? null : s.named || answer === true ? 'split' : answer === false ? 'separate' : 'ask';
    const t = choices.typed[account.id] ?? {};
    const apr = resolveApr(account.plaidApr, t.apr);
    const minimum = resolveMinimum(account, t.minimum);
    const accruedIncluded = account.accruedInterestCents !== null && !choices.withoutAccrued[account.id];
    const owed =
      account.balanceCents === null ? null : account.balanceCents + (accruedIncluded ? account.accruedInterestCents! : 0);
    const out = choices.leftOut[account.id];
    let status: RowStatus;
    if (owed === null || owed > MAX_CENTS) status = 'no-balance';
    else if (owed <= 0) status = 'nothing-owed';
    else if (out === true) status = 'left-out';
    else if (out === undefined && account.paidInFull) status = 'paid-in-full';
    else if (apr.value === null || minimum.value === null) status = 'needs-terms';
    else status = 'ready';

    if (status === 'needs-terms') waiting++;
    // Every term is in range by now (the balance just above, the rest in
    // resolveApr and resolveMinimum), so simulate never throws on these.
    if (status === 'ready') debts.push({ id: account.id, balanceCents: owed!, apr: apr.value!, minimumCents: minimum.value! });
    rows.push({ account, owedCents: owed, accruedIncluded, apr, minimum, status, shared });
  }
  return { rows, debts, waiting };
}
