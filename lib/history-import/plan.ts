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
//   3. Likely the bank's: the same amount as a bank row, dated within a few
//      days (lib/history-import/match.ts), a PROPOSAL with a confidence and the
//      bank's row beside it. The person chooses: the same transaction (kept as
//      a duplicate, never counted), or a transaction of its own (kept beside
//      the bank's). High and medium confidence start as "the same"; a low one
//      has no answer until the person gives it, and the import waits for it.
//   4. New: nothing like it, imported and counted. Dated before the bank's
//      own rows begin, it is history the bank never gave.
// Never a silent merge: every proposal is listed with both rows, and the
// commit refuses a plan that no longer matches what was reviewed
// (reviewKey), since a sync or another import landing in between changes it.
//
// The bank rows a proposal can take exclude those already accounted for:
// claimed by an earlier duplicate, marked by an earlier "its own", or
// superseding an earlier import's row (lib/history-import/match.ts
// supersede). So the review shows exactly what the import will do once
// stored, and a later read finds nothing more to match among the rows it
// added.

import { matchRows, type Differs, type Outcome, type StoredRow } from '../import/match';
import { digitsOf, type NormalizedRecord } from '../import/normalize';
import type { Problem } from '../import/record';
import { isTransfer } from '../spending';
import { couldBe, pairUp, SIMILAR, supersede, unclaimed, type BankRow, type Confidence, type HeldRow, type Pair } from './match';

/** What a proposal is: the bank's row (`same`, kept as a duplicate, never
 *  counted) or a transaction of its own (`new`, kept and counted). */
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

/** What is done with one row: added and counted, kept as a duplicate of the
 *  bank's, nothing (already imported, repeated, or skipped), or waiting for
 *  the person's answer. */
export type RowAction = 'add' | 'duplicate' | 'none' | 'ask';

type Shown = { date: string; name: string; amount: number; currency: string | null };

/** A proposal as the review lists it. */
export type Proposal = {
  /** The row's place among the records read: what a choice is keyed by. */
  index: number;
  line: number | null;
  file: Shown;
  /** The bank's row: its merchant name as the Activity tab shows it, and the
   *  bank's own descriptor beside it. */
  bank: Shown & { transaction_id: string; descriptor: string };
  days: number;
  confidence: Confidence;
  /** The descriptions share a word that says who (lib/history-import/match.ts SIMILAR). */
  similar: boolean;
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
  /** Kept as duplicates of the bank's rows, never counted. */
  duplicates: number;
  /** Already imported for this account. */
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
  pairs: Map<number, Pair>;
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
 * The plan (see the header). `held` is the account's kept rows under every id
 * it has had; `banks` its bank rows under every id (pending ones included,
 * never matched); `order` the account's imports, earliest first, for which
 * kept rows a bank row supersedes; `bankFrom` the bank's earliest row for
 * the connection.
 */
export function planHistoryImport(input: {
  rows: NormalizedRecord[];
  problems: Problem[];
  held: readonly PlanHeld[];
  banks: readonly BankRow[];
  order: readonly string[];
  bankFrom: string | null;
  choices?: HistoryChoices;
}): HistoryPlan {
  const { rows, held, banks, choices = {} } = input;
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

  // The bank rows a proposal may take: none an earlier decision claimed or
  // marked, nor one superseding an earlier import's row.
  const superseding = new Set(supersede(held, banks, input.order).values());
  const free = unclaimed(banks, held).filter((b) => !superseding.has(b));
  const matching = rows.flatMap((r, i) =>
    outcomes[i].outcome === 'new' || (outcomes[i].outcome === 'conflict' && conflictChoice.get(i) === 'new')
      ? [{ index: i, date: r.row.date, amount: r.row.amount, currency: r.row.currency, name: r.row.name }]
      : []
  );
  const pairs = pairUp(matching, free);

  const counts: PlanCounts = { new: 0, duplicates: 0, present: 0, repeated: 0, skipped: 0, conflicts: 0, unanswered: 0, unreadable: input.problems.length };
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
      proposals.push({
        index: r.index,
        line: r.line,
        file: shown(r.row),
        bank: { ...shown({ ...pair.bank, name: pair.bank.merchant_name || pair.bank.name }), transaction_id: pair.bank.transaction_id, descriptor: pair.bank.name },
        days: pair.days,
        confidence: pair.confidence,
        similar: pair.similarity >= SIMILAR,
        choice,
      });
      if (choice === 'same') {
        counts.duplicates++;
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
    review: reviewKey(rows, outcomes, conflictChoice, pairs),
  };
}

/**
 * What the review shows, as one string, before the person's choices: each
 * row's outcome and what it names (the earlier row it is, the row it
 * repeats, the bank's row it looks like and how many days apart). Equal keys
 * are the same review: a sync, a re-link or another import landing between
 * the review and the commit changes it, and the commit is refused then
 * rather than applying choices to proposals the person never saw.
 */
function reviewKey(rows: NormalizedRecord[], outcomes: Outcome[], conflictChoice: Map<number, ConflictChoice | null>, pairs: Map<number, Pair>): string {
  return rows
    .map((r, i) => {
      const o = outcomes[i];
      const pair = pairs.get(i);
      const head =
        o.outcome === 'present' ? `p:${o.row_id}` : o.outcome === 'repeated' ? `r:${o.of}` : o.outcome === 'conflict' ? `c:${o.row_id}:${conflictChoice.get(i) ?? ''}` : 'n';
      return `${r.index}=${head}${pair ? `>${pair.bank.transaction_id}:${pair.days}:${pair.confidence}` : ''}`;
    })
    .join(',');
}
