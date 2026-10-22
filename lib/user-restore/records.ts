// lib/user-restore/records.ts
//
// The checks a restore shares between the browser, the server and its stores
// (lib/user-restore/): the small value checks, and the shape of a bank's
// transaction and an investment transaction as a download carries them.
// Pure.
//
// CLOSED WHERE NYA DECIDES THE SHAPE, open where the bank does. A
// transaction's own fields are Nya's (lib/transactions.ts StoredTxn): a field
// this release doesn't know refuses it, since it may change what the row
// means. Inside Plaid's own objects (`location`, `payment_meta`,
// `counterparties`, `personal_finance_category`, an investment's `security`),
// the fields Nya reads are typed and others are allowed: Plaid adds fields
// without a Nya release, and the bank store keeps what Plaid sent.

import { isCalendarDay, isCurrencyCode } from '../manual-txn-input';
import { isPlaidId } from './ids';
import type { StoredTxn } from '../transactions';

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isText = (v: unknown, max = 10_000): v is string => typeof v === 'string' && v.length <= max;
export const isTextOrNull = (v: unknown, max = 10_000): v is string | null => v === null || isText(v, max);
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isNumberOrNull = (v: unknown): v is number | null => v === null || isNumber(v);
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** An ISO instant as the app writes them (`toISOString`), or a date-time a
 *  bank sent (Plaid's `datetime`, with its offset): anything `Date` reads. */
export const isInstant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
export const isInstantOrNull = (v: unknown): v is string | null => v === null || isInstant(v);
export const isDayOrNull = (v: unknown): v is string | null => v === null || isCalendarDay(v);
export { isCalendarDay, isCurrencyCode };

/** An id as the storage seam takes one for a field name (lib/repo.ts). */
export const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && v !== '__proto__';

export { PLAID_ID, isPlaidId } from './ids';

/** Only these keys (absent is allowed): the closed check of one object. */
export function onlyKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const k of Object.keys(v)) if (!keys.includes(k)) return false;
  return true;
}

/** The fields of a stored bank transaction (lib/transactions.ts StoredTxn). */
export const BANK_FIELDS = [
  'transaction_id',
  'pending_transaction_id',
  'account_id',
  'amount',
  'iso_currency_code',
  'unofficial_currency_code',
  'date',
  'authorized_date',
  'authorized_datetime',
  'datetime',
  'name',
  'merchant_name',
  'merchant_entity_id',
  'website',
  'logo_url',
  'personal_finance_category',
  'personal_finance_category_icon_url',
  'pending',
  'payment_channel',
  'transaction_code',
  'transaction_type',
  'check_number',
  'account_owner',
  'location',
  'payment_meta',
  'counterparties',
  'category',
  'account_name',
  'institution_name',
] as const satisfies readonly (keyof StoredTxn)[];

/** Plaid's objects inside a transaction: typed where Nya reads them, open
 *  otherwise (see the header). */
function isPfc(v: unknown): boolean {
  return v === null || (isRecord(v) && isTextOrNull(v.primary ?? null, 200) && isTextOrNull(v.detailed ?? null, 200) && isTextOrNull(v.confidence_level ?? null, 40));
}
function isLocation(v: unknown): boolean {
  if (v === null) return true;
  if (!isRecord(v)) return false;
  for (const k of ['address', 'city', 'region', 'postal_code', 'country', 'store_number']) if (!(v[k] === undefined || isTextOrNull(v[k], 500))) return false;
  for (const k of ['lat', 'lon']) if (!(v[k] === undefined || isNumberOrNull(v[k]))) return false;
  return true;
}
function isPaymentMeta(v: unknown): boolean {
  if (v === null) return true;
  if (!isRecord(v)) return false;
  for (const k of ['reference_number', 'ppd_id', 'payee', 'by_order_of', 'payer', 'payment_method', 'payment_processor', 'reason']) {
    if (!(v[k] === undefined || isTextOrNull(v[k], 1000))) return false;
  }
  return true;
}
function isCounterparty(v: unknown): boolean {
  if (!isRecord(v)) return false;
  for (const k of ['name', 'type', 'entity_id', 'website', 'logo_url', 'confidence_level', 'phone_number']) {
    if (!(v[k] === undefined || isTextOrNull(v[k], 1000))) return false;
  }
  return true;
}

/**
 * A bank transaction as a download holds it, with Nya's own fields typed and
 * closed: `null` where the store kept nothing. A field a store from an older
 * release never wrote may be missing; the restore writes it as `null` (or no
 * counterparties), which is how the store reads such a row.
 */
export function isBankRecord(v: unknown, opts: { extra?: readonly string[] } = {}): v is StoredTxn {
  if (!isRecord(v)) return false;
  if (!onlyKeys(v, [...BANK_FIELDS, ...(opts.extra ?? [])])) return false;
  const opt = (k: string, check: (x: unknown) => boolean) => v[k] === undefined || check(v[k]);
  return (
    isPlaidId(v.transaction_id) &&
    opt('pending_transaction_id', (x) => x === null || isPlaidId(x)) &&
    isPlaidId(v.account_id) &&
    isNumber(v.amount) &&
    opt('iso_currency_code', (x) => x === null || isCurrencyCode(x)) &&
    opt('unofficial_currency_code', (x) => isTextOrNull(x, 20)) &&
    isCalendarDay(v.date) &&
    opt('authorized_date', isDayOrNull) &&
    opt('authorized_datetime', isInstantOrNull) &&
    opt('datetime', isInstantOrNull) &&
    isText(v.name, 2000) &&
    opt('merchant_name', (x) => isTextOrNull(x, 2000)) &&
    opt('merchant_entity_id', (x) => isTextOrNull(x, 200)) &&
    opt('website', (x) => isTextOrNull(x, 2000)) &&
    opt('logo_url', (x) => isTextOrNull(x, 2000)) &&
    opt('personal_finance_category', isPfc) &&
    opt('personal_finance_category_icon_url', (x) => isTextOrNull(x, 2000)) &&
    isBool(v.pending) &&
    opt('payment_channel', (x) => isTextOrNull(x, 40)) &&
    opt('transaction_code', (x) => isTextOrNull(x, 40)) &&
    opt('transaction_type', (x) => isTextOrNull(x, 40)) &&
    opt('check_number', (x) => isTextOrNull(x, 100)) &&
    opt('account_owner', (x) => isTextOrNull(x, 500)) &&
    opt('location', isLocation) &&
    opt('payment_meta', isPaymentMeta) &&
    opt('counterparties', (x) => Array.isArray(x) && x.length <= 50 && x.every(isCounterparty)) &&
    opt('category', (x) => isTextOrNull(x, 200)) &&
    opt('account_name', (x) => isText(x, 500)) &&
    opt('institution_name', (x) => isText(x, 500))
  );
}

/** The bank's own fields of a checked record, every one present (`null`, or
 *  no counterparties, where the record had none), and nothing else: what the
 *  bank store would hold for it. */
export function bankFieldsOf(v: StoredTxn | Record<string, unknown>): StoredTxn {
  const r = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of BANK_FIELDS) {
    const x = r[k];
    out[k] = x === undefined ? (k === 'counterparties' ? [] : k === 'account_name' || k === 'institution_name' ? '' : null) : x;
  }
  return out as StoredTxn;
}

/** An investment transaction's fields as a download holds them
 *  (docs/data-export.md, investment_transactions[]): Plaid's, then Nya's. */
export const INVESTMENT_FIELDS = [
  'investment_transaction_id',
  'account_id',
  'security_id',
  'date',
  'name',
  'quantity',
  'price',
  'amount',
  'fees',
  'type',
  'subtype',
  'iso_currency_code',
  'unofficial_currency_code',
  'cancel_transaction_id',
  'item_id',
  'security',
  'seen_at',
  'missing_since',
  'excluded',
  'cancelled',
] as const;

function isSecurity(v: unknown): boolean {
  if (v === null) return true;
  if (!isRecord(v)) return false;
  for (const k of ['name', 'ticker_symbol', 'type', 'cusip', 'isin', 'iso_currency_code']) if (!(v[k] === undefined || isTextOrNull(v[k], 500))) return false;
  return v.is_cash_equivalent === undefined || v.is_cash_equivalent === null || isBool(v.is_cash_equivalent);
}

/** One investment transaction, closed where Nya decides it. Plaid sends a few
 *  more fields on some, which the store keeps as sent: those are allowed, as
 *  Plaid's (the download spreads every field Plaid sent). */
export function isInvestmentRecord(v: unknown): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  const opt = (k: string, check: (x: unknown) => boolean) => v[k] === undefined || check(v[k]);
  return (
    isPlaidId(v.investment_transaction_id) &&
    isText(v.account_id, 150) &&
    isText(v.date, 40) &&
    isPlaidId(v.item_id) &&
    opt('security_id', (x) => isTextOrNull(x, 200)) &&
    opt('name', (x) => isTextOrNull(x, 2000)) &&
    opt('quantity', isNumberOrNull) &&
    opt('price', isNumberOrNull) &&
    opt('amount', isNumberOrNull) &&
    opt('fees', isNumberOrNull) &&
    opt('type', (x) => isTextOrNull(x, 100)) &&
    opt('subtype', (x) => isTextOrNull(x, 100)) &&
    opt('iso_currency_code', (x) => isTextOrNull(x, 20)) &&
    opt('unofficial_currency_code', (x) => isTextOrNull(x, 20)) &&
    opt('cancel_transaction_id', (x) => isTextOrNull(x, 200)) &&
    opt('security', isSecurity) &&
    isText(v.seen_at, 40) &&
    opt('missing_since', (x) => isTextOrNull(x, 40)) &&
    isBool(v.excluded) &&
    isBool(v.cancelled)
  );
}

/** A JSON value's size as written, to bound what one record may hold: the
 *  value is checked after a JSON round trip anyway (the seam's rule), so
 *  this is the text the store would write. */
export const jsonChars = (v: unknown): number => JSON.stringify(v)?.length ?? 0;
