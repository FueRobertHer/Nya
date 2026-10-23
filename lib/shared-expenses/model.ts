// lib/shared-expenses/model.ts
//
// Shared expenses (#49): what other people owe you and what you owe them,
// kept as the person says it, with a running balance per person worked out
// from it on every read (lib/shared-expenses/balances.ts). Nya never moves
// money: it keeps the list, opens a payment app with a request filled in
// (lib/shared-expenses/links.ts), and proposes which of the person's own
// transactions paid something back (lib/shared-expenses/match.ts), which
// only the person confirms. Pure, safe in the browser: the shapes, their
// checks and the limits. The stores are lib/shared-expenses/store.ts.
//
// WHAT IS KEPT.
//   - A PERSON: a name the person types (unique in any case or spacing) and,
//     optionally, the public handle they would type into Venmo or Cash App
//     to find them. Never an email, a phone number, bank details or a Nya
//     account: they never need Nya. Forgetting one keeps the money and drops
//     the name (removed_at), so no past total moves.
//   - A SHARE of one of the person's transactions (money out, posted, in a
//     currency): who owes which part of it, by entries, each with an id of
//     its own. On a split transaction (#39) it names the part it comes from.
//   - An IOU, typed, with no transaction of the person's behind it: owed to
//     them or by them. One they owe can name the category of what it was for
//     (their part of groceries someone else paid for), which then counts as
//     their spending on its day; one with no category is a loan.
//   - A PAYMENT: one of the person's transactions they confirmed paid
//     something back, by how much of each item it closes (allocations).
//   - What closed an item outside any transaction Nya sees (cash, another
//     app) or what the person let go: kept on the item itself (`closed`), so
//     counting a row never reads a list of settlements.
//   - A ROW THE PERSON SAID IS NO REPAYMENT, so it is never proposed again.
//   - The setting: whether shared expenses change totals (`counting`).
//
// AMOUNTS are positive, in the item's currency, no finer than its minor unit
// (lib/split-rows.ts unitScale): what is owed, or what closes it. Which way
// the money goes is the item's direction. Plaid's sign belongs to rows only.
//
// THE SHAPES ARE CLOSED. A field this release doesn't know makes the entry
// unrecognised, never half applied: a share read without a field a later
// release added could count a part that shouldn't. Stored bounds are wider
// than an edit may make, so an entry saved under other limits still reads.

import { isCalendarDay } from '../manual-txn-input';

export const EXPENSES_VERSION = 1;

// ---- Limits ----

/** A person's name, as long as a category's. */
export const PERSON_NAME_MAX = 60;
/** What an item was for, as the card and the message show it. */
export const WHAT_MAX = 120;
/** A note on what closed an item, or on a payment. */
export const NOTE_MAX = 200;
/** A Venmo username or a Cash App cashtag. */
export const HANDLE_MAX = 30;
export const MAX_PEOPLE = 200;
/** The requests kept on a person: the latest. */
export const MAX_REQUESTS = 20;
export const MAX_SHARES = 5_000;
/** People sharing one transaction with the person. */
export const MAX_ENTRIES = 20;
export const MAX_IOUS = 5_000;
export const MAX_PAYMENTS = 10_000;
/** Items one payment, one request or one settling outside can close. */
export const MAX_ALLOCATIONS = 100;
/** What can close one item outside a payment. */
export const MAX_CLOSED = 50;
export const MAX_DISMISSED = 2_000;
/** A row said to be no repayment is kept this many days after its day:
 *  longer than any window a proposal is looked for in. */
export const DISMISSED_DAYS = 180;
/** Transactions one tap can share from a tag. */
export const MAX_BATCH = 50;
/** An item open this many months gets "let it go?" on the card. */
export const LET_GO_MONTHS = 6;

// Stored bounds (see THE SHAPES ARE CLOSED).
const STORED_TEXT = 10_000;
const STORED_LIST = 1_000;

// ---- Kinds ----

export const COUNTINGS = ['part', 'bank'] as const;
/** `part`: your part of a shared expense counts, on the day it was bought,
 *  and money moving between you and another person counts as neither
 *  spending nor income. `bank`: every row counts as the bank shows it. */
export type Counting = (typeof COUNTINGS)[number];
export const DEFAULT_COUNTING: Counting = 'part';

export const APPS = ['venmo', 'cashapp', 'other'] as const;
export type PaymentApp = (typeof APPS)[number];

export const DIRECTIONS = ['to_you', 'by_you'] as const;
/** `to_you`: they owe you. `by_you`: you owe them. */
export type Direction = (typeof DIRECTIONS)[number];

/** How an entry of a share was worked out, for the sheet that edits it: the
 *  amount is what counts. */
export type SplitHow = { kind: 'half' } | { kind: 'even'; ways: number } | { kind: 'percent'; percent: number } | { kind: 'amount' };

export const CLOSED_KINDS = ['outside', 'forgiven'] as const;
export type ClosedKind = (typeof CLOSED_KINDS)[number];

export const REQUEST_VIAS = ['venmo', 'venmo-app', 'cashapp', 'message'] as const;
export type RequestVia = (typeof REQUEST_VIAS)[number];

// ---- Shapes ----

/** What closed some of an item outside a payment: settled outside the
 *  person's accounts (cash, an app Nya doesn't see), or let go. Items closed
 *  together carry one `event`. */
export type Closed = { event: string; kind: ClosedKind; amount: number; date: string; note?: string; at: string };

/** A request the person sent through the handoff (lib/shared-expenses/links.ts). */
export type PaymentRequest = { id: string; at: string; direction: Direction; amount: number; currency: string; via: RequestVia; items: string[] };

export type Person = {
  version: typeof EXPENSES_VERSION;
  /** Absent only once the person was forgotten (removed_at). */
  name?: string;
  venmo?: string;
  cashtag?: string;
  app?: PaymentApp;
  /** Transactions carrying this tag are offered as shared with them, split so. */
  tag?: { id: string; how: SplitHow };
  requests?: PaymentRequest[];
  archived_at?: string;
  removed_at?: string;
  created_at: string;
  updated_at: string;
};

export type ShareEntry = { id: string; person: string; amount: number; how?: SplitHow; closed?: Closed[] };

/** Who owes what of one transaction, kept under the transaction's id. */
export type Share = {
  version: typeof EXPENSES_VERSION;
  /** The split part (#39) it is shared from, by the part's id. */
  part?: string;
  account_id: string;
  /** The transaction's (or the part's) amount and currency when shared. */
  amount_was: number;
  currency: string;
  date: string;
  what: string;
  entries: ShareEntry[];
  /** The person said to keep it although its transaction is gone. */
  kept_gone?: string;
  created_at: string;
  updated_at: string;
};

export type Iou = {
  version: typeof EXPENSES_VERSION;
  person: string;
  direction: Direction;
  amount: number;
  currency: string;
  date: string;
  what: string;
  /** For one owed by the person: the category (in a spending group) of what
   *  their part was for. Absent: a loan. */
  category_id?: string;
  closed?: Closed[];
  created_at: string;
  updated_at: string;
};

export type Allocation = { item: string; amount: number };

/** One of the person's transactions they confirmed paid something back,
 *  under its id. */
export type Payment = {
  version: typeof EXPENSES_VERSION;
  account_id: string;
  /** The row as confirmed: Plaid's sign. */
  row: { amount: number; currency: string; date: string };
  allocations: Allocation[];
  note?: string;
  kept_gone?: string;
  confirmed_at: string;
};

/** A row the person said is no repayment, under its id. */
export type Dismissed = { version: typeof EXPENSES_VERSION; date: string; at: string };

export type ExpenseSettings = {
  version: typeof EXPENSES_VERSION;
  counting: Counting;
  own_venmo?: string;
  own_cashtag?: string;
  updated_at: string;
};

// ---- Checks of the stored shapes ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const isInstant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isText = (v: unknown, max = STORED_TEXT): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const optional = (v: unknown, check: (x: unknown) => boolean) => v === undefined || check(v);

/** A transaction's or an account's id, as lib/txn-annotations.ts
 *  isTransactionId takes one (kept here so this module stays light in the
 *  browser: that one declares a store). */
export const isTransactionId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v) && v !== '__proto__';
/** A tag's id, as lib/tags.ts isTagId takes one. */
const isTagId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
/** An id Nya made (crypto.randomUUID()), or any of the same characters. */
const ID = /^[A-Za-z0-9-]{1,64}$/;
export const isExpenseId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
/** A category's id as stored (lib/category-store.ts takes the same). */
const CATEGORY_ID = /^[A-Za-z0-9_:-]{1,80}$/;
export const isCategoryRef = (v: unknown): v is string => typeof v === 'string' && CATEGORY_ID.test(v);
/** A currency as a row carries it: ISO's code, or Plaid's unofficial one. */
const CURRENCY = /^[A-Z0-9]{2,10}$/;
export const isCurrencyRef = (v: unknown): v is string => typeof v === 'string' && CURRENCY.test(v);
/** A handle: letters, digits, "-" and "_", not all digits (so nothing that
 *  looks like a card, account or phone number is ever kept). */
const HANDLE = /^[A-Za-z0-9_-]+$/;
export function isHandle(v: unknown, max = HANDLE_MAX): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && HANDLE.test(v) && !/^[0-9_-]+$/.test(v);
}

export function isSplitHow(v: unknown): v is SplitHow {
  if (!isRecord(v)) return false;
  if (v.kind === 'half' || v.kind === 'amount') return only(v, ['kind']);
  if (v.kind === 'even') return only(v, ['kind', 'ways']) && typeof v.ways === 'number' && Number.isInteger(v.ways) && v.ways >= 2 && v.ways <= 100;
  if (v.kind === 'percent') return only(v, ['kind', 'percent']) && typeof v.percent === 'number' && Number.isFinite(v.percent) && v.percent > 0 && v.percent <= 100;
  return false;
}

export function isClosed(v: unknown): v is Closed {
  return (
    isRecord(v) &&
    only(v, ['event', 'kind', 'amount', 'date', 'note', 'at']) &&
    isExpenseId(v.event) &&
    (CLOSED_KINDS as readonly unknown[]).includes(v.kind) &&
    isPositive(v.amount) &&
    isCalendarDay(v.date) &&
    optional(v.note, (x) => isText(x)) &&
    isInstant(v.at)
  );
}

const isClosedList = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= STORED_LIST && v.every(isClosed) && new Set(v.map((c) => (c as Closed).event)).size === v.length);

export function isPaymentRequest(v: unknown): v is PaymentRequest {
  return (
    isRecord(v) &&
    only(v, ['id', 'at', 'direction', 'amount', 'currency', 'via', 'items']) &&
    isExpenseId(v.id) &&
    isInstant(v.at) &&
    (DIRECTIONS as readonly unknown[]).includes(v.direction) &&
    isPositive(v.amount) &&
    isCurrencyRef(v.currency) &&
    (REQUEST_VIAS as readonly unknown[]).includes(v.via) &&
    Array.isArray(v.items) &&
    v.items.length <= STORED_LIST &&
    v.items.every(isExpenseId)
  );
}

export function isPerson(v: unknown): v is Person {
  if (!isRecord(v) || !only(v, ['version', 'name', 'venmo', 'cashtag', 'app', 'tag', 'requests', 'archived_at', 'removed_at', 'created_at', 'updated_at'])) return false;
  if (v.version !== EXPENSES_VERSION || !isInstant(v.created_at) || !isInstant(v.updated_at)) return false;
  // A name, unless the person was forgotten; then no name and no handle.
  if (v.removed_at !== undefined) {
    if (!isInstant(v.removed_at) || v.name !== undefined || v.venmo !== undefined || v.cashtag !== undefined) return false;
  } else if (!isText(v.name, STORED_TEXT)) return false;
  if (!optional(v.venmo, (x) => isHandle(x, 100)) || !optional(v.cashtag, (x) => isHandle(x, 100))) return false;
  if (!optional(v.app, (x) => (APPS as readonly unknown[]).includes(x))) return false;
  if (v.tag !== undefined && !(isRecord(v.tag) && only(v.tag, ['id', 'how']) && isTagId(v.tag.id) && isSplitHow(v.tag.how) && v.tag.how.kind !== 'amount')) return false;
  if (v.requests !== undefined && !(Array.isArray(v.requests) && v.requests.length <= STORED_LIST && v.requests.every(isPaymentRequest))) return false;
  return optional(v.archived_at, isInstant);
}

export function isShareEntry(v: unknown): v is ShareEntry {
  return (
    isRecord(v) &&
    only(v, ['id', 'person', 'amount', 'how', 'closed']) &&
    isExpenseId(v.id) &&
    isExpenseId(v.person) &&
    isPositive(v.amount) &&
    optional(v.how, isSplitHow) &&
    isClosedList(v.closed)
  );
}

export function isShare(v: unknown): v is Share {
  if (!isRecord(v) || !only(v, ['version', 'part', 'account_id', 'amount_was', 'currency', 'date', 'what', 'entries', 'kept_gone', 'created_at', 'updated_at'])) return false;
  return (
    v.version === EXPENSES_VERSION &&
    optional(v.part, isExpenseId) &&
    isTransactionId(v.account_id) &&
    isPositive(v.amount_was) &&
    isCurrencyRef(v.currency) &&
    isCalendarDay(v.date) &&
    isText(v.what) &&
    Array.isArray(v.entries) &&
    v.entries.length >= 1 &&
    v.entries.length <= STORED_LIST &&
    v.entries.every(isShareEntry) &&
    new Set(v.entries.map((e) => (e as ShareEntry).id)).size === v.entries.length &&
    optional(v.kept_gone, isInstant) &&
    isInstant(v.created_at) &&
    isInstant(v.updated_at)
  );
}

export function isIou(v: unknown): v is Iou {
  if (!isRecord(v) || !only(v, ['version', 'person', 'direction', 'amount', 'currency', 'date', 'what', 'category_id', 'closed', 'created_at', 'updated_at'])) return false;
  return (
    v.version === EXPENSES_VERSION &&
    isExpenseId(v.person) &&
    (DIRECTIONS as readonly unknown[]).includes(v.direction) &&
    isPositive(v.amount) &&
    isCurrencyRef(v.currency) &&
    isCalendarDay(v.date) &&
    isText(v.what) &&
    // A category only on one owed by the person (see Iou).
    (v.category_id === undefined || (v.direction === 'by_you' && isCategoryRef(v.category_id))) &&
    isClosedList(v.closed) &&
    isInstant(v.created_at) &&
    isInstant(v.updated_at)
  );
}

export function isAllocation(v: unknown): v is Allocation {
  return isRecord(v) && only(v, ['item', 'amount']) && isExpenseId(v.item) && isPositive(v.amount);
}

export function isPayment(v: unknown): v is Payment {
  if (!isRecord(v) || !only(v, ['version', 'account_id', 'row', 'allocations', 'note', 'kept_gone', 'confirmed_at'])) return false;
  const row = v.row;
  return (
    v.version === EXPENSES_VERSION &&
    isTransactionId(v.account_id) &&
    isRecord(row) &&
    only(row, ['amount', 'currency', 'date']) &&
    typeof row.amount === 'number' &&
    Number.isFinite(row.amount) &&
    row.amount !== 0 &&
    isCurrencyRef(row.currency) &&
    isCalendarDay(row.date) &&
    Array.isArray(v.allocations) &&
    v.allocations.length >= 1 &&
    v.allocations.length <= STORED_LIST &&
    v.allocations.every(isAllocation) &&
    new Set(v.allocations.map((a) => (a as Allocation).item)).size === v.allocations.length &&
    optional(v.note, (x) => isText(x)) &&
    optional(v.kept_gone, isInstant) &&
    isInstant(v.confirmed_at)
  );
}

export function isDismissed(v: unknown): v is Dismissed {
  return isRecord(v) && only(v, ['version', 'date', 'at']) && v.version === EXPENSES_VERSION && isCalendarDay(v.date) && isInstant(v.at);
}

export function isExpenseSettings(v: unknown): v is ExpenseSettings {
  return (
    isRecord(v) &&
    only(v, ['version', 'counting', 'own_venmo', 'own_cashtag', 'updated_at']) &&
    v.version === EXPENSES_VERSION &&
    (COUNTINGS as readonly unknown[]).includes(v.counting) &&
    optional(v.own_venmo, (x) => isHandle(x, 100)) &&
    optional(v.own_cashtag, (x) => isHandle(x, 100)) &&
    isInstant(v.updated_at)
  );
}

// ---- Words ----

/** What a forgotten person is called everywhere. */
export const REMOVED_NAME = 'Someone you removed';

/** A person's name as shown: theirs, or REMOVED_NAME once forgotten. */
export const personName = (p: Pick<Person, 'name'> | null | undefined): string => p?.name ?? REMOVED_NAME;

/** A name as a match compares it: no case, no spacing (one person per name). */
export const nameKey = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
