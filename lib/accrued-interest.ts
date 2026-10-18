// lib/accrued-interest.ts
//
// A student loan's accrued interest, and what the total on Home says of it
// (plan #19). Plaid reports a student loan's balance as its principal,
// Sallie Mae's aside (Plaid says theirs include it), and the interest accrued
// on it apart (outstanding_interest_amount, lib/liabilities.ts). Both are
// owed: the Accounts tab shows the interest on the loan's row, and the payoff
// plan plans on the two together unless the person leaves the interest out
// there (lib/payoff.ts, which reads the rule here).
//
// THE TOTAL STAYS THE BALANCES, as every other reader has it: the chart and
// every day lib/history.ts records, the Accounts tab's subtotals, the API, the
// download and a net worth share. Under it, a line says how much accrued
// interest it leaves out, on how many loans (homeAccrued, accruedLines). The
// interest comes from a call of its own (/liabilities/get), which can fail
// while the balances come back, and a servicer's row may carry none: a loan
// whose interest wasn't reported on this load is named in a line of its own,
// as interest that couldn't be read, never passed over. So a failure moves no
// total: only the lines change, to say what couldn't be read.
//
// Pure: no I/O, so the browser bundle can import it.

import { joinNames } from './month-coverage';

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
  type: string;
  subtype?: string | null;
  balance: number | null;
  hidden?: boolean;
  liability?: { kind?: string | null; outstanding_interest?: number | null } | null;
};
type HomeInstitution = {
  institution_name: string;
  institution_id?: string | null;
  /** Kept by hand, or fed by a connector (lib/connectors): no Plaid terms. */
  manual?: boolean;
  connector?: string;
  accounts: readonly Row[];
};

/** What the total on Home leaves out in accrued interest. */
export type HomeAccrued = {
  /** Reported on this load: how much, on how many loans. */
  total: number;
  loans: number;
  /** The student loans whose interest wasn't reported on this load, by
   *  institution, in the order they are listed. */
  unread: { institution: string; loans: number }[];
};

/**
 * The accrued interest on the rows the total counts: every account Plaid
 * sent that isn't hidden and has a balance (an account that ended is not
 * among them: lib/lifecycle.ts applyLifecycle). A student loan (Plaid's terms
 * say so, or its type does) whose interest isn't a reported number is
 * unread: the liabilities call failed or isn't on for its institution, the
 * servicer's row carries none, or the row is its last known balance
 * (lib/last-known.ts), which carries no terms. Accounts kept by hand or fed
 * by a connector have no such figure, and Sallie Mae's balances include it.
 */
export function homeAccrued(institutions: readonly HomeInstitution[]): HomeAccrued {
  let cents = 0;
  let loans = 0;
  const unread = new Map<string, number>();
  for (const inst of institutions) {
    if (inst.manual || inst.connector || inst.institution_id === SALLIE_MAE) continue;
    for (const a of inst.accounts) {
      if (a.hidden || a.balance == null) continue;
      const student = a.liability?.kind === 'student' || (a.type === 'loan' && a.subtype === 'student');
      if (!student) continue;
      const reported = a.liability?.kind === 'student' ? a.liability.outstanding_interest : undefined;
      if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
        unread.set(inst.institution_name, (unread.get(inst.institution_name) ?? 0) + 1);
        continue;
      }
      if (reported === 0) continue;
      cents += Math.round(reported * 100);
      loans++;
    }
  }
  return { total: cents / 100, loans, unread: [...unread].map(([institution, n]) => ({ institution, loans: n })) };
}

/**
 * The lines under the total: how much accrued interest it leaves out, as
 * Plaid reports it apart from the balances (`leftOut`), and the loans whose
 * interest couldn't be read on this load (`unread`). Each null when there is
 * nothing to say. `money` formats an amount as the total is.
 */
export function accruedLines(view: HomeAccrued, money: (n: number) => string): { leftOut: string | null; unread: string | null } {
  const one = view.loans === 1;
  const leftOut =
    view.loans > 0 && view.total > 0
      ? `Leaves out ${money(view.total)} of accrued interest on ${one ? 'a student loan' : `${view.loans} student loans`}, which Plaid reports apart from ${one ? 'its balance' : 'their balances'}. The payoff plan counts it, unless you leave it out there.`
      : null;
  const n = view.unread.reduce((sum, u) => sum + u.loans, 0);
  if (n === 0) return { leftOut, unread: null };
  const which = view.loans > 0 ? (n === 1 ? 'another student loan' : `${n} other student loans`) : n === 1 ? 'your student loan' : `${n} student loans`;
  const where = joinNames(view.unread.map((u) => u.institution));
  return {
    leftOut,
    unread: `The accrued interest on ${which} at ${where} couldn’t be read, so how much interest the total leaves out for ${n === 1 ? 'it' : 'them'} isn’t known.`,
  };
}
