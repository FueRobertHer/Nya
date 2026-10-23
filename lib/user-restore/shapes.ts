// lib/user-restore/shapes.ts
//
// The closed shapes of a download (docs/data-export.md) this release can
// bring back: what the page checks the file's own parts against, record by
// record as it reads them (lib/user-restore/file.ts), before anything is
// sent. Pure, for the browser and the server. The parts kept on the storage
// seam are checked by their stores' own checks, on the server
// (lib/user-restore/check.ts), which the page asks before it starts.
//
// CLOSED. The version can't tell a newer release's file, since an added field
// leaves it at 2, so one field or part this release doesn't know refuses the
// whole file, named by where it is (never by its value): a newer release's
// field may change what the rest means. Where the bank decides the shape (a
// transaction's location, payment_meta, counterparties and
// personal_finance_category, an investment's security), the fields Nya reads
// are typed and the rest allowed, as the bank store keeps what Plaid sent
// (lib/user-restore/records.ts). Where Nya keeps the outside world's own
// record (a link's evidence), anything, as stored.
//
// A problem is said as "<part>[3].field: what is wrong", for the preview.

import { BANK_FIELDS, isBankRecord, isCalendarDay, isCount, isCurrencyCode, isInstant, isInvestmentRecord, isNumber, isRecord, ID, onlyKeys } from './records';
import { CORE_PARTS, HEADER_PARTS, NEVER_CORE, SEAM, isKnownPart, type CorePart } from './parts';

/** A check of one value at a path: null when it passes, else the problem. */
export type Check = (v: unknown, at: string) => string | null;

const said = (at: string, what: string) => `${at}: ${what}`;

export const any: Check = () => null;
export const text =
  (max = 10_000): Check =>
  (v, at) =>
    typeof v === 'string' && v.length <= max ? null : said(at, `must be text of at most ${max} characters`);
export const textOrNull = (max = 10_000): Check => nullable(text(max));
export const number: Check = (v, at) => (isNumber(v) ? null : said(at, 'must be a number'));
export const count: Check = (v, at) => (isCount(v) ? null : said(at, 'must be a whole number'));
export const bool: Check = (v, at) => (typeof v === 'boolean' ? null : said(at, 'must be true or false'));
export const day: Check = (v, at) => (isCalendarDay(v) ? null : said(at, 'must be a day (YYYY-MM-DD)'));
export const instant: Check = (v, at) => (isInstant(v) ? null : said(at, 'must be a time'));
export const id: Check = (v, at) => (typeof v === 'string' && ID.test(v) && v !== '__proto__' ? null : said(at, 'must be an id'));
export const currency: Check = (v, at) => (isCurrencyCode(v) ? null : said(at, 'must be a currency code'));
export const literal =
  (...values: readonly unknown[]): Check =>
  (v, at) =>
    values.includes(v) ? null : said(at, `must be ${values.map((x) => JSON.stringify(x)).join(' or ')}`);
export function nullable(c: Check): Check {
  return (v, at) => (v === null ? null : c(v, at));
}
export function list(item: Check, max = 1_000_000): Check {
  return (v, at) => {
    if (!Array.isArray(v)) return said(at, 'must be a list');
    if (v.length > max) return said(at, `must be a list of at most ${max}`);
    for (let i = 0; i < v.length; i++) {
      const p = item(v[i], `${at}[${i}]`);
      if (p) return p;
    }
    return null;
  };
}
/** An object of these fields and no others; `optional` may be absent. */
export function object(fields: Record<string, Check>, optional: readonly string[] = []): Check {
  const keys = Object.keys(fields);
  return (v, at) => {
    if (!isRecord(v)) return said(at, 'must be an object');
    for (const k of Object.keys(v)) if (!keys.includes(k)) return said(`${at}.${k.slice(0, 60)}`, 'is a field this version of Nya doesn’t know');
    for (const k of keys) {
      if (!(k in v)) {
        if (optional.includes(k)) continue;
        return said(`${at}.${k}`, 'is missing');
      }
      const p = fields[k](v[k], `${at}.${k}`);
      if (p) return p;
    }
    return null;
  };
}
/** An object whose keys are ids, each value checked. */
export function byId(value: Check, max = 100_000): Check {
  return (v, at) => {
    if (!isRecord(v)) return said(at, 'must be an object');
    const entries = Object.entries(v);
    if (entries.length > max) return said(at, `must hold at most ${max}`);
    for (const [k, x] of entries) {
      if (!ID.test(k)) return said(at, 'has a key that isn’t an id');
      const p = value(x, `${at}.${k}`);
      if (p) return p;
    }
    return null;
  };
}

// ---- The header ----

/** The versions this release reads: 1 (a file that was whole, or not made)
 *  as 2 with nothing said missing. */
export const READ_VERSIONS = [1, 2] as const;

const PROBLEM_KINDS = ['unreadable', 'unrecognised', 'unavailable', 'record_id_unreadable'] as const;
export const problemShape = object({ section: text(200), problem: literal(...PROBLEM_KINDS), ids: list(text(400), 1_000_000), count: count }, ['ids', 'count']);

/** What the header says of a file before anything else is read: refused
 *  outright, or which version it is. */
export function checkFormat(format: unknown, version: unknown): { ok: true; version: 1 | 2 } | { ok: false; problem: string } {
  if (format !== 'nya-export') return { ok: false, problem: 'This isn’t a download from Nya: choose the JSON file Download my data made (nya-data-<date>.json, or .json.age when protected).' };
  if (typeof version === 'number' && Number.isInteger(version) && version > 2) {
    return { ok: false, problem: `This file was made by a newer version of Nya (version ${version}): bring it back there, or once this copy is updated.` };
  }
  if (version !== 1 && version !== 2) return { ok: false, problem: 'This file says it is a download from Nya, but its version isn’t one Nya made.' };
  return { ok: true, version };
}

export const HEADER: Record<(typeof HEADER_PARTS)[number], Check> = {
  format: literal('nya-export'),
  version: literal(...READ_VERSIONS),
  exported_at: instant,
  documentation: text(2_000),
  not_included: list(text(5_000), 100),
  notes: list(text(10_000), 10_000),
  problems: list(problemShape, 10_000),
};

// ---- The core parts ----

const lifecycleShape = nullable(object({ state: literal('closed', 'left', 'untracked'), date: day, note: textOrNull(500), assumed: bool }));
const institution = object({ item_id: id, institution_name: text(500), institution_id: textOrNull(200), provider: text(40) });
const account = object({
  account_id: id,
  provider: textOrNull(40),
  item_id: nullable(id),
  institution_name: textOrNull(500),
  institution_id: textOrNull(200),
  connected: bool,
  name: textOrNull(500),
  official_name: textOrNull(500),
  type: textOrNull(40),
  subtype: textOrNull(100),
  mask: textOrNull(40),
  currency: textOrNull(20),
  credit_limit: nullable(number),
  persistent_account_id: textOrNull(500),
  first_seen: nullable(day),
  last_seen: nullable(day),
  hidden: bool,
  hidden_at: nullable(instant),
  latest_balance: nullable(object({ balance: number, date: day })),
  lifecycle: lifecycleShape,
});
const manualAccount = object(
  {
    account_id: id,
    name: text(500),
    institution_name: text(500),
    type: literal('depository', 'credit', 'investment', 'loan', 'other'),
    subtype: textOrNull(100),
    balance: number,
    currency: currency,
    updated_at: nullable(instant),
    hidden: bool,
    hidden_at: nullable(instant),
    lifecycle: lifecycleShape,
  },
  ['currency']
);
const kind = literal('recorded', 'estimated');

/** The fields the download adds to each bank transaction: what the app
 *  works out from what is restored, so never read back. */
const TXN_DERIVED: Record<string, Check> = {
  item_id: id,
  vendor_key: text(2_000),
  your_category: textOrNull(500),
  your_category_from_earlier_account: textOrNull(500),
  nya_category: textOrNull(500),
  nya_category_id: textOrNull(200),
  nya_group: text(500),
  your_merchant_name: textOrNull(500),
  superseded_by_posted: bool,
  account_hidden: bool,
  tags: list(text(200), 1_000),
  your_note: textOrNull(10_000),
  nya_name: text(2_000),
  excluded: nullable(bool),
  excluded_by_rule: bool,
  rule_ids: list(text(200), 1_000),
};
const TXN_DERIVED_KEYS = Object.keys(TXN_DERIVED);
const BANK_KEYS: ReadonlySet<string> = new Set(BANK_FIELDS);
const transaction: Check = (v, at) => {
  if (!isRecord(v)) return said(at, 'must be an object');
  const unknown = Object.keys(v).find((k) => !TXN_DERIVED_KEYS.includes(k) && !BANK_KEYS.has(k));
  if (unknown !== undefined) return said(`${at}.${unknown.slice(0, 60)}`, 'is a field this version of Nya doesn’t know');
  if (!isBankRecord(v, { extra: TXN_DERIVED_KEYS })) return said(at, 'isn’t a bank transaction this version can read');
  const r = v as Record<string, unknown>;
  for (const [k, c] of Object.entries(TXN_DERIVED)) {
    if (!(k in r)) continue;
    const p = c(r[k], `${at}.${k}`);
    if (p) return p;
  }
  return typeof r.item_id === 'string' ? null : said(`${at}.item_id`, 'is missing');
};

const rollover = nullable(object({ from: text(20), why: literal('start', 'reset', 'data', 'budget', 'none'), start: text(20), carry: number, uncertain_months: list(text(20), 1_000) }));

/** Each core part's shape, record by record where the file holds many
 *  (`each`: one element of the part's list at a time), whole otherwise. */
export const CORE: Record<CorePart, { each?: Check; whole?: Check }> = {
  institutions: { each: institution },
  accounts: { each: account },
  manual_accounts: { each: manualAccount },
  hidden_accounts: { each: object({ account_id: id, type: text(40), hidden_at: nullable(instant) }) },
  net_worth_history: { whole: object({ includes_hidden_accounts: literal(true), points: list(object({ date: day, total: number, kind }), 1_000_000) }) },
  account_history: {
    each: object({ account_id: id, points: list(object({ date: day, balance: number, kind, layer: literal('partial', 'extended') }, ['layer']), 1_000_000) }),
  },
  estimate_flat: {
    whole: object({ days: list(object({ date: day, balances: byId(number, 100_000) }), 1_000_000), before_days: nullable(byId(number, 100_000)) }),
  },
  transactions: { each: transaction },
  category_overrides: { each: object({ transaction_id: id, category: text(500) }) },
  merchant_renames: { each: object({ vendor_key: text(2_000), name: text(500) }) },
  investment_transactions: { each: (v, at) => (isInvestmentRecord(v) ? null : said(at, 'isn’t an investment transaction this version can read')) },
  investment_history_coverage: { each: object({ item_id: id, account_id: id, from: text(40), through: text(40) }) },
  account_links: {
    whole: object({
      links: list(object({ earlier_account_id: id, account_id: id, linked_at: instant, evidence: (v, at) => (isRecord(v) ? null : said(at, 'must be an object')) }), 100_000),
      declined_suggestions: list(object({ earlier_account_id: id, account_id: nullable(id), declined_at: instant }), 100_000),
      carried_categories: list(
        object({ earlier_account_id: id, rows: list(object({ date: text(20), amount: nullable(number), description: text(2_000), category: textOrNull(500) }), 1_000_000) }),
        100_000
      ),
    }),
  },
  budgets: {
    whole: nullable(list(object({ category: textOrNull(500), monthly_amount: number, category_id: textOrNull(200), group: textOrNull(500), rollover }), 1_000)),
  },
  group_budgets: { whole: nullable(list(object({ group: textOrNull(500), monthly_amount: number, group_id: textOrNull(200), rollover }), 1_000)) },
  goals: {
    whole: nullable(
      list(
        object(
          {
            id: text(200),
            name: text(500),
            target: number,
            account_id: nullable(id),
            allocation: nullable(number),
            monthly_target: nullable(number),
            target_date: nullable(day),
            archived: nullable(bool),
            archived_on: nullable(day),
            archived_amount: nullable(number),
            plan_start: nullable(object({ date: day, amount: nullable(number) })),
          },
          // A file from before goals had plans has their four fields only.
          ['allocation', 'monthly_target', 'target_date', 'archived', 'archived_on', 'archived_amount', 'plan_start']
        ),
        1_000
      )
    ),
  },
  // Never brought back (parts.ts NEVER_CORE): read to count, whatever they hold.
  api_tokens: { whole: (v, at) => (Array.isArray(v) ? null : said(at, 'must be a list')) },
  attachments: { whole: (v, at) => (Array.isArray(v) ? null : said(at, 'must be a list')) },
  sharing: { whole: any },
};

/** How a seam part's value is laid out in the file: a value store's value
 *  (any JSON, checked by the store on the server), or a map store's entries
 *  as { id, value }, each id once. */
export const seamEntry = object({ id, value: any });

/** A part the file has that this release doesn't know, or null. */
export function unknownPart(keys: Iterable<string>): string | null {
  for (const k of keys) if (!isKnownPart(k)) return k;
  return null;
}

/** Whether a core part is never brought back. */
export const isNeverCore = (part: string): boolean => NEVER_CORE.has(part);

/** The parts a restore writes something for. */
export const writtenSeam = (name: string): boolean => SEAM[name]?.restore === 'write';

export { CORE_PARTS, HEADER_PARTS, onlyKeys };
