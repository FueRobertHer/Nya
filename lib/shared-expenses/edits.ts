// lib/shared-expenses/edits.ts
//
// Every write shared expenses make (#49), with the strict reads each depends
// on, for the routes under app/api/shared-expenses. Nothing else writes the
// stores (test/shared-expenses-routes.test.ts scans the source): not the read
// layer, not matching, not a cron. Above all a payment is written only here,
// from the person's own Confirm, never from a proposal on its own.
//
// CHECKED AGAINST WHAT IS STORED, never what a page says: a transaction is
// looked up in the stores (lib/txn-lookup.ts findTransactions, which refuses
// rather than guess when a store that could hold it can't be read), and a
// share, a payment, a split or a group on it is read strictly first. So a
// transaction is shared only while posted, money out and in a currency; a
// row pays something back only while posted, in its items' currency, not
// shared, split or in a group; and what a payment closes is never more than
// is open.
//
// ONE ROW, ONE OF EACH. A share is kept under its transaction's id and a
// payment under its row's, so two devices doing the same at once meet in one
// compare-and-set: the second is refused (409), nothing lost. A share's edit
// sends the `updated_at` it was opened on. When a share and a payment land on
// one row from two devices, the share wins (lib/shared-expenses/rows.ts).
// Moving a share or a payment to another transaction is one updateMany within
// its store, so it is never half done; nothing ever moves between stores.

import type { Ctx } from '../containers';
import { categoryById, groupOf, indexTaxonomy } from '../categories';
import { ensureTaxonomy } from '../category-store';
import { groupStore, memberIndex } from '../groups';
import { addDays, isCalendarDay, isCurrencyCode, knownCurrency, MAX_AMOUNT } from '../manual-txn-input';
import { isSplitOrGroupId, toUnits, unitScale } from '../split-rows';
import { splitStore } from '../splits';
import { findTransactions, type FoundTxn } from '../txn-lookup';
import { assembleBankRows, finishActivity } from '../activity';
import { IMPORTED_TXN_PREFIX } from '../history-import/view';
import { sharedAccounts } from './read';
import type { Carried } from './rows';
import { MANY_AT_ONCE } from '../repo';
import { itemState, itemsOf, paidOf, allClosed, type Item } from './balances';
import {
  APPS,
  CLOSED_KINDS,
  COUNTINGS,
  DIRECTIONS,
  DISMISSED_DAYS,
  EXPENSES_VERSION,
  HANDLE_MAX,
  isExpenseId,
  isHandle,
  isSplitHow,
  isTransactionId,
  MAX_ALLOCATIONS,
  MAX_BATCH,
  MAX_CLOSED,
  MAX_DISMISSED,
  MAX_ENTRIES,
  MAX_IOUS,
  MAX_PAYMENTS,
  MAX_PEOPLE,
  MAX_REQUESTS,
  MAX_SHARES,
  nameKey,
  NOTE_MAX,
  PERSON_NAME_MAX,
  REQUEST_VIAS,
  WHAT_MAX,
  type Allocation,
  type Closed,
  type ClosedKind,
  type Counting,
  type Direction,
  type ExpenseSettings,
  type Iou,
  type Payment,
  type PaymentApp,
  type PaymentRequest,
  type Person,
  type RequestVia,
  type Share,
  type ShareEntry,
  type SplitHow,
} from './model';
import { expenseDismissedStore, expenseIousStore, expensePaymentsStore, expensePeopleStore, expenseSettingsStore, expenseSharesStore } from './store';

/** A change refused for what it asked, with the route's status: nothing was
 *  written. */
export class ExpenseError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = 'ExpenseError';
  }
}

// Typed as never-returning so a call narrows what follows it.
const fail: (message: string, status?: number) => never = (message, status = 400) => {
  throw new ExpenseError(message, status);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const newId = () => crypto.randomUUID();

/** Text as an edit keeps it: NFC, spaces collapsed, trimmed, no control
 *  characters; refused past `max`. Empty is none. */
export function checkText(raw: unknown, max: number, what: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') fail(`${what} is text.`);
  const text = (raw as string).normalize('NFC').replace(/\s+/g, ' ').trim();
  if (/[\u0000-\u001f\u007f]/.test(text)) fail(`${what} can’t hold control characters.`);
  if ([...text].length > max) fail(`${what} can be at most ${max} characters.`);
  return text || undefined;
}

/** A handle as typed: an optional leading @ or $ taken off. */
export function checkHandle(raw: unknown, what: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') fail(`${what} is text.`);
  const handle = (raw as string).trim().replace(/^[@$]/, '');
  if (!isHandle(handle, HANDLE_MAX)) fail(`${what} is letters, digits, “-” and “_”, at most ${HANDLE_MAX} characters, and not only digits.`);
  return handle;
}

/** An amount as an edit takes it: finite, more than nothing, at most
 *  MAX_AMOUNT, no finer than the currency's minor unit. */
export function checkAmount(raw: unknown, currency: string, what = 'An amount'): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail(`${what} is a number.`);
  if (raw <= 0) fail(`${what} is more than nothing.`);
  if (raw > MAX_AMOUNT) fail(`${what} is too large.`);
  const scale = unitScale(currency);
  const units = raw * scale;
  if (Math.abs(units - Math.round(units)) > Math.max(1e-6, Math.abs(units) * 4 * Number.EPSILON)) fail(`${what} can’t be finer than the currency allows.`);
  return Math.round(units) / scale;
}

/** A day as an edit takes it: real, not after tomorrow anywhere. */
export function checkDay(raw: unknown, now: Date, what = 'The day'): string {
  if (!isCalendarDay(raw)) return fail(`${what} is a real day, written YYYY-MM-DD.`);
  if ((raw as string) > addDays(now.toISOString().slice(0, 10), 1)) fail(`${what} can’t be in the future.`);
  return raw as string;
}

/** A transaction's id as a request names it: never a row the read layer made
 *  (a part, a group's row, another person's part, an IOU's row). */
export function checkTransactionId(raw: unknown): string {
  if (!isTransactionId(raw)) return fail('Invalid transaction id');
  if (isSplitOrGroupId(raw as string)) fail('That isn’t a transaction of yours but a part of one: open the transaction itself.');
  return raw as string;
}

const checkId = (raw: unknown, what: string): string => (isExpenseId(raw) ? (raw as string) : fail(`Invalid ${what}`));

// ---- Reads the writes depend on, strictly ----

/** The stored transaction, or a refusal: it must be stored. */
async function stored(ctx: Ctx, id: string): Promise<FoundTxn> {
  const found = (await findTransactions(ctx, [id])).get(id);
  if (!found) return fail('That transaction is no longer stored. Reload to see your transactions as they are.', 404);
  return found;
}

/** Every item and what is paid of each, read strictly. */
async function itemsNow(ctx: Ctx): Promise<{ shares: Map<string, Share>; ious: Map<string, Iou>; payments: Map<string, Payment>; items: Map<string, Item> }> {
  const [shares, ious, payments] = await Promise.all([expenseSharesStore.getAll(ctx), expenseIousStore.getAll(ctx), expensePaymentsStore.getAll(ctx)]);
  return { shares, ious, payments, items: itemsOf(shares, ious) };
}

/** A person who can be given something new: there, not forgotten, and not
 *  archived (an archived person owes nothing and is owed nothing, and the
 *  card lists them apart: bring them back first). */
async function livePerson(ctx: Ctx, id: string): Promise<Person> {
  const p = await expensePeopleStore.get(ctx, id);
  if (!p) return fail('That person is no longer on your list. Reload to see it as it is.', 404);
  if (p.removed_at) fail('You removed that person: add them again to share with them.', 409);
  if (p.archived_at) fail(`You archived ${p.name ?? 'that person'}: bring them back first to share with them.`, 409);
  return p;
}

/** Refuses a change on a transaction that is in a group: the group says how
 *  it counts. Read strictly. */
async function refuseGrouped(ctx: Ctx, id: string, doing: string): Promise<void> {
  const groups = await groupStore.getAll(ctx);
  const g = memberIndex(groups).get(id);
  if (g) fail(`This transaction is in a group (“${groups.get(g)!.name}”), which says how it counts: take it out of the group to ${doing}.`, 409);
}

// ---- People ----

export type PersonInput = { name?: unknown; venmo?: unknown; cashtag?: unknown; app?: unknown; tag?: unknown };

function checkPerson(input: PersonInput, current: Person | null): Omit<Person, 'version' | 'created_at' | 'updated_at'> {
  const out: Omit<Person, 'version' | 'created_at' | 'updated_at'> = current ? { ...current } : {};
  delete (out as Partial<Person>).version;
  delete (out as Partial<Person>).created_at;
  delete (out as Partial<Person>).updated_at;
  if (input.name !== undefined || !current) {
    const name = checkText(input.name, PERSON_NAME_MAX, 'A name');
    if (!name) fail('Give them a name.');
    out.name = name;
  }
  for (const k of ['venmo', 'cashtag'] as const) {
    if (input[k] === undefined) continue;
    const h = checkHandle(input[k], k === 'venmo' ? 'A Venmo username' : 'A cashtag');
    if (h) out[k] = h;
    else delete out[k];
  }
  if (input.app !== undefined) {
    if (input.app === null) delete out.app;
    else if (!(APPS as readonly unknown[]).includes(input.app)) fail('Choose Venmo, Cash App or another way.');
    else out.app = input.app as PaymentApp;
  }
  if (input.tag !== undefined) {
    if (input.tag === null) delete out.tag;
    else {
      const t = input.tag;
      if (!isRecord(t) || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.id) || !isSplitHow(t.how) || t.how.kind === 'amount') fail('A tag is one of your tags and how to split what carries it.');
      out.tag = { id: (t as { id: string }).id, how: (t as { how: SplitHow }).how };
    }
  }
  return out;
}

/** Refuses a name another person already has, in any case or spacing. Reads
 *  every person strictly: one that can't be read could have it. */
async function refuseSameName(ctx: Ctx, name: string, except: string | null): Promise<void> {
  const people = await expensePeopleStore.getAll(ctx);
  for (const [id, p] of people) if (id !== except && p.name && nameKey(p.name) === nameKey(name)) fail(`You already have someone called ${p.name}.`, 409);
}

export async function createPerson(ctx: Ctx, input: PersonInput, now = new Date()): Promise<{ id: string; person: Person }> {
  const fields = checkPerson(input, null);
  if ((await expensePeopleStore.count(ctx)) >= MAX_PEOPLE) fail(`You can keep at most ${MAX_PEOPLE} people. Forget someone first.`, 409);
  await refuseSameName(ctx, fields.name!, null);
  const id = newId();
  const person: Person = { version: EXPENSES_VERSION, ...fields, created_at: now.toISOString(), updated_at: now.toISOString() };
  await expensePeopleStore.update(ctx, id, (cur) => (cur ? fail('Try again.', 409) : person));
  return { id, person };
}

export async function editPerson(ctx: Ctx, id: string, input: PersonInput, now = new Date()): Promise<Person> {
  if (input.name !== undefined) {
    const name = checkText(input.name, PERSON_NAME_MAX, 'A name');
    if (name) await refuseSameName(ctx, name, id);
  }
  return (await expensePeopleStore.update(ctx, id, (cur) => {
    if (!cur) return fail('That person is no longer on your list.', 404);
    if (cur.removed_at) return fail('You removed that person.', 409);
    return { version: EXPENSES_VERSION, ...checkPerson(input, cur), created_at: cur.created_at, updated_at: now.toISOString() };
  }))!;
}

/** Archives a person once everything with them is closed, in every
 *  currency, so an archived person owes nothing and is never matched; or
 *  brings them back. */
export async function archivePerson(ctx: Ctx, id: string, archived: boolean, now = new Date()): Promise<Person> {
  if (archived) {
    const { items, payments } = await itemsNow(ctx);
    if (!allClosed(items, payments, id)) fail('Settle everything with them first: archiving is for someone who owes nothing and is owed nothing.', 409);
  }
  return (await expensePeopleStore.update(ctx, id, (cur) => {
    if (!cur) return fail('That person is no longer on your list.', 404);
    const next: Person = { ...cur, updated_at: now.toISOString() };
    if (archived) next.archived_at = now.toISOString();
    else delete next.archived_at;
    return next;
  }))!;
}

/** Forget: the name, the handles, the tag and the requests go; every amount
 *  and what closed it stays, so no total and no balance moves. */
export async function forgetPerson(ctx: Ctx, id: string, now = new Date()): Promise<Person> {
  return (await expensePeopleStore.update(ctx, id, (cur) => {
    if (!cur) return fail('That person is no longer on your list.', 404);
    const next: Person = { version: EXPENSES_VERSION, removed_at: cur.removed_at ?? now.toISOString(), created_at: cur.created_at, updated_at: now.toISOString() };
    if (cur.archived_at) next.archived_at = cur.archived_at;
    return next;
  }))!;
}

/** Removes everything shared with someone forgotten or archived: their
 *  parts of shares (a share left with no part goes) and their IOUs. Their
 *  parts become yours on their days, which the page says first. Refused
 *  while a payment names one of them: reopen it first. Each record in its
 *  own compare-and-set; one cut off is finished by asking again. */
export async function removeTheirExpenses(ctx: Ctx, id: string): Promise<{ shares: number; ious: number }> {
  const p = await expensePeopleStore.get(ctx, id);
  if (!p) return fail('That person is no longer on your list.', 404);
  if (!p.removed_at && !p.archived_at) fail('Archive or forget them first.', 409);
  const { shares, ious, payments, items } = await itemsNow(ctx);
  const theirs = new Set([...items.values()].filter((i) => i.person === id).map((i) => i.id));
  for (const pay of payments.values()) if (pay.allocations.some((a) => theirs.has(a.item))) fail('A payment you confirmed pays back something of theirs: reopen it first.', 409);
  let s = 0;
  for (const [tid, share] of shares) {
    if (!share.entries.some((e) => e.person === id)) continue;
    await expenseSharesStore.update(ctx, tid, (cur) => {
      if (!cur) return null;
      const entries = cur.entries.filter((e) => e.person !== id);
      return entries.length > 0 ? { ...cur, entries } : null;
    });
    s++;
  }
  const mine = [...ious].filter(([, i]) => i.person === id).map(([iid]) => iid);
  if (mine.length > 0) await expenseIousStore.remove(ctx, ...mine);
  return { shares: s, ious: mine.length };
}

export type RequestInput = { direction?: unknown; amount?: unknown; currency?: unknown; via?: unknown; items?: unknown };

/** Records a request the person sent through the handoff, the latest
 *  MAX_REQUESTS kept. Nothing about what happened in the app is known. */
export async function recordRequest(ctx: Ctx, id: string, input: RequestInput, now = new Date()): Promise<PaymentRequest> {
  if (!(DIRECTIONS as readonly unknown[]).includes(input.direction)) fail('Say which way the money goes.');
  if (!isCurrencyCode(input.currency) && !(typeof input.currency === 'string' && /^[A-Z0-9]{2,10}$/.test(input.currency))) fail('Invalid currency');
  const currency = input.currency as string;
  const amount = checkAmount(input.amount, currency);
  if (!(REQUEST_VIAS as readonly unknown[]).includes(input.via)) fail('Say how it was sent.');
  if (!Array.isArray(input.items) || input.items.length > MAX_ALLOCATIONS || !input.items.every(isExpenseId)) fail('Say which items it covers.');
  const request: PaymentRequest = { id: newId(), at: now.toISOString(), direction: input.direction as Direction, amount, currency, via: input.via as RequestVia, items: [...new Set(input.items as string[])] };
  await expensePeopleStore.update(ctx, id, (cur) => {
    if (!cur) return fail('That person is no longer on your list.', 404);
    if (cur.removed_at) return fail('You removed that person.', 409);
    return { ...cur, requests: [...(cur.requests ?? []), request].slice(-MAX_REQUESTS), updated_at: now.toISOString() };
  });
  return request;
}

// ---- Shares ----

/** An entry as a request gives it. An `id` it names is never taken: an
 *  entry keeps the id it has while it names the same person, else gets a new
 *  one, so no request can make two items one. */
export type EntryInput = { id?: unknown; person?: unknown; amount?: unknown; how?: unknown };
/** `carried_from`: the share shows on this transaction carried across a
 *  re-link (lib/shared-expenses/rows.ts), kept under the transaction it was
 *  on before; saving it moves it onto this one. */
export type ShareInput = { part?: unknown; what?: unknown; entries?: unknown; updated_at?: unknown; carried_from?: unknown };

/** What an edit was opened on: a share's updated_at, null for none, absent
 *  for not said. */
function seenOf(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return raw as null | undefined;
  if (typeof raw !== 'string' || raw.length > 40 || Number.isNaN(Date.parse(raw))) return fail('Invalid updated_at');
  return raw;
}

/** The amount a share comes from: the transaction's, or the part's it names
 *  on a split transaction, checked against the split as stored. */
async function shareTarget(ctx: Ctx, found: FoundTxn, part: unknown): Promise<{ part?: string; amount: number }> {
  const split = await splitStore.get(ctx, found.transaction_id);
  if (!split) {
    if (part !== undefined && part !== null) fail('That transaction isn’t split now. Reload to see it as it is.', 409);
    return { amount: found.amount };
  }
  if (part === undefined || part === null) return fail('This transaction is split: share one of its parts.', 409);
  const p = split.parts.find((x) => x.id === part);
  if (!p) return fail('That part of the split is gone. Reload to see the split as it is.', 409);
  if (!(p.amount > 0)) fail('Only money out can be shared.', 409);
  return { part: p.id, amount: p.amount };
}

/**
 * Shares one of the person's transactions (or a part of a split one), or
 * changes who owes what of it. Each entry is a person and their part, at most
 * MAX_ENTRIES, adding up to at most the transaction's amount; your part is
 * the rest. An entry keeps its id (and what closed it) while it names the
 * same person, so a payment that names it still does; no part is lowered
 * below what has closed it. Refused for a transaction that isn't posted,
 * money out and in a currency, one in a group, one that pays something back,
 * and, given `updated_at`, one changed since the edit was opened.
 */
export async function saveShare(ctx: Ctx, transaction_id: string, input: ShareInput, now = new Date(), known?: ReadonlyMap<string, Carried>): Promise<Share> {
  const seen = seenOf(input.updated_at);
  const carriedFrom = input.carried_from === undefined || input.carried_from === null ? null : checkTransactionId(input.carried_from);
  if (carriedFrom === transaction_id) fail('That is the same transaction.');
  if (!Array.isArray(input.entries) || input.entries.length < 1) fail('Say who owes what of it.');
  if ((input.entries as unknown[]).length > MAX_ENTRIES) fail(`At most ${MAX_ENTRIES} people can share one transaction with you.`);
  await refuseGrouped(ctx, transaction_id, 'share it');
  if (await expensePaymentsStore.has(ctx, transaction_id)) fail('This transaction pays something back: reopen that payment to share it instead.', 409);
  const found = await stored(ctx, transaction_id);
  // What applies to it from elsewhere (a re-link's carry, a file's row it
  // stands for): a carried share is changed here only from where it is kept,
  // as the read says, never on the request's word.
  const carried = (known ?? (await carriedOnto(ctx, [transaction_id]))).get(transaction_id);
  if (carried?.kind === 'payment') fail('This transaction pays something back: reopen that payment to share it instead.', 409);
  if (carriedFrom ? carried?.kind !== 'share' || carried.from !== carriedFrom || carriedFrom.startsWith(IMPORTED_TXN_PREFIX) : carried?.kind === 'share') {
    fail(carriedFrom ? 'That share isn’t carried to this transaction. Reload to see it as it is.' : 'This transaction is shared already. Reload to see it as it is, and change it there.', 409);
  }
  if (found.pending) fail('A pending transaction can’t be shared: the bank gives it a new id when it posts. Share it once it has posted.', 409);
  if (!found.currency) fail('This transaction doesn’t say its currency, so what someone owes of it can’t be kept.', 409);
  if (!(found.amount > 0)) fail('Only money out can be shared: you paid, and they owe you their part.', 409);
  const currency = found.currency!;
  const target = await shareTarget(ctx, found, input.part);
  const scale = unitScale(currency);
  const people = new Set<string>();
  const wanted = (input.entries as unknown[]).map((raw) => {
    if (!isRecord(raw)) return fail('Each part is a person and an amount.');
    const e = raw as EntryInput;
    const person = checkId(e.person, 'person');
    if (people.has(person)) fail('Each person has one part.');
    people.add(person);
    if (e.how !== undefined && !isSplitHow(e.how)) fail('Invalid split');
    return { id: e.id, person, amount: checkAmount(e.amount, currency, 'A part'), how: e.how as SplitHow | undefined };
  });
  const total = wanted.reduce((n, e) => n + toUnits(e.amount, scale), 0);
  if (total > toUnits(target.amount, scale)) fail('The parts come to more than the transaction.', 400);
  // A person new to it, or whose part changes, must be one who can be given
  // something; an entry left as it is goes through (a forgotten or archived
  // person's part kept while the others change).
  const before = await expenseSharesStore.get(ctx, carriedFrom ?? transaction_id);
  if (carriedFrom && !before) fail('Nothing is shared under that transaction any more. Reload to see it as it is.', 404);
  if (carriedFrom && before?.part) fail('A share of a split part doesn’t carry across a re-link: share the transaction again.', 409);
  if (carriedFrom && before && before.currency !== currency) fail('That transaction is in another currency.', 409);
  for (const w of wanted) {
    const kept = before?.entries.find((e) => e.person === w.person);
    if (kept && toUnits(kept.amount, scale) === toUnits(w.amount, scale)) continue;
    await livePerson(ctx, w.person);
  }
  const what = checkText(input.what, WHAT_MAX, 'What it was for') ?? checkText(found.name, WHAT_MAX * 10, 'What it was for')?.slice(0, WHAT_MAX) ?? 'Shared expense';
  const isNew = !carriedFrom && !(await expenseSharesStore.has(ctx, transaction_id));
  if (isNew && (await expenseSharesStore.count(ctx)) >= MAX_SHARES) fail(`At most ${MAX_SHARES.toLocaleString('en-US')} transactions can be shared. Remove some settled ones first.`, 409);
  // What has closed each entry by a payment, read strictly: never lowered below.
  const { payments, items } = await itemsNow(ctx);
  const paid = paidOf(payments, items);
  const build = (cur: Share | null): Share => {
    if (seen !== undefined && (cur?.updated_at ?? null) !== seen) return fail('This was changed on another device since you opened it. Close it and open it again to see the change.', 409);
    const byPerson = new Map((cur?.entries ?? []).map((e) => [e.person, e] as const));
    const entries: ShareEntry[] = wanted.map((w) => {
      const was = byPerson.get(w.person);
      const id = was?.id ?? newId();
      const entry: ShareEntry = { id, person: w.person, amount: w.amount, ...(w.how ? { how: w.how } : {}), ...(was?.closed?.length ? { closed: was.closed } : {}) };
      const item = items.get(id);
      const closedBy = (paid.get(id)?.units ?? 0) + (entry.closed ?? []).reduce((n, c) => n + toUnits(c.amount, scale), 0);
      if (item && toUnits(entry.amount, scale) < closedBy) fail('Part of this has already been paid back or settled: it can’t be less than that.', 409);
      return entry;
    });
    // A part taken out that a payment names, or that something closed, stays.
    for (const e of cur?.entries ?? []) {
      if (people.has(e.person)) continue;
      if (paid.has(e.id) || (e.closed?.length ?? 0) > 0) fail('A part you’re taking out has been paid back or settled: reopen that first.', 409);
    }
    return {
      version: EXPENSES_VERSION,
      ...(target.part ? { part: target.part } : {}),
      account_id: found.account_id,
      amount_was: target.amount,
      currency,
      date: found.date,
      what,
      entries,
      created_at: cur?.created_at ?? now.toISOString(),
      updated_at: now.toISOString(),
    };
  };
  if (!carriedFrom) return (await expenseSharesStore.update(ctx, transaction_id, build))!;
  // Carried across a re-link: written under this transaction and gone from
  // the one before, in one step.
  const written = await expenseSharesStore.updateMany(ctx, [carriedFrom, transaction_id], (cur) => {
    if (cur.get(transaction_id)) return fail('That transaction is shared already.', 409);
    const was = cur.get(carriedFrom);
    if (!was) return fail('Nothing is shared under that transaction any more. Reload to see it as it is.', 404);
    return new Map<string, Share | null>([
      [carriedFrom, null],
      [transaction_id, build(was)],
    ]);
  });
  return written.get(transaction_id)!;
}

/** Stops sharing a transaction: it counts whole again. Refused while a
 *  payment names one of its parts, or something closed one. */
export async function removeShare(ctx: Ctx, transaction_id: string, updatedAt?: unknown): Promise<boolean> {
  const seen = seenOf(updatedAt);
  const { payments, items } = await itemsNow(ctx);
  const paid = paidOf(payments, items);
  let had = false;
  await expenseSharesStore.update(ctx, transaction_id, (cur) => {
    if (seen !== undefined && (cur?.updated_at ?? null) !== seen) return fail('This was changed on another device since you opened it.', 409);
    if (!cur) return null;
    if (cur.entries.some((e) => paid.has(e.id))) return fail('A payment you confirmed pays part of this back: reopen it first.', 409);
    if (cur.entries.some((e) => (e.closed?.length ?? 0) > 0)) return fail('Part of this was settled outside your accounts or let go: reopen that first.', 409);
    had = true;
    return null;
  });
  return had;
}

/** Keeps a share whose transaction is gone: still in the balance, no longer
 *  said to be gone. */
export async function keepShare(ctx: Ctx, transaction_id: string, now = new Date()): Promise<Share> {
  return (await expenseSharesStore.update(ctx, transaction_id, (cur) => (cur ? { ...cur, kept_gone: now.toISOString() } : fail('Nothing is shared under that transaction.', 404))))!;
}

/** The transaction a gone share or payment moves to, as stored (looked up in
 *  this container's own stores): on the account the request says it is on,
 *  posted, in a currency, and free (no share, no payment, no split, in no
 *  group). Refused otherwise, saying why. */
async function moveTarget(ctx: Ctx, to: string, account: unknown, doing: string): Promise<FoundTxn> {
  if (typeof account !== 'string' || !isTransactionId(account)) return fail('Say which account that transaction is on.');
  await refuseGrouped(ctx, to, doing);
  if (await expensePaymentsStore.has(ctx, to)) fail('That transaction pays something back already.', 409);
  if (await expenseSharesStore.has(ctx, to)) fail('That transaction is shared already.', 409);
  if (await splitStore.has(ctx, to)) fail('That transaction is split.', 409);
  const found = await stored(ctx, to);
  if (found.account_id !== account) fail('That transaction isn’t on the account you chose. Reload to see your transactions as they are.', 409);
  if (found.pending) fail('That transaction is still pending: move it once it has posted.', 409);
  if (!found.currency) fail('That transaction doesn’t say its currency.', 409);
  // Shared or paying, though nothing is stored under its id: what a re-link
  // carried to it (lib/shared-expenses/rows.ts, ACROSS A RE-LINK).
  const carried = (await carriedOnto(ctx, [to])).get(to);
  if (carried?.kind === 'share') fail('That transaction is shared already.', 409);
  if (carried?.kind === 'payment') fail('That transaction pays something back already.', 409);
  return found;
}

/** What applies to each of these transactions though nothing is stored
 *  under its id, applied or not (lib/shared-expenses/rows.ts ShareResult
 *  `onto`): a share or payment carried across a re-link to it, or that of a
 *  row imported from a file it stands for. As the Activity tab reads it (hidden and ended
 *  accounts' rows among them), since what carries is decided by the link
 *  and the rows, one to one: a key two rows have carries to neither, so
 *  either is free. Every write onto a transaction asks (a share, a payment,
 *  a move, a split, a group), so none lands beside what applies there.
 *  Read only while something holds a key a disconnect recorded, is kept
 *  under an imported row's id, or can't be read; then the links are read
 *  strictly, so an edit fails rather than take links it couldn't read for
 *  none. */
export async function carriedOnto(ctx: Ctx, ids: readonly string[]): Promise<Map<string, Carried>> {
  const out = new Map<string, Carried>();
  if (ids.length === 0) return out;
  const kept = await Promise.all([expenseSharesStore.getAllReport(ctx), expensePaymentsStore.getAllReport(ctx)]);
  const carrying = kept.some((r) => r.unreadable.length + r.unrecognised.length > 0 || [...r.entries].some(([id, v]) => v.carry_key || id.startsWith(IMPORTED_TXN_PREFIX)));
  if (!carrying) return out;
  await sharedAccounts(ctx);
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden: true, withAccountIds: true, keepEnded: true });
  const onto = (await finishActivity(ctx, bank.payload, new Set(), { keepEnded: true })).shared_onto;
  for (const id of ids) {
    const c = onto.get(id);
    if (c) out.set(id, c);
  }
  return out;
}

/** Moves a share to the transaction a gone one came back as (the bank sent
 *  it again under a new id, a re-link it didn't carry across, a row entered
 *  again), in one step within the store. `account` is the account the
 *  request says the transaction is on, checked against it as stored. It
 *  must be money out, in the share's currency, at least what the others owe
 *  of it. */
export async function moveShare(ctx: Ctx, from: string, to: string, account: unknown, now = new Date()): Promise<Share> {
  if (from === to) fail('That is the same transaction.');
  const share = await expenseSharesStore.get(ctx, from);
  if (!share) return fail('Nothing is shared under that transaction.', 404);
  if (share.part) fail('A share of a split part moves with its split: share the part again.', 409);
  const found = await moveTarget(ctx, to, account, 'share it');
  if (!(found.amount > 0)) fail('Only money out can take a share: choose a transaction you paid.', 409);
  if (found.currency !== share.currency) fail('That transaction is in another currency.', 409);
  const scale = unitScale(share.currency);
  if (share.entries.reduce((n, e) => n + toUnits(e.amount, scale), 0) > toUnits(found.amount, scale)) fail('What the others owe of it is more than that transaction.', 409);
  const written = await expenseSharesStore.updateMany(ctx, [from, to], (cur) => {
    if (cur.get(to)) return fail('That transaction is shared already.', 409);
    const was = cur.get(from);
    if (!was) return fail('Nothing is shared under that transaction.', 404);
    const moved: Share = { ...was, account_id: found.account_id, date: found.date, amount_was: found.amount, updated_at: now.toISOString() };
    delete moved.kept_gone;
    delete moved.carry_key;
    return new Map<string, Share | null>([
      [from, null],
      [to, moved],
    ]);
  });
  return written.get(to)!;
}

/** Shares several transactions with one person at once, from a tag: each in
 *  its own write, each answered. */
export async function shareMany(ctx: Ctx, person: string, ids: readonly string[], how: SplitHow, now = new Date()): Promise<{ id: string; ok: boolean; error?: string }[]> {
  if (ids.length > MAX_BATCH) fail(`At most ${MAX_BATCH} at once.`);
  if (how.kind === 'amount') fail('Choose half, an even split or a percentage.');
  const out: { id: string; ok: boolean; error?: string }[] = [];
  // What applies to them from elsewhere, read once for all of them.
  const carried = await carriedOnto(ctx, ids);
  for (const id of ids) {
    try {
      const found = await stored(ctx, id);
      if (!found.currency) fail('No currency.', 409);
      const scale = unitScale(found.currency!);
      const whole = toUnits(found.amount, scale);
      // Their part rounded down to the minor unit: yours is never less.
      const theirs = how.kind === 'half' ? Math.floor(whole / 2) : how.kind === 'even' ? Math.floor(whole / how.ways) : Math.floor((whole * how.percent) / 100);
      if (theirs <= 0) fail('Nothing to share.', 409);
      await saveShare(ctx, id, { entries: [{ person, amount: theirs / scale, how }], updated_at: null }, now, carried);
      out.push({ id, ok: true });
    } catch (err) {
      if (!(err instanceof ExpenseError)) throw err;
      out.push({ id, ok: false, error: err.message });
    }
  }
  return out;
}

// ---- IOUs ----

export type IouInput = { person?: unknown; direction?: unknown; amount?: unknown; currency?: unknown; date?: unknown; what?: unknown; category_id?: unknown };

/** The category an IOU you owe is for, as it is now (a merge followed): one
 *  in a spending group, since your part of what they paid is spending. */
async function iouCategory(ctx: Ctx, raw: unknown): Promise<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > 80) return fail('Invalid category');
  const ix = indexTaxonomy(await ensureTaxonomy(ctx));
  const c = categoryById(ix, raw);
  if (!c) return fail('That category no longer exists. Reload to see your categories as they are.', 404);
  if (groupOf(ix, c).kind !== 'expense') fail('Choose a spending category: your part of what they paid is spending.');
  return c.id;
}

/** Adds an IOU, or changes one; never below what has closed it. */
export async function saveIou(ctx: Ctx, id: string | null, input: IouInput, now = new Date()): Promise<{ id: string; iou: Iou }> {
  const iouId = id ?? newId();
  const cur = id ? await expenseIousStore.get(ctx, id) : null;
  if (id && !cur) fail('That IOU is no longer kept. Reload to see your IOUs as they are.', 404);
  if (!id && (await expenseIousStore.count(ctx)) >= MAX_IOUS) fail(`At most ${MAX_IOUS.toLocaleString('en-US')} IOUs can be kept. Remove some settled ones first.`, 409);
  const person = input.person !== undefined ? checkId(input.person, 'person') : (cur?.person ?? fail('Say who.'));
  if (!cur || person !== cur.person) await livePerson(ctx, person);
  const direction = input.direction !== undefined ? ((DIRECTIONS as readonly unknown[]).includes(input.direction) ? (input.direction as Direction) : fail('Say who owes whom.')) : cur!.direction;
  const currency = input.currency !== undefined ? (isCurrencyCode(input.currency) && knownCurrency(input.currency) ? (input.currency as string) : fail('Choose a currency.')) : cur!.currency;
  const amount = input.amount !== undefined ? checkAmount(input.amount, currency) : cur!.amount;
  const date = input.date !== undefined ? checkDay(input.date, now) : cur!.date;
  const what = input.what !== undefined ? (checkText(input.what, WHAT_MAX, 'What it was for') ?? fail('Say what it was for.')) : cur!.what;
  let category_id = input.category_id !== undefined ? await iouCategory(ctx, input.category_id) : cur?.category_id;
  if (direction === 'to_you') {
    if (input.category_id) fail('A category is for what you owe them for: your part of something they paid.');
    category_id = undefined;
  }
  if (cur && (currency !== cur.currency || person !== cur.person || direction !== cur.direction)) {
    const { payments, items } = await itemsNow(ctx);
    if (paidOf(payments, items).has(iouId) || (cur.closed?.length ?? 0) > 0) fail('Part of this has been paid or settled: its person, direction and currency stay as they are.', 409);
  }
  const { payments, items } = await itemsNow(ctx);
  const paid = paidOf(payments, items);
  const iou = (await expenseIousStore.update(ctx, iouId, (stored_) => {
    if (id && !stored_) return fail('That IOU is no longer kept.', 404);
    if (!id && stored_) return fail('Try again.', 409);
    const closed = stored_?.closed ?? [];
    const scale = unitScale(currency);
    const closedBy = (paid.get(iouId)?.units ?? 0) + closed.reduce((n, c) => n + toUnits(c.amount, scale), 0);
    if (toUnits(amount, scale) < closedBy) fail('Part of this has already been paid or settled: it can’t be less than that.', 409);
    return {
      version: EXPENSES_VERSION,
      person,
      direction,
      amount,
      currency,
      date,
      what,
      ...(category_id ? { category_id } : {}),
      ...(closed.length > 0 ? { closed } : {}),
      created_at: stored_?.created_at ?? now.toISOString(),
      updated_at: now.toISOString(),
    };
  }))!;
  return { id: iouId, iou };
}

/** Removes an IOU: refused while a payment names it or something closed it. */
export async function removeIou(ctx: Ctx, id: string): Promise<boolean> {
  const { payments, items } = await itemsNow(ctx);
  if (paidOf(payments, items).has(id)) fail('A payment you confirmed pays this: reopen it first.', 409);
  let had = false;
  await expenseIousStore.update(ctx, id, (cur) => {
    if (!cur) return null;
    if ((cur.closed?.length ?? 0) > 0) return fail('This was settled outside your accounts or let go: reopen that first.', 409);
    had = true;
    return null;
  });
  return had;
}

// ---- Payments ----

export type PaymentInput = { allocations?: unknown; note?: unknown };

/** Allocations as a request gives them, each an item and how much of it, no
 *  item twice. */
function checkAllocations(raw: unknown, currency: string): Allocation[] {
  if (!Array.isArray(raw) || raw.length < 1) return fail('Say what it pays back.');
  if (raw.length > MAX_ALLOCATIONS) fail(`One payment can pay back at most ${MAX_ALLOCATIONS} items.`);
  const seen = new Set<string>();
  return raw.map((a) => {
    if (!isRecord(a)) return fail('Each is an item and an amount.');
    const item = checkId(a.item, 'item');
    if (seen.has(item)) fail('Each item once.');
    seen.add(item);
    return { item, amount: checkAmount(a.amount, currency) };
  });
}

/** What allocations close, checked against what is open (read strictly):
 *  every item there, in the row's currency, open by at least that much, and
 *  the whole adding up to the row's sign and at most its amount. */
function checkAgainst(allocations: readonly Allocation[], row: { amount: number; currency: string }, items: ReadonlyMap<string, Item>, paid: ReturnType<typeof paidOf>): void {
  const scale = unitScale(row.currency);
  let sum = 0;
  for (const a of allocations) {
    const item = items.get(a.item);
    if (!item) return fail('Something it pays back is no longer kept. Reload to see it as it is.', 409);
    if (item.currency !== row.currency) fail('A payment pays back only what is in its own currency.', 409);
    const open = toUnits(itemState(item, paid).open, scale);
    const units = toUnits(a.amount, scale);
    if (units > open) fail(`That is more than is still open of “${item.what}”.`, 409);
    sum += item.direction === 'to_you' ? -units : units;
  }
  const rowUnits = toUnits(row.amount, scale);
  if (sum === 0 || Math.sign(sum) !== Math.sign(rowUnits)) fail(rowUnits < 0 ? 'Money in pays back what someone owes you.' : 'Money out pays what you owe someone.', 409);
  if (Math.abs(sum) > Math.abs(rowUnits)) fail('That is more than the payment.', 409);
}

/**
 * Confirms that one of the person's transactions paid something back (money
 * in: what someone owed them) or paid what they owed (money out): the only
 * write of a payment, from their own tap. Checked against the row as stored
 * and what is open now, both read strictly; a row pays once.
 */
export async function confirmPayment(ctx: Ctx, row_id: string, input: PaymentInput, now = new Date()): Promise<Payment> {
  await refuseGrouped(ctx, row_id, 'confirm it');
  if (await splitStore.has(ctx, row_id)) fail('This transaction is split: unsplit it to confirm what it paid back.', 409);
  if (await expenseSharesStore.has(ctx, row_id)) fail('This transaction is shared: a shared expense can’t also be a repayment.', 409);
  if (await expenseDismissedStore.has(ctx, row_id)) fail('You said this paid nothing back: undo that first.', 409);
  const found = await stored(ctx, row_id);
  // A share or payment that applies to it from elsewhere, as for its own.
  const carried = (await carriedOnto(ctx, [row_id])).get(row_id);
  if (carried?.kind === 'share') fail('This transaction is shared: a shared expense can’t also be a repayment.', 409);
  if (carried?.kind === 'payment') fail('This payment was already confirmed.', 409);
  if (found.pending) fail('A pending transaction can’t be confirmed: it gets a new id when it posts.', 409);
  if (!found.currency) fail('This transaction doesn’t say its currency.', 409);
  const currency = found.currency!;
  const allocations = checkAllocations(input.allocations, currency);
  const note = checkText(input.note, NOTE_MAX, 'A note');
  if (!(await expensePaymentsStore.has(ctx, row_id)) && (await expensePaymentsStore.count(ctx)) >= MAX_PAYMENTS) fail(`At most ${MAX_PAYMENTS.toLocaleString('en-US')} payments can be kept.`, 409);
  const { payments, items } = await itemsNow(ctx);
  checkAgainst(allocations, { amount: found.amount, currency }, items, paidOf(payments, items));
  const payment: Payment = {
    version: EXPENSES_VERSION,
    account_id: found.account_id,
    row: { amount: found.amount, currency, date: found.date },
    allocations,
    ...(note ? { note } : {}),
    confirmed_at: now.toISOString(),
  };
  await expensePaymentsStore.update(ctx, row_id, (cur) => (cur ? fail('This payment was already confirmed.', 409) : payment));
  return payment;
}

/** Reopens a payment: what it paid back is open again, and the row counts as
 *  the bank shows it. */
export async function reopenPayment(ctx: Ctx, row_id: string): Promise<boolean> {
  let had = false;
  await expensePaymentsStore.update(ctx, row_id, (cur) => {
    had = cur !== null;
    return null;
  });
  return had;
}

export async function keepPayment(ctx: Ctx, row_id: string, now = new Date()): Promise<Payment> {
  return (await expensePaymentsStore.update(ctx, row_id, (cur) => (cur ? { ...cur, kept_gone: now.toISOString() } : fail('No payment is kept under that transaction.', 404))))!;
}

/** Moves a payment to the row a gone one came back as, in one step: money
 *  the same way (in, for what someone paid you back; out, for what you paid
 *  someone), in its currency, at least what it paid back (moveShare says the
 *  rest). */
export async function movePayment(ctx: Ctx, from: string, to: string, account: unknown): Promise<Payment> {
  if (from === to) fail('That is the same transaction.');
  const payment = await expensePaymentsStore.get(ctx, from);
  if (!payment) return fail('No payment is kept under that transaction.', 404);
  const found = await moveTarget(ctx, to, account, 'confirm it');
  if (Math.sign(found.amount) !== Math.sign(payment.row.amount)) fail(payment.row.amount < 0 ? 'A payment back to you moves only to money in.' : 'A payment you made moves only to money out.', 409);
  if (found.currency !== payment.row.currency) fail('That transaction is in another currency.', 409);
  const scale = unitScale(payment.row.currency);
  // What it paid back nets both ways ($60 of dinner less $25 of groceries).
  const { items } = await itemsNow(ctx);
  const net = payment.allocations.reduce((n, a) => n + (items.get(a.item)?.direction === 'by_you' ? -1 : 1) * toUnits(a.amount, scale), 0);
  if (Math.abs(net) > Math.abs(toUnits(found.amount, scale))) fail('What it paid back is more than that transaction.', 409);
  const written = await expensePaymentsStore.updateMany(ctx, [from, to], (cur) => {
    if (cur.get(to)) return fail('That transaction is confirmed already.', 409);
    const p = cur.get(from);
    if (!p) return fail('No payment is kept under that transaction.', 404);
    const moved: Payment = { ...p, account_id: found.account_id, row: { amount: found.amount, currency: p.row.currency, date: found.date } };
    delete moved.kept_gone;
    delete moved.carry_key;
    return new Map<string, Payment | null>([
      [from, null],
      [to, moved],
    ]);
  });
  return written.get(to)!;
}

/** Says a row paid nothing back, so it is never proposed again. Rows dated
 *  more than DISMISSED_DAYS ago are let go first (no proposal looks that
 *  far), best effort. */
export async function dismissRow(ctx: Ctx, row_id: string, now = new Date()): Promise<void> {
  if (await expensePaymentsStore.has(ctx, row_id)) fail('This payment is confirmed: reopen it first.', 409);
  const found = await stored(ctx, row_id);
  // Only readable old ones are let go; one that can't be read stays.
  const all = (await expenseDismissedStore.getAllReport(ctx)).entries;
  const floor = addDays(now.toISOString().slice(0, 10), -DISMISSED_DAYS);
  const old = [...all].filter(([, d]) => d.date < floor).map(([id]) => id);
  if (old.length > 0) await expenseDismissedStore.remove(ctx, ...old);
  if (!(await expenseDismissedStore.has(ctx, row_id)) && (await expenseDismissedStore.count(ctx)) >= MAX_DISMISSED) fail('Too many payments are set aside: undo some first.', 409);
  await expenseDismissedStore.set(ctx, row_id, { version: EXPENSES_VERSION, date: found.date, at: now.toISOString() });
}

export async function undismissRow(ctx: Ctx, row_id: string): Promise<void> {
  await expenseDismissedStore.remove(ctx, row_id);
}

// ---- Across a re-link ----

/** A transaction of a connection being disconnected, as lib/txn-annotations.ts
 *  RetiringTxn has it: its id, its account, its content key, pending. */
export type RetiringRow = { transaction_id: string; account_id: string; key: string; pending: boolean };

/**
 * Records, on each share and payment of a disconnecting connection's posted
 * transactions, the transaction's content key (Share carry_key), before its
 * id dies with the connection: once the re-added account is linked to the
 * old one, the share or payment carries to the transaction there with the
 * same key (lib/shared-expenses/rows.ts ACROSS A RE-LINK). A share of a split
 * part records none (the split doesn't carry). What can't be read records
 * nothing. Returns how many it recorded. Throws if storage fails: the caller
 * (lib/disconnect-item.ts) must not let that stop the disconnect.
 */
export async function retireShares(ctx: Ctx, rows: readonly RetiringRow[]): Promise<number> {
  const posted = new Map(rows.filter((r) => !r.pending).map((r) => [r.transaction_id, r]));
  if (posted.size === 0) return 0;
  const [shares, payments] = await Promise.all([expenseSharesStore.getAllReport(ctx), expensePaymentsStore.getAllReport(ctx)]);
  const due = <T extends { carry_key?: string; part?: string }>(entries: ReadonlyMap<string, T>) =>
    [...entries].filter(([id, v]) => posted.has(id) && !v.part && v.carry_key !== posted.get(id)!.key).map(([id]) => id);
  const shareIds = due(shares.entries);
  const paymentIds = due(payments.entries as ReadonlyMap<string, Payment & { part?: undefined }>);
  for (let i = 0; i < shareIds.length; i += MANY_AT_ONCE) {
    const ids = shareIds.slice(i, i + MANY_AT_ONCE);
    await expenseSharesStore.updateMany(ctx, ids, (cur) => new Map(ids.flatMap((id) => (cur.get(id) ? [[id, { ...cur.get(id)!, carry_key: posted.get(id)!.key }] as [string, Share]] : []))));
  }
  for (let i = 0; i < paymentIds.length; i += MANY_AT_ONCE) {
    const ids = paymentIds.slice(i, i + MANY_AT_ONCE);
    await expensePaymentsStore.updateMany(ctx, ids, (cur) => new Map(ids.flatMap((id) => (cur.get(id) ? [[id, { ...cur.get(id)!, carry_key: posted.get(id)!.key }] as [string, Payment]] : []))));
  }
  return shareIds.length + paymentIds.length;
}

// ---- Settled outside your accounts, or let go ----

export type CloseInput = { kind?: unknown; items?: unknown; date?: unknown; note?: unknown };

/**
 * Closes items outside any payment Nya sees (`outside`: cash, another app)
 * or lets them go (`forgiven`), each by an amount, under one event id, on
 * each item itself: a store at a time, at most MANY_AT_ONCE records a step.
 * One cut off leaves each item saying truly what closed it. Never more than
 * is open (read strictly).
 */
export async function closeItems(ctx: Ctx, input: CloseInput, now = new Date()): Promise<{ event: string; closed: number }> {
  if (!(CLOSED_KINDS as readonly unknown[]).includes(input.kind)) fail('Say whether it was settled or let go.');
  const kind = input.kind as ClosedKind;
  const date = checkDay(input.date, now);
  const note = checkText(input.note, NOTE_MAX, 'A note');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ALLOCATIONS) fail('Say what it closes.');
  const { shares, payments, items } = await itemsNow(ctx);
  const paid = paidOf(payments, items);
  const event = newId();
  const wanted = new Map<string, number>();
  for (const raw of input.items as unknown[]) {
    if (!isRecord(raw)) fail('Each is an item and an amount.');
    const r = raw as Record<string, unknown>;
    const id = checkId(r.item, 'item');
    const item = items.get(id) ?? fail('Something it closes is no longer kept. Reload to see it as it is.', 409);
    if (wanted.has(id)) fail('Each item once.');
    const amount = checkAmount(r.amount, item.currency);
    if (toUnits(amount, unitScale(item.currency)) > toUnits(itemState(item, paid).open, unitScale(item.currency))) fail(`That is more than is still open of “${item.what}”.`, 409);
    if (item.closed.length >= MAX_CLOSED) fail(`“${item.what}” has been settled in too many pieces.`, 409);
    wanted.set(id, amount);
  }
  const closing = (amount: number): Closed => ({ event, kind, amount, date, ...(note ? { note } : {}), at: now.toISOString() });
  // Shares, by the transaction they are kept under.
  const byShare = new Map<string, string[]>();
  for (const id of wanted.keys()) {
    const item = items.get(id)!;
    if (item.kind === 'share') byShare.set(item.transaction_id!, [...(byShare.get(item.transaction_id!) ?? []), id]);
  }
  const shareIds = [...byShare.keys()];
  for (let i = 0; i < shareIds.length; i += MANY_AT_ONCE) {
    const ids = shareIds.slice(i, i + MANY_AT_ONCE);
    await expenseSharesStore.updateMany(ctx, ids, (cur) => {
      const next = new Map<string, Share | null>();
      for (const sid of ids) {
        const s = cur.get(sid) ?? shares.get(sid);
        if (!cur.get(sid)) return fail('Something it closes is no longer kept. Reload to see it as it is.', 409);
        next.set(sid, { ...s!, entries: s!.entries.map((e) => (wanted.has(e.id) ? { ...e, closed: [...(e.closed ?? []), closing(wanted.get(e.id)!)] } : e)), updated_at: now.toISOString() });
      }
      return next;
    });
  }
  const iouIds = [...wanted.keys()].filter((id) => items.get(id)!.kind === 'iou');
  for (let i = 0; i < iouIds.length; i += MANY_AT_ONCE) {
    const ids = iouIds.slice(i, i + MANY_AT_ONCE);
    await expenseIousStore.updateMany(ctx, ids, (cur) => {
      const next = new Map<string, Iou | null>();
      for (const id of ids) {
        const iou = cur.get(id);
        if (!iou) return fail('Something it closes is no longer kept. Reload to see it as it is.', 409);
        next.set(id, { ...iou, closed: [...(iou.closed ?? []), closing(wanted.get(id)!)], updated_at: now.toISOString() });
      }
      return next;
    });
  }
  return { event, closed: wanted.size };
}

/** Takes back one event that closed an item (settled outside or let go). */
export async function reopenClosed(ctx: Ctx, item: string, event: string, now = new Date()): Promise<boolean> {
  const { items } = await itemsNow(ctx);
  const it = items.get(item);
  if (!it) return fail('That is no longer kept.', 404);
  let had = false;
  if (it.kind === 'share') {
    await expenseSharesStore.update(ctx, it.transaction_id!, (cur) => {
      if (!cur) return null;
      return {
        ...cur,
        entries: cur.entries.map((e) => {
          if (e.id !== item || !e.closed?.some((c) => c.event === event)) return e;
          had = true;
          const closed = e.closed.filter((c) => c.event !== event);
          const next: ShareEntry = { ...e, closed };
          if (closed.length === 0) delete next.closed;
          return next;
        }),
        updated_at: now.toISOString(),
      };
    });
  } else {
    await expenseIousStore.update(ctx, item, (cur) => {
      if (!cur || !cur.closed?.some((c) => c.event === event)) return cur;
      had = true;
      const closed = cur.closed.filter((c) => c.event !== event);
      const next: Iou = { ...cur, closed, updated_at: now.toISOString() };
      if (closed.length === 0) delete next.closed;
      return next;
    });
  }
  return had;
}

// ---- Removing what can't be read ----

/** Removes entries of a store that can't be read, once the person confirmed:
 *  only those the strict read names unreadable (damaged), never unrecognised
 *  ones (intact data a later release wrote). */
export async function removeUnreadable(ctx: Ctx, store: 'people' | 'shares' | 'ious' | 'payments' | 'dismissed', ids: readonly string[]): Promise<number> {
  const s = { people: expensePeopleStore, shares: expenseSharesStore, ious: expenseIousStore, payments: expensePaymentsStore, dismissed: expenseDismissedStore }[store];
  const { unreadable } = await s.getAllReport(ctx);
  const damaged = ids.filter((id) => unreadable.includes(id));
  if (damaged.length > 0) await s.remove(ctx, ...damaged);
  return damaged.length;
}

// ---- The setting ----

export type SettingsInput = { counting?: unknown; own_venmo?: unknown; own_cashtag?: unknown };

/** Saves the setting. One that can't be read is never saved over: the seam
 *  refuses. */
export async function saveSettings(ctx: Ctx, input: SettingsInput, now = new Date()): Promise<ExpenseSettings> {
  return (await expenseSettingsStore.update(ctx, (cur) => {
    const next: ExpenseSettings = { version: EXPENSES_VERSION, counting: cur?.counting ?? 'part', ...(cur?.own_venmo ? { own_venmo: cur.own_venmo } : {}), ...(cur?.own_cashtag ? { own_cashtag: cur.own_cashtag } : {}), updated_at: now.toISOString() };
    if (input.counting !== undefined) {
      if (!(COUNTINGS as readonly unknown[]).includes(input.counting)) fail('Choose how shared expenses count.');
      next.counting = input.counting as Counting;
    }
    for (const [k, field] of [
      ['own_venmo', 'Your Venmo username'],
      ['own_cashtag', 'Your cashtag'],
    ] as const) {
      if (input[k] === undefined) continue;
      const h = checkHandle(input[k], field);
      if (h) next[k] = h;
      else delete next[k];
    }
    return next;
  }))!;
}

// ---- For the splits and groups routes ----

/**
 * Why a split, an unsplit or a group can't be made on a transaction because
 * of a share or a payment on it, or null when it can (read strictly: one
 * that can't be read could be either). For app/api/transaction-splits and
 * app/api/transaction-groups, which refuse with their own error and a 409.
 * `parts` are the ids of the parts a split would keep.
 */
export async function sharesBlock(
  ctx: Ctx,
  transaction_id: string,
  change: 'group' | 'split' | 'unsplit',
  parts: readonly string[] = [],
  /** carriedOnto's answer, when the caller asks for several at once. */
  known?: ReadonlyMap<string, Carried>
): Promise<string | null> {
  const [share, paying] = await Promise.all([expenseSharesStore.get(ctx, transaction_id), expensePaymentsStore.has(ctx, transaction_id)]);
  if (paying) return 'This transaction pays something back under Shared expenses: reopen that payment first.';
  // One applying from elsewhere (a re-link's carry, a file's row it stands
  // for) is whole and says how the row counts, as its own would; a split
  // transaction is never carried to, so undoing a split asks nothing.
  if (!share && change !== 'unsplit') {
    const carried = (known ?? (await carriedOnto(ctx, [transaction_id]))).get(transaction_id);
    if (carried?.kind === 'payment') return 'This transaction pays something back under Shared expenses: reopen that payment first.';
    if (carried?.kind === 'share') {
      return change === 'group'
        ? 'This transaction is shared under Shared expenses, which says how it counts: stop sharing it to group it.'
        : 'This transaction is shared whole under Shared expenses: stop sharing it to split it, then share one of its parts.';
    }
  }
  if (!share) return null;
  if (change === 'group') return 'This transaction is shared under Shared expenses, which says how it counts: stop sharing it to group it.';
  if (change === 'split' && !share.part) return 'This transaction is shared whole under Shared expenses: stop sharing it to split it, then share one of its parts.';
  if (share.part && (change === 'unsplit' || !parts.includes(share.part))) return 'A part of this split is shared under Shared expenses: stop sharing that part first.';
  return null;
}
