// lib/migration/plan.ts
//
// What importing another app's export would do (M2), worked out before
// anything is written: the review the person sees, and the commit applies
// (lib/migration/commit.ts), which works it out again and refuses unless it
// is the one reviewed (its digest). No storage: the route reads what it needs
// (lib/migration/targets.ts) and hands it in.
//
// EACH OF THE FILE'S ACCOUNTS GOES WHERE THE PERSON SAYS, never anywhere by
// itself: a new manual account (its name, institution, type and the balance
// they type, as the Add form takes them), one they have, a linked account, or
// nowhere. Until every account has an answer the import waits. Each Nya
// account's rows then go through that account's own import, unchanged:
//   - a manual account: lib/import/commit.ts planImport, which matches them
//     exactly against its book (the content key: re-importing the same file
//     adds nothing);
//   - a linked account: lib/history-import/plan.ts, the review against the
//     bank's own rows (a row the bank has is proposed as its duplicate, kept
//     beside it and never counted while it is there; a low-confidence one
//     waits for the person's answer), so the bank's rows are never doubled.
//     Nor is anything the bank's balance and rows already are brought in
//     beside them (planMigration's first pass): the app's opening balances
//     and balance adjustments never; and where the account's own
//     transactions reach (the bank's from its first row on, an earlier
//     file's period), neither Lunch Money's groups nor the lines of a split
//     whose whole the file doesn't hold, a split Nya can't hold coming in
//     whole instead (TargetPlan left_out, whole). Before that, they come in
//     as a manual account takes them. An export that marks no split has its
//     rows of one day and key taken together as one of the account's
//     transactions where they add up to one no row is by itself
//     (combineUnmarked, TargetPlan combined).
// The rows are CSV rows to both ('import:csv', matched by content), with the
// app's payee, note, and the category the mapping sends their category to
// (lib/migration/categories.ts): a transfer the app marks between the
// person's own accounts is filed as Nya files a bank's ("transfer out",
// "transfer in"), an opening balance under OPENING (neither income nor
// spending), and a row with no category under none.
//
// WHAT THE ROWS CARRY BESIDE THEM, kept where the app keeps them for a bank's
// row: tags in what is said about the transaction (lib/txn-annotations.ts);
// a split transaction's parts in the splits store (lib/splits.ts), each part
// checked by checkParts, the rule a split made in the app meets, in the
// account's currency (one that fails, or past MAX_SPLITS, comes in as its
// lines: lib/import/apps/splits.ts explode); and for a row a linked account's
// bank already has (a duplicate the bank's row stands for, lib/history-
// import/match.ts settle), the category, tags and note the app had, said on
// the imported row so the bank's row shows them (lib/activity.ts
// categoriesFromImports, lib/txn-layers.ts): the person's own categorizing
// comes over for the years the bank also reaches. So does a row the account
// adds whose only look-alike at the bank is a pending row (TargetPlan
// onto_pending): that row stands in for it until it posts, and the posted
// one then takes its place and what is said about it (settle again), so
// what the app said of it goes there by the same answer, and otherwise it
// comes in at its total, without its parts or tags. Only what will show, and
// never over the person's approval (TargetPlan carry_to): a row that is one
// a file imported before brought, which no bank row stands for, carries
// nothing (nothing shows what is said on a row standing for such a row, and
// that row keeps what it has); one whose bank row holds an approval in the
// review queue (lib/review-layer.ts approvalFor) carries its tags and note
// but neither the category nor the split, so it stays where it was approved.
//
// LIMITS, checked here so the review says so before anything is made: the
// file's rows, MAX_IMPORT_ROWS in any one account; manual accounts
// (MAX_MANUAL_ACCOUNTS), categories (lib/migration/categories.ts), tags
// (MAX_TAGS, each name within TAG_NAME_MAX, at most MAX_TAGS_PER_TRANSACTION
// on one), what is said about transactions (MAX_ANNOTATIONS) and splits
// (MAX_SPLITS).

import { createHash } from 'node:crypto';
import type { Problem } from '../import/record';
import { normalizeDescription, normalizeRecords, type NormalizedRecord } from '../import/normalize';
import { planImport, type ImportPlan } from '../import/commit';
import type { RawRecord } from '../import/record';
import { MAX_IMPORT_ROWS } from '../import/record';
import { explode, fromLines, WHY } from '../import/apps/splits';
import type { AppRead } from '../import/apps/read';
import type { AppTxn, SplitWhole } from '../import/apps/types';
import type { AppProblem } from '../import/apps/common';
import { APP_NAMES } from '../import/apps/types';
import { knownOf, planHistoryImport, type HistoryChoices, type HistoryPlan, type Period } from '../history-import/plan';
import { couldBe, crossesEdge, daysApart, pairUp, type Matchable } from '../history-import/match';
import { coveredPeriod } from '../history-import/commit';
import type { Covers } from '../history-import/store';
import type { AccountContext, LinkedAccount } from '../history-import/read';
import type { ManualTxnBook } from '../manual-txns';
import { MANUAL_TYPES, MAX_BALANCE, MAX_MANUAL_ACCOUNTS, type ManualAccount, type ManualType } from '../manual';
import { isOwedType } from '../balance';
import { checkParts, MAX_SPLITS, SplitError } from '../splits';
import { MAX_ANNOTATIONS } from '../txn-annotations';
import { cleanTagName, MAX_TAGS, MAX_TAGS_PER_TRANSACTION, TAG_NAME_MAX, tagByName, type TagSet } from '../tags';
import { categoryForKey, indexTaxonomy, MAX_CATEGORIES, TEXT, type Taxonomy } from '../categories';
import { DEFAULT_CURRENCY, toMinorUnits } from '../manual-txn-input';
import { mapCategories, OPENING, sourceKey, type CategoryChoice, type CategoryPlan, type SourceCategory } from './categories';

export { MAX_MANUAL_ACCOUNTS };
/** The most of the file's accounts one import takes. */
export const MAX_SOURCE_ACCOUNTS = 100;

/** Where the person sends one of the file's accounts. */
export type AccountChoice =
  | { to: 'new'; name: string; institution: string; type: ManualType; balance: number }
  | { to: 'manual'; id: string }
  | { to: 'linked'; id: string }
  | { to: 'skip' };

/** One of the file's accounts, as the review lists it. */
export type SourceAccount = {
  key: string;
  name: string;
  rows: number;
  first: string | null;
  last: string | null;
  /** The currencies its rows say they are in (Lunch Money's), most first. */
  currencies: string[];
  /** Its rows added up from the holder's side (money in less money out): what
   *  its balance moved by across the file, the app's balance when the file
   *  holds all of its history from an opening balance. */
  net: number;
  transfers: number;
  opening: number;
  splits: number;
  /** Rows with no category (YNAB's accounts it tracks off budget have none:
   *  they count as spending or income here until categorized). */
  uncategorized: number;
  choice: AccountChoice | null;
};

/** A Nya account the file's accounts can go into. */
export type TargetAccount =
  | { kind: 'manual'; id: string; name: string; institution: string; type: string; currency: string }
  | { kind: 'linked'; id: string; name: string; institution: string; type: string; currency: string | null; mask: string | null };

/** Where what the app said of a linked account's row its bank (or a file
 *  imported before) already has would go, were it the same (see the header):
 *  onto the bank's row it leads to, all of it (`bank`); onto one the person
 *  approved in the review queue, its tags and note only (`approved`); or
 *  nowhere, the row a file imported before brought keeping what it has
 *  (`earlier`). */
export type CarryTo = 'bank' | 'approved' | 'earlier';

/** Of a linked account's rows that are its bank's (answered the same as
 *  planned) or that a pending row of its bank will take the place of
 *  (onto_pending): how many would give their bank's row something (`bank`);
 *  how many stay where the person approved theirs (`approved`), and of
 *  those, how many would give it their tags or note (`notes`); and how many
 *  are a file imported before's, which keep what they have (`earlier`). */
export type CarryCounts = { bank: number; approved: number; notes: number; earlier: number };

/** What one Nya account's import would be. */
export type TargetPlan = {
  /** 'new:<the file's account>', 'manual:<id>' or 'linked:<id>'. */
  key: string;
  kind: 'manual' | 'linked';
  /** Null for a manual account the import makes. */
  account_id: string | null;
  name: string;
  /** The new account's fields, for one the import makes. */
  create: (Omit<ManualAccount, 'account_id' | 'updated_at'> & { currency?: string }) | null;
  sources: string[];
  currency: string;
  rows: NormalizedRecord[];
  /** The transaction each row is (rows[i] is txns[i]). */
  txns: AppTxn[];
  /** Its lines that couldn't be read, with the file's whose account
   *  couldn't be told (they may be its own), as its import keeps them; and
   *  its own alone, as the review lists them under it. */
  problems: Problem[];
  own_problems: Problem[];
  manual: ImportPlan | null;
  linked: HistoryPlan | null;
  /** A linked account's answers, by each row's place (byIndex). */
  choices: HistoryChoices;
  covers: Covers | null;
  /** By row: the tags it carries (names), a split's parts, and for a linked
   *  account's row the bank already has, the category and note to say on it. */
  tags: Map<number, string[]>;
  parts: Map<number, { amount: number; text: string; note: string | null }[]>;
  /** A linked account's: by row, for each that has a proposal or is in
   *  onto_pending, where what the app said of it goes were it the bank's
   *  (CarryTo); the rows of those that would give the bank's row something
   *  there (`moves`: a category, a split, tags or a note; only tags or a
   *  note onto an approved one); the rows the account adds whose only
   *  look-alike at the bank is a pending row, which takes their place once
   *  it posts (see the header); and the counts (CarryCounts). */
  carry_to: Map<number, CarryTo>;
  moves: Set<number>;
  onto_pending: Set<number>;
  carried: CarryCounts;
  /** Splits that came in as their lines here (a manual account), with why. */
  exploded: { reason: string; lines: number[] }[];
  /** A linked account's (see the header): splits brought in whole, as its
   *  bank has them, without their parts, with why; what isn't brought in at
   *  all, by the file's lines (the app's opening balances and balance
   *  adjustments, Lunch Money's groups, a split's lines without its whole);
   *  and the rows of a split the export doesn't mark, taken together as one
   *  of its bank's transactions. */
  whole: { reason: string; lines: number[] }[];
  left_out: { opening: number[]; groups: number[]; lines: number[] };
  combined: { transactions: number; lines: number[] };
  /** A linked account that ended (lib/lifecycle.ts): how, from when, and the
   *  rows the import adds dated from then, which count in nothing. */
  ended: { state: string; day: string; rows: number } | null;
  /** Tags cut to what a transaction can carry. */
  tags_cut: number;
};

/** What the person answered, as checked (lib/migration/request.ts). A linked
 *  account's answers to its proposals are by the line of the file each row
 *  starts on, never by its place in the account's rows: that place moves when
 *  another of the file's accounts is sent into the same account, and an
 *  answer given for one row must never land on another. */
export type MigrationAnswers = {
  accounts: Readonly<Record<string, AccountChoice>>;
  categories: Readonly<Record<string, CategoryChoice>>;
  tags: boolean;
  currency: string | null;
  /** On a linked account's row its bank has already, the app's category,
   *  tags, note and split, said on it so the bank's row shows them (the
   *  person's own choice for it, ahead of rules): on unless the person says
   *  otherwise in the review. */
  carry: boolean;
  choices: Readonly<Record<string, HistoryChoices>>;
};

/** A linked account's answers by line (see MigrationAnswers) as the
 *  history import's plan takes them: by each row's place among its records. */
function byIndex(choices: HistoryChoices | undefined, rows: readonly NormalizedRecord[]): HistoryChoices {
  if (!choices) return {};
  const proposals = choices.proposals;
  const conflicts = choices.conflicts;
  const each = <T,>(by: Record<string, T> | undefined) => {
    if (!by) return undefined;
    const out: Record<string, T> = {};
    for (const r of rows) {
      const c = r.line === null ? undefined : by[String(r.line)];
      if (c !== undefined) out[String(r.index)] = c;
    }
    return out;
  };
  return {
    ...(proposals ? { proposals: { ...(proposals.all ? { all: proposals.all } : {}), ...(proposals.each ? { each: each(proposals.each) } : {}) } } : {}),
    ...(conflicts ? { conflicts: { ...(conflicts.all ? { all: conflicts.all } : {}), ...(conflicts.each ? { each: each(conflicts.each) } : {}) } } : {}),
  };
}

/** What the plan reads, from the route (lib/migration/targets.ts). */
export type MigrationState = {
  today: string;
  taxonomy: Taxonomy;
  tags: TagSet | null;
  /** The person's tags couldn't be read (when the import brings tags). */
  tagsUnreadable?: boolean;
  manual: ReadonlyMap<string, ManualAccount>;
  linked: ReadonlyMap<string, LinkedAccount>;
  /** For each target chosen: a manual account's book, a linked account's
   *  context (its bank rows, earlier imports, links). */
  books: ReadonlyMap<string, ManualTxnBook | null>;
  contexts: ReadonlyMap<string, AccountContext>;
  /** Linked accounts chosen whose context couldn't be read, with why. */
  unavailable: ReadonlyMap<string, string>;
  /** For each linked account with a context: the posted bank row each of its
   *  kept rows stands for, followed through earlier imports' rows
   *  (lib/history-import/read.ts standsFor), and its bank rows, posted or
   *  pending, that hold an approval in the review queue, or one that can't
   *  be read (lib/review-layer.ts approvalFor). */
  reach: ReadonlyMap<string, { leads: ReadonlyMap<string, string>; approved: ReadonlySet<string> }>;
  /** Linked accounts chosen that ended, how and from which day (read
   *  leniently: only the review's words). */
  ends?: ReadonlyMap<string, { state: string; day: string }>;
  counts: { annotations: number; splits: number; manual: number };
};

export type MigrationPlan = {
  read: Extract<AppRead, { status: 'ready' }>;
  accounts: SourceAccount[];
  categories: CategoryPlan;
  sources: SourceCategory[];
  targets: TargetPlan[];
  tags: { on: boolean; names: { name: string; rows: number; existing: boolean }[]; added: number; room: number };
  /** Lines that couldn't be read whose account couldn't be told, and the
   *  file's own (a line with no account). */
  problems: AppProblem[];
  /** What blocks the import as it stands, in words. */
  blocks: string[];
  /** Rows waiting for the person: accounts without an answer, linked
   *  proposals of low confidence. */
  waiting: { accounts: number; proposals: number };
  /** Splits rebuilt that go in whole, and the room left. */
  needs: { annotations: number; splits: number; accounts: number };
  room: { annotations: number; splits: number; accounts: number };
  counts: { uncategorized: number; transfers: number; opening: number };
  /** The fingerprint of everything above (planDigest). */
  digest: string;
};

/** The words a transfer between the person's own accounts is filed by, as
 *  Nya files a bank's (seeded, in the Transfers group): by its side. */
const transferText = (amount: number) => (amount > 0 ? 'transfer out' : 'transfer in');

/** A key a source account is answered by: its name as the file writes it. */
export const accountKey = (t: AppTxn) => t.account;

/** The app's categories the file's rows (and split parts) name, with the
 *  opening balances' when there are any. */
export function sourceCategories(txns: readonly AppTxn[]): SourceCategory[] {
  const out = new Map<string, SourceCategory>();
  const add = (c: AppTxn['category']) => {
    if (!c) return;
    const key = sourceKey(c);
    const found = out.get(key);
    if (found) found.rows++;
    else out.set(key, { key, group: c.group, name: c.name, kind: c.kind, from: c.from ?? null, rows: 1 });
  };
  for (const t of txns) {
    if (t.starting) add(OPENING);
    else if (t.parts) for (const p of t.parts) (p.transfer === null ? add(p.category) : undefined);
    else if (t.transfer === null) add(t.category);
  }
  return [...out.values()];
}

/** The file's accounts, in file order of their first row. */
export function sourceAccounts(txns: readonly AppTxn[], answers: Readonly<Record<string, AccountChoice>>): SourceAccount[] {
  const out = new Map<string, SourceAccount & { byCurrency: Map<string, number> }>();
  for (const t of txns) {
    const key = accountKey(t);
    let a = out.get(key);
    if (!a) {
      a = { key, name: key || 'This file’s account', rows: 0, first: null, last: null, currencies: [], net: 0, transfers: 0, opening: 0, splits: 0, uncategorized: 0, choice: (Object.hasOwn(answers, key) ? answers[key] : null) ?? null, byCurrency: new Map() };
      out.set(key, a);
    }
    a.rows++;
    if (!a.first || t.date < a.first) a.first = t.date;
    if (!a.last || t.date > a.last) a.last = t.date;
    if (t.currency) a.byCurrency.set(t.currency, (a.byCurrency.get(t.currency) ?? 0) + 1);
    a.net -= t.amount;
    if (t.transfer !== null) a.transfers++;
    if (t.starting) a.opening++;
    if (t.parts) a.splits++;
    if (!t.starting && t.transfer === null && !t.parts && !t.category) a.uncategorized++;
  }
  return [...out.values()].map(({ byCurrency, ...a }) => ({
    ...a,
    net: Math.round(a.net * 1e6) / 1e6,
    currencies: [...byCurrency].sort((x, y) => y[1] - x[1]).map(([c]) => c),
  }));
}

/** The text a transaction (or part) is filed by: a transfer's words, an
 *  opening balance's category, its category's target, or none. */
function textFor(t: { transfer: string | null; category: AppTxn['category']; amount: number }, starting: boolean, texts: ReadonlyMap<string, string>): string | null {
  if (t.transfer !== null) return transferText(t.amount);
  if (starting) return texts.get(sourceKey(OPENING)) ?? null;
  return t.category ? (texts.get(sourceKey(t.category)) ?? null) : null;
}

/** Why a rebuilt split can't be held as one in Nya, in the account's
 *  currency, or null: the rule a split made in the app meets
 *  (lib/splits.ts checkParts). Every category of the app's maps to one of
 *  the person's (lib/migration/categories.ts), so only a line with none, or
 *  a transfer line with no transfer category to file it under, can't be a
 *  part. */
function holdable(t: AppTxn, currency: string, transfersFiled: boolean): string | null {
  const parts = t.parts!;
  // A part with no category can't be one in Nya: it would need the
  // uncategorized category's id, which a migration doesn't choose for it.
  if (parts.some((p) => p.transfer === null && !p.category)) return 'A line of it has no category, and every part of a split in Nya has one.';
  if (!transfersFiled && parts.some((p) => p.transfer !== null)) return 'A line of it moved money to another of your accounts, and your categories have no transfer category to file that part under.';
  try {
    checkParts(
      parts.map((p) => ({ amount: p.amount, category_id: 'migration-part', ...(p.note ? { note: p.note } : {}) })),
      { amount: t.amount, currency, pending: false }
    );
  } catch (err) {
    if (err instanceof SplitError) return WHY.rules;
    throw err;
  }
  return null;
}

/** A target's key. */
export function targetKey(choice: Exclude<AccountChoice, { to: 'skip' }>, source: string): string {
  return choice.to === 'new' ? `new:${source}` : `${choice.to}:${choice.id}`;
}

/** How a new manual account's balance must be, as the Add form checks it
 *  (app/api/manual-accounts), in words, or null. */
export function newAccountProblem(c: Extract<AccountChoice, { to: 'new' }>): string | null {
  if (!c.name.trim() || !c.institution.trim()) return 'A new account needs a name and an institution.';
  if (!(MANUAL_TYPES as readonly string[]).includes(c.type)) return 'Choose what kind of account it is.';
  if (!Number.isFinite(c.balance) || Math.abs(c.balance) > MAX_BALANCE) return 'Its balance isn’t one Nya can keep.';
  if (isOwedType(c.type) && c.balance < 0) return 'A card’s or a loan’s balance is the amount owed, so it can’t be negative.';
  return null;
}

/** One transaction as a target brings it: `split` when it goes in with its
 *  parts (held: holdable), else whole. */
type Entry = { txn: AppTxn; split: boolean };

/** The parts of a split as one taken whole: its shared category, else none. */
const sharedCategory = (cats: readonly (AppTxn['category'] | null)[]): AppTxn['category'] =>
  cats.length > 0 && cats.every((c) => c !== null && cats[0] !== null && sourceKey(c) === sourceKey(cats[0])) ? cats[0] : null;

/** A split's lines as the one transaction the file gives whole (a linked
 *  account's bank has it so): no parts. */
function wholeTxn(whole: SplitWhole, lines: readonly AppTxn[]): AppTxn {
  return {
    line: Math.min(...lines.map((l) => l.line)),
    lines: lines.flatMap((l) => l.lines).sort((a, b) => a - b),
    account: lines[0].account,
    date: whole.date,
    amount: whole.amount,
    currency: whole.currency ?? lines[0].currency,
    payee: whole.payee,
    category: sharedCategory(lines.map((l) => (l.transfer === null ? l.category : null))),
    transfer: null,
    starting: false,
    note: whole.note,
    tags: [...new Set(lines.flatMap((l) => l.tags))],
    parts: null,
    raw: lines.map((l) => l.raw),
  };
}

/** A rebuilt split taken whole, without its parts (one Nya can't hold as a
 *  split, into a linked account, whose bank has it as one row). */
const withoutParts = (t: AppTxn): AppTxn => ({ ...t, category: sharedCategory((t.parts ?? []).map((p) => (p.transfer === null ? p.category : null))), parts: null });

/**
 * In a linked account, the rows of an export that doesn't mark a split's
 * lines (AppTxn.group_key) of one of the file's accounts, one day and one
 * group key, that add up exactly to one of the account's own transactions
 * which no row of the file is by itself (a bank row, posted or still
 * pending, or a row an earlier file brought), when they aren't each one by
 * themselves: one split transaction's lines, which the bank has as one row.
 * They go in together, with their categories as its parts where Nya can hold
 * it (else whole), so they are matched to that row (or, while it is
 * pending, retired by it once it posts), never counted beside it.
 *
 * Every row of the file is paired with what it is by itself first (the
 * closest such transaction, each once, a pending one too): rows that each are
 * one stay as they are, and a total is only ever matched to a transaction no
 * row of the file is, so separate purchases are never made one.
 */
function combineUnmarked(
  entries: Entry[],
  known: readonly Matchable[],
  currencyOf: (t: AppTxn) => string,
  canHold: (t: AppTxn) => string | null,
  room: { splits: number }
): { entries: Entry[]; transactions: number; lines: number[] } {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const t = e.txn;
    if (e.split || t.parts || !t.group_key || t.transfer !== null || t.starting || t.grouped || t.split_of) continue;
    const key = [t.account, t.date, t.group_key.toLowerCase(), currencyOf(t)].join('\u001f');
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  if (![...groups.values()].some((g) => g.length > 1)) return { entries, transactions: 0, lines: [] };

  // The account's transactions by amount, to find each row's quickly; a
  // pending one counts here, as what the row will be once it posts.
  const cents = (n: number) => Math.round(n * 100);
  const byAmount = new Map<number, Matchable[]>();
  for (const k of known) byAmount.set(cents(k.amount), [...(byAmount.get(cents(k.amount)) ?? []), k]);
  const alike = (row: { date: string; amount: number; currency: string }, k: Matchable) => couldBe(row, k.pending ? { ...k, pending: false } : k);
  const claimed = new Set<Matchable>();
  const claim = (row: { date: string; amount: number; currency: string }): Matchable | null => {
    let best: Matchable | null = null;
    for (const k of byAmount.get(cents(row.amount)) ?? []) {
      if (claimed.has(k) || !alike(row, k)) continue;
      if (!best || daysApart(row.date, k.date) < daysApart(row.date, best.date)) best = k;
    }
    if (best) claimed.add(best);
    return best;
  };
  const single = new Map<Entry, Matchable | null>();
  for (const e of [...entries].sort((a, b) => (a.txn.date < b.txn.date ? -1 : a.txn.date > b.txn.date ? 1 : a.txn.line - b.txn.line))) {
    single.set(e, claim({ date: e.txn.date, amount: e.txn.amount, currency: currencyOf(e.txn) }));
  }

  const taken = new Set<Entry>();
  const added: Entry[] = [];
  let transactions = 0;
  const lines: number[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sign = Math.sign(group[0].txn.amount);
    if (sign === 0 || group.some((e) => Math.sign(e.txn.amount) !== sign)) continue;
    // Each one by itself: separate transactions.
    if (group.every((e) => single.get(e))) continue;
    const first = group[0].txn;
    const currency = currencyOf(first);
    const total = group.reduce((n, e) => n + Math.round(e.txn.amount * 1e6), 0) / 1e6;
    if (!claim({ date: first.date, amount: total, currency })) continue;
    // What some of its rows were taken to be by themselves is free again:
    // they are the parts of the one transaction.
    for (const e of group) {
      const own = single.get(e);
      if (own) claimed.delete(own);
    }
    const parts = group.map((e) => e.txn);
    const built = fromLines({ account: first.account, date: first.date, currency: first.currency, payee: first.payee, note: null, tags: [...new Set(parts.flatMap((p) => p.tags))], raw: parts.map((p) => p.raw) }, parts);
    let entry: Entry;
    if (!('reason' in built) && room.splits > 0 && canHold(built.txn) === null) {
      room.splits--;
      entry = { txn: built.txn, split: true };
    } else {
      entry = { txn: wholeTxn({ date: first.date, amount: total, payee: first.payee, note: null, currency: first.currency }, parts), split: false };
    }
    for (const e of group) taken.add(e);
    added.push(entry);
    transactions++;
    lines.push(...parts.map((p) => p.line));
  }
  if (added.length === 0) return { entries, transactions: 0, lines: [] };
  return { entries: [...entries.filter((e) => !taken.has(e)), ...added].sort((a, b) => a.txn.line - b.txn.line), transactions, lines };
}

/** A linked account's earlier imports with the period each covers, as its
 *  import's own plan takes them. */
const importsOf = (context: AccountContext) => new Map<string, { covers: Period | null }>([...context.summaries].map(([id, s]) => [id, { covers: { from: s.covers.from, to: s.covers.to } }]));

/** The most of the app's categories one import maps (and the most the
 *  person's answers can name: lib/migration/request.ts). */
export const MAX_SOURCE_CATEGORIES = 1_000;

/** A name cut to `max` UTF-16 units, never inside a character written as two. */
function cutUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A tag's name as Nya keeps it (cleaned, within TAG_NAME_MAX). */
const tagName = (raw: string) => cutUnits(cleanTagName(raw), TAG_NAME_MAX).trimEnd();

/** An answer by a key the file wrote, never one an object inherits
 *  ("constructor"). */
const own = <T,>(by: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(by, key) ? by[key] : undefined);

/**
 * The plan (see the header). `state` holds what the route read for the
 * accounts chosen; an account answered with one that isn't there now (gone
 * since, another device) is listed as unanswered.
 */
export function planMigration(read: Extract<AppRead, { status: 'ready' }>, answers: MigrationAnswers, state: MigrationState): MigrationPlan {
  const blocks: string[] = [];
  // The split room is shared by every account: one past it comes in as its
  // lines (whole, in a linked account), in the order the file has them.
  const room = { splits: Math.max(0, MAX_SPLITS - state.counts.splits) };
  const txns = read.parsed.txns;
  const accounts = sourceAccounts(txns, answers.accounts);
  if (accounts.length > MAX_SOURCE_ACCOUNTS) blocks.push(`This file holds ${accounts.length} accounts, more than one import takes (${MAX_SOURCE_ACCOUNTS}). Export some of them at a time.`);

  // Each account's answer, as it can be applied now.
  const chosen = new Map<string, Exclude<AccountChoice, { to: 'skip' }>>();
  let unanswered = 0;
  for (const a of accounts) {
    const c = a.choice;
    if (!c) {
      unanswered++;
      continue;
    }
    if (c.to === 'skip') continue;
    if (c.to === 'manual' && !state.manual.has(c.id)) {
      a.choice = null;
      unanswered++;
      continue;
    }
    if (c.to === 'linked' && !state.linked.has(c.id)) {
      a.choice = null;
      unanswered++;
      continue;
    }
    if (c.to === 'linked' && !state.contexts.has(c.id)) {
      // Kept as the answer, so the review shows it, and refused with why.
      blocks.push(state.unavailable.get(c.id) ?? `${state.linked.get(c.id)!.name} can’t be read just now. Try again later.`);
      continue;
    }
    if (c.to === 'new') {
      const problem = newAccountProblem(c);
      if (problem) blocks.push(`${a.name}: ${problem}`);
    }
    chosen.set(a.key, c);
  }
  const newAccounts = [...chosen.values()].filter((c) => c.to === 'new').length;
  const accountRoom = Math.max(0, MAX_MANUAL_ACCOUNTS - state.counts.manual);
  if (newAccounts > accountRoom) blocks.push(`This import would make ${newAccounts} manual accounts, and you have room for ${accountRoom} more (Nya keeps at most ${MAX_MANUAL_ACCOUNTS}). Send some of the file’s accounts to accounts you have.`);

  // Each Nya account, by the file's accounts that go into it.
  const byTarget = new Map<string, { choice: Exclude<AccountChoice, { to: 'skip' }>; sources: string[] }>();
  for (const [source, choice] of chosen) {
    const key = targetKey(choice, source);
    const t = byTarget.get(key) ?? { choice, sources: [] };
    t.sources.push(source);
    byTarget.set(key, t);
  }

  // What each brings, before anything is mapped: its transactions, a split
  // with its parts where Nya can hold them; in a linked account, nothing its
  // bank's own rows and balance already are, and a split as one row where
  // the bank has it so.
  const ix = indexTaxonomy(state.taxonomy);
  const transfersFiled = !!categoryForKey(ix, TEXT, 'transfer out') && !!categoryForKey(ix, TEXT, 'transfer in');
  type Built = {
    key: string;
    choice: Exclude<AccountChoice, { to: 'skip' }>;
    from: string[];
    currency: string;
    entries: Entry[];
    exploded: Map<string, number[]>;
    whole: Map<string, number[]>;
    left_out: TargetPlan['left_out'];
    combined: TargetPlan['combined'];
  };
  const built: Built[] = [];
  for (const [key, { choice, sources: from }] of byTarget) {
    const manualAccount = choice.to === 'manual' ? state.manual.get(choice.id)! : null;
    const linkedAccount = choice.to === 'linked' ? state.linked.get(choice.id)! : null;
    // Rows that don't say their currency are in the one the person chose,
    // else the account's: a linked account's bank's, a manual account's, or
    // for a new one, the one its rows say (Lunch Money's), else dollars.
    const sourceCurrency = choice.to === 'new' ? (accounts.find((a) => a.key === from[0])?.currencies[0] ?? null) : null;
    const currency = (answers.currency ?? linkedAccount?.currency ?? manualAccount?.currency ?? sourceCurrency ?? DEFAULT_CURRENCY).toUpperCase();
    const currencyOf = (t: AppTxn) => (t.currency ?? currency).toUpperCase();
    const canHold = (t: AppTxn) => holdable(t, currencyOf(t), transfersFiled);
    const isLinked = choice.to === 'linked';
    const sources = new Set(from);
    const b: Built = {
      key,
      choice,
      from,
      currency,
      entries: [],
      exploded: new Map(),
      whole: new Map(),
      left_out: { opening: [], groups: [], lines: [] },
      combined: { transactions: 0, lines: [] },
    };
    const note = (by: Map<string, number[]>, reason: string, lines: readonly number[]) => by.set(reason, [...(by.get(reason) ?? []), ...lines]);
    const splitLines = new Map<string, AppTxn[]>();
    const context = isLinked ? state.contexts.get(choice.id)! : null;
    // Where a linked account's own transactions already reach: its bank's,
    // from its first row on, and the periods files imported into it cover.
    // There, what the bank or an earlier file has, as one row or as several,
    // would count twice beside what the app writes otherwise; before, nothing
    // has it, and a row comes in as a manual account takes it.
    const periods = context ? [...context.summaries.values()].map((s) => s.covers) : [];
    const reached = (day: string) => !!context && ((context.bank_from !== null && day >= context.bank_from) || periods.some((p) => p.from <= day && day <= p.to));
    for (const t of txns) {
      if (!sources.has(accountKey(t))) continue;
      if (isLinked) {
        // The app's opening balance or balance adjustment: the account's
        // balance is its bank's, and nothing its bank moved.
        if (t.starting) {
          b.left_out.opening.push(...t.lines);
          continue;
        }
        // Lunch Money's group: the net of transactions the bank has one by one.
        if (t.grouped && reached(t.date)) {
          b.left_out.groups.push(...t.lines);
          continue;
        }
        // A split's line: the bank may have its transaction as one row.
        if (t.split_of) {
          splitLines.set(t.split_of.key, [...(splitLines.get(t.split_of.key) ?? []), t]);
          continue;
        }
      }
      if (!t.parts) {
        b.entries.push({ txn: t, split: false });
        continue;
      }
      const why = room.splits > 0 ? canHold(t) : WHY.room;
      if (why === null) {
        room.splits--;
        b.entries.push({ txn: t, split: true });
      } else if (isLinked && reached(t.date)) {
        note(b.whole, why, t.lines);
        b.entries.push({ txn: withoutParts(t), split: false });
      } else {
        note(b.exploded, why, t.parts.map((p) => p.line));
        for (const e of explode(t)) b.entries.push({ txn: e, split: false });
      }
    }
    if (context) {
      // Each split's lines where the bank or an earlier file reaches: the
      // whole the file gives, as they have it, or left out when the file
      // doesn't hold it (a line is missing); before, its lines as they are.
      const keptWhy = new Map<number, string>();
      for (const k of read.parsed.splits.kept) for (const line of k.lines) keptWhy.set(line, k.reason);
      for (const lines of splitLines.values()) {
        const whole = lines[0].split_of!.whole;
        const day = whole?.date ?? lines.reduce((d, l) => (l.date < d ? l.date : d), lines[0].date);
        if (!reached(day)) {
          for (const l of lines) b.entries.push({ txn: l, split: false });
          continue;
        }
        if (!whole) {
          b.left_out.lines.push(...lines.flatMap((l) => l.lines));
          continue;
        }
        note(b.whole, keptWhy.get(lines[0].line) ?? WHY.together, lines.flatMap((l) => l.lines));
        b.entries.push({ txn: wholeTxn(whole, lines), split: false });
      }
      b.entries.sort((x, y) => x.txn.line - y.txn.line);
      // What the account already has, as its import's own plan counts it,
      // and the bank's pending rows: what a row will be once they post.
      const known: Matchable[] = [...knownOf(context.held, context.banks, context.order, context.bank_from, importsOf(context), context.twins), ...context.banks.filter((r) => r.pending)];
      const c = combineUnmarked(b.entries, known, currencyOf, canHold, room);
      b.entries = c.entries;
      b.combined = { transactions: c.transactions, lines: c.lines };
    }
    built.push(b);
  }

  // Categories, from what goes in.
  const going = built.flatMap((b) => b.entries.map((e) => e.txn));
  const sources = sourceCategories(going);
  let categories: CategoryPlan;
  if (sources.length > MAX_SOURCE_CATEGORIES) {
    categories = { mappings: [], groups: [], added: 0, room: Math.max(0, MAX_CATEGORIES - state.taxonomy.categories.length), problem: null };
    blocks.push(`This file has ${sources.length.toLocaleString('en-US')} of the app’s categories, more than one import maps (${MAX_SOURCE_CATEGORIES.toLocaleString('en-US')}). Export fewer accounts or a shorter period at a time.`);
  } else {
    categories = mapCategories(sources, state.taxonomy, answers.categories);
  }
  if (categories.problem) blocks.push(categories.problem);
  const texts = new Map(categories.mappings.map((m) => [m.key, m.target.text]));

  // Tags: by name, the person's where they have one.
  const tagRows = new Map<string, { name: string; rows: number }>();
  if (answers.tags) {
    for (const t of going) {
      for (const raw of t.tags) {
        const name = tagName(raw);
        if (!name) continue;
        const key = name.toLowerCase();
        const found = tagRows.get(key);
        if (found) found.rows++;
        else tagRows.set(key, { name, rows: 1 });
      }
    }
  }
  if (state.tagsUnreadable && tagRows.size > 0) blocks.push('Your tags can’t be read just now, so the file’s tags can’t be matched to yours. Import without tags, or try again later.');
  const tagNames = [...tagRows.values()].map((t) => ({ ...t, existing: !!tagByName(state.tags, t.name) }));
  const tagsAdded = tagNames.filter((t) => !t.existing).length;
  const tagRoom = Math.max(0, MAX_TAGS - (state.tags?.tags.length ?? 0));
  if (tagsAdded > tagRoom) blocks.push(`This file has ${tagsAdded} tags you don’t have, and you have room for ${tagRoom} more (Nya keeps at most ${MAX_TAGS}). Delete some tags first, or import without tags.`);

  // Each Nya account's rows, read and planned as its own import plans them.
  const unattributed = read.parsed.problems.filter((p) => p.account === null || !accounts.some((a) => a.key === p.account));
  const targets: TargetPlan[] = [];
  for (const b of built) {
    const { key, choice, from, currency, entries } = b;
    const manualAccount = choice.to === 'manual' ? state.manual.get(choice.id)! : null;
    const linkedAccount = choice.to === 'linked' ? state.linked.get(choice.id)! : null;
    const sources = new Set(from);
    const tagsOf = new Map<number, string[]>();
    const partsOf = new Map<number, { amount: number; text: string; note: string | null }[]>();
    let tags_cut = 0;
    const partsWith = (t: AppTxn) => t.parts!.map((p) => ({ amount: p.amount, text: textFor(p, false, texts) ?? '', note: p.note }));
    const records: RawRecord[] = entries.map(({ txn: t, split }) => {
      const parts = split ? partsWith(t) : null;
      return {
        source: 'csv',
        date: t.date,
        amount: t.amount,
        description: t.payee,
        raw: t.raw,
        ...(t.currency ? { currency: t.currency } : {}),
        // A split's own category: the one its parts share, else none (it
        // shows as its parts while split).
        category: parts ? (parts.every((p) => p.text === parts[0].text) ? parts[0].text : null) : textFor(t, t.starting, texts),
        note: t.note,
        line: t.line,
      };
    });
    const normalized = normalizeRecords(records, { today: state.today, currency });
    const rows = normalized.rows;
    const rowTxns = rows.map((r) => entries[r.index].txn);
    rows.forEach((r, i) => {
      const { txn, split } = entries[r.index];
      if (split) partsOf.set(i, partsWith(txn));
      if (answers.tags && txn.tags.length > 0) {
        const names = [...new Set(txn.tags.map(tagName).filter((n) => !!n))];
        if (names.length > MAX_TAGS_PER_TRANSACTION) tags_cut++;
        tagsOf.set(i, names.slice(0, MAX_TAGS_PER_TRANSACTION));
      }
    });
    // Its lines that couldn't be read, and the file's whose account couldn't
    // be told: they may be this account's, so its period isn't taken as
    // whole while they stand (the walk, lib/history-import/extend.ts). The
    // review lists those once, for the file.
    const ownProblems: Problem[] = [...read.parsed.problems.filter((p) => p.account !== null && sources.has(p.account)), ...normalized.problems].map(({ line, reason, raw }) => ({ line, reason, raw }));
    const problems: Problem[] = [...ownProblems, ...unattributed.map(({ line, reason, raw }) => ({ line, reason, raw }))];
    const name = linkedAccount?.name ?? manualAccount?.name ?? (choice.to === 'new' ? choice.name.trim() : key);
    if (rows.length > MAX_IMPORT_ROWS) {
      blocks.push(`${name} would take ${rows.length.toLocaleString('en-US')} transactions from this file, more than one account’s import takes (${MAX_IMPORT_ROWS.toLocaleString('en-US')}). Export a shorter period and import it in parts.`);
    }
    // A linked account's rows in another currency than its bank's could
    // never be found as the bank's own: each would count beside them.
    if (linkedAccount?.currency) {
      const off = new Map<string, number>();
      for (const { row } of rows) if (row.currency !== linkedAccount.currency) off.set(row.currency, (off.get(row.currency) ?? 0) + 1);
      if (off.size > 0) {
        const n = [...off.values()].reduce((x, y) => x + y, 0);
        blocks.push(
          `${linkedAccount.institution_name} keeps ${linkedAccount.name} in ${linkedAccount.currency}, and ${n === 1 ? 'one of this file’s rows for it is' : `${n.toLocaleString('en-US')} of this file’s rows for it are`} in ${[...off.keys()].join(' and ')}: ${n === 1 ? 'it' : 'they'} could never be found as its bank’s own, so ${n === 1 ? 'it' : 'each'} would count beside them. ${answers.currency && answers.currency !== linkedAccount.currency ? `Read the file in ${linkedAccount.currency}, or send` : 'Send'} ${from.length === 1 ? from[0] || 'this file’s account' : 'these accounts'} somewhere else.`
        );
      }
    }
    // A new account is in the currency most of its rows are in.
    const byCurrency = new Map<string, number>();
    for (const { row } of rows) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + 1);
    const accountCurrency = choice.to === 'new' ? ([...byCurrency].sort((x, y) => y[1] - x[1])[0]?.[0] ?? currency) : currency;
    let manual: ImportPlan | null = null;
    let linked: HistoryPlan | null = null;
    let covers: Covers | null = null;
    const chosenAnswers = choice.to === 'linked' ? byIndex(own(answers.choices, key), rows) : {};
    let ended: TargetPlan['ended'] = null;
    const carryTo = new Map<number, CarryTo>();
    const moves = new Set<number>();
    const ontoPending = new Set<number>();
    const carried: CarryCounts = { bank: 0, approved: 0, notes: 0, earlier: 0 };
    if (choice.to === 'linked') {
      const context = state.contexts.get(choice.id)!;
      let first: string | null = null;
      let last: string | null = null;
      for (const { row } of rows) {
        if (first === null || row.date < first) first = row.date;
        if (last === null || row.date > last) last = row.date;
      }
      covers = coveredPeriod(null, first, last, state.today);
      const imports = importsOf(context);
      linked = planHistoryImport({
        rows,
        problems,
        held: context.held,
        banks: context.banks,
        order: context.order,
        bankFrom: context.bank_from,
        twins: context.twins,
        covers,
        imports,
        choices: chosenAnswers,
      });
      // Where what the app said of each row the account already has would
      // go (see the header): onto the bank's row it is, or the one the
      // earlier file's row it is leads to; else nowhere. With nothing read
      // of the account's approvals (lib/migration/targets.ts reads them
      // with its context), every bank row counts as approved.
      const reach = state.reach.get(choice.id);
      const approvedAt = (bankId: string) => !reach || reach.approved.has(bankId);
      for (const [i, pair] of linked.pairs) {
        const bank = pair.twin.kind === 'bank' ? pair.twin.id : reach?.leads.get(pair.twin.id);
        carryTo.set(i, bank === undefined ? 'earlier' : approvedAt(bank) ? 'approved' : 'bank');
      }
      // The rows it adds that only a pending row of the bank looks like (the
      // history plan's pending_alike), each with the one that stands in for
      // it, as settle pairs them (the closest, one to one, never across an
      // edge): that row takes its place once it posts (see the header).
      const pendings = context.banks.filter((b) => b.pending).map((b) => ({ ...b, pending: false }));
      if (pendings.length > 0) {
        const history = linked;
        const lone = rows.flatMap((r, i) => (history.actions[i] === 'add' && !history.pairs.has(i) ? [{ index: i, date: r.row.date, amount: r.row.amount, currency: r.row.currency, name: r.row.name }] : []));
        for (const [i, pair] of pairUp(lone, pendings, (row, b) => crossesEdge(row.date, b.date, context.bank_from, covers))) {
          carryTo.set(i, approvedAt(pair.twin.transaction_id) ? 'approved' : 'bank');
          ontoPending.add(i);
        }
      }
      // What each would give its bank's row there, and how many would, of
      // those that are its bank's as answered.
      for (const [i, to] of carryTo) {
        const notes = (tagsOf.get(i)?.length ?? 0) > 0 || !!rows[i].row.note;
        const refiles = !!rows[i].row.category || partsOf.has(i);
        if (to === 'bank' ? notes || refiles : to === 'approved' && notes) moves.add(i);
        if (linked.actions[i] !== 'duplicate' && !ontoPending.has(i)) continue;
        if (to === 'earlier') carried.earlier++;
        else if (to === 'approved') {
          carried.approved++;
          if (moves.has(i)) carried.notes++;
        } else if (moves.has(i)) carried.bank++;
      }
      // One only a pending row looks like comes in at its total, its parts
      // left out, unless they go onto that row.
      for (const i of ontoPending) if (!answers.carry || carryTo.get(i) !== 'bank') partsOf.delete(i);
      // An account that ended counts nothing dated from its end: said, as
      // its own import says it (app/api/history-import).
      const end = state.ends?.get(choice.id);
      if (end) ended = { state: end.state, day: end.day, rows: rows.filter((r, i) => r.row.date >= end.day && linked!.actions[i] !== 'none').length };
    } else {
      manual = planImport(rows, problems, choice.to === 'manual' ? (state.books.get(choice.id) ?? null) : null);
    }
    targets.push({
      key,
      kind: choice.to === 'linked' ? 'linked' : 'manual',
      account_id: manualAccount?.account_id ?? linkedAccount?.account_id ?? null,
      name,
      create:
        choice.to === 'new'
          ? {
              name: choice.name.trim().slice(0, 60),
              institution_name: choice.institution.replace(/\s+/g, ' ').trim().slice(0, 60),
              type: choice.type,
              subtype: null,
              balance: toMinorUnits(choice.balance, accountCurrency),
              ...(accountCurrency !== 'USD' ? { currency: accountCurrency } : {}),
            }
          : null,
      sources: from,
      currency: accountCurrency,
      rows,
      txns: rowTxns,
      problems,
      own_problems: ownProblems,
      manual,
      linked,
      choices: chosenAnswers,
      covers,
      tags: tagsOf,
      parts: partsOf,
      carry_to: carryTo,
      moves,
      onto_pending: ontoPending,
      carried,
      exploded: [...b.exploded].map(([reason, lines]) => ({ reason, lines })),
      whole: [...b.whole].map(([reason, lines]) => ({ reason, lines })),
      left_out: b.left_out,
      combined: b.combined,
      ended,
      tags_cut,
    });
  }

  // What the rows that go in could need said beside them, whatever the
  // answers to a linked account's proposals turn out to be: a row with a
  // proposal may come in as its own or stand for its twin.
  let annotations = 0;
  let splits = 0;
  let proposals = 0;
  for (const t of targets) {
    proposals += t.linked ? t.linked.counts.unanswered + t.linked.counts.conflicts : 0;
    const proposed = new Set(t.linked?.proposals.map((p) => p.index) ?? []);
    t.rows.forEach((r, i) => {
      const action = t.manual ? t.manual.actions[i] : t.linked!.actions[i];
      const asked = proposed.has(r.index) || action === 'ask';
      // One a pending row of the bank will take the place of is as one its
      // bank has.
      const onto = t.onto_pending.has(i);
      const mayAdd = (action === 'add' && !onto) || asked;
      const mayStand = action === 'duplicate' || asked || onto;
      if (!mayAdd && !mayStand) return;
      // Standing for its twin, it carries what will show there (carry_to).
      const to = t.carry_to.get(i);
      const carries = mayStand && answers.carry && to !== undefined && to !== 'earlier';
      if (((t.tags.get(i)?.length ?? 0) > 0 && (mayAdd || carries)) || (carries && t.txns[i].note)) annotations++;
      if (t.parts.has(i) && (mayAdd || (carries && to === 'bank'))) splits++;
    });
  }
  const annotationRoom = Math.max(0, MAX_ANNOTATIONS - state.counts.annotations);
  if (annotations > annotationRoom) {
    blocks.push(`This import would tag or note ${annotations.toLocaleString('en-US')} transactions, and you have room for ${annotationRoom.toLocaleString('en-US')} more (Nya keeps what is said about at most ${MAX_ANNOTATIONS.toLocaleString('en-US')}). Import without tags, or clear some first.`);
  }

  // What goes in, by kind: what the review says of transfers, opening
  // balances and rows with no category.
  let uncategorized = 0;
  let transfers = 0;
  let opening = 0;
  for (const t of targets) {
    for (const x of t.txns) {
      if (x.starting) opening++;
      else if (x.transfer !== null) transfers++;
      else if (!x.parts && !x.category) uncategorized++;
    }
  }

  const plan: Omit<MigrationPlan, 'digest'> = {
    read,
    accounts,
    categories,
    sources,
    targets,
    tags: { on: answers.tags, names: tagNames, added: tagsAdded, room: tagRoom },
    problems: unattributed,
    blocks,
    waiting: { accounts: unanswered, proposals },
    needs: { annotations, splits, accounts: newAccounts },
    room: { annotations: annotationRoom, splits: Math.max(0, MAX_SPLITS - state.counts.splits), accounts: accountRoom },
    counts: { uncategorized, transfers, opening },
  };
  return { ...plan, digest: planDigest(plan, answers) };
}

/**
 * The fingerprint of a plan: the app and how its file was read, where each
 * of its accounts goes, where each category goes, the tags, and each
 * account's rows as read (day, amount, currency, payee, category, note, tags,
 * a split's parts) with what becomes of each: a manual account's outcome, a
 * linked account's whole review (lib/history-import/plan.ts review), which is
 * what the person answers and never those answers, so answering a proposal
 * keeps the review (the history import's own is the same); which rows a
 * pending row of the bank will take the place of (onto_pending, which no
 * review of the bank's posted rows says); and while its rows carry what the
 * app said of them, where that goes (carry_to), so an approval made in the
 * review queue since is reviewed. Equal fingerprints are the same import:
 * the commit refuses one whose plan, worked out again, has another.
 */
export function planDigest(plan: Omit<MigrationPlan, 'digest'>, answers: MigrationAnswers): string {
  const h = createHash('sha256');
  const r = plan.read;
  h.update(JSON.stringify([r.app, r.parsed.variant, r.read, answers.currency, answers.tags, answers.carry, plan.blocks]));
  h.update(JSON.stringify(plan.accounts.map((a) => [a.key, a.rows, a.choice])));
  h.update(JSON.stringify(plan.categories.mappings.map((m) => [m.key, m.target])));
  h.update(JSON.stringify(plan.tags.names));
  for (const t of plan.targets) {
    h.update(`\n${t.key}|${t.currency}|${t.covers ? `${t.covers.from}..${t.covers.to}` : '-'}|${t.linked ? t.linked.review : ''}\n`);
    t.rows.forEach((n, i) => {
      // A manual account's outcome; for a linked account's row, whether a
      // pending row of the bank will take its place (one there since is
      // reviewed), and where what it would carry goes, while it carries (an
      // approval made since is reviewed).
      const action = t.manual
        ? `=${t.manual.actions[i]}:${JSON.stringify(t.manual.outcomes[i])}`
        : `${t.onto_pending.has(i) ? '~p' : ''}${answers.carry && t.carry_to.has(i) ? `>${t.carry_to.get(i)}` : ''}`;
      const row = n.row;
      h.update(
        `${n.index}[${row.date}|${Math.round(row.amount * 1000)}|${row.currency}|${normalizeDescription(row.name)}|${row.category ?? ''}|${row.note ?? ''}|${(t.tags.get(i) ?? []).join(',')}|${JSON.stringify(t.parts.get(i) ?? null)}]${action}\n`
      );
    });
    h.update(JSON.stringify(t.problems.map((p) => [p.line, p.reason])));
  }
  return h.digest('hex').slice(0, 32);
}

/** The app's name, for the import's records. */
export const appName = (plan: Pick<MigrationPlan, 'read'>) => APP_NAMES[plan.read.app];
