// lib/manual-txn-input.ts
//
// What a manual transaction may hold, and how its fields are read from the
// quick-add form (components/ManualTxnSheet.tsx) and from a request
// (app/api/manual-transactions), shared so the two agree. Pure, safe to
// import from client code; the store is lib/manual-txns.ts.

export const MAX_PAYEE_CHARS = 100; // as long as a vendor rename (app/api/rename)
export const MAX_CATEGORY_CHARS = 60; // as long as a recategorization (app/api/recategorize)
export const MAX_NOTE_CHARS = 500;
/** How far past the server's day a date may be: one day, because the server
 *  counts days in UTC and a person east of it is already in tomorrow. Nothing
 *  later: a transaction is something that happened, and one dated ahead would
 *  count in a month's totals before it did (and open the Activity tab on a
 *  month still to come). */
export const MAX_FUTURE_DAYS = 1;
/** The earliest date taken: earlier than any history an import could bring. */
export const EARLIEST_DATE = '1900-01-01';
/** The bound on an amount, the same as on a manual account's balance
 *  (MAX_BALANCE in lib/manual.ts, which test/manual-txns.test.ts holds this
 *  to): a pasted account number is refused before it can swamp a total. */
export const MAX_AMOUNT = 1e12;
/** Manual accounts are kept in US dollars (lib/manual.ts toInstitutions), so a
 *  transaction is too unless the person picks another currency. */
export const DEFAULT_CURRENCY = 'USD';

/** The start of every manual row's id. Not a Plaid id: Plaid's have no colon. */
export const MANUAL_TXN_PREFIX = 'manual-txn:';

/** A new row's id: the prefix and a random UUID. Minted by the quick-add form
 *  when it opens, so sending the same add again finds its row already there
 *  (lib/manual-txns.ts addManualTxn). */
export function newManualTxnId(): string {
  return `${MANUAL_TXN_PREFIX}${crypto.randomUUID()}`;
}

/** Where a row came from, in a few words for the transaction list. Rows
 *  entered in the app are 'manual'; file imports (lib/import/) and SimpleFIN
 *  add theirs. */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'manual':
      return 'entered by hand';
    case 'import:csv':
      return 'imported from CSV';
    case 'import:ofx':
      return 'imported from OFX';
    case 'import:qif':
      return 'imported from QIF';
    case 'simplefin':
      return 'from SimpleFIN';
    default:
      return source;
  }
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day written YYYY-MM-DD ("2026-02-30" is not one). */
export function isCalendarDay(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

/** The calendar day `n` days after `day` (both YYYY-MM-DD). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Three capital letters, the way ISO 4217 writes a currency. */
export function isCurrencyCode(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Z]{3}$/.test(s);
}

/** Whether this runtime knows the currency (ISO 4217's list, as Intl has it),
 *  so a typo ("USX") is refused. A runtime without the list takes any code of
 *  the right form. */
export function knownCurrency(code: string): boolean {
  if (!isCurrencyCode(code)) return false;
  const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof list !== 'function') return true;
  return list('currency').includes(code);
}

/** How many decimal places an amount in the currency has: its minor unit, as
 *  Intl knows it (2 for USD and EUR, 0 for JPY, 3 for KWD), or 2 for a code
 *  Intl doesn't take. */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** The amount rounded to the currency's minor unit (half away from zero). */
export function toMinorUnits(amount: number, currency: string): number {
  const scale = 10 ** minorDigits(currency);
  return (Math.sign(amount) * Math.round(Math.abs(amount) * scale)) / scale;
}

/** Whether the amount is a whole number of the currency's minor units: no
 *  more precise than the currency allows. */
export function inMinorUnits(amount: number, currency: string): boolean {
  const scaled = Math.abs(amount) * 10 ** minorDigits(currency);
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Why an amount can't be in the currency, or null: more precise than its
 *  minor unit (which includes smaller than one). */
export function amountUnitsError(amount: number, currency: string): string | null {
  if (inMinorUnits(amount, currency)) return null;
  const d = minorDigits(currency);
  return d === 0
    ? `An amount in ${currency} is a whole number`
    : `An amount in ${currency} has at most ${d} decimal place${d === 1 ? '' : 's'}`;
}

/**
 * An amount as typed, rounded to the currency's minor unit, or null if it
 * isn't one. No sign: the form asks whether money went out or came in, since a
 * phone's decimal keypad has no minus key. That keypad shows the locale's
 * decimal separator, so "12,50" is twelve and a half.
 *
 * Thousands separators are taken only where they group properly, so a
 * doubled or stray mark never turns into a hundredfold amount ("12..50",
 * "12,,50", "12.5.0" and "1,2,3" are not amounts):
 *   - with both marks, the last one is the decimal point, once, and the other
 *     groups the digits before it in threes: "1,234.56", "1.234,56";
 *   - one mark used several times groups in threes, with no decimals:
 *     "1,234,567", "1.234.567";
 *   - one mark used once is the decimal point ("12,50", "1.234"), except a
 *     comma before exactly three digits, after one to three that don't start
 *     with 0: "1,234" is 1234, as typed in the US, since money is rarely
 *     written to three decimal places.
 * Zero, and anything that rounds to it, is not an amount. The form shows what
 * it read before anything is saved.
 */
export function parseAmountInput(text: string, currency: string = DEFAULT_CURRENCY): number | null {
  const s = text.replace(/[\s  ]/g, '');
  if (!/^[0-9.,]+$/.test(s) || !/\d/.test(s)) return null;
  const dots = s.split('.').length - 1;
  const commas = s.split(',').length - 1;
  let normal: string | null = null;
  const grouped = (digits: string, mark: string) => new RegExp(`^\\d{1,3}(\\${mark}\\d{3})*$`).test(digits);
  if (dots > 0 && commas > 0) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    const at = s.lastIndexOf(decimal);
    const [whole, fraction] = [s.slice(0, at), s.slice(at + 1)];
    if ((decimal === '.' ? dots : commas) === 1 && grouped(whole, group) && /^\d*$/.test(fraction)) {
      normal = `${whole.split(group).join('')}.${fraction}`;
    }
  } else if (dots + commas > 1) {
    const mark = dots > 0 ? '.' : ',';
    if (grouped(s, mark)) normal = s.split(mark).join('');
  } else if (commas === 1 && /^[1-9]\d{0,2},\d{3}$/.test(s)) {
    normal = s.replace(',', '');
  } else {
    normal = s.replace(',', '.');
  }
  if (normal === null || !/^(\d+\.?\d*|\.\d+)$/.test(normal)) return null;
  const n = toMinorUnits(Number(normal), currency);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A manual account's balance after a transaction, as a normal balance update
 *  records it, to the cent. Plaid's sign: a positive amount is money out, which
 *  lowers what an account holds and raises what is owed on a card or loan. */
export function balanceAfter(balance: number, amount: number, owed: boolean): number {
  return Math.round((owed ? balance + amount : balance - amount) * 100) / 100;
}

/** The fields of a manual transaction a person enters. */
export type TxnFields = {
  date: string;
  amount: number;
  currency: string;
  name: string;
  category: string | null;
  note: string | null;
};

type Read<T> = { ok: true; value: T } | { ok: false; error: string };
function ok<T>(value: T): Read<T> {
  return { ok: true, value };
}
function fail<T>(error: string): Read<T> {
  return { ok: false, error };
}

function readDate(v: unknown, today: string): Read<string> {
  if (typeof v !== 'string' || !DAY.test(v)) return fail('Enter the date as YYYY-MM-DD');
  if (!isCalendarDay(v)) return fail('That date is not a real day');
  if (v < EARLIEST_DATE) return fail(`The date can't be before ${EARLIEST_DATE}`);
  if (v > addDays(today, MAX_FUTURE_DAYS)) return fail("The date can't be in the future");
  return ok(v);
}

function readAmount(v: unknown): Read<number> {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail('Enter an amount');
  if (v === 0) return fail('Enter an amount other than zero');
  if (Math.abs(v) > MAX_AMOUNT) return fail('That amount is too large');
  return ok(v);
}

function readCurrency(v: unknown): Read<string> {
  if (typeof v !== 'string') return fail('Invalid currency');
  const code = v.trim().toUpperCase();
  if (!knownCurrency(code)) return fail('Enter a currency as its three-letter code, like USD or EUR');
  return ok(code);
}

function readName(v: unknown): Read<string> {
  if (typeof v !== 'string') return fail('Enter who was paid, or who paid you');
  const name = v.replace(/\s+/g, ' ').trim();
  if (!name) return fail('Enter who was paid, or who paid you');
  if (name.length > MAX_PAYEE_CHARS) return fail(`The payee can be at most ${MAX_PAYEE_CHARS} characters`);
  return ok(name);
}

/** A category: lower case, as recategorizing stores one; empty is none. */
function readCategory(v: unknown): Read<string | null> {
  if (v === null) return ok(null);
  if (typeof v !== 'string') return fail('Invalid category');
  const category = v.replace(/\s+/g, ' ').trim().toLowerCase();
  if (category.length > MAX_CATEGORY_CHARS) return fail(`The category can be at most ${MAX_CATEGORY_CHARS} characters`);
  return ok(category || null);
}

function readNote(v: unknown): Read<string | null> {
  if (v === null) return ok(null);
  if (typeof v !== 'string') return fail('Invalid note');
  const note = v.trim();
  if (note.length > MAX_NOTE_CHARS) return fail(`The note can be at most ${MAX_NOTE_CHARS} characters`);
  return ok(note || null);
}

/** What a new transaction takes for a field left out. */
const DEFAULTS: Partial<TxnFields> = { currency: DEFAULT_CURRENCY, category: null, note: null };

/**
 * The fields of a request body, checked strictly: each must have the right
 * type, length and range, and an amount must be a whole number of its
 * currency's minor units (a cent, a yen). A new transaction (`partial` false)
 * needs a date, an amount and a payee, and takes USD and no category or note
 * for those left out. An edit (`partial` true) reads only the fields it
 * carries; a category or note sent as null is cleared, and an amount or a
 * currency sent alone is checked against the other as stored
 * (lib/manual-txns.ts editManualTxn). `today` is the server's day (UTC),
 * which a date may not be more than MAX_FUTURE_DAYS past.
 */
export function readTxnFields(
  body: Record<string, unknown>,
  opts: { partial: boolean; today: string }
): { fields: Partial<TxnFields> } | { error: string } {
  const readers: Record<keyof TxnFields, () => Read<unknown>> = {
    date: () => readDate(body.date, opts.today),
    amount: () => readAmount(body.amount),
    currency: () => readCurrency(body.currency),
    name: () => readName(body.name),
    category: () => readCategory(body.category),
    note: () => readNote(body.note),
  };
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(readers) as (keyof TxnFields)[]) {
    if (body[key] === undefined) {
      if (opts.partial) continue;
      if (key in DEFAULTS) {
        fields[key] = DEFAULTS[key];
        continue;
      }
      // Required, and missing: its reader says what to enter.
    }
    const r = readers[key]();
    if (!r.ok) return { error: r.error };
    fields[key] = r.value;
  }
  const read = fields as Partial<TxnFields>;
  if (read.amount !== undefined && read.currency !== undefined) {
    const units = amountUnitsError(read.amount, read.currency);
    if (units) return { error: units };
  }
  return { fields: read };
}
