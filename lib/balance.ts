// lib/balance.ts
//
// How an account balance contributes to net worth: credit and loan balances are
// amounts OWED, so they subtract.
//
// One definition, shared by every consumer: computeNetWorth, the hidden-account
// subtraction in lib/history.ts, manual-account validation, the ingest endpoint
// and the Dashboard. This module imports nothing, which is what lets client
// components share it: lib/hidden.ts imports the Redis client, so pulling
// signedContribution from it would drag @upstash/redis into the browser bundle
// (the lib/format.ts pattern).
//
// WARNING: lib/backfill.ts walks transactions with
//
//     balances[id] += walkType[id] === 'credit' ? -amount : amount
//
// which has the same shape and the OPPOSITE meaning: a card purchase RAISES the
// owed balance. Rewriting it with signedContribution would silently invert the
// estimated series for every credit account, so it is deliberately open-coded
// there (signedContribution IS used in that file, for the net-worth term).

/** Types whose stored balance is an amount owed rather than an amount held. */
export function isOwedType(type: string): boolean {
  return type === 'credit' || type === 'loan';
}

/** A balance as it contributes to a net-worth total: negative when owed. */
export function signedContribution(type: string, balance: number): number {
  return isOwedType(type) ? -balance : balance;
}

/**
 * Types that can hold securities. Plaid still returns the legacy 'brokerage'
 * alongside 'investment' at some institutions and they mean the same thing, which
 * is why this is a function and not a comparison. Kept here next to isOwedType
 * because it decides whether a Plaid call is made at all (lib/networth.ts skips
 * /investments/holdings/get for an Item with no such account), so a drifting
 * open-coded copy would silently stop fetching a real brokerage's holdings.
 */
export function isInvestmentType(type: string): boolean {
  return type === 'investment' || type === 'brokerage';
}

/**
 * A health savings account Plaid reports as a bank account (type depository,
 * subtype hsa), as some institutions do: money for health costs, never cash to
 * live on. The Plan counts it with the investment accounts, in the HSA bucket
 * (lib/fire/inputs.ts, lib/fire/buckets-today.ts); the cash forecast and Runway
 * leave it out of the cash they start from (lib/forecast.ts cashPosition). One
 * reported as an investment account is one already. Not in isInvestmentType,
 * which decides whether holdings are asked for.
 */
export function isDepositoryHsa(a: { type: string | null; subtype?: string | null }): boolean {
  return a.type === 'depository' && (a.subtype ?? '').toLowerCase() === 'hsa';
}

/** Checking, savings and cash on hand: a depository account that isn't a
 *  health savings account. */
export function isBankCash(a: { type: string | null; subtype?: string | null }): boolean {
  return a.type === 'depository' && !isDepositoryHsa(a);
}

/** What a transaction row carries of its account's being a depository HSA
 *  (lib/transactions.ts Txn.account_hsa), the subtype being on the account,
 *  not the row: the flag when it is one, else nothing. */
export function accountHsa(a: { type: string | null; subtype?: string | null } | null | undefined): { account_hsa?: true } {
  return a && isDepositoryHsa(a) ? { account_hsa: true } : {};
}

/** Whether a recurring series is on bill-paying cash, as isBankCash tells an
 *  account: on a depository account not flagged a health savings account
 *  (lib/recurring.ts RecurringSeries.accountHsa). What the cash forecast and
 *  Runway count a series by, and the calendar and the Recurring card say. */
export function onBankCash(s: { accountType: string | null; accountHsa?: true }): boolean {
  return s.accountType === 'depository' && !s.accountHsa;
}

/**
 * The subtype a manual account is saved with when the person says it is cash
 * on hand (a wallet, a jar): a depository account, like checking, that holds
 * the cash taken out at an ATM. The Plan reads it to count withdrawals and the
 * cash spending entered on it once (lib/fire/inputs.ts). A manual checking or
 * savings account is not cash unless the person says so.
 */
export const CASH_SUBTYPE = 'cash';

export function isCashOnHand(a: { type: string; subtype?: string | null }): boolean {
  return a.type === 'depository' && a.subtype === CASH_SUBTYPE;
}
