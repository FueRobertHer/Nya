// lib/investment-imports-review.ts
//
// What importing a brokerage's transactions download would do to one
// account (lib/investment-imports.ts), for the review its sheet shows before
// anything is kept. Pure: the route (app/api/investment-imports) reads the
// account's sync and imports and hands them here.
//
// It is the merge run twice, as the account is now and with the file's rows
// added as the newest import, through the same seam both activity readers use
// (lib/investment-activity.ts activityFromSync), so the review's figures are
// the ones the chart, Investments and the Plan will count:
//
//   - the days the file would decide, and how many rows it brings in place of
//     how many there are now;
//   - deposits & withdrawals over those days, the file's and what counts now
//     (null where nothing counts now: days before Nya's activity starts), in
//     all and by month, each month where they differ;
//   - the new savings over those days each way, as the Plan counts them;
//   - the rows just outside those days left out as the same event as one of
//     the file's (the edge twins), what they count now said in the month
//     their file row lands in;
//   - or that its days don't reach Nya's activity, so it would never be used.

import { activityFromSync } from './investment-activity';
import { withImportedRows, type AccountImport, type ImportSource, type InvestmentImport } from './investment-imports';
import { contributedAmount, isContribution } from './investments';
import type { InvSync } from './invstore';
import type { Unreadable } from './import/vanguard-transactions';

/** The id the file's rows take in the review: never a stored import's
 *  (those are UUIDs). */
export const REVIEW_ID = 'reviewing';

/** A month of the file's days where its deposits & withdrawals differ from
 *  what counts now. Money in is positive. `now` is null where nothing counts
 *  now. */
export type MonthChange = { month: string; now: number | null; file: number };

/** A row Nya has just outside the file's days, left out as the same event as
 *  the file's row on `file_date`. `amount` is Plaid's sign (positive when cash
 *  leaves). */
export type TwinShown = { date: string; file_date: string; name: string; type: string; subtype: string; amount: number };

export type AccountEffect =
  | {
      kind: 'unreached';
      /** The file's days, and Nya's activity for the account (null: none). */
      covers: { from: string; to: string };
      activity: { from: string; through: string } | null;
    }
  | {
      kind: 'takes';
      /** The days the file would decide. */
      days: { from: string; to: string }[];
      /** Its rows in those days, and the account's there now. */
      rows: number;
      now_rows: number;
      /** Deposits & withdrawals over those days. */
      flows: { file: number; now: number | null };
      /** New savings over those days, as the Plan counts them: contributions,
       *  never rollovers (lib/investments.ts isContribution). `now` only over
       *  days that count now, null where none does. */
      savings: { file: number; now: number | null };
      months: MonthChange[];
      twins: TwinShown[];
    };

/** Why an account in the file can't be taken: no live investment account at
 *  Vanguard ends in its four digits, or two do; two of the file's accounts
 *  end in them; a line of its can't be read; it has nothing in the file's
 *  days (`now`: the rows Nya has there, which stay); it has as many imports
 *  as it keeps; or the file's days don't reach Nya's activity for it. */
export type Problem =
  | { why: 'not-in-nya' }
  | { why: 'two-in-nya' }
  | { why: 'repeated' }
  | { why: 'unreadable'; detail: Unreadable }
  | { why: 'no-rows'; now: number }
  | { why: 'full' }
  | { why: 'unreached'; covers: { from: string; to: string }; activity: { from: string; through: string } | null };

/** One of the file's accounts, as the review shows it: `lines` the file has
 *  for it, `rows` it would bring (those before today), the account in Nya
 *  it is, and why it can't be taken or what taking it would do. */
export type ReviewedAccount = {
  mask: string;
  lines: number;
  rows: number;
  account: { account_id: string; item_id: string; name: string } | null;
  problem: Problem | null;
  effect: Extract<AccountEffect, { kind: 'takes' }> | null;
};

/** A CSV import that covers some of a QFX's days, and so decides them, with
 *  the last four digits of the file's accounts it does that in. */
export type DecidingCsv = { import_id: string; file_name: string | null; imported_at: string; covers: { from: string; to: string }; masks: string[] };

/** The review: the fingerprint of the imports it was made under (an import
 *  names it), which download it is, the file's days, how many of its rows
 *  are from today or later (left out), whether any of its accounts ends in
 *  the sheet's account's four digits (taken or not), and each of its accounts
 *  in its order. A QFX's says too the day it was made when its days stop the
 *  day before (`stated_end`: the file states that day, which can be
 *  partial), and the CSV imports that cover some of its days in an account
 *  it can be imported into (`csv`, by their first day), which decide those
 *  days there. */
export type ImportsReview = {
  fingerprint: string;
  source: ImportSource;
  covers: { from: string; to: string };
  stated_end: string | null;
  after_today: number;
  sheet_in: boolean;
  csv: DecidingCsv[];
  accounts: ReviewedAccount[];
};

const cents = (n: number) => Math.round(n * 100);
const inside = (d: string, spans: readonly { from: string; to: string }[]) => spans.some((s) => d >= s.from && d <= s.to);

/** What importing `file` into the account would do, given its sync and its
 *  imports now (across its linked ids). */
export function effectOf(sync: InvSync, account_id: string, imports: readonly AccountImport[], file: InvestmentImport): AccountEffect {
  const now = withImportedRows(sync, account_id, imports);
  const candidate: AccountImport = { ...file, account_id, import_id: REVIEW_ID };
  const after = withImportedRows(sync, account_id, [...imports, candidate]);
  if (after.unused.includes(REVIEW_ID)) {
    const cov = sync.coverage[account_id];
    return { kind: 'unreached', covers: file.covers, activity: cov ? { from: cov.from, through: cov.through } : null };
  }
  const days = after.decided.filter((d) => d.import_id === REVIEW_ID).map(({ from, to }) => ({ from, to }));
  const mine = (s: InvSync) => s.rows.filter((t) => t.account_id === account_id);
  const rows = mine(after.sync).filter((t) => t.investment_transaction_id.startsWith(`${REVIEW_ID}:`)).length;
  const now_rows = mine(now.sync).filter((t) => inside(t.date, days)).length;

  // The flows each way, through the seam the chart's line uses.
  const nowActivity = activityFromSync(now.sync, account_id, now.counted);
  const afterActivity = activityFromSync(after.sync, account_id, after.counted);
  const known = nowActivity.flows_from && nowActivity.flows_to ? { from: nowActivity.flows_from, to: nowActivity.flows_to } : null;
  const months = new Map<string, { now: number; file: number; known: boolean }>();
  const month = (d: string) => {
    const m = d.slice(0, 7);
    return months.get(m) ?? months.set(m, { now: 0, file: 0, known: false }).get(m)!;
  };
  for (const s of days) {
    // Every month the days touch, and whether any of its days counted now.
    for (let d = s.from; d <= s.to; d = nextMonthStart(d)) {
      const m = month(d);
      const end = monthEnd(d) < s.to ? monthEnd(d) : s.to;
      if (known && d <= known.to && end >= known.from) m.known = true;
    }
  }
  for (const f of afterActivity.flows ?? []) if (inside(f.date, days)) month(f.date).file += f.amount;
  if (known) for (const f of nowActivity.flows ?? []) if (inside(f.date, days) && f.date >= known.from && f.date <= known.to) month(f.date).now += f.amount;

  const twinPairs = after.pairs.filter((p) => p.file.investment_transaction_id.startsWith(`${REVIEW_ID}:`));
  // An edge twin counts now on its own day, just outside the file's days, and
  // after only as the file's row inside them. So what it counted now is put
  // in the month its file row lands in, or the file would seem to add it. Its
  // day's flows now less after (nothing else changes on a day the file
  // doesn't cover), once a day, in the month of that day's first twin.
  const byDay = (flows: readonly { date: string; amount: number }[] | null, d: string) => (flows ?? []).reduce((n, f) => (f.date === d ? n + f.amount : n), 0);
  const twinDays = new Map<string, string>();
  for (const p of twinPairs) if (!twinDays.has(p.plaid.date)) twinDays.set(p.plaid.date, p.file.date);
  for (const [d, fileDay] of twinDays) {
    const counted = byDay(nowActivity.flows, d) - byDay(afterActivity.flows, d);
    if (cents(counted) === 0) continue;
    const m = month(fileDay);
    m.known = true;
    m.now += counted;
  }

  const changed: MonthChange[] = [];
  let fileTotal = 0;
  let nowTotal = 0;
  let anyKnown = false;
  for (const [m, v] of [...months].sort(([a], [b]) => (a < b ? -1 : 1))) {
    fileTotal += v.file;
    if (v.known) {
      anyKnown = true;
      nowTotal += v.now;
    }
    const was = v.known ? v.now : null;
    if (was === null ? cents(v.file) !== 0 : cents(was) !== cents(v.file)) changed.push({ month: m, now: was === null ? null : round(was), file: round(v.file) });
  }

  const twins = twinPairs.map(({ plaid, file: f }) =>({ date: plaid.date, file_date: f.date, name: plaid.name, type: plaid.type, subtype: plaid.subtype, amount: plaid.amount }));

  // New savings each way: a QFX can't say what money in was, so its days can
  // count less than they do now even where the flows agree.
  const saved = (m: ReturnType<typeof withImportedRows>, within: (d: string) => boolean) =>
    mine(m.sync)
      .filter((t) => inside(t.date, days) && within(t.date) && isContribution(t, m.counted))
      .reduce((n, t) => n + contributedAmount(t, m.counted), 0);
  const savings = { file: round(saved(after, () => true)), now: known ? round(saved(now, (d) => d >= known.from && d <= known.to)) : null };

  return { kind: 'takes', days, rows, now_rows, flows: { file: round(fileTotal), now: anyKnown ? round(nowTotal) : null }, savings, months: changed, twins };
}

const round = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};

/** The first of the next month. */
function nextMonthStart(d: string): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** The last day of the day's month. */
function monthEnd(d: string): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
