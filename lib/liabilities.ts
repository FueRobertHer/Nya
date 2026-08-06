// lib/liabilities.ts
//
// Normalizes Plaid's /liabilities/get response into one flat per-account
// shape. Plaid returns three unrelated structures (credit / student /
// mortgage) with different field names for the same ideas -- "what rate am I
// paying", "what's the minimum", "when is it due" -- so the Accounts tab would
// otherwise need three renderers for one row of text.
//
// Pure and total: no I/O, and a malformed or partial response yields fewer
// entries rather than throwing. That matters because the caller runs inside
// lib/networth.ts's per-institution try block, where a throw would reject the
// whole Promise.all and 500 both /api/net-worth and the snapshot cron.

import type { LiabilitiesObject } from 'plaid';

export type AccountLiability = {
  kind: 'credit' | 'student' | 'mortgage';
  /** Annualized rate, as a percentage (5.25 means 5.25%). */
  apr: number | null;
  /** What that rate is, since it differs by kind ('Purchase APR', 'Interest rate'). */
  apr_label: string | null;
  minimum_payment: number | null;
  next_due_date: string | null; // YYYY-MM-DD
  last_statement_balance: number | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  is_overdue: boolean | null;
  // Kind-specific extras, shown only in the expanded account row.
  maturity_date?: string | null;
  escrow_balance?: number | null;
  expected_payoff_date?: string | null;
  outstanding_interest?: number | null;
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The rate that actually costs money on a revolving balance.
 *
 * Cards report several APRs (purchase, cash advance, balance transfer, special
 * promotional rates). Showing an arbitrary one would be misleading -- a 0%
 * balance-transfer promo next to a $4,000 balance reads as "this debt is
 * free". Prefer the purchase APR, and where the card doesn't report one fall
 * back to the highest rather than the first, so the number shown is never
 * rosier than what's being charged.
 */
function creditApr(aprs: unknown): { rate: number; label: string } | null {
  if (!Array.isArray(aprs) || aprs.length === 0) return null;
  const purchase = aprs.find((a) => a?.apr_type === 'purchase_apr');
  if (purchase) {
    const rate = num(purchase.apr_percentage);
    if (rate != null) return { rate, label: 'Purchase APR' };
  }
  const rates = aprs.map((a) => num(a?.apr_percentage)).filter((r): r is number => r != null);
  if (rates.length === 0) return null;
  // The label has to travel with the rate. Hardcoding "Purchase APR" here would
  // print it over a cash-advance rate on a card that reports no purchase APR at
  // all -- attributing a 29.99% cash rate to everyday spending, or a 0%
  // balance-transfer promo to a balance that is very much accruing interest.
  return { rate: Math.max(...rates), label: 'Highest APR' };
}

/** { account_id: AccountLiability } across all three liability kinds. */
export function normalizeLiabilities(o: LiabilitiesObject | null | undefined): Record<
  string,
  AccountLiability
> {
  const out: Record<string, AccountLiability> = {};
  if (!o) return out;

  for (const c of o.credit ?? []) {
    if (!c?.account_id) continue; // account_id is nullable on CreditCardLiability
    const apr = creditApr(c.aprs);
    out[c.account_id] = {
      kind: 'credit',
      apr: apr?.rate ?? null,
      apr_label: apr?.label ?? null,
      minimum_payment: num(c.minimum_payment_amount),
      next_due_date: c.next_payment_due_date ?? null,
      last_statement_balance: num(c.last_statement_balance),
      last_payment_amount: num(c.last_payment_amount),
      last_payment_date: c.last_payment_date ?? null,
      is_overdue: c.is_overdue ?? null,
    };
  }

  for (const s of o.student ?? []) {
    if (!s?.account_id) continue;
    out[s.account_id] = {
      kind: 'student',
      apr: num(s.interest_rate_percentage),
      apr_label: 'Interest rate',
      minimum_payment: num(s.minimum_payment_amount),
      next_due_date: s.next_payment_due_date ?? null,
      last_statement_balance: null, // student loans report no statement balance
      last_payment_amount: num(s.last_payment_amount),
      last_payment_date: s.last_payment_date ?? null,
      is_overdue: s.is_overdue ?? null,
      expected_payoff_date: s.expected_payoff_date ?? null,
      outstanding_interest: num(s.outstanding_interest_amount),
    };
  }

  for (const m of o.mortgage ?? []) {
    if (!m?.account_id) continue;
    out[m.account_id] = {
      kind: 'mortgage',
      apr: num(m.interest_rate?.percentage),
      apr_label: 'Interest rate',
      // Mortgages report the scheduled payment, not a "minimum" -- same role
      // in the UI, so it lands in the same field.
      minimum_payment: num(m.next_monthly_payment),
      next_due_date: m.next_payment_due_date ?? null,
      last_statement_balance: null,
      last_payment_amount: num(m.last_payment_amount),
      last_payment_date: m.last_payment_date ?? null,
      // Mortgages have no is_overdue; a nonzero past_due_amount is the signal.
      is_overdue: num(m.past_due_amount) != null ? (m.past_due_amount as number) > 0 : null,
      maturity_date: m.maturity_date ?? null,
      escrow_balance: num(m.escrow_balance),
    };
  }

  return out;
}
