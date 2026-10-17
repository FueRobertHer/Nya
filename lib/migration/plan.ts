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
// comes over for the years the bank also reaches.
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
import { explode, WHY } from '../import/apps/splits';
import type { AppRead } from '../import/apps/read';
import type { AppPart, AppTxn } from '../import/apps/types';
import type { AppProblem } from '../import/apps/common';
import { APP_NAMES } from '../import/apps/types';
import { planHistoryImport, type HistoryChoices, type HistoryPlan, type Period } from '../history-import/plan';
import { coveredPeriod } from '../history-import/commit';
import type { Covers } from '../history-import/store';
import type { AccountContext, LinkedAccount } from '../history-import/read';
import type { ManualTxnBook } from '../manual-txns';
import { MANUAL_TYPES, MAX_BALANCE, type ManualAccount, type ManualType } from '../manual';
import { isOwedType } from '../balance';
import { checkParts, MAX_SPLITS, SplitError } from '../splits';
import { MAX_ANNOTATIONS } from '../txn-annotations';
import { cleanTagName, MAX_TAGS, MAX_TAGS_PER_TRANSACTION, TAG_NAME_MAX, tagByName, type TagSet } from '../tags';
import type { Taxonomy } from '../categories';
import { DEFAULT_CURRENCY, toMinorUnits } from '../manual-txn-input';
import { mapCategories, OPENING, sourceKey, type CategoryChoice, type CategoryPlan, type SourceCategory } from './categories';

/** Manual accounts one person may have (app/api/manual-accounts). */
export const MAX_MANUAL_ACCOUNTS = 50;
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
  problems: Problem[];
  manual: ImportPlan | null;
  linked: HistoryPlan | null;
  /** A linked account's answers, by each row's place (byIndex). */
  choices: HistoryChoices;
  covers: Covers | null;
  /** By row: the tags it carries (names), a split's parts, and for a linked
   *  account's row the bank already has, the category and note to say on it. */
  tags: Map<number, string[]>;
  parts: Map<number, { amount: number; text: string; note: string | null }[]>;
  /** Splits that came in as their lines here, with why. */
  exploded: { reason: string; lines: number[] }[];
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
      a = { key, name: key || 'This file’s account', rows: 0, first: null, last: null, currencies: [], net: 0, transfers: 0, opening: 0, splits: 0, uncategorized: 0, choice: answers[key] ?? null, byCurrency: new Map() };
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

/** A split's parts in the account's currency, or why it can't be held: the
 *  rule a split made in the app meets (lib/splits.ts checkParts). */
function partsFor(t: AppTxn, currency: string, texts: ReadonlyMap<string, string>): { amount: number; text: string; note: string | null }[] | { reason: string } {
  const parts = t.parts!.map((p: AppPart) => ({ amount: p.amount, text: textFor(p, false, texts), note: p.note }));
  // A part with no category can't be one in Nya: it would need the
  // uncategorized category's id, which a migration doesn't choose for it.
  if (parts.some((p) => p.text === null)) return { reason: 'A line of it has no category, and every part of a split in Nya has one.' };
  try {
    checkParts(
      parts.map((p) => ({ amount: p.amount, category_id: 'migration-part', ...(p.note ? { note: p.note } : {}) })),
      { amount: t.amount, currency, pending: false }
    );
  } catch (err) {
    if (err instanceof SplitError) return { reason: WHY.rules };
    throw err;
  }
  return parts.map((p) => ({ amount: p.amount, text: p.text!, note: p.note }));
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

/**
 * The plan (see the header). `state` holds what the route read for the
 * accounts chosen; an account answered with one that isn't there now (gone
 * since, another device) is listed as unanswered.
 */
export function planMigration(read: Extract<AppRead, { status: 'ready' }>, answers: MigrationAnswers, state: MigrationState): MigrationPlan {
  const blocks: string[] = [];
  // The split room is shared by every account: one past it comes in as its
  // lines, in the order the file has them.
  let splitRoom = Math.max(0, MAX_SPLITS - state.counts.splits);
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

  // Categories, from the rows that go somewhere.
  const going = txns.filter((t) => chosen.has(accountKey(t)));
  const sources = sourceCategories(going);
  const categories = mapCategories(sources, state.taxonomy, answers.categories);
  if (categories.problem) blocks.push(categories.problem);
  const texts = new Map(categories.mappings.map((m) => [m.key, m.target.text]));

  // Tags: by name, the person's where they have one.
  const tagRows = new Map<string, { name: string; rows: number }>();
  if (answers.tags) {
    for (const t of going) {
      for (const raw of t.tags) {
        const name = cleanTagName(raw).slice(0, TAG_NAME_MAX).trimEnd();
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

  // Each Nya account's rows, by the file's accounts that go into it.
  const byTarget = new Map<string, { choice: Exclude<AccountChoice, { to: 'skip' }>; sources: string[] }>();
  for (const [source, choice] of chosen) {
    const key = targetKey(choice, source);
    const t = byTarget.get(key) ?? { choice, sources: [] };
    t.sources.push(source);
    byTarget.set(key, t);
  }
  const unattributed = read.parsed.problems.filter((p) => p.account === null || !accounts.some((a) => a.key === p.account));
  const targets: TargetPlan[] = [];
  for (const [key, { choice, sources: from }] of byTarget) {
    const manualAccount = choice.to === 'manual' ? state.manual.get(choice.id)! : null;
    const linkedAccount = choice.to === 'linked' ? state.linked.get(choice.id)! : null;
    const currency = (answers.currency ?? manualAccount?.currency ?? linkedAccount?.currency ?? DEFAULT_CURRENCY).toUpperCase();
    const own = new Set(from);
    const exploded = new Map<string, number[]>();
    const tagsOf = new Map<number, string[]>();
    const partsOf = new Map<number, { amount: number; text: string; note: string | null }[]>();
    let tags_cut = 0;
    // The transactions, a split that can't be held as its lines.
    const list: { txn: AppTxn; parts: { amount: number; text: string; note: string | null }[] | null }[] = [];
    for (const t of txns) {
      if (!own.has(accountKey(t))) continue;
      if (!t.parts) {
        list.push({ txn: t, parts: null });
        continue;
      }
      const parts = splitRoom > 0 ? partsFor(t, (t.currency ?? currency).toUpperCase(), texts) : { reason: WHY.room };
      if ('reason' in parts) {
        exploded.set(parts.reason, [...(exploded.get(parts.reason) ?? []), ...t.parts.map((p) => p.line)]);
        for (const e of explode(t)) list.push({ txn: e, parts: null });
      } else {
        splitRoom--;
        list.push({ txn: t, parts });
      }
    }
    const records: RawRecord[] = list.map(({ txn: t, parts }) => ({
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
    }));
    const normalized = normalizeRecords(records, { today: state.today, currency });
    const rows = normalized.rows;
    const rowTxns = rows.map((r) => list[r.index].txn);
    rows.forEach((r, i) => {
      const { txn, parts } = list[r.index];
      if (parts) partsOf.set(i, parts);
      if (answers.tags && txn.tags.length > 0) {
        const names = [...new Set(txn.tags.map((n) => cleanTagName(n).slice(0, TAG_NAME_MAX).trimEnd()).filter((n) => !!n))];
        if (names.length > MAX_TAGS_PER_TRANSACTION) tags_cut++;
        tagsOf.set(i, names.slice(0, MAX_TAGS_PER_TRANSACTION));
      }
    });
    // Its lines that couldn't be read, and the file's whose account couldn't
    // be told (they may be this account's).
    const problems: Problem[] = [
      ...read.parsed.problems.filter((p) => p.account !== null && own.has(p.account)),
      ...unattributed,
      ...normalized.problems,
    ].map(({ line, reason, raw }) => ({ line, reason, raw }));
    if (rows.length > MAX_IMPORT_ROWS) {
      blocks.push(`${linkedAccount?.name ?? manualAccount?.name ?? (choice.to === 'new' ? choice.name : key)} would take ${rows.length.toLocaleString('en-US')} transactions from this file, more than one account’s import takes (${MAX_IMPORT_ROWS.toLocaleString('en-US')}). Export a shorter period and import it in parts.`);
    }
    let manual: ImportPlan | null = null;
    let linked: HistoryPlan | null = null;
    let covers: Covers | null = null;
    const chosenAnswers = choice.to === 'linked' ? byIndex(answers.choices[key], rows) : {};
    if (choice.to === 'linked') {
      const context = state.contexts.get(choice.id)!;
      let first: string | null = null;
      let last: string | null = null;
      for (const { row } of rows) {
        if (first === null || row.date < first) first = row.date;
        if (last === null || row.date > last) last = row.date;
      }
      covers = coveredPeriod(null, first, last, state.today);
      const imports = new Map<string, { covers: Period | null }>([...context.summaries].map(([id, s]) => [id, { covers: { from: s.covers.from, to: s.covers.to } }]));
      linked = planHistoryImport({
        rows,
        problems,
        held: context.held,
        banks: context.banks,
        order: context.order,
        bankFrom: context.bank_from,
        covers,
        imports,
        choices: chosenAnswers,
      });
    } else {
      manual = planImport(rows, problems, choice.to === 'manual' ? (state.books.get(choice.id) ?? null) : null);
    }
    targets.push({
      key,
      kind: choice.to === 'linked' ? 'linked' : 'manual',
      account_id: manualAccount?.account_id ?? linkedAccount?.account_id ?? null,
      name: manualAccount?.name ?? linkedAccount?.name ?? (choice.to === 'new' ? choice.name.trim() : key),
      create:
        choice.to === 'new'
          ? {
              name: choice.name.trim().slice(0, 60),
              institution_name: choice.institution.replace(/\s+/g, ' ').trim().slice(0, 60),
              type: choice.type,
              subtype: null,
              balance: toMinorUnits(choice.balance, currency),
              ...(currency !== 'USD' ? { currency } : {}),
            }
          : null,
      sources: from,
      currency,
      rows,
      txns: rowTxns,
      problems,
      manual,
      linked,
      choices: chosenAnswers,
      covers,
      tags: tagsOf,
      parts: partsOf,
      exploded: [...exploded].map(([reason, lines]) => ({ reason, lines })),
      tags_cut,
    });
  }

  // What the rows that go in would need said beside them.
  let annotations = 0;
  let splits = 0;
  let proposals = 0;
  for (const t of targets) {
    proposals += t.linked ? t.linked.counts.unanswered + t.linked.counts.conflicts : 0;
    t.rows.forEach((_, i) => {
      const action = t.manual ? t.manual.actions[i] : t.linked!.actions[i];
      if (action !== 'add' && action !== 'duplicate') return;
      const duplicate = action === 'duplicate';
      if ((t.tags.get(i)?.length ?? 0) > 0 || (duplicate && t.txns[i].note)) annotations++;
      if (t.parts.has(i)) splits++;
    });
  }
  const annotationRoom = Math.max(0, MAX_ANNOTATIONS - state.counts.annotations);
  if (annotations > annotationRoom) {
    blocks.push(`This import would tag or note ${annotations.toLocaleString('en-US')} transactions, and you have room for ${annotationRoom.toLocaleString('en-US')} more (Nya keeps what is said about at most ${MAX_ANNOTATIONS.toLocaleString('en-US')}). Import without tags, or clear some first.`);
  }

  let uncategorized = 0;
  let transfers = 0;
  let opening = 0;
  for (const t of going) {
    if (t.starting) opening++;
    else if (t.transfer !== null) transfers++;
    else if (!t.parts && !t.category) uncategorized++;
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
 * a split's parts) with what becomes of each (a linked account's whole review,
 * lib/history-import/plan.ts review). Equal fingerprints are the same import:
 * the commit refuses one whose plan, worked out again, has another.
 */
export function planDigest(plan: Omit<MigrationPlan, 'digest'>, answers: MigrationAnswers): string {
  const h = createHash('sha256');
  const r = plan.read;
  h.update(JSON.stringify([r.app, r.parsed.variant, r.read, answers.currency, answers.tags, plan.blocks]));
  h.update(JSON.stringify(plan.accounts.map((a) => [a.key, a.rows, a.choice])));
  h.update(JSON.stringify(plan.categories.mappings.map((m) => [m.key, m.target])));
  h.update(JSON.stringify(plan.tags.names));
  for (const t of plan.targets) {
    h.update(`\n${t.key}|${t.currency}|${t.covers ? `${t.covers.from}..${t.covers.to}` : '-'}|${t.linked ? t.linked.review : ''}\n`);
    t.rows.forEach((n, i) => {
      const action = t.manual ? `${t.manual.actions[i]}:${JSON.stringify(t.manual.outcomes[i])}` : t.linked!.actions[i];
      const row = n.row;
      h.update(
        `${n.index}[${row.date}|${Math.round(row.amount * 1000)}|${row.currency}|${normalizeDescription(row.name)}|${row.category ?? ''}|${row.note ?? ''}|${(t.tags.get(i) ?? []).join(',')}|${JSON.stringify(t.parts.get(i) ?? null)}]=${action}\n`
      );
    });
    h.update(JSON.stringify(t.problems.map((p) => [p.line, p.reason])));
  }
  return h.digest('hex').slice(0, 32);
}

/** The app's name, for the import's records. */
export const appName = (plan: Pick<MigrationPlan, 'read'>) => APP_NAMES[plan.read.app];
