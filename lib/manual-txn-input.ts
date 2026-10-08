// lib/manual-txn-input.ts
//
// What a manual transaction may hold, and how its fields are read from the
// quick-add form (components/ManualTxnSheet.tsx) and from a request
// (app/api/manual-transactions), shared so the two agree. Pure, safe to
// import from client code; the store is lib/manual-txns.ts.

export const MAX_PAYEE_CHARS = 100; // as long as a vendor rename (app/api/rename)
export const MAX_CATEGORY_CHARS = 60; // as long as a recategorization (app/api/recategorize)
export const MAX_NOTE_CHARS = 500;
/** How far ahead a date may be: a mistyped year (2062 for 2026) is refused,
 *  a bill entered a little ahead of time is not. */
export const MAX_FUTURE_DAYS = 366;
/** The earliest date taken: earlier than any history an import could bring. */
export const EARLIEST_DATE = '1900-01-01';
/** The bound on an amount, the same as on a manual account's balance
 *  (MAX_BALANCE in lib/manual.ts, which test/manual-txns.test.ts holds this
 *  to): a pasted account number is refused before it can swamp a total. */
export const MAX_AMOUNT = 1e12;
/** Manual accounts are kept in US dollars (lib/manual.ts toInstitutions), so a
 *  transaction is too unless the person picks another currency. */
export const DEFAULT_CURRENCY = 'USD';

/** Where a row came from, in a few words for the transaction list. Rows
 *  entered in the app are 'manual'; imports (#43) and SimpleFIN add theirs. */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'manual':
      return 'entered by hand';
    case 'import:csv':
      return 'imported from CSV';
    case 'import:ofx':
      return 'imported from OFX';
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

/**
 * An amount as typed, or null if it isn't one. No sign: the form asks whether
 * money went out or came in, since a phone's decimal keypad has no minus key.
 * That keypad shows the locale's decimal separator, so "12,50" is twelve and a
 * half. Thousands separators are taken too: with both marks, the last one is
 * the decimal point ("1,234.56", "1.234,56"); several of one mark only group
 * thousands ("1,234,567"); and a lone comma before exactly three digits, after
 * one to three that don't start with 0, groups thousands ("1,234" is 1234, as
 * typed in the US), since money is rarely written to three decimal places.
 * Zero is not an amount. The form shows what it read before anything is saved.
 */
export function parseAmountInput(text: string): number | null {
  const s = text.replace(/[\s ]/g, '');
  if (!/^[0-9.,]+$/.test(s) || !/\d/.test(s)) return null;
  const dots = s.split('.').length - 1;
  const commas = s.split(',').length - 1;
  let normal: string;
  if (dots > 0 && commas > 0) {
    const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    if ((decimal === '.' ? dots : commas) !== 1) return null;
    normal = s.split(decimal === '.' ? ',' : '.').join('').replace(',', '.');
  } else if (commas === 1) {
    normal = /^[1-9]\d{0,2},\d{3}$/.test(s) ? s.replace(',', '') : s.replace(',', '.');
  } else if (commas > 1) {
    normal = s.split(',').join('');
  } else {
    normal = dots > 1 ? s.split('.').join('') : s;
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(normal)) return null;
  const n = Number(normal);
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
  if (v > addDays(today, MAX_FUTURE_DAYS)) return fail("The date can't be more than a year from today");
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
 * type, length and range. A new transaction (`partial` false) needs a date, an
 * amount and a payee, and takes USD and no category or note for those left
 * out. An edit (`partial` true) reads only the fields it carries; a category or
 * note sent as null is cleared. `today` is the server's day (UTC), which a date
 * may not be more than MAX_FUTURE_DAYS past.
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
  return { fields: fields as Partial<TxnFields> };
}
