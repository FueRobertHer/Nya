// lib/manual-account-writes.ts
//
// Making and changing a manual account (lib/manual.ts): what the Add and
// Update forms do through app/api/manual-accounts, and what the API's writes
// do (lib/api-writes.ts), in one place so the two never differ. The route
// reads a request and answers it; everything that is stored, refused or
// cleared happens here.
//
// ONE ACCOUNT PER CALL, as the route's header explains: a call can only touch
// the account it names. Each write is one compare-and-set on that account's
// field (lib/manual.ts changeManualAccount), so a balance pushed by a script
// or a rename on another device at the same moment is read again, never lost
// inside the request. The Update form still sends the whole record, balance
// included, so a form left open writes over a balance pushed since it opened:
// what it shows is what it saves.
//
// NEVER BETWEEN HELD AND OWED. A type stays on its side of isOwedType for
// good: depository, investment and other can become one another, and credit
// a loan, but never across. History keeps each account's past balances
// unsigned beside totals signed when they were recorded, and every reader
// that takes an account back out of a total (hiding it, its end, the split
// by currency, forgetting it) signs them with one type, so a change across
// would read every earlier point with the opposite sign, and a forget would
// write that into the totals for good. Nothing records the sign a point was
// measured with, and the release before would read none, so the change is
// refused instead (OWED_FLIP), for the app and the API alike, and the person
// closes the account and adds a new one of the other kind: every earlier
// point stays as it was recorded.
//
// AFTER A WRITE the cached payloads are dropped, and the backfill flag is
// cleared when the estimated history no longer fits the account: its balance
// moved, or its type changed (within its side, an investment account held
// flat and a depository one walked, say). The flag goes first, the caches
// second (see invalidate).

import type { Ctx } from './containers';
import {
  changeManualAccount,
  currencyField,
  getManualAccounts,
  MANUAL_CURRENCY,
  MANUAL_TYPES,
  MAX_BALANCE,
  MAX_MANUAL_ACCOUNTS,
  normalizeInstitutionName,
  type ManualAccount,
  type ManualType,
} from './manual';
import { isOwedType } from './balance';
import { isCurrencyCode, knownCurrency } from './manual-txn-input';
import { clearCaches } from './cache';
import { clearBackfillDone } from './history';
import { followAccountCurrency } from './import/commit';

/** The fields a form or a request gives an account: all but its id and time. */
export type AccountFields = Omit<ManualAccount, 'account_id' | 'updated_at' | 'currency'>;

export const CURRENCY_ERROR = 'The currency is a three-letter ISO code, like USD or EUR';

/** A currency a request names: undefined when it names none. */
export function currencyOf(given: unknown): { error: string } | { currency: string | undefined } {
  if (given === undefined) return { currency: undefined };
  return isCurrencyCode(given) && knownCurrency(given) ? { currency: given } : { error: CURRENCY_ERROR };
}

const OWED_NEGATIVE = 'Credit and loan balances are the amount owed, so they cannot be negative';

/** Why an account can't change between money held and money owed (see the
 *  header), and what to do instead. */
export const OWED_FLIP =
  'Money owed and money held count in opposite directions, so changing an account between them would change how every past balance of it counts. Instead, mark this account closed in the app and add a new one of the other kind: its past stays as it was.';

/** Whether a change of type crosses between money held and money owed. */
export const crossesOwed = (from: string, to: string) => isOwedType(from) !== isOwedType(to);

/** Why a balance can't stand on an account of this type, or null. */
export function balanceError(type: ManualType, balance: number): string | null {
  // Unlike a savings goal, a balance of 0 is meaningful and a negative one is
  // legitimate (an overdrawn checking account), so only reject values that
  // aren't real numbers.
  if (!Number.isFinite(balance) || Math.abs(balance) > MAX_BALANCE) return 'Invalid balance';
  // Credit and loan balances are amounts OWED, which computeNetWorth()
  // subtracts. Accepting a negative here would double-negate into positive net
  // worth, so a "-500" card balance is a user error, not a credit.
  if (isOwedType(type) && balance < 0) return OWED_NEGATIVE;
  return null;
}

/** The forms' field validation, for create and update: an error, or the
 *  cleaned fields, with the currency when the request names one. Lenient in
 *  the way the forms always were (a name past 60 is cut); the API checks its
 *  own limits strictly before it calls this. */
export function validateAccountFields(body: Record<string, unknown> | null | undefined): { error: string } | { value: AccountFields; currency: string | undefined } {
  const name = String(body?.name ?? '').trim().slice(0, 60);
  const institution_name = normalizeInstitutionName(String(body?.institution_name ?? '')).slice(0, 60);
  const type = String(body?.type ?? '') as ManualType;
  const subtype = body?.subtype == null ? null : String(body.subtype).trim().slice(0, 40) || null;
  const balance = Number(body?.balance);

  if (!name || !institution_name) return { error: 'Name and institution are required' };
  if (!MANUAL_TYPES.includes(type)) return { error: 'Invalid account type' };
  const wrong = balanceError(type, balance);
  if (wrong) return { error: wrong };
  const currency = currencyOf(body?.currency);
  if ('error' in currency) return currency;
  return { value: { name, institution_name, type, subtype, balance }, currency: currency.currency };
}

/** Cached payloads still hold the old account. The backfill flag is cleared
 *  only when the estimated history no longer fits it (see the header): a
 *  rename changes no total, and recomputing forces a full Plaid transaction
 *  re-pull. Flag first, cache second: the other order leaves a window where a
 *  /api/net-worth request reads the flag as still set and re-caches
 *  `backfill_stale: false`, pinning it for the TTL and dropping the recompute
 *  this call just asked for. (/api/hidden-accounts does the same.) */
export async function invalidate(ctx: Ctx, rebuild: boolean): Promise<void> {
  if (rebuild) await clearBackfillDone(ctx);
  await clearCaches(ctx);
}

/** What createManualAccount did: made it, found one already under its id
 *  (`created` false: the same create sent again), or found the limit. */
export type Created = { account: ManualAccount; created: boolean } | { limit: number };

/**
 * Makes one account under `id` (minted by the caller with newManualId, so a
 * create sent again finds its own), refused at `limit` accounts (the Add
 * form's MAX_MANUAL_ACCOUNTS; the API keeps room under it), and refused
 * (AccountEditRefused, 400) for fields the Add form refuses. Written only where
 * nothing is: an account already under the id is answered as it is, never
 * written over. Throws, rather than counting an unreadable hash as empty.
 */
export async function createManualAccount(
  ctx: Ctx,
  fields: AccountFields,
  currency: string | undefined,
  opts: { id: string; now?: Date; limit?: number }
): Promise<Created> {
  // The Add form's own checks, whoever asks (the route has run them already;
  // the API's are stricter, but never let through what these refuse).
  const checked = validateAccountFields({ ...fields, ...(currency !== undefined ? { currency } : {}) });
  if ('error' in checked) throw new AccountEditRefused(checked.error, 400);
  fields = checked.value;
  const limit = opts.limit ?? MAX_MANUAL_ACCOUNTS;
  const existing = await getManualAccounts(ctx);
  const mine = existing.find((a) => a.account_id === opts.id);
  if (mine) return { account: mine, created: false };
  if (existing.length >= limit) return { limit };
  const account: ManualAccount = {
    ...fields,
    ...currencyField(currency ?? MANUAL_CURRENCY),
    account_id: opts.id,
    updated_at: (opts.now ?? new Date()).toISOString(),
  };
  const { before, written } = await changeManualAccount(ctx, opts.id, (current) => (current ? null : account));
  if (!written) return { account: before!, created: false };
  await invalidate(ctx, true);
  return { account, created: true };
}

/** An edit refused inside its compare-and-set (a version that no longer
 *  matches, a balance the type can't take), with what to say. */
export class AccountEditRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 412
  ) {
    super(message);
    this.name = 'AccountEditRefused';
  }
}

/** What saveAccountEdit did, from the attempt that wrote. */
export type AccountEdit = { before: ManualAccount; account: ManualAccount; balanceChanged: boolean; typeChanged: boolean };

/**
 * Saves an edit of one account: `edit` gives the fields to write over the
 * stored ones (the Update form gives them all; the API only those it
 * changes) and the currency when one is chosen, a page that names none
 * keeping the account's own. Validated against the record as it is read in
 * the compare-and-set (`check` runs there too, and may refuse by throwing),
 * and `updated_at` stamped only when the balance moved, so the "Updated ..."
 * line reflects the last real balance change rather than a rename. What
 * imports learned follows a currency changed (lib/import/commit.ts), and the
 * caches and the backfill flag go (see the header). Null when the account no
 * longer exists.
 */
export async function saveAccountEdit(
  ctx: Ctx,
  account_id: string,
  edit: { fields: Partial<AccountFields>; currency?: string },
  opts: { now?: Date; check?: (current: ManualAccount) => void } = {}
): Promise<AccountEdit | null> {
  const at = (opts.now ?? new Date()).toISOString();
  let outcome: AccountEdit | null = null;
  const { before, written } = await changeManualAccount(ctx, account_id, (current) => {
    outcome = null; // this may run more than once: only the attempt that writes counts
    if (!current) return null;
    opts.check?.(current);
    const merged = { ...current, ...edit.fields };
    if (crossesOwed(current.type, merged.type)) throw new AccountEditRefused(OWED_FLIP, 409);
    const wrong = balanceError(merged.type, merged.balance);
    if (wrong) throw new AccountEditRefused(wrong, 400);
    const currency = edit.currency ?? current.currency ?? MANUAL_CURRENCY;
    const balanceChanged = current.balance !== merged.balance;
    const account: ManualAccount = {
      account_id,
      name: merged.name,
      institution_name: merged.institution_name,
      type: merged.type,
      subtype: merged.subtype,
      balance: merged.balance,
      updated_at: balanceChanged ? at : current.updated_at,
      ...currencyField(currency),
    };
    outcome = { before: current, account, balanceChanged, typeChanged: current.type !== account.type };
    return account;
  });
  if (!before || !written || !outcome) return null;
  const done: AccountEdit = outcome;
  await followAccountCurrency(ctx, account_id, done.before.currency ?? MANUAL_CURRENCY, done.account.currency ?? MANUAL_CURRENCY);
  await invalidate(ctx, done.balanceChanged || done.typeChanged);
  return done;
}

/** What setAccountBalance did. */
export type BalanceOutcome =
  | { kind: 'set'; before: ManualAccount; account: ManualAccount }
  | { kind: 'same'; account: ManualAccount }
  | { kind: 'missing' };

/**
 * Sets one account's balance alone, as a measurement: the balance and its
 * time, in one compare-and-set, every other field as stored. The same to the
 * cent writes nothing ('same'). A balance the type can't take (an amount owed
 * below zero) is refused against the type as read in that same step
 * (AccountEditRefused). `expect` is a check of the account as read, inside
 * that step, that may refuse by throwing (an undo's: it still holds what was
 * set). Then, as the Update form's balance change does, the caches go, and
 * the backfill flag, unless `rebuild` says not this time (the API's pushes:
 * lib/api-rebuilds.ts rebuildForPush). Nothing here records a history point:
 * the daily snapshot, or the person's next visit, records it with the day's
 * other balances.
 */
export async function setAccountBalance(
  ctx: Ctx,
  account_id: string,
  balance: number,
  opts: { now?: Date; expect?: (current: ManualAccount) => void; rebuild?: () => Promise<boolean> } = {}
): Promise<BalanceOutcome> {
  const at = (opts.now ?? new Date()).toISOString();
  const cents = (n: number) => Math.round(n * 100);
  const { before, written } = await changeManualAccount(ctx, account_id, (current) => {
    if (!current) return null;
    opts.expect?.(current);
    const wrong = balanceError(current.type, balance);
    if (wrong) throw new AccountEditRefused(wrong, 400);
    if (cents(current.balance) === cents(balance)) return null;
    return { ...current, balance, updated_at: at };
  });
  if (!before) return { kind: 'missing' };
  if (!written) return { kind: 'same', account: before };
  await invalidate(ctx, opts.rebuild ? await opts.rebuild() : true);
  return { kind: 'set', before, account: written };
}
