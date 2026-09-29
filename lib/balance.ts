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
