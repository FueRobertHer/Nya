// lib/history-import/plan.ts
//
// What importing a file into a LINKED account would do (#52), worked out
// before anything is stored: the review the person sees, and the commit
// applies (lib/history-import/commit.ts). Pure, no storage.
//
// Each row of the file, in this order:
//   1. Already imported: the same transaction as a row an earlier import kept
//      for this account (lib/import/match.ts: by FITID exactly, then by the
//      content key), so re-importing a period adds nothing. A row whose FITID
//      an earlier import has on another transaction is a conflict the person
//      decides (import it as new, or skip it), with a suggestion only when
//      nothing but the id is alike, as for a manual account.
//   2. Repeated within the file: counted once.
//   3. Likely already there: the same amount as a transaction the account
//      already has, dated within a few days (lib/history-import/match.ts), a
//      PROPOSAL with a confidence and that transaction beside it. What the
//      account already has is every transaction it counts, each once: the
//      bank's posted rows (one an earlier import kept a duplicate of, or that
//      now stands for an earlier import's row, among them), and the rows
//      earlier imports kept that count (a file of the same period in another
//      format: a bank's CSV and its OFX describe one transaction differently,
//      so only this finds the two). The person chooses: the same transaction
//      (kept as a duplicate naming it, never counted while it is there), or a
//      transaction of its own (kept and counted). High and medium confidence
//      start as "the same"; a low one has no answer until the person gives it,
//      and the import waits for it. A pair across the edge of either side's
//      coverage (the file's row before the bank's earliest row, the other row
//      outside the period the file covers) is one only through a posting lag:
//      it is low, and says why, and for a file dated by posting, as OFX is,
//      never made.
//   4. New: nothing like it, imported and counted. Dated before the bank's
//      own rows begin, it is history the bank never gave.
// Never a silent merge: every proposal is listed with both rows, and the
// commit refuses a plan that no longer matches what was reviewed
// (reviewKey), since a sync or another import landing in between changes it.

import { matchRows, type Differs, type Outcome, type StoredRow } from '../import/match';
import { digitsOf, normalizeDescription, type NormalizedRecord } from '../import/normalize';
import type { Problem } from '../import/record';
import { isTransfer } from '../spending';
import {
  bankKey,
  couldBe,
  crossesEdge,
  pairUp,
  POSTED_DATED,
  settle,
  SIMILAR,
  type BankRow,
  type Confidence,
  type HeldRow,
  type Matchable,
  type Pair,
} from './match';

/** What a proposal is: the transaction already there (`same`, kept as a
 *  duplicate, never counted while it is there) or one of its own (`new`,
 *  kept and counted). */
export type ProposalChoice = 'same' | 'new';
export const PROPOSAL_CHOICES: readonly ProposalChoice[] = ['same', 'new'];

/** What to do with a row whose FITID an earlier import has on another
 *  transaction: import it as new, or skip it. */
export type ConflictChoice = 'new' | 'skip';
export const CONFLICT_CHOICES: readonly ConflictChoice[] = ['new', 'skip'];

/** Choices for every one (`all`), and for each by the row's place among the
 *  records read (`each`), which wins. */
export type Choices<T> = { all?: T; each?: Record<string, T> };
export type HistoryChoices = { proposals?: Choices<ProposalChoice>; conflicts?: Choices<ConflictChoice> };

/** A row an earlier import kept, as planning reads it: what matching needs
 *  both ways (lib/import/match.ts StoredRow, and HeldRow). */
export type PlanHeld = StoredRow & HeldRow;

/** A period, inclusive days. */
export type Period = { from: string; to: string };

/** How a duplicate names the transaction it is: the bank's row by its key,
 *  or a row an earlier import kept, by its id (lib/history-import/match.ts). */
export type TwinName = { key: string } | { row: string };

/** A transaction the account already has, as a file's row may be paired with
 *  it: a bank's posted row, or a row an earlier import kept that counts. */
export type Known = Matchable & {
  kind: 'bank' | 'imported';
  /** The bank's transaction id, or the kept row's id. */
  id: string;
  /** What a duplicate of it names: for a bank row an earlier import's row
   *  already stands on (a duplicate of it, or the row it superseded), that
   *  row, so two files' rows never both claim it. */
  names: TwinName;
  /** For a kept row: its import, and the period that import's file covers. */
  import_id?: string;
  covers?: Period | null;
  source?: string;
};

/** Why a pair is one only through a posting lag (see the header). */
export type Edge =
  /** The file's row is dated before the bank's earliest posted row. */
  | { kind: 'before-bank'; day: string }
  /** The other row is dated outside the period the file covers. */
  | { kind: 'outside-file'; from: string; to: string }
  /** The file's row is dated outside the period the earlier import covers. */
  | { kind: 'outside-import'; from: string; to: string };

export type PlanPair = Pair<Known> & { edge: Edge | null };

/** What is done with one row: added and counted, kept as a duplicate of a
 *  transaction already there, nothing (already imported, repeated, or
 *  skipped), or waiting for the person's answer. */
export type RowAction = 'add' | 'duplicate' | 'none' | 'ask';

type Shown = { date: string; name: string; amount: number; currency: string | null };

/** A proposal as the review lists it. */
export type Proposal = {
  /** The row's place among the records read: what a choice is keyed by. */
  index: number;
  line: number | null;
  file: Shown;
  /** The transaction already there: a bank's row (its merchant name as the
   *  Activity tab shows it, and the bank's own descriptor beside it), or a
   *  row an earlier import kept (with that import, for its file's name). */
  twin: Shown & { kind: 'bank' | 'imported'; id: string; descriptor: string | null; import_id: string | null };
  days: number;
  confidence: Confidence;
  /** The descriptions share a word that says who (lib/history-import/match.ts SIMILAR). */
  similar: boolean;
  /** Why it is one only through a posting lag, or null. */
  edge: Edge | null;
  /** What will be done: the choice sent, else high and medium start as the
   *  same; null until the person answers a low one. */
  choice: ProposalChoice | null;
};

/** A FITID conflict as the review lists it. */
export type HistoryConflict = {
  index: number;
  line: number | null;
  row_id: string;
  differs: Differs;
  suggested: 'new' | null;
  choice: ConflictChoice | null;
  file: Shown;
  stored: Shown;
};

export type PlanCounts = {
  /** Added and counted. */
  new: number;
  /** Kept as duplicates of the bank's rows, never counted while they are there. */
  duplicates: number;
  /** Kept as duplicates of rows earlier imports kept (a file of the same
   *  period in another format), never counted while they are there. */
  already: number;
  /** Already imported for this account, exactly. */
  present: number;
  repeated: number;
  /** FITID conflicts skipped as asked. */
  skipped: number;
  /** FITID conflicts and low-confidence proposals still to answer. */
  conflicts: number;
  unanswered: number;
  unreadable: number;
};

export type HistoryPlan = {
  rows: NormalizedRecord[];
  /** What exact matching against earlier imports made of each row. */
  outcomes: Outcome[];
  /** The proposal of each row that has one, by its place in `rows`. */
  pairs: Map<number, PlanPair>;
  actions: RowAction[];
  /** The rows that can't be read, each with its line and why, in file order. */
  problems: Problem[];
  counts: PlanCounts;
  proposals: Proposal[];
  conflicts: HistoryConflict[];
  first_date: string | null;
  last_date: string | null;
  currency: string | null;
  others: { currency: string; count: number }[];
  /** Money out and in of the rows to be added, in `currency`. */
  totals: { out: number; in: number };
  shortened: number;
  kinds: { transfers: number; atm: number; payments: number; fees: number };
  /** The bank's earliest row for this account's connection, or null when it
   *  has none: rows added before it are history the bank never gave. */
  bank_from: string | null;
  /** Rows to be added dated before it, and on or after it (the bank has
   *  nothing like them although it covers their day). */
  before_bank: number;
  within_bank: number;
  /** Rows to be added whose only look-alike at the bank is still pending:
   *  once it posts, the bank's row supersedes them. */
  pending_alike: number;
  /** What the review shows, before any choice: the commit refuses a plan
   *  whose key changed since (reviewKey). */
  review: string;
};

const shown = (r: { date: string; name: string; amount: number; currency: string | null }): Shown => ({ date: r.date, name: r.name, amount: r.amount, currency: r.currency });
const roundTo = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const choiceOf = <T>(choices: Choices<T> | undefined, index: number): T | undefined => choices?.each?.[String(index)] ?? choices?.all;

/**
 * The transactions the account already has, each once (see the header):
 * every posted bank row, naming the earlier import's row that already stands
 * on it where one does, and every row earlier imports kept that counts.
 */
export function knownOf(
  held: readonly PlanHeld[],
  banks: readonly BankRow[],
  order: readonly string[],
  bankFrom: string | null,
  imports: ReadonlyMap<string, { covers: Period | null }>
): Known[] {
  const covers = new Map<string, Period>();
  for (const [id, i] of imports) if (i.covers) covers.set(id, i.covers);
  const settled = settle(held, banks, order, { bankFrom, covers });
  const standsOn = new Map<BankRow, string>();
  for (const [rowId, st] of settled.standing) if ('bank' in st) standsOn.set(st.bank, rowId);
  for (const [rowId, b] of settled.superseded) standsOn.set(b, rowId);
  const known: Known[] = [];
  for (const b of banks) {
    if (b.pending) continue;
    const on = standsOn.get(b);
    known.push({
      kind: 'bank',
      id: b.transaction_id,
      date: b.date,
      amount: b.amount,
      currency: b.currency,
      name: b.name,
      merchant_name: b.merchant_name,
      names: on ? { row: on } : { key: bankKey(b) },
    });
  }
  for (const r of settled.counted) {
    known.push({
      kind: 'imported',
      id: r.id,
      date: r.date,
      amount: r.amount,
      currency: r.currency,
      name: r.name,
      names: { row: r.id },
      import_id: r.import_id,
      covers: covers.get(r.import_id) ?? null,
      source: r.source,
    });
  }
  return known;
}

/** Why a file's row and a known transaction are a pair only through a
 *  posting lag (see the header), or null. */
function edgeOf(row: { date: string }, twin: Known, bankFrom: string | null, covers: Period | null): Edge | null {
  if (twin.kind === 'bank') {
    if (bankFrom !== null && crossesEdge(row.date, twin.date, bankFrom, null)) return { kind: 'before-bank', day: bankFrom };
  } else if (twin.covers && crossesEdge(twin.date, row.date, null, twin.covers)) {
    return { kind: 'outside-import', from: twin.covers.from, to: twin.covers.to };
  }
  if (covers && crossesEdge(row.date, twin.date, null, covers)) return { kind: 'outside-file', from: covers.from, to: covers.to };
  return null;
}

/**
 * The plan (see the header). `held` is the account's kept rows under every id
 * it has had; `banks` its bank rows under every id (pending ones included,
 * never matched); `order` the account's imports, earliest first, and
 * `imports` the period each covers; `bankFrom` the bank's earliest row for
 * the connection; `covers` the period this file covers.
 */
export function planHistoryImport(input: {
  rows: NormalizedRecord[];
  problems: Problem[];
  held: readonly PlanHeld[];
  banks: readonly BankRow[];
  order: readonly string[];
  bankFrom: string | null;
  covers?: Period | null;
  imports?: ReadonlyMap<string, { covers: Period | null }>;
  choices?: HistoryChoices;
}): HistoryPlan {
  const { rows, held, banks, choices = {} } = input;
  const covers = input.covers ?? null;
  const outcomes = matchRows(
    rows.map((r) => r.row),
    held
  );
  const byId = new Map(held.map((r) => [r.id, r]));

  // FITID conflicts first: whether one joins the matching depends on its answer.
  const conflicts: HistoryConflict[] = [];
  const conflictChoice = new Map<number, ConflictChoice | null>();
  outcomes.forEach((o, i) => {
    if (o.outcome !== 'conflict') return;
    const r = rows[i];
    const choice = choiceOf(choices.conflicts, r.index) ?? o.suggested;
    conflictChoice.set(i, choice);
    conflicts.push({ index: r.index, line: r.line, row_id: o.row_id, differs: o.differs, suggested: o.suggested, choice, file: shown(r.row), stored: shown(byId.get(o.row_id)!) });
  });

  // What the account already has, each transaction once.
  const known = knownOf(held, banks, input.order, input.bankFrom, input.imports ?? new Map());
  const matching = rows.flatMap((r, i) =>
    outcomes[i].outcome === 'new' || (outcomes[i].outcome === 'conflict' && conflictChoice.get(i) === 'new')
      ? [{ index: i, date: r.row.date, amount: r.row.amount, currency: r.row.currency, name: r.row.name }]
      : []
  );
  // A file dated by posting never pairs across an edge with a row dated so too.
  const postedHere = rows.length > 0 && POSTED_DATED(rows[0].row.source);
  const found = pairUp(matching, known, (row, twin) => {
    if (!postedHere || (twin.kind === 'imported' && !POSTED_DATED(twin.source))) return false;
    return edgeOf(row, twin, input.bankFrom, covers) !== null;
  });
  const pairs = new Map<number, PlanPair>();
  for (const [i, pair] of found) {
    const edge = edgeOf(rows[i].row, pair.twin, input.bankFrom, covers);
    pairs.set(i, { ...pair, confidence: edge ? 'low' : pair.confidence, edge });
  }

  const counts: PlanCounts = { new: 0, duplicates: 0, already: 0, present: 0, repeated: 0, skipped: 0, conflicts: 0, unanswered: 0, unreadable: input.problems.length };
  const proposals: Proposal[] = [];
  const pendings = banks.filter((b) => b.pending);
  let before_bank = 0;
  let within_bank = 0;
  let pending_alike = 0;
  const actions = rows.map((r, i): RowAction => {
    const o = outcomes[i];
    if (o.outcome === 'present') {
      counts.present++;
      return 'none';
    }
    if (o.outcome === 'repeated') {
      counts.repeated++;
      return 'none';
    }
    if (o.outcome === 'conflict') {
      const c = conflictChoice.get(i);
      if (c === 'skip') {
        counts.skipped++;
        return 'none';
      }
      if (c !== 'new') {
        counts.conflicts++;
        return 'ask';
      }
    }
    const pair = pairs.get(i);
    if (pair) {
      const sent = choiceOf(choices.proposals, r.index);
      const choice = sent ?? (pair.confidence === 'low' ? null : 'same');
      const t = pair.twin;
      proposals.push({
        index: r.index,
        line: r.line,
        file: shown(r.row),
        twin: {
          ...shown({ ...t, name: (t.kind === 'bank' && t.merchant_name) || t.name }),
          kind: t.kind,
          id: t.id,
          descriptor: t.kind === 'bank' ? t.name : null,
          import_id: t.import_id ?? null,
        },
        days: pair.days,
        confidence: pair.confidence,
        similar: pair.similarity >= SIMILAR,
        edge: pair.edge,
        choice,
      });
      if (choice === 'same') {
        if (t.kind === 'bank') counts.duplicates++;
        else counts.already++;
        return 'duplicate';
      }
      if (choice === null) {
        counts.unanswered++;
        return 'ask';
      }
    }
    counts.new++;
    if (input.bankFrom === null || r.row.date < input.bankFrom) before_bank++;
    else within_bank++;
    if (!pair && pendings.some((b) => couldBe(r.row, { ...b, pending: false }))) pending_alike++;
    return 'add';
  });

  const byCurrency = new Map<string, number>();
  let first: string | null = null;
  let last: string | null = null;
  for (const { row } of rows) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + 1);
    if (first === null || row.date < first) first = row.date;
    if (last === null || row.date > last) last = row.date;
  }
  let currency: string | null = null;
  for (const [c, n] of byCurrency) if (currency === null || n > byCurrency.get(currency)!) currency = c;
  const totals = { out: 0, in: 0 };
  const kinds = { transfers: 0, atm: 0, payments: 0, fees: 0 };
  rows.forEach(({ row }, i) => {
    if (actions[i] !== 'add') return;
    if (row.transaction_code === 'atm') kinds.atm++;
    else if (row.category === 'loan payments') kinds.payments++;
    else if (isTransfer({ transaction_code: row.transaction_code ?? null, category: row.category })) kinds.transfers++;
    else if (row.category === 'bank fees') kinds.fees++;
    if (row.currency !== currency) return;
    if (row.amount > 0) totals.out += row.amount;
    else totals.in -= row.amount;
  });
  const digits = currency ? digitsOf(currency) : 2;
  // Low confidence first, then by date, so what needs an answer leads.
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  proposals.sort((a, b) => rank[a.confidence] - rank[b.confidence] || (a.file.date < b.file.date ? -1 : a.file.date > b.file.date ? 1 : a.index - b.index));
  return {
    rows,
    outcomes,
    pairs,
    actions,
    problems: [...input.problems].sort((a, b) => a.line - b.line),
    counts,
    proposals,
    conflicts,
    first_date: first,
    last_date: last,
    currency,
    others: [...byCurrency].filter(([c]) => c !== currency).map(([c, count]) => ({ currency: c, count })),
    totals: { out: roundTo(totals.out, digits), in: roundTo(totals.in, digits) },
    shortened: rows.filter((r) => r.shortened).length,
    kinds,
    bank_from: input.bankFrom,
    before_bank,
    within_bank,
    pending_alike,
    review: reviewKey(rows, outcomes, conflictChoice, pairs, covers),
  };
}

/**
 * What the review shows, as one string, before the person's choices: each
 * row as read (its day, amount, currency and description, so a file read
 * otherwise, or another file of as many rows, is another review), its outcome
 * and what it names (the earlier row it is, the row it repeats, the
 * transaction it looks like, how many days apart and how sure), and the
 * period the file covers. Equal keys are the same review: a sync, a re-link or
 * another import landing between the review and the commit changes it, and
 * the commit is refused then rather than applying choices to proposals the
 * person never saw.
 */
function reviewKey(rows: NormalizedRecord[], outcomes: Outcome[], conflictChoice: Map<number, ConflictChoice | null>, pairs: Map<number, PlanPair>, covers: Period | null): string {
  const each = rows.map((r, i) => {
    const o = outcomes[i];
    const pair = pairs.get(i);
    const head =
      o.outcome === 'present' ? `p:${o.row_id}` : o.outcome === 'repeated' ? `r:${o.of}` : o.outcome === 'conflict' ? `c:${o.row_id}:${conflictChoice.get(i) ?? ''}` : 'n';
    const what = `${r.row.date}|${Math.round(r.row.amount * 1000)}|${r.row.currency}|${normalizeDescription(r.row.name)}`;
    const twin = pair ? `>${pair.twin.kind}:${pair.twin.id}:${pair.days}:${pair.confidence}${pair.edge ? `:${pair.edge.kind}` : ''}` : '';
    return `${r.index}[${what}]=${head}${twin}`;
  });
  return `${covers ? `${covers.from}..${covers.to}` : '-'};${each.join(',')}`;
}
