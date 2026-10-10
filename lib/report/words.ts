// lib/report/words.ts
//
// What a report says, in plain words: its title, whether anything may be
// missing and why, and the caveats on its totals. One place, so the printed
// page (components/ReportView.tsx) and the CSV (lib/report/csv.ts) say the
// same thing, in the words the app uses for the same facts: "hasn't synced
// since", "still importing older transactions", "Plaid doesn't provide their
// transactions" (lib/month-coverage.ts, lib/no-transactions.ts). Pure and
// client-safe. Each takes `day`, how a calendar day is written: the page's
// local date, the CSV's YYYY-MM-DD.

import { joinNames } from '../month-coverage';
import { sourceLabel } from '../manual-txn-input';
import type { HealthState } from '../connection-state';
import type { NoTransactionsReason } from '../item-products';
import type { Gap, Report } from './build';

/** How a calendar day (YYYY-MM-DD) is written. */
export type DayFormat = (day: string) => string;

/** "2025 tax year" or "Jan 1, 2026 to Mar 31, 2026". */
export function reportTitle(report: Pick<Report, 'period'>, day: DayFormat): string {
  const { period } = report;
  return period.kind === 'year' ? `${period.start.slice(0, 4)} tax year` : `${day(period.start)} to ${day(period.end)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Each gap as a sentence, in the order given. Gaps of one kind without a day
 * of their own are said together, as the app's month notes say them; a stale
 * connection, a late start and a removal each have their own day, and their
 * own sentence.
 */
export function gapSentences(gaps: readonly Gap[], day: DayFormat): string[] {
  const out: string[] = [];
  const grouped = new Set<string>();
  const namesOf = (kind: Gap['kind']) => [...new Set(gaps.filter((g) => g.kind === kind).map((g) => g.institution ?? ''))];
  for (const g of gaps) {
    switch (g.kind) {
      case 'missing':
      case 'importing':
      case 'refused':
      case 'no_consent': {
        if (grouped.has(g.kind)) continue;
        grouped.add(g.kind);
        const names = namesOf(g.kind);
        const one = names.length === 1;
        const who = joinNames(names);
        if (g.kind === 'missing') out.push(`Doesn’t include ${who}: ${one ? 'its' : 'their'} transactions couldn’t be loaded, so this report may be incomplete.`);
        else if (g.kind === 'importing') out.push(`${who} ${one ? 'is' : 'are'} still importing older transactions, so this report may be incomplete.`);
        else if (g.kind === 'refused') out.push(`Doesn’t include the bank or card accounts at ${who}: Plaid doesn’t provide their transactions, so this report may be incomplete.`);
        else {
          out.push(
            `Doesn’t include the bank or card accounts at ${who}: you didn’t allow Nya to see their transactions, so this report may be incomplete. To bring them in, choose Allow transactions on the Accounts tab.`
          );
        }
        break;
      }
      case 'stale':
        out.push(
          g.since
            ? `${g.institution} hasn’t synced since ${day(g.since)}, so this report may be missing some of its transactions.`
            : `When ${g.institution} last synced isn’t known, so this report may be missing some of its transactions.`
        );
        break;
      case 'begins_late':
        out.push(`${g.institution}’s transactions in Nya begin on ${day(g.first)}: if its accounts were open before then, this report is missing their earlier transactions.`);
        break;
      case 'removed':
        out.push(`${g.institution} was removed on or after ${day(g.last_seen)}, and the transactions it brought in went with it, so this report may be missing some of them.`);
        break;
      case 'unreadable':
        out.push(`${g.note.replace(/[.\s]+$/, '')}.`);
        break;
    }
  }
  return out;
}

/** A gap in a few words, beside its institution in the report's list of
 *  where the data comes from (the sentence above says the rest). */
export function gapShort(g: Gap, day: DayFormat): string {
  switch (g.kind) {
    case 'missing':
      return 'Its transactions couldn’t be loaded';
    case 'stale':
      return g.since ? `Hasn’t synced since ${day(g.since)}` : 'When it last synced isn’t known';
    case 'importing':
      return 'Still importing older transactions';
    case 'begins_late':
      return `Its transactions in Nya begin on ${day(g.first)}`;
    case 'refused':
      return 'Plaid doesn’t provide its bank or card transactions';
    case 'no_consent':
      return 'You didn’t allow its bank or card transactions';
    case 'removed':
      return `Removed on or after ${day(g.last_seen)}`;
    case 'unreadable':
      return g.note;
  }
}

/** What a connection that has stopped needs to be brought up to date: said
 *  once, after the gaps, when any connection's gap is one a sync can close. */
export const SYNC_REMEDY =
  'Opening Nya brings connections up to date where they can be, and Connection health on the Accounts tab says what to do about the rest. Then make this report again.';

/** The headline: none of the period is there, some may be missing, or
 *  nothing is known to be missing. */
export function statusHeadline(report: Pick<Report, 'empty' | 'gaps'>): string {
  if (report.empty) return report.gaps.length > 0 ? 'There are no transactions in this period, and some may be missing:' : 'There are no transactions in this period.';
  if (report.gaps.length > 0) return 'This report may be incomplete:';
  return 'Nothing is known to be missing from this period.';
}

/** What may be missing: each gap, the remedy where a sync can help, and why
 *  no connection brings in spending, when none can. */
export function problemLines(report: Pick<Report, 'gaps' | 'no_spending'>, day: DayFormat): string[] {
  const lines = gapSentences(report.gaps, day);
  if (report.gaps.some((g) => g.kind === 'stale' || g.kind === 'missing' || g.kind === 'importing')) lines.push(SYNC_REMEDY);
  if (report.no_spending) lines.push(`${report.no_spending.lead}, so no bank or card transactions come in. To see spending, ${report.no_spending.remedy}.`);
  return lines;
}

/** The lines under the headline: what may be missing, then the period's own
 *  caveats. */
export function statusLines(report: Report, day: DayFormat): string[] {
  return [...problemLines(report, day), ...caveatLines(report, day)];
}

/** What is true of the period whatever the data: a year still running, days
 *  still settling, accounts left out, and what couldn't be read about the
 *  connections. */
export function caveatLines(report: Report, day: DayFormat): string[] {
  const { caveats, period } = report;
  const out: string[] = [];
  if (caveats.not_over) out.push(`${period.start.slice(0, 4)} isn’t over: this report covers ${day(period.start)} to ${day(period.through)}.`);
  if (caveats.settling) out.push('Banks can take a few days to post a transaction, so the last days of this period may still change.');
  if (caveats.hidden) out.push('Accounts you hid are left out, as everywhere in Nya.');
  if (caveats.health_unread) out.push('How each bank connection is doing couldn’t be read, so what is said of each may be missing something.');
  if (caveats.removed_unread) out.push('Whether a connection was removed during this period couldn’t all be read.');
  return out;
}

/** What the totals leave out, as the Activity tab says it under a month: the
 *  transfers, what the person excluded, what couldn't be read, and other
 *  currencies. */
export function totalsNote(report: Pick<Report, 'totals'>): string {
  const t = report.totals;
  const parts = [
    `Transfers, cash withdrawals and loan payments (paying a card off among them) aren’t counted as money in or out${
      t.excluded > 0 ? `, and ${plural(t.excluded, 'transaction')} you excluded from budgets and reports ${t.excluded === 1 ? 'is' : 'are'} left out` : ''
    }.`,
  ];
  if (t.exclusion_unknown > 0) {
    parts.push(
      `Whether you excluded ${plural(t.exclusion_unknown, 'transaction')} couldn’t be read, so ${t.exclusion_unknown === 1 ? 'it counts' : 'they count'} here.`
    );
  }
  if (t.left_out_text) parts.push(t.left_out_text);
  return parts.join(' ');
}

/** Where an appendix row came from: a bank's, or a manual row's source as
 *  the Activity tab names it. */
export function sourceName(source: string): string {
  return source === 'plaid' ? 'from the bank' : sourceLabel(source);
}

/** The words for how an appendix row stands in the totals, or null when it
 *  counts as any other. */
export function appendixStatus(row: { not_counted: 'transfer' | 'currency' | null; pending: boolean; exclusion_unknown: boolean; currency: string | null }): string | null {
  const parts: string[] = [];
  if (row.not_counted === 'transfer') parts.push('Not counted: a transfer or loan payment');
  if (row.not_counted === 'currency') parts.push(`Not counted: in ${row.currency}`);
  if (row.pending) parts.push('Pending');
  if (row.exclusion_unknown) parts.push('Whether you excluded it couldn’t be read');
  return parts.length > 0 ? parts.join('; ') : null;
}

/** A connection's recorded state, in the words of its badge on the Connection
 *  health card (components/ConnectionHealth.tsx; test/report.test.ts holds
 *  the two together). */
export const STATE_WORDS: Readonly<Record<HealthState, string>> = {
  healthy: 'Working',
  reconnect_soon: 'Reconnect soon',
  needs_reauth: 'Needs reconnecting',
  outage: 'Not updating',
  relink: 'Needs connecting again',
  closed: 'No open accounts',
  partial: 'Missing accounts',
};

/** Why a connection brings in no transactions (lib/item-products.ts). */
export const NO_TRANSACTIONS_WORDS: Readonly<Record<NoTransactionsReason, string>> = {
  investment_accounts: 'Investment accounts only, so it brings in no transactions',
  no_cash_accounts: 'No bank account or card, so it brings in no transactions',
  refused: 'Plaid doesn’t provide transactions for its bank or card accounts',
  no_consent: 'You didn’t allow Nya to see transactions from its bank or card accounts',
};

/** The note on a group whose categories are marked: the person's choice,
 *  never Nya's, and no word on how any of it is taxed. */
export const MARKED_NOTE =
  'You marked these categories as ones that matter for your taxes. Nya doesn’t judge how any of them is taxed: that is for you and your accountant.';
