// lib/import/apps/splits.ts
//
// Rebuilding split transactions from an app's export. Pure, safe to import
// from client code.
//
// THE APPS WRITE A SPLIT AS LINES. YNAB writes one line per part, each with
// "Split (1/3)" before its memo; Actual Budget writes the transaction ("(SPLIT
// INTO 3)", with its amount under Split_Amount) and then its parts ("(SPLIT 1
// OF 3)"); Lunch Money writes the parts, each naming its parent's id. Nya keeps
// a split as one transaction with its parts beside it (lib/splits.ts), so the
// lines become one AppTxn whose amount is their total and whose `parts` are
// the lines, each with its own category and note.
//
// ONLY WHAT NYA CAN HOLD, EXACTLY. A split is rebuilt only when its lines
// come together (every part there, on one account and one day, in one
// currency), number between MIN_PARTS and MAX_PARTS once lines of nothing are
// left out, are all money out or all money in (a part in Nya is of its
// transaction's own sign), and add up exactly to the transaction where the
// app gives its total. Otherwise the lines come in as they are, each a
// transaction of its own with its own category, which counts the same in
// every total, and the import's review says how many and why. Nothing is
// ever spread, rounded or guessed to make a split fit. The plan checks the
// parts once more by the very rule a split saved in the app meets
// (lib/splits.ts checkParts, in the account's currency), and explodes one
// that fails it the same way (explode).

import { MAX_PARTS, MIN_PARTS } from '../../split-rows';
import type { AppPart, AppTxn, SplitReport } from './types';

/** Lines' amounts compared at a millionth: more than any currency's minor
 *  unit, and past the float error of adding decimals. */
const micro = (n: number) => Math.round(n * 1e6);

/** A new, empty report. */
export const newSplitReport = (): SplitReport => ({ rebuilt: 0, parts: 0, dropped: [], kept: [], unmarked: null });

/** Counts a split rebuilt, and the lines of nothing left out of it. */
export function noteRebuilt(report: SplitReport, built: { txn: AppTxn; dropped: number }, lines: readonly AppTxn[]): void {
  report.rebuilt++;
  report.parts += built.txn.parts!.length;
  if (built.dropped > 0) report.dropped.push(...lines.filter((l) => !built.txn.parts!.some((p) => p.line === l.line)).map((l) => l.line));
}

/** Notes in the report that a split's lines came in as rows, and why. */
export function keepLines(report: SplitReport, reason: string, lines: readonly number[]): void {
  const found = report.kept.find((k) => k.reason === reason);
  if (found) found.lines.push(...lines);
  else report.kept.push({ reason, lines: [...lines] });
}

/** The reasons, in the person's words. */
export const WHY = {
  together: 'Its lines aren’t all together in the file (a line is missing, or they are on different accounts or days).',
  signs: 'Its lines are money out and money in at once, and the parts of a split in Nya are all one or the other.',
  few: `Fewer than ${MIN_PARTS} of its lines move any money, so it is a transaction of its own.`,
  many: `It has more than ${MAX_PARTS} lines, more parts than Nya splits a transaction into.`,
  total: 'Its lines don’t add up to the transaction’s amount.',
  currency: 'Its lines are in more than one currency.',
  room: 'Nya keeps at most 5,000 split transactions, and this one is past what is left of that.',
  rules: 'Its parts aren’t amounts a split in Nya can hold in its account’s currency.',
} as const;

/**
 * One transaction from a split's lines (see the header), or why not. `head`
 * is the transaction as the app gives it (its payee, note and tags, and its
 * total when the app writes one: `total`); the lines are its parts. Lines of
 * nothing are left out (`dropped`).
 */
export function fromLines(
  head: Pick<AppTxn, 'account' | 'date' | 'currency' | 'payee' | 'note' | 'tags' | 'raw'> & { total?: number | null },
  lines: readonly AppTxn[]
): { txn: AppTxn; dropped: number } | { reason: string } {
  if (lines.some((l) => l.account !== head.account || l.date !== head.date)) return { reason: WHY.together };
  if (lines.some((l) => (l.currency ?? '') !== (head.currency ?? lines[0].currency ?? ''))) return { reason: WHY.currency };
  const moving = lines.filter((l) => micro(l.amount) !== 0);
  if (moving.length < MIN_PARTS) return { reason: WHY.few };
  if (moving.length > MAX_PARTS) return { reason: WHY.many };
  const sign = Math.sign(moving[0].amount);
  if (moving.some((l) => Math.sign(l.amount) !== sign)) return { reason: WHY.signs };
  const sum = moving.reduce((n, l) => n + micro(l.amount), 0);
  if (head.total !== undefined && head.total !== null && micro(head.total) !== sum) return { reason: WHY.total };
  const parts: AppPart[] = moving.map((l) => ({ amount: l.amount, category: l.category, transfer: l.transfer, note: l.note, payee: l.payee, line: l.line }));
  const txn: AppTxn = {
    line: Math.min(...lines.map((l) => l.line)),
    lines: lines.map((l) => l.line).sort((a, b) => a - b),
    account: head.account,
    date: head.date,
    amount: sum / 1e6,
    currency: head.currency ?? lines[0].currency,
    payee: head.payee,
    // The transaction's own category, for what its parts don't cover: one
    // they all share, else none (it shows as its parts while split).
    category: parts.every((p) => sameCategory(p.category, parts[0].category)) ? parts[0].category : null,
    transfer: null,
    starting: false,
    note: head.note,
    tags: head.tags,
    parts,
    raw: head.raw,
  };
  return { txn, dropped: lines.length - moving.length };
}

const sameCategory = (a: AppPart['category'], b: AppPart['category']) =>
  (a === null && b === null) || (a !== null && b !== null && a.name.toLowerCase() === b.name.toLowerCase() && (a.group ?? '').toLowerCase() === (b.group ?? '').toLowerCase());

/** A rebuilt split's parts as the transactions of their own they were lines
 *  of: what the import brings when the plan finds the split can't be held
 *  (see the header). A transaction that isn't split is itself. */
export function explode(txn: AppTxn): AppTxn[] {
  if (!txn.parts) return [txn];
  return txn.parts.map((p) => ({
    line: p.line,
    lines: [p.line],
    account: txn.account,
    date: txn.date,
    amount: p.amount,
    currency: txn.currency,
    payee: p.payee,
    category: p.category,
    transfer: p.transfer,
    starting: false,
    note: p.note,
    tags: txn.tags,
    parts: null,
    raw: { line: p.line, of: txn.raw },
  }));
}

/** A line's place in a split, as YNAB marks it in its memo: "Split (1/3)"
 *  (and YNAB 4's "(Split 1/3)"), with the memo that follows. */
export function splitMark(memo: string | null): { i: number; n: number; memo: string | null } | null {
  if (!memo) return null;
  const m = /^(?:Split \((\d{1,3})\/(\d{1,3})\)|\(Split (\d{1,3})\/(\d{1,3})\))\s*(.*)$/s.exec(memo);
  if (!m) return null;
  const i = Number(m[1] ?? m[3]);
  const n = Number(m[2] ?? m[4]);
  if (!(i >= 1 && n >= 1 && i <= n)) return null;
  const rest = m[5].trim();
  return { i, n, memo: rest || null };
}

/**
 * Rebuilds the splits YNAB marks in its memos (splitMark): a run of lines
 * numbered 1 to n, one after another in the file, is one transaction. The
 * transaction's payee is the one its lines share, else the first that isn't
 * a transfer; its tags are the lines' (YNAB flags the whole transaction).
 * A run that is broken (a number missing or out of turn) is kept as rows.
 */
export function rebuildMarked(txns: readonly (AppTxn & { mark: ReturnType<typeof splitMark> })[], report: SplitReport): AppTxn[] {
  const out: AppTxn[] = [];
  let i = 0;
  const plain = (t: AppTxn & { mark?: unknown }): AppTxn => {
    const { mark: _mark, ...rest } = t;
    return rest;
  };
  while (i < txns.length) {
    const t = txns[i];
    if (!t.mark) {
      out.push(plain(t));
      i++;
      continue;
    }
    // A run: the lines from 1 to n, in order.
    const n = t.mark.n;
    const run: (AppTxn & { mark: ReturnType<typeof splitMark> })[] = [];
    let j = i;
    while (j < txns.length && run.length < n) {
      const l = txns[j];
      if (!l.mark || l.mark.n !== n || l.mark.i !== run.length + 1) break;
      run.push(l);
      j++;
    }
    if (t.mark.i !== 1 || run.length !== n) {
      // A broken run: each line is a row of its own, its memo as written (so
      // it still says it was part of a split), and the next line starts
      // looking again.
      const broken = run.length > 0 ? run : [t];
      keepLines(report, WHY.together, broken.map((l) => l.line));
      for (const l of broken) out.push(plain(l));
      i += broken.length;
      continue;
    }
    // A part's note is its memo after the mark.
    const lines = run.map((l) => plain({ ...l, note: l.mark!.memo }));
    const payees = new Set(lines.map((l) => l.payee));
    const payee = payees.size === 1 ? lines[0].payee : (lines.find((l) => l.transfer === null)?.payee ?? lines[0].payee);
    const tags = [...new Set(lines.flatMap((l) => l.tags))];
    const built = fromLines({ account: t.account, date: t.date, currency: t.currency, payee, note: null, tags, raw: run.map((l) => l.raw) }, lines);
    if ('reason' in built) {
      keepLines(report, built.reason, lines.map((l) => l.line));
      out.push(...run.map(plain));
    } else {
      noteRebuilt(report, built, lines);
      out.push(built.txn);
    }
    i = j;
  }
  return out;
}
