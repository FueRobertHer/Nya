// lib/investment-imports.ts
//
// Transactions imported for an investment account from its brokerage's own
// download (today Vanguard's transaction history CSV, lib/import/vanguard-
// transactions.ts), and how they join the rows Plaid sent (lib/invstore.ts)
// on every read. Pure and client safe; the store is lib/investment-imports-
// store.ts.
//
// THE RULE. For each account and day, the import that decides it is the
// newest CSV covering it, or else the newest QFX covering it. Its rows count
// for that day; Plaid's rows and every other import's don't. A day no import
// covers is Plaid's. It is worked out on every read, so an Undo hands each
// day back to the next import in line, or to Plaid, exactly as before, and
// nothing is ever written to Plaid's store. (The estimated history,
// lib/backfill.ts, keeps walking Plaid's rows alone.)
//
// ONLY WHERE IT JOINS NYA'S ACTIVITY. The days imports cover join the days
// Plaid's rows are verified for (the store's coverage) where they touch or
// overlap them, and the joined stretch is the account's coverage from then
// on. An import whose days don't reach that stretch, with days between that
// nothing covers, is said (`unused`) and not used at all: drawing the money-
// added line across days nothing covers would book their flows as growth.
//
// AT THE EDGES. A Plaid row a few days outside the imported days that does
// what a file row inside them does is the same event dated differently
// (settlement against trade), so it is left out (`twins`), one for one, the
// nearest pairs first. Money crossing the account is matched by its flow,
// whatever each source calls it (one books a paycheck as a cash row, the
// other as a buy); anything else by its type, subtype and amount, so a
// dividend is never taken for a deposit of the same amount.
//
// COUNTED TRADES (lib/investments.ts countedTrades) look for evidence within
// 45 days, so they are judged over each source's own rows and joined: over
// all of Plaid's rows, those a file replaces included, so a Plaid trade just
// outside a file's days keeps its evidence; and over each import's own rows.

import { countedTrades, externalFlow, type InvestmentTxn } from './investments';
import type { InvSync } from './invstore';

/** Where an import came from. A CSV decides over a QFX (Fue, 2026-11-12):
 *  the QFX leaves out in-kind transfers and conversion legs. */
export type ImportSource = 'vanguard-csv' | 'vanguard-qfx';

/** A row as stored: an InvestmentTxn without its two ids, which come from
 *  the entry's key and the row's place in it. */
export type ImportedRow = Omit<InvestmentTxn, 'investment_transaction_id' | 'account_id'>;

/** One import of one account, as stored under `${account_id}:${import_id}`,
 *  never changed after it is written. `covers` is the days it holds every row
 *  of, first to last, UTC days as Plaid's are. */
export type InvestmentImport = {
  source: ImportSource;
  file_name: string | null;
  imported_at: string;
  covers: { from: string; to: string };
  currency: string | null;
  rows: ImportedRow[];
};

/** An import as read for an account: its entry and the ids its key holds
 *  (the account id it was imported on, which a link can make an earlier
 *  one). */
export type AccountImport = InvestmentImport & { account_id: string; import_id: string };

/** At most this many imports an account keeps, across its linked ids. */
export const MAX_IMPORTS_PER_ACCOUNT = 24;
/** At most this many accounts take one import: one atomic write
 *  (lib/repo.ts MANY_AT_ONCE). */
export const MAX_ACCOUNTS_PER_IMPORT = 16;
/** At most this many rows an entry holds (lib/import/record.ts
 *  MAX_IMPORT_ROWS, the reader's own bound on a file). */
export const MAX_IMPORTED_ROWS = 10_000;
/** How far apart a Plaid row outside the imported days and a file row inside
 *  them may be dated and still be one event. */
export const EDGE_TWIN_DAYS = 5;

// ---- Keys ------------------------------------------------------------------

/** The key an import of an account is stored under. */
export const importKey = (account_id: string, import_id: string): string => `${account_id}:${import_id}`;

/** A key's two ids, split at its last ':' (an import id holds none), or null
 *  for a key that isn't one. */
export function keyParts(key: string): { account_id: string; import_id: string } | null {
  const at = key.lastIndexOf(':');
  if (at <= 0 || at === key.length - 1) return null;
  return { account_id: key.slice(0, at), import_id: key.slice(at + 1) };
}

// ---- The stored shape ------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** A UTC day, YYYY-MM-DD, that is one, from 1970 on. */
export const isDay = (v: unknown): v is string =>
  typeof v === 'string' && DAY.test(v) && v >= '1970-01-01' && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const CURRENCY = /^[A-Za-z0-9]{2,12}$/;
const MAX_FIGURE = 1e12;
const isFigure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_FIGURE;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isInstant = (v: string) => {
  const at = Date.parse(v);
  return Number.isFinite(at) && new Date(at).toISOString() === v;
};
/** The types a reader gives a row (lib/import/vanguard-transactions.ts
 *  KINDS), as Plaid types them. */
const TYPES = new Set(['buy', 'sell', 'cash', 'fee', 'transfer']);
const ROW_KEYS = ['date', 'name', 'type', 'subtype', 'quantity', 'price', 'amount', 'fees', 'currency', 'security'];
const IMPORT_KEYS = ['source', 'file_name', 'imported_at', 'covers', 'currency', 'rows'];
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k)) && keys.every((k) => k in v);

/** A stored row, closed: every field there and nothing else. */
export function isImportedRow(v: unknown): v is ImportedRow {
  return (
    isRecord(v) &&
    onlyKeys(v, ROW_KEYS) &&
    isDay(v.date) &&
    isText(v.name, 500) &&
    typeof v.type === 'string' &&
    TYPES.has(v.type) &&
    isText(v.subtype, 100) &&
    isFigure(v.quantity) &&
    isFigure(v.price) &&
    isFigure(v.amount) &&
    (v.fees === null || isFigure(v.fees)) &&
    (v.currency === null || (typeof v.currency === 'string' && CURRENCY.test(v.currency))) &&
    (v.security === null || isText(v.security, 500))
  );
}

/** A stored import, closed, its rows inside the days it covers, at least
 *  one: a restore sends a split entry (lib/user-restore/parts.ts) as pieces
 *  of its rows, so an entry with none would never come back, and an account
 *  with nothing in a file's days isn't taken (its days stay Plaid's). Each
 *  piece is checked on its own, so nothing here ties the rows together. */
export function isInvestmentImport(v: unknown): v is InvestmentImport {
  if (!isRecord(v) || !onlyKeys(v, IMPORT_KEYS)) return false;
  if (v.source !== 'vanguard-csv' && v.source !== 'vanguard-qfx') return false;
  if (!(v.file_name === null || isText(v.file_name, 255))) return false;
  // An ISO instant, as written, so the order imports decide in can compare
  // them as text.
  if (typeof v.imported_at !== 'string' || !isInstant(v.imported_at)) return false;
  const covers = v.covers;
  if (!isRecord(covers) || !onlyKeys(covers, ['from', 'to']) || !isDay(covers.from) || !isDay(covers.to) || covers.from > covers.to) return false;
  if (!(v.currency === null || (typeof v.currency === 'string' && CURRENCY.test(v.currency)))) return false;
  const rows = v.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_IMPORTED_ROWS) return false;
  return rows.every((r) => isImportedRow(r) && r.date >= (covers.from as string) && r.date <= (covers.to as string));
}

// ---- The order imports decide in -------------------------------------------

/** What decides between two imports: where each came from, when it was
 *  imported and its id. */
export type Ranked = Pick<AccountImport, 'source' | 'imported_at' | 'import_id'>;

/** First the import that decides a day both cover: a CSV before a QFX, then
 *  the newer (by when imported, then by id, so every reader agrees). */
export function byDeciding(a: Ranked, b: Ranked): number {
  const rank = (i: Ranked) => (i.source === 'vanguard-csv' ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.imported_at !== b.imported_at) return a.imported_at > b.imported_at ? -1 : 1;
  return a.import_id > b.import_id ? -1 : a.import_id < b.import_id ? 1 : 0;
}

// ---- Days ------------------------------------------------------------------

/** Days as whole numbers since 1970, both ends in. */
type Days = readonly [from: number, to: number];
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const dayOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const spanOf = (i: { covers: { from: string; to: string } }): Days => [dayNumber(i.covers.from), dayNumber(i.covers.to)];
const within = (n: number, spans: readonly Days[]) => spans.some(([a, b]) => n >= a && n <= b);

/** Spans that overlap or touch, joined, in order. */
function joined(spans: readonly Days[]): Days[] {
  const out: [number, number][] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `span` less every day in `taken` (joined, in order). */
function less(span: Days, taken: readonly Days[]): Days[] {
  const out: Days[] = [];
  let from = span[0];
  for (const [a, b] of taken) {
    if (b < from || a > span[1]) continue;
    if (a > from) out.push([from, a - 1]);
    from = Math.max(from, b + 1);
  }
  if (from <= span[1]) out.push([from, span[1]]);
  return out;
}

// ---- The merge ---------------------------------------------------------------

/** Days an import decides, in order. */
export type ImportedDays = { import_id: string; from: string; to: string };

export type MergedActivity = {
  /** The sync with the account's rows inside the imported days taken from
   *  the imports that decide them, and its coverage joined. Other accounts'
   *  rows as they were. */
  sync: InvSync;
  /** The counted trades among the merged rows (see the header). */
  counted: Set<InvestmentTxn>;
  /** Each stretch of days an import decides, in order. */
  decided: ImportedDays[];
  /** The imports whose days don't reach Nya's activity: not used. */
  unused: string[];
  /** Plaid's rows inside the imported days, left out. */
  replaced: InvestmentTxn[];
  /** Plaid's rows just outside, left out as the same event as a file row. */
  twins: InvestmentTxn[];
  /** Each twin with the file row it was taken for, in the twins' order. */
  pairs: { plaid: InvestmentTxn; file: InvestmentTxn }[];
};

const cents = (n: number) => Math.round(n * 100);

/**
 * The account's rows with its imports joined (see the header). `imports`
 * are the account's, across its linked ids; their rows take `account_id`,
 * and each its id `${import_id}:${index}`.
 */
export function withImportedRows(sync: InvSync, account_id: string, imports: readonly AccountImport[]): MergedActivity {
  const plaid = sync.rows.filter((t) => t.account_id === account_id);
  const plaidCounted = countedTrades(plaid);
  const cov = sync.coverage[account_id];
  const unchanged = (unused: string[]): MergedActivity => ({ sync, counted: plaidCounted, decided: [], unused, replaced: [], twins: [], pairs: [] });
  if (imports.length === 0) return unchanged([]);
  // No verified days to join: nothing is used.
  if (!cov) return unchanged(imports.map((i) => i.import_id));

  // The stretch around Plaid's verified days that the imports reach,
  // grown until no other import touches it.
  let reach: [number, number] = [dayNumber(cov.from), dayNumber(cov.through)];
  const used = new Set<AccountImport>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of imports) {
      if (used.has(i)) continue;
      const [a, b] = spanOf(i);
      if (a <= reach[1] + 1 && b >= reach[0] - 1) {
        used.add(i);
        reach = [Math.min(reach[0], a), Math.max(reach[1], b)];
        grew = true;
      }
    }
  }
  const unused = imports.filter((i) => !used.has(i)).map((i) => i.import_id);
  if (used.size === 0) return unchanged(unused);

  // Each import's own days, less those of every import before it in line.
  const counted = new Set(plaidCounted);
  const decided: { import_id: string; days: Days }[] = [];
  const fileRows: InvestmentTxn[] = [];
  let taken: Days[] = [];
  for (const i of [...used].sort(byDeciding)) {
    const own = less(spanOf(i), taken);
    taken = joined([...taken, spanOf(i)]);
    const rows = i.rows.map((r, index): InvestmentTxn => ({ ...r, investment_transaction_id: `${i.import_id}:${index}`, account_id }));
    for (const t of countedTrades(rows)) counted.add(t);
    for (const days of own) decided.push({ import_id: i.import_id, days });
    fileRows.push(...rows.filter((t) => within(dayNumber(t.date), own)));
  }

  // Plaid's rows inside the imported days go; just outside, a twin of a
  // file row goes too: the nearest pairs first, one for one.
  const replaced: InvestmentTxn[] = [];
  const outside: InvestmentTxn[] = [];
  for (const t of plaid) (within(dayNumber(t.date), taken) ? replaced : outside).push(t);
  const doing = (t: InvestmentTxn) => {
    const flow = counted.has(t) ? t.amount : externalFlow(t);
    return flow !== 0 ? `flow\u0000${cents(flow)}` : `${t.type.toLowerCase()}\u0000${(t.subtype || '').toLowerCase()}\u0000${cents(t.amount)}`;
  };
  const files = new Map<string, number[]>(); // what a file row does -> its places in fileRows
  fileRows.forEach((t, f) => {
    const k = doing(t);
    (files.get(k) ?? files.set(k, []).get(k)!).push(f);
  });
  const pairs: { p: number; f: number; gap: number }[] = [];
  outside.forEach((t, p) => {
    for (const f of files.get(doing(t)) ?? []) {
      const gap = Math.abs(dayNumber(fileRows[f].date) - dayNumber(t.date));
      if (gap <= EDGE_TWIN_DAYS) pairs.push({ p, f, gap });
    }
  });
  const byDay = (a: InvestmentTxn, b: InvestmentTxn) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.investment_transaction_id < b.investment_transaction_id ? -1 : a.investment_transaction_id > b.investment_transaction_id ? 1 : 0;
  pairs.sort((a, b) => a.gap - b.gap || byDay(outside[a.p], outside[b.p]) || a.f - b.f);
  const paired = new Map<number, number>(); // Plaid's row -> the file row it is
  const matched = new Set<number>();
  for (const { p, f } of pairs) {
    if (paired.has(p) || matched.has(f)) continue;
    paired.set(p, f);
    matched.add(f);
  }
  const twinPairs = [...paired].map(([p, f]) => ({ plaid: outside[p], file: fileRows[f] })).sort((a, b) => byDay(a.plaid, b.plaid));
  const twins = twinPairs.map((t) => t.plaid);
  const kept = outside.filter((_, p) => !paired.has(p));

  const rows = [...sync.rows.filter((t) => t.account_id !== account_id), ...kept, ...fileRows];
  const coverage = { ...sync.coverage, [account_id]: { from: dayOf(reach[0]), through: dayOf(reach[1]) } };
  return {
    sync: { ...sync, rows, coverage },
    counted,
    decided: decided.sort((a, b) => a.days[0] - b.days[0]).map((d) => ({ import_id: d.import_id, from: dayOf(d.days[0]), to: dayOf(d.days[1]) })),
    unused,
    replaced,
    twins,
    pairs: twinPairs,
  };
}

// ---- The request -----------------------------------------------------------

/** The most a file's text may be: Vanguard's download at the reader's bound
 *  on lines, with room. */
export const MAX_FILE_CHARS = 3 * 1024 * 1024;

export type ImportsChange =
  | {
      /** What importing the file would do, for the review. */
      action: 'review';
      account_id: string;
      file_name: string | null;
      text: string;
      today: string;
    }
  | {
      action: 'import';
      /** The account whose sheet it is: answered with its imports. */
      account_id: string;
      file_name: string | null;
      /** The file as read on the device, read again on the server. */
      text: string;
      /** The person's own today: the file's days end the day before. */
      today: string;
      /** Each account the file's rows go to, by the last four digits the
       *  file gives it. */
      take: { account_id: string; mask: string }[];
      /** The fingerprint the file was reviewed against. */
      counting: string;
    }
  | { action: 'undo'; account_id: string; import_id: string };

const ACCOUNT_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const IMPORT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const FINGERPRINT = /^[A-Za-z0-9_-]{1,64}$/;
const isAccountId = (v: unknown): v is string => typeof v === 'string' && ACCOUNT_ID.test(v) && v !== '__proto__';

/**
 * A request to the route, or what is wrong with it in the person's words:
 *
 *   { action: 'review', account_id, file_name, text, today }
 *   { action: 'import', account_id, file_name, text, today, take, counting }
 *   { action: 'undo', account_id, import_id }
 */
export function parseImportsChange(body: unknown): ImportsChange | string {
  if (!isRecord(body)) return 'Send the file, as JSON';
  const { account_id, action } = body;
  if (!isAccountId(account_id)) return 'Invalid account id';
  if (action === 'undo') {
    if (Object.keys(body).some((k) => !['action', 'account_id', 'import_id'].includes(k))) return 'Undoing takes the account and the import alone';
    if (typeof body.import_id !== 'string' || !IMPORT_ID.test(body.import_id)) return 'Invalid import id';
    return { action: 'undo', account_id, import_id: body.import_id };
  }
  if (action !== 'import' && action !== 'review') return 'Say whether to review, import or undo';
  const fields = action === 'review' ? ['action', 'account_id', 'file_name', 'text', 'today'] : ['action', 'account_id', 'file_name', 'text', 'today', 'take', 'counting'];
  const extra = Object.keys(body).find((k) => !fields.includes(k));
  if (extra) return `${extra.slice(0, 40)} isn’t part of ${action === 'review' ? 'a review' : 'an import'}`;
  const file_name = body.file_name ?? null;
  if (file_name !== null && (typeof file_name !== 'string' || file_name.length > 255)) return 'Invalid file name';
  if (typeof body.text !== 'string' || body.text.length === 0 || body.text.length > MAX_FILE_CHARS) return 'Send the file’s text';
  if (!isDay(body.today)) return 'Send today, YYYY-MM-DD';
  if (action === 'review') return { action, account_id, file_name, text: body.text, today: body.today };
  const take = body.take;
  if (!Array.isArray(take) || take.length === 0) return 'Choose at least one account';
  if (take.length > MAX_ACCOUNTS_PER_IMPORT) return `At most ${MAX_ACCOUNTS_PER_IMPORT} accounts take one import`;
  for (const t of take) {
    if (!isRecord(t) || Object.keys(t).some((k) => k !== 'account_id' && k !== 'mask')) return 'Each account is its id and the last four digits the file gives it';
    if (!isAccountId(t.account_id)) return 'Invalid account id';
    if (typeof t.mask !== 'string' || !/^\d{4}$/.test(t.mask)) return 'Each account’s last four digits, as the file gives them';
  }
  const chosen = take as { account_id: string; mask: string }[];
  if (new Set(chosen.map((t) => t.account_id)).size !== chosen.length) return 'Each account once';
  if (new Set(chosen.map((t) => t.mask)).size !== chosen.length) return 'Each of the file’s accounts once';
  if (typeof body.counting !== 'string' || !FINGERPRINT.test(body.counting)) return 'Say which imports the file was checked against';
  return {
    action: 'import',
    account_id,
    file_name,
    text: body.text,
    today: body.today,
    take: chosen.map((t) => ({ account_id: t.account_id, mask: t.mask })),
    counting: body.counting,
  };
}

/** The day before a day. */
export const dayBefore = (d: string): string => dayOf(dayNumber(d) - 1);
/** Days from `a` to `b`. */
export const daysApart = (a: string, b: string): number => dayNumber(b) - dayNumber(a);

// ---- After an undo ---------------------------------------------------------

/** A stretch of days and what decides it: an import, or Plaid (`by` null). */
export type DecidedBy = { from: string; to: string; by: string | null };

/**
 * What decides an import's days once it is undone, by the same rule:
 * `decided` is what it decides now (the activity's `imported_days` for it),
 * `others` the account's other imports. Each day goes to the first of them in
 * line that covers it, else back to Plaid. One that stops reaching Nya's
 * activity once this one goes (it touched only this one's days) is taken as
 * still reaching it: that is rare, and only the words are off then.
 */
export function afterUndo(decided: readonly { from: string; to: string }[], others: readonly (Ranked & { covers: { from: string; to: string } })[]): DecidedBy[] {
  const out: { days: Days; by: string | null }[] = [];
  const line = [...others].sort(byDeciding);
  for (const d of decided) {
    let left: Days[] = [[dayNumber(d.from), dayNumber(d.to)]];
    for (const o of line) {
      const [a, b] = spanOf(o);
      for (const [x, y] of left) {
        const from = Math.max(a, x);
        const to = Math.min(b, y);
        if (from <= to) out.push({ days: [from, to], by: o.import_id });
      }
      left = left.flatMap((span) => less(span, [[a, b]]));
    }
    for (const days of left) out.push({ days, by: null });
  }
  out.sort((a, b) => a.days[0] - b.days[0]);
  const merged: { days: [number, number]; by: string | null }[] = [];
  for (const o of out) {
    const last = merged[merged.length - 1];
    if (last && last.by === o.by && o.days[0] <= last.days[1] + 1) last.days[1] = Math.max(last.days[1], o.days[1]);
    else merged.push({ days: [o.days[0], o.days[1]], by: o.by });
  }
  return merged.map((m) => ({ from: dayOf(m.days[0]), to: dayOf(m.days[1]), by: m.by }));
}
