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
// while the balances come back, isn't on for an institution linked before it
// existed, or is still importing, and a servicer's row may carry none: a loan
// whose interest wasn't reported on this load is named in a line of its own,
// saying why, and what to do when there is something, never passed over. So
// a failure moves no total: only the lines change, to say what isn't known.
//
// IN THE LOANS' OWN CURRENCY: the interest is summed by currency and said in
// it, never in the currency the total is labelled with; with a home currency
// chosen, converted into it at the newest rates, as the total above it is
// (lib/fx/view.ts), and what can't be converted kept in its own, marked so
// (accruedAmountsText).
//
// Pure: no I/O, so the browser bundle can import it.

import { joinNames } from './month-coverage';
import { balancesNow, type PageFx } from './fx/view';

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
  /** The currency its balance is in, and so its interest. */
  currency?: string | null;
  hidden?: boolean;
  liability?: { kind?: string | null; outstanding_interest?: number | null } | null;
};
type HomeInstitution = {
  institution_name: string;
  institution_id?: string | null;
  /** Kept by hand, or fed by a connector (lib/connectors): no Plaid terms. */
  manual?: boolean;
  connector?: string;
  /** Plaid's liabilities product on this Item, as /api/net-worth sends it:
   *  'on' | 'off' (the Accounts tab offers Enable payment details) |
   *  'loading' (still importing) | 'unavailable'. Absent on an older cached
   *  payload. */
  liabilities?: string;
  /** Set when its bank couldn't be reached and its balances are the last
   *  known ones (lib/last-known.ts). */
  stale_as_of?: string;
  accounts: readonly Row[];
};

/** Why a student loan's interest isn't known on this load, as the payoff
 *  plan tells it (lib/payoff.ts noTerms): its bank couldn't be reached; the
 *  payment details aren't enabled for it, or are still importing; or Plaid
 *  didn't report it (the call failed, or the servicer's row carries none). */
export type UnreadWhy = 'unreachable' | 'not-enabled' | 'loading' | 'not-reported';

/** What the total on Home leaves out in accrued interest. */
export type HomeAccrued = {
  /** Reported on this load: how much in each of the loans' currencies (null
   *  for a loan that says none), in the order first met, and on how many
   *  loans. */
  amounts: { currency: string | null; total: number }[];
  loans: number;
  /** Student loans whose interest was reported as none. */
  none: number;
  /** The student loans whose interest wasn't reported on this load, by why
   *  and by institution, in the order they are listed. */
  unread: { institution: string; loans: number; why: UnreadWhy }[];
};

/** Why an institution's student loans carry no interest on this load. */
function whyUnread(inst: HomeInstitution): UnreadWhy {
  if (inst.stale_as_of) return 'unreachable';
  if (inst.liabilities === 'off') return 'not-enabled';
  if (inst.liabilities === 'loading') return 'loading';
  return 'not-reported';
}

/**
 * The accrued interest on the rows the total counts: every account Plaid
 * sent that isn't hidden and has a balance (an account that ended is not
 * among them: lib/lifecycle.ts applyLifecycle). A student loan (Plaid's terms
 * say so, or its type does) whose interest isn't a reported number is
 * unread, with why (whyUnread): its bank couldn't be reached, so the row is
 * its last known balance (lib/last-known.ts), which carries no terms; the
 * liabilities product isn't on for its institution, or is still importing;
 * or the call failed, or the servicer's row carries none. Accounts kept by
 * hand or fed by a connector have no such figure, and Sallie Mae's balances
 * include it.
 */
export function homeAccrued(institutions: readonly HomeInstitution[]): HomeAccrued {
  const cents = new Map<string | null, number>();
  let loans = 0;
  let none = 0;
  const unread = new Map<string, { institution: string; loans: number; why: UnreadWhy }>();
  for (const inst of institutions) {
    if (inst.manual || inst.connector || inst.institution_id === SALLIE_MAE) continue;
    for (const a of inst.accounts) {
      if (a.hidden || a.balance == null) continue;
      const student = a.liability?.kind === 'student' || (a.type === 'loan' && a.subtype === 'student');
      if (!student) continue;
      const reported = a.liability?.kind === 'student' ? a.liability.outstanding_interest : undefined;
      if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
        const why = whyUnread(inst);
        const key = `${why}\u0000${inst.institution_name}`;
        const at = unread.get(key) ?? { institution: inst.institution_name, loans: 0, why };
        at.loans++;
        unread.set(key, at);
        continue;
      }
      if (reported === 0) {
        none++;
        continue;
      }
      const currency = a.currency ?? null;
      cents.set(currency, (cents.get(currency) ?? 0) + Math.round(reported * 100));
      loans++;
    }
  }
  return { amounts: [...cents].map(([currency, n]) => ({ currency, total: n / 100 })), loans, none, unread: [...unread.values()] };
}

/**
 * The interest's amounts in words, each in its loans' own currency ("$612.40",
 * "$612.40 and CA$80.00"; `main` for a loan that says none), or, with a home
 * currency chosen (`fx`, what the page converts with), converted into it at
 * the newest rates as the total above is, saying from what ("€530.17
 * (converted from USD)"); an amount that can't be converted stays in its own
 * currency, marked so ("$612.40 (in USD, not converted)"), and the note under
 * the total says why. `money` writes an amount in a currency, as the total is.
 */
export function accruedAmountsText(
  amounts: HomeAccrued['amounts'],
  fx: PageFx | null,
  main: string | null,
  money: (n: number, currency: string | null) => string
): string {
  // A loan that says no currency is in the main one: added to it, so no
  // currency is named twice.
  const cents = new Map<string | null, number>();
  for (const a of amounts) cents.set(a.currency ?? main, (cents.get(a.currency ?? main) ?? 0) + Math.round(a.total * 100));
  const own = [...cents].map(([currency, n]) => ({ currency, total: n / 100 }));
  if (!fx || own.every((a) => a.currency === fx.home)) return joinNames(own.map((a) => money(a.total, a.currency)));
  const b = balancesNow(own.map((a) => ({ amount: a.total, currency: a.currency })), fx, main);
  const said: string[] = [];
  const from = b.parts.filter((p) => p.converted !== null && p.currency !== fx.home).map((p) => p.currency);
  if (b.parts.some((p) => p.converted !== null)) said.push(`${money(b.total, fx.home)}${from.length > 0 ? ` (converted from ${joinNames(from)})` : ''}`);
  for (const p of b.parts) if (p.converted === null) said.push(`${money(p.amount, p.currency)} (in ${p.currency}, not converted)`);
  return joinNames(said);
}

/** The order the lines take: what the person can do something about first. */
const WHY_ORDER: readonly UnreadWhy[] = ['not-enabled', 'loading', 'unreachable', 'not-reported'];

/**
 * The lines under the total: how much accrued interest it leaves out (`leftOut`:
 * the line, and `why` it is apart, said behind "Why?" on Home), and, one for each
 * reason, the loans whose interest isn't known on this load, with what to do
 * when there is something (`unread`). Null, or none, when there is nothing to
 * say. `amountsText` writes the amounts (accruedAmountsText).
 */
export function accruedLines(
  view: HomeAccrued,
  amountsText: (amounts: HomeAccrued['amounts']) => string
): { leftOut: { line: string; why: string } | null; unread: string[] } {
  const one = view.loans === 1;
  const owed = view.amounts.filter((a) => a.total > 0);
  const leftOut =
    view.loans > 0 && owed.length > 0
      ? {
          line: `Leaves out ${amountsText(owed)} of accrued interest on ${one ? 'a student loan' : `${view.loans} student loans`}.`,
          why: `Plaid reports it apart from ${one ? 'the loan’s balance' : 'their balances'}. The payoff plan counts it, unless you leave it out there.`,
        }
      : null;
  const unreadLoans = view.unread.reduce((sum, u) => sum + u.loans, 0);
  // "Your student loan" only when it is the one student loan counted: beside
  // one whose interest was reported (as none, even), it is a student loan,
  // and beside the line above, another.
  const only = unreadLoans === 1 && view.loans === 0 && view.none === 0;
  const loansPhrase = (n: number): string =>
    only ? 'your student loan' : view.loans > 0 ? (n === 1 ? 'another student loan' : `${n} other student loans`) : n === 1 ? 'a student loan' : `${n} student loans`;
  const unread: string[] = [];
  for (const why of WHY_ORDER) {
    const at = view.unread.filter((u) => u.why === why);
    if (at.length === 0) continue;
    const n = at.reduce((sum, u) => sum + u.loans, 0);
    const where = joinNames(at.map((u) => u.institution));
    const loans = loansPhrase(n);
    const it = n === 1 ? 'it' : 'them';
    if (why === 'not-enabled') {
      unread.push(`Payment details aren’t enabled for ${where}, so the accrued interest on ${loans} there isn’t known. To see it, choose Enable payment details in the ⋯ on ${at.length === 1 ? 'its card' : 'their cards'} on the Accounts tab.`);
    } else if (why === 'loading') {
      unread.push(`Payment details are still importing from ${where}, so the accrued interest on ${loans} there isn’t known yet.`);
    } else if (why === 'unreachable') {
      unread.push(`${where} couldn’t be reached, so the accrued interest on ${loans} there isn’t known until ${at.length === 1 ? 'it answers' : 'they answer'}.`);
    } else {
      unread.push(`The accrued interest on ${loans} at ${where} couldn’t be read, so how much interest the total leaves out for ${it} isn’t known.`);
    }
  }
  return { leftOut, unread };
}
