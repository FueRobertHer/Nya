// lib/spending.ts
//
// Which transactions count in budgets and reports, decided in one place, so
// every total agrees. Pure, safe to import from client code.
//
// Two things keep a transaction out of a total:
//   - it moves money rather than spending or earning it: between your own
//     accounts, out as cash, a charge Plaid codes with those, or a loan
//     payment (paying a card off settles purchases already counted on the
//     card). isTransfer, the Activity tab's rule;
//   - you excluded it (lib/txn-annotations.ts): a one-off you want left out of
//     budgets and reports, such as a car bought outright or a work trip that
//     was paid back. isExcluded.
// countsInTotals is both, and every total that leaves transfers out uses it:
// the Activity tab's money in and out, its chart, top categories, places and
// channels, the budgets, and the Home insights. Two totals have a transfer rule
// of their own and check isExcluded first all the same: recurring bills
// (lib/recurring.ts), which keep loan payments, and the Plan's spending
// (lib/fire/inputs.ts), which puts some of them back. A transaction you
// excluded still shows in the list, marked; only the totals leave it out.
//
// New code that sums spending or income goes through countsInTotals (or, with
// a rule of its own, checks isExcluded), never a filter of its own.

/** What these rules read of a transaction (the Activity tab's Txn). */
export type Countable = {
  transaction_code: string | null;
  category: string | null;
  /** True when you excluded it; null when whether you did could not be read,
   *  which counts it (see isExcluded). */
  excluded?: boolean | null;
};

// Plaid's transaction_code is the reliable signal for money that moves without
// being spent (transfers, ATM withdrawals, a bank's charges); the category
// heuristic covers rows Plaid didn't code (older data, or codes it never
// resolved).
const MOVEMENT_CODES = new Set(['transfer', 'atm', 'bank charge']);

/** Money moved rather than spent or earned: between your own accounts, out as
 *  cash, or a charge Plaid codes with those. Loan payments are not in it: for
 *  recurring bills a mortgage payment is a classic bill. */
export function isMoneyMovement(t: Countable): boolean {
  if (t.transaction_code && MOVEMENT_CODES.has(t.transaction_code)) return true;
  return !!t.category && t.category.startsWith('transfer');
}

/** The Activity tab's rule: money moved, or a loan payment (paying a card off
 *  would otherwise count its purchases twice). */
export function isTransfer(t: Countable): boolean {
  return isMoneyMovement(t) || t.category === 'loan payments';
}

/** You excluded it from budgets and reports. When whether you did could not be
 *  read (null), it counts: a total that may include it is shown with a note,
 *  never one that silently leaves out something you did not exclude. */
export function isExcluded(t: Pick<Countable, 'excluded'>): boolean {
  return t.excluded === true;
}

/** Whether a transaction counts in totals of money in and out: not a transfer
 *  or loan payment, and not excluded. */
export function countsInTotals(t: Countable): boolean {
  return !isExcluded(t) && !isTransfer(t);
}
