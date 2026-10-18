// lib/accrued-interest.ts
//
// A student loan's accrued interest in today's net worth (plan #19). Plaid
// reports a student loan's balance as its principal, Sallie Mae's aside (Plaid
// says theirs include it), and the interest accrued on it apart
// (outstanding_interest_amount, lib/liabilities.ts). Both are owed: the
// Accounts tab shows the interest on the loan's row, and the payoff planner
// plans on the two together (lib/payoff.ts, which reads it here). The total on
// Home counts it too, as owed, in a line of its own that says where it comes
// from (accruedNote).
//
// NEVER IN HISTORY. What lib/history.ts records each day, and every point the
// chart draws from it, today's among them (withTodayPoint, which shows only a
// figure the history layer has), is the balances as reported: a day recorded
// before this counted would otherwise be set against one after, and the step
// between them read as a loss. So the server never sees this: it is worked
// out on the page, from the rows the total is made of, and the line says the
// chart counts the balances alone, and by how much its point for today is
// above the total.
//
// Only what Plaid reported on this load counts: a loan whose bank couldn't be
// reached shows its last known balance (lib/last-known.ts), which carries no
// liability, so it counts its balance alone until its bank answers. Pure: no
// I/O, so the browser bundle can import it.

/** Plaid's institution id for Sallie Mae, whose student loan balances already
 *  include accrued interest (Plaid's AccountBalance.current documentation). */
export const SALLIE_MAE = 'ins_116944';

/**
 * The interest accrued on a loan that is owed on top of its balance: a
 * student loan's reported outstanding interest, when it is positive and not
 * in the balance already. Null otherwise.
 */
export function accruedApart(
  kind: string | null | undefined,
  institutionId: string | null | undefined,
  outstanding: unknown
): number | null {
  if (kind !== 'student' || institutionId === SALLIE_MAE) return null;
  return typeof outstanding === 'number' && Number.isFinite(outstanding) && outstanding > 0 ? outstanding : null;
}

type Row = {
  account_id: string;
  balance: number | null;
  hidden?: boolean;
  liability?: { kind?: string | null; outstanding_interest?: number | null } | null;
};

/** What today's total owes in accrued interest, and on how many loans. */
export type AccruedOwed = { total: number; loans: number };

export const NO_ACCRUED: AccruedOwed = { total: 0, loans: 0 };

/**
 * The accrued interest the total on Home leaves out, over the rows it is made
 * of: every account the server sent that isn't hidden and has a balance (an
 * account that ended is not among them: lib/lifecycle.ts applyLifecycle).
 */
export function accruedInterestOwed(institutions: readonly { institution_id?: string | null; accounts: readonly Row[] }[]): AccruedOwed {
  let cents = 0;
  let loans = 0;
  for (const inst of institutions) {
    for (const a of inst.accounts) {
      if (a.hidden || a.balance == null) continue;
      const accrued = accruedApart(a.liability?.kind, inst.institution_id, a.liability?.outstanding_interest);
      if (accrued === null) continue;
      cents += Math.round(accrued * 100);
      loans++;
    }
  }
  return loans === 0 ? NO_ACCRUED : { total: cents / 100, loans };
}

/**
 * The line under the total, when it counts accrued interest: how much, where
 * it comes from, and, when the chart is shown, that it (and the change beside
 * the total, which is worked out from it) counts the balances alone.
 * `chartToday`: the chart's last point is today's, the total before the
 * interest, so the line says how far above the total it is. `money` formats
 * an amount as the total is.
 */
export function accruedNote(
  owed: AccruedOwed,
  opts: { chart: boolean; chartToday: boolean; delta: boolean },
  money: (n: number) => string
): string | null {
  if (owed.loans === 0 || !(owed.total > 0)) return null;
  const one = owed.loans === 1;
  const lead = `Counts ${money(owed.total)} of accrued interest on ${one ? 'a student loan' : `${owed.loans} student loans`} as owed: Plaid reports it apart from ${one ? 'the loan’s balance' : 'the loans’ balances'}.`;
  if (!opts.chart) return lead;
  const counts = opts.delta ? 'The chart and the change above count' : 'The chart counts';
  const today = opts.chartToday ? `, so ${opts.delta ? 'the chart’s' : 'its'} point for today is ${money(owed.total)} above this total` : '';
  return `${lead} ${counts} the balances alone, as every day is recorded${today}.`;
}
