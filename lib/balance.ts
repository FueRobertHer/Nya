// lib/balance.ts
//
// How an account balance contributes to net worth: credit and loan balances are
// amounts OWED, so they subtract.
//
// One definition, shared by every consumer -- computeNetWorth, the hidden
// account subtraction in lib/history.ts, manual-account validation, the ingest
// endpoint and the Dashboard. It used to be open-coded in six places, with
// lib/hidden.ts nominating itself the canonical copy. That could never actually
// hold: lib/hidden.ts imports the Redis client, so a client component pulling
// signedContribution from it would drag @upstash/redis into the browser bundle,
// which is exactly why Dashboard kept its own copy. This module imports nothing
// at all, which is what lets both sides share it (the lib/format.ts pattern).
//
// WARNING for anyone extending this to "all the places that look like it":
// app/api/backfill/route.ts walks transactions with
//
//     balances[id] += walkType[id] === 'credit' ? -amount : amount
//
// which is the same shape and the OPPOSITE concept -- a card purchase RAISES
// the owed balance. Rewriting it in terms of signedContribution would silently
// invert the estimated series for every credit account. It is deliberately left
// open-coded, and deliberately not imported from here.

/** Types whose stored balance is an amount owed rather than an amount held. */
export function isOwedType(type: string): boolean {
  return type === 'credit' || type === 'loan';
}

/** A balance as it contributes to a net-worth total: negative when owed. */
export function signedContribution(type: string, balance: number): number {
  return isOwedType(type) ? -balance : balance;
}
