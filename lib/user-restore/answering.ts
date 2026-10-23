// lib/user-restore/answering.ts
//
// The person's answers about the accounts a restore brought back from a bank
// connected through Plaid, as the restore card asks them
// (app/api/user-restore/answers, components/RestoreCard.tsx), and what the
// card shows of them. What the answers do to the rows is
// lib/user-restore/answers.ts.
//
//   count      "Chase is gone: count its transactions": each account is
//              ended (closed, no longer yours, or stop following, from a
//              day), unless it has an end already, then counted. The end is
//              written first, through the lifecycle module as Close… writes
//              it: stopped between the two, the account is ended and held
//              (Stop following), and the card offers the count again.
//   uncount    "Don't count them": counted no more, held again; the end
//              stays.
//   apart      "Not among this connection's accounts": a Plaid Item, or an
//              account tracked through a connector since the restore (or one
//              kept as a manual account from one), named for each account.
//   ask-again  takes that answer back.
//   hand-over  "Chase via SimpleFIN is Chase": a connector account carries a
//              restored account on (answers.ts HANDED OVER). Counted, ended
//              first if it has no end. One restored account per connector
//              account, in the same currency.
//   take-back  the handover undone: counted still, and held again by every
//              connector account until it is answered for.
//
// THE END'S LAST DAY. A restored account has no transaction or balance after
// its download, so an end the answer writes is at the latest the day after
// the download's day (`downloaded` + 1): a later one would leave days the
// account counts in with nothing of it known, said nowhere. An end it already
// has is kept as it is.
//
// Every answer is checked against what is stored now, under the links lock
// (a link or a forget of the same account can't land in between): an account
// a restore brought back, that the directory still lists and that isn't
// linked to a live account (a link answers it: its rows are that account's).
// Each write drops the ids of connections that are gone (a new one asks
// again anyway), and refuses past MAX_APART.

import type { Ctx } from '../containers';
import { getItems, type StoredItem } from '../storage';
import { addDays } from '../manual-txn-input';
import { directoryIds, effectiveLinks, getLinks, historySpans, liveAccountIds, withLinksLock } from '../links';
import { effectiveLifecycle, endOf, isEndDay, isLifecycleNote, lastEndDay, lifecycleOf, lifecycleStore, markEnded, LIFECYCLE_NOTE_MAX, type AccountAbout, type EndedLifecycle } from '../lifecycle';
import { connectorAccountsStore, endedAccountsStore } from '../connectors/store';
import { clearCaches } from '../cache';
import { MANY_AT_ONCE } from '../repo';
import { restoredAccountsStore, restoredAnswersStore, MAX_APART, type AnsweredEnd, type RestoredAccount, type RestoredAnswer } from './store';
import { linkedTo } from './restored';
import { restoreUnfinished } from './restored';
import { connectorHolders, holdersSince, readHandover, unanswered, type Holder } from './answers';

export class AnswerRefused extends Error {
  constructor(
    message: string,
    readonly status: number = 409
  ) {
    super(message);
    this.name = 'AnswerRefused';
  }
}

/** A connection an answer names: a Plaid Item, or a connector account (one
 *  kept as a manual account from one too), by id. */
export type ConnectionRef = { kind: 'item' | 'connector'; id: string };

export type AnswerRequest =
  | { action: 'count'; account_ids: string[]; end: EndedLifecycle | null }
  | { action: 'uncount'; account_ids: string[] }
  | { action: 'apart' | 'ask-again'; connection: ConnectionRef; account_ids: string[] }
  | { action: 'hand-over'; account_id: string; to: string; end: EndedLifecycle | null }
  | { action: 'take-back'; account_id: string };

/** The most accounts one answer names: more than a bank holds. */
export const MAX_ANSWERED = 50;

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && v !== '__proto__';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEYS: Record<AnswerRequest['action'], readonly string[]> = {
  count: ['action', 'account_ids', 'end'],
  uncount: ['action', 'account_ids'],
  apart: ['action', 'connection', 'account_ids'],
  'ask-again': ['action', 'connection', 'account_ids'],
  'hand-over': ['action', 'account_id', 'to', 'end'],
  'take-back': ['action', 'account_id'],
};

/** An end as a request says it, checked as the lifecycle route checks one
 *  (a real day, from 1970, never after the person's today), or what is
 *  wrong with it. Null: none sent. */
function parseEnd(v: unknown, now: number): EndedLifecycle | null | string {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) return 'The end is { state, on } or { state: "untracked", from }';
  const latest = lastEndDay(now);
  const day = (d: unknown, what: string) => (!isEndDay(d) ? `${what} is a date, YYYY-MM-DD, from 1970 on` : d > latest ? `${what} can't be in the future` : null);
  if (v.state === 'untracked') {
    if (!Object.keys(v).every((k) => k === 'state' || k === 'from')) return 'Stopping following takes a day to stop from';
    const wrong = day(v.from, 'The day to stop following it from');
    return wrong ?? { state: 'untracked', from: v.from as string };
  }
  if (v.state !== 'closed' && v.state !== 'left') return 'The end is closed, left or untracked';
  if (!Object.keys(v).every((k) => k === 'state' || k === 'on' || k === 'note')) return 'An end takes its day and a note';
  const wrong = day(v.on, 'The day it ended');
  if (wrong) return wrong;
  let note: string | undefined;
  if (v.note !== undefined && v.note !== null) {
    if (typeof v.note !== 'string') return 'The note is text';
    const clean = v.note.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length > LIFECYCLE_NOTE_MAX) return `The note is at most ${LIFECYCLE_NOTE_MAX} characters`;
    if (clean && !isLifecycleNote(clean)) return 'The note is one line of text';
    if (clean) note = clean;
  }
  return { state: v.state, on: v.on as string, ...(note ? { note } : {}) };
}

/** The request as an answer, or what is wrong with it, in the person's
 *  words. Every field is checked, and anything else refused. */
export function parseAnswer(body: unknown, now: number = Date.now()): AnswerRequest | string {
  if (!isRecord(body)) return 'Send the answer, as JSON';
  const action = body.action;
  if (typeof action !== 'string' || !Object.hasOwn(KEYS, action)) return 'The answer is count, uncount, apart, ask-again, hand-over or take-back';
  const a = action as AnswerRequest['action'];
  const extra = Object.keys(body).find((k) => !KEYS[a].includes(k));
  if (extra) return `${extra.slice(0, 40)} isn't part of that answer`;
  const ids = (v: unknown): string[] | string => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ANSWERED || !v.every(isId)) return `Name the accounts it is about: 1 to ${MAX_ANSWERED} of them`;
    return [...new Set(v)];
  };
  switch (a) {
    case 'count': {
      const account_ids = ids(body.account_ids);
      if (typeof account_ids === 'string') return account_ids;
      const end = parseEnd(body.end, now);
      if (typeof end === 'string') return end;
      return { action: a, account_ids, end };
    }
    case 'uncount': {
      const account_ids = ids(body.account_ids);
      return typeof account_ids === 'string' ? account_ids : { action: a, account_ids };
    }
    case 'apart':
    case 'ask-again': {
      const account_ids = ids(body.account_ids);
      if (typeof account_ids === 'string') return account_ids;
      const c = body.connection;
      if (!isRecord(c) || !Object.keys(c).every((k) => k === 'kind' || k === 'id') || (c.kind !== 'item' && c.kind !== 'connector') || !isId(c.id)) {
        return 'Name the connection: { kind: "item" | "connector", id }';
      }
      return { action: a, connection: { kind: c.kind, id: c.id }, account_ids };
    }
    case 'hand-over': {
      if (!isId(body.account_id) || !isId(body.to)) return 'Name the account brought back and the account that carries it on';
      const end = parseEnd(body.end, now);
      if (typeof end === 'string') return end;
      return { action: a, account_id: body.account_id, to: body.to, end };
    }
    case 'take-back':
      return isId(body.account_id) ? { action: a, account_id: body.account_id } : 'Name the account brought back';
  }
}

/** "Oct 5, 2026": a UTC day, as the card says one. */
const longDay = (d: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const nameOf = (a: RestoredAccount) => `${a.institution_name} ${a.name ?? 'Account'}${a.mask ? ` ••${a.mask}` : ''}`;

/** What an end entry needs about a restored account (lib/lifecycle.ts
 *  AccountAbout): as the restore brought it, on the connection it was on in
 *  the old copy. */
export const aboutRestored = (a: RestoredAccount): AccountAbout => ({
  type: a.type,
  label: { name: a.name ?? 'Account', institution: a.institution_name, mask: a.mask },
  item_id: a.item_id,
  currency: a.currency,
});

/** The latest day an answer may end a restored account on (see THE END'S
 *  LAST DAY), and never after the person's today. */
export function latestEnd(a: RestoredAccount, now: number = Date.now()): string {
  const after = addDays(a.downloaded, 1);
  const today = lastEndDay(now);
  return after < today ? after : today;
}

/** An end's day, as stored. */
const dayOf = (end: EndedLifecycle) => (end.state === 'untracked' ? end.from : end.on);

/** Everything an answer is checked against, read strictly. */
type Context = {
  restored: Map<string, RestoredAccount>;
  answers: Map<string, RestoredAnswer>;
  links: Awaited<ReturnType<typeof effectiveLinks>>;
  view: ReturnType<typeof effectiveLifecycle>;
  items: StoredItem[];
};

async function readContext(ctx: Ctx, ids: readonly string[]): Promise<Context> {
  const [restored, listed, links, live, items, entries, answers] = await Promise.all([
    restoredAccountsStore.getMany(ctx, ids),
    directoryIds(ctx),
    getLinks(ctx),
    liveAccountIds(ctx, { strict: true }),
    getItems(ctx),
    lifecycleStore.getAll(ctx),
    restoredAnswersStore.getMany(ctx, ids),
  ]);
  const applied = effectiveLinks(links, live);
  for (const id of ids) {
    const a = restored.get(id);
    if (!a) throw new AnswerRefused('That isn’t an account a restore brought back.', 404);
    if (!listed.has(id)) throw new AnswerRefused(`${nameOf(a)} was forgotten: there is nothing of it left to count.`);
    if (linkedTo(id, applied, live)) throw new AnswerRefused(`${nameOf(a)} is linked to an account connected again: its transactions count as that account’s. Unlink it first.`);
  }
  return { restored, answers, links: applied, view: effectiveLifecycle(entries, applied), items };
}

/** The connections made since the restore that can be named now: every
 *  Item, and the connector accounts holdersSince lists. Throws when what
 *  says so can't be read: an answer is never checked against less. */
async function holdersNow(ctx: Ctx, restored: Iterable<RestoredAccount>, items: readonly StoredItem[]): Promise<Holder[]> {
  const since = [...restored].map((a) => a.restored_at).reduce((x, y) => (y < x ? y : x));
  const { holders, unreadable } = await holdersSince(ctx, since, items);
  if (unreadable) throw new AnswerRefused('Your accounts from SimpleFIN or Lunch Flow can’t be read right now, so this can’t be answered. Try again later.');
  return holders;
}

const blank = (now: string): RestoredAnswer => ({ version: 1, counted: null, apart: { items: [], accounts: [] }, handed_to: null, set_at: now });

/** An answer with the ids of connections that are gone dropped (`present`),
 *  refused past MAX_APART; null when it says nothing any more. */
function tidy(a: RestoredAnswer, present: { items: Set<string>; accounts: Set<string> }, name: string): RestoredAnswer | null {
  const apart = { items: a.apart.items.filter((id) => present.items.has(id)), accounts: a.apart.accounts.filter((id) => present.accounts.has(id)) };
  if (apart.items.length > MAX_APART || apart.accounts.length > MAX_APART) throw new AnswerRefused(`${name} has been answered for ${MAX_APART} connections already: Nya keeps no more.`);
  const out = { ...a, apart };
  return out.counted || out.handed_to || apart.items.length > 0 || apart.accounts.length > 0 ? out : null;
}

/** Writes the answers for `ids` as `change` makes each from the stored one
 *  (null: none yet), in steps of MANY_AT_ONCE, each in one compare-and-set. */
async function writeAnswers(
  ctx: Ctx,
  ids: readonly string[],
  context: Context,
  present: { items: Set<string>; accounts: Set<string> },
  change: (current: RestoredAnswer | null, id: string) => RestoredAnswer | null,
  now: number
): Promise<void> {
  const at = new Date(now).toISOString();
  for (let i = 0; i < ids.length; i += MANY_AT_ONCE) {
    const chunk = ids.slice(i, i + MANY_AT_ONCE);
    await restoredAnswersStore.updateMany(ctx, chunk, (current) => {
      const writes = new Map<string, RestoredAnswer | null>();
      for (const id of chunk) {
        const next = change(current.get(id) ?? null, id);
        writes.set(id, next ? tidy({ ...next, set_at: at }, present, nameOf(context.restored.get(id)!)) : null);
      }
      return writes;
    });
  }
}

/** The end each account counts up to, written where it has none (see THE
 *  END'S LAST DAY): what it wrote, by id (null where one applied already). */
async function endFirst(ctx: Ctx, ids: readonly string[], context: Context, end: EndedLifecycle | null, now: number): Promise<Map<string, AnsweredEnd | null>> {
  const wrote = new Map<string, AnsweredEnd | null>();
  const needed: string[] = [];
  for (const id of ids) {
    const entry = lifecycleOf(context.view, id);
    if (entry && endOf(entry.lifecycle) !== null) wrote.set(id, null);
    else needed.push(id);
  }
  if (needed.length === 0) return wrote;
  if (!end) throw new AnswerRefused(`Say when to stop counting ${needed.map((id) => nameOf(context.restored.get(id)!)).join(', ')}: closed, no longer yours, or stop following, from a day.`, 400);
  for (const id of needed) {
    const a = context.restored.get(id)!;
    const latest = latestEnd(a, now);
    if (dayOf(end) > latest) {
      throw new AnswerRefused(`Nya has ${nameOf(a)}’s transactions only up to your download of ${longDay(a.downloaded)}: it can stop counting on ${longDay(latest)} at the latest.`, 400);
    }
  }
  for (const id of needed) {
    await markEnded(ctx, id, end, aboutRestored(context.restored.get(id)!), now, context.links);
    wrote.set(id, end);
  }
  return wrote;
}

/**
 * Answers for restored accounts (see the header), under the links lock.
 * Refused while a restore is being written or undone (its accounts aren't
 * settled), with AnswerRefused for anything that doesn't hold now. Clears the
 * caches: every figure that weighs transactions changes. Returns the ids it
 * answered for.
 */
export async function answer(ctx: Ctx, req: AnswerRequest, now: number = Date.now()): Promise<string[]> {
  if (await restoreUnfinished(ctx)) throw new AnswerRefused('A restore is being written or undone: answer once it has finished.');
  const ids = 'account_ids' in req ? req.account_ids : [req.account_id];
  return withLinksLock(ctx, async () => {
    const context = await readContext(ctx, ids);
    const holders = await holdersNow(ctx, context.restored.values(), context.items);
    const present = { items: new Set(context.items.map((i) => i.item_id)), accounts: new Set(connectorHolders(holders).map((h) => h.id)) };
    const at = new Date(now).toISOString();
    switch (req.action) {
      case 'count': {
        const wrote = await endFirst(ctx, ids, context, req.end, now);
        await writeAnswers(ctx, ids, context, present, (c, id) => {
          const base = c ?? blank(at);
          // Counted already: as it was (the end its first answer wrote stays
          // the one a link takes away).
          return base.counted ? base : { ...base, counted: { at, by: 'person', ended: wrote.get(id) ?? null } };
        }, now);
        break;
      }
      case 'uncount':
        await writeAnswers(ctx, ids, context, present, (c) => (c ? { ...c, counted: null, handed_to: null } : null), now);
        break;
      case 'apart':
      case 'ask-again': {
        const { kind, id: named } = req.connection;
        const there = kind === 'item' ? present.items.has(named) : present.accounts.has(named);
        if (!there && req.action === 'apart') throw new AnswerRefused('That connection is no longer there: nothing to answer for it.', 404);
        const key = kind === 'item' ? 'items' : 'accounts';
        await writeAnswers(ctx, ids, context, present, (c) => {
          const base = c ?? blank(at);
          const list = base.apart[key].filter((x) => x !== named);
          return { ...base, apart: { ...base.apart, [key]: req.action === 'apart' ? [...list, named] : list } };
        }, now);
        break;
      }
      case 'hand-over': {
        const a = context.restored.get(req.account_id)!;
        const to = connectorHolders(holders).find((h) => h.id === req.to);
        if (!to) throw new AnswerRefused('That account isn’t one tracked through SimpleFIN or Lunch Flow since the restore.', 404);
        const currency = (await connectorAccountsStore.get(ctx, to.id))?.currency ?? (await endedAccountsStore.get(ctx, to.id))?.currency ?? null;
        if (a.currency && currency && a.currency !== currency) throw new AnswerRefused(`${to.institution} ${to.name} is in ${currency} and ${nameOf(a)} in ${a.currency}: an account doesn’t change currency.`);
        const all = await restoredAnswersStore.getAll(ctx);
        const taken = [...all].find(([id, x]) => id !== req.account_id && x.handed_to?.account_id === to.id);
        if (taken) throw new AnswerRefused(`${to.institution} ${to.name} carries on another account from your download already.`);
        const wrote = await endFirst(ctx, ids, context, req.end, now);
        await writeAnswers(ctx, ids, context, present, (c, id) => {
          const base = c ?? blank(at);
          return { ...base, counted: base.counted ?? { at, by: 'person', ended: wrote.get(id) ?? null }, handed_to: { account_id: to.id, at } };
        }, now);
        break;
      }
      case 'take-back':
        await writeAnswers(ctx, ids, context, present, (c) => (c ? { ...c, handed_to: null } : null), now);
        break;
    }
    await clearCaches(ctx);
    return ids;
  });
}

// ---- What the card shows ----

/** A restored account as the card asks about it. `end`: the end that
 *  applies to it now, if any; `counted`: who answered count (the person, or
 *  a restore that found it ended in the file); `held_by`: while counted, the
 *  connections made since that still hold it, by id ('unread' when that
 *  can't be told); `handed_to`: the connector account carrying it on, with
 *  the day its rows stop counting (null until that account has coverage). */
export type AnsweredAccount = {
  account_id: string;
  name: string | null;
  mask: string | null;
  type: string | null;
  currency: string | null;
  rows: { first: string; last: string; count: number } | null;
  hidden: boolean;
  end: AnsweredEnd | null;
  counted: 'person' | 'file' | null;
  held_by: string[] | 'unread';
  apart: { items: string[]; accounts: string[] };
  handed_to: { account_id: string; cut: string | null } | null;
};

/** A bank brought back, as the card asks about it: its accounts not linked,
 *  the day an end is prefilled with (the day after the later of its last
 *  restored transaction and its last restored balance, of any of its
 *  accounts), and the latest an answer may end them on. */
export type AnsweredBank = { institution_name: string; accounts: AnsweredAccount[]; prefill: string | null; latest: string };

/** A connection made since the restore, as the card names it: an Item with
 *  its accounts' names (the link sheet's choices), or a connector account. */
export type HolderView = Holder & { accounts?: { account_id: string; name: string; mask: string | null }[] };

export type AnswersView = { banks: AnsweredBank[]; holders: HolderView[]; unreadable: boolean };

const endView = (e: EndedLifecycle): AnsweredEnd => (e.state === 'untracked' ? { state: 'untracked', from: e.from } : { state: e.state, on: e.on, ...(e.note ? { note: e.note } : {}) });

/**
 * The banks a restore brought back that have accounts not linked, with what
 * was answered about each, and the connections made since (for the
 * questions). `unreadable` when the answers, or what holds, can't be read:
 * the card says so, and the rows are held (answers.ts). Reads the balance
 * history's every day only when there is a bank to prefill an end for.
 * Storage failing throws; an entry that can't be read isn't listed (the
 * card's other notes name it).
 */
export async function answersView(
  ctx: Ctx,
  opts: { hidden: ReadonlySet<string>; accountsOf: (item_id: string) => Promise<{ account_id: string; name: string; mask: string | null }[]> },
  now: number = Date.now()
): Promise<AnswersView> {
  const report = await restoredAccountsStore.getAllReport(ctx);
  if (report.entries.size === 0) return { banks: [], holders: [], unreadable: false };
  const [listed, links, live, items, entries, answers] = await Promise.all([
    directoryIds(ctx),
    getLinks(ctx),
    liveAccountIds(ctx, { strict: true, readOnly: true }),
    getItems(ctx),
    lifecycleStore.getAllReport(ctx),
    restoredAnswersStore.getAllReport(ctx),
  ]);
  const applied = effectiveLinks(links, live);
  const view = effectiveLifecycle(entries.entries, applied);
  const open = [...report.entries].filter(([id]) => listed.has(id) && !linkedTo(id, applied, live));
  if (open.length === 0) return { banks: [], holders: [], unreadable: false };
  const since = [...report.entries.values()].map((a) => a.restored_at).reduce((x, y) => (y < x ? y : x));
  const { holders, unreadable: holdersUnread } = await holdersSince(ctx, since, items);
  const answersUnread = [...answers.unreadable, ...answers.unrecognised].some((id) => report.entries.has(id));
  const spans = await historySpans(ctx);
  const banks = new Map<string, AnsweredBank>();
  for (const [id, a] of open) {
    const answer = answers.entries.get(id) ?? null;
    const entry = lifecycleOf(view, id);
    const ended = entry && endOf(entry.lifecycle) !== null ? endView(entry.lifecycle as EndedLifecycle) : null;
    let handed: AnsweredAccount['handed_to'] = null;
    if (answer?.handed_to) {
      let cut: string | null = null;
      try {
        const h = await readHandover(ctx, answer.handed_to.account_id);
        cut = h === 'gone' ? null : h.cut;
      } catch {
        cut = null;
      }
      handed = { account_id: answer.handed_to.account_id, cut };
    }
    const account: AnsweredAccount = {
      account_id: id,
      name: a.name,
      mask: a.mask,
      type: a.type,
      currency: a.currency,
      rows: a.rows ? { first: a.rows.first, last: a.rows.last, count: a.rows.count } : null,
      hidden: opts.hidden.has(id),
      end: ended,
      counted: answer?.counted?.by ?? null,
      held_by: holdersUnread ? 'unread' : answer?.counted ? unanswered(answer, holders).map((h) => h.id) : [],
      apart: answer?.apart ?? { items: [], accounts: [] },
      handed_to: handed,
    };
    const last = [a.rows?.last, spans[id]?.last].filter((d): d is string => !!d).reduce<string | null>((m, d) => (m === null || d > m ? d : m), null);
    const bank = banks.get(a.institution_name) ?? { institution_name: a.institution_name, accounts: [], prefill: null, latest: latestEnd(a, now) };
    bank.accounts.push(account);
    if (last) {
      const day = addDays(last, 1);
      const capped = day > bank.latest ? bank.latest : day;
      if (bank.prefill === null || capped > bank.prefill) bank.prefill = capped;
    }
    const latest = latestEnd(a, now);
    if (latest < bank.latest) bank.latest = latest;
    banks.set(a.institution_name, bank);
  }
  const holderViews: HolderView[] = [];
  for (const h of holders) holderViews.push(h.kind === 'item' ? { ...h, accounts: await opts.accountsOf(h.id) } : h);
  const sorted = [...banks.values()].sort((x, y) => x.institution_name.localeCompare(y.institution_name));
  for (const b of sorted) b.accounts.sort((x, y) => (x.name ?? '').localeCompare(y.name ?? '') || x.account_id.localeCompare(y.account_id));
  return { banks: sorted, holders: holderViews, unreadable: holdersUnread || answersUnread };
}
