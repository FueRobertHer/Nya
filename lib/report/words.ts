// lib/report/words.ts
//
// What a report says, in plain words: its title, whether anything may be
// missing and why, and the caveats on its totals. One place, so the printed
// page (components/ReportView.tsx) and the CSV (lib/report/csv.ts) say the
// same thing, in the words the app uses for the same facts: "hasn't synced
// since", "still importing older transactions", "Plaid doesn't provide their
// transactions" (lib/month-coverage.ts, lib/no-transactions.ts), "no longer
// yours" (components/AccountLifecycle.tsx). Pure and client-safe. Each takes
// `day`, how a calendar day is written: the page's local date, the CSV's
// YYYY-MM-DD.

import { joinNames } from '../month-coverage';
import { sourceLabel } from '../manual-txn-input';
import type { HealthState } from '../connection-state';
import type { NoTransactionsReason } from '../item-products';
import type { Gap, Report, ReportEnded } from './build';

/** How a calendar day (YYYY-MM-DD) is written. */
export type DayFormat = (day: string) => string;

/** "2025 tax year" or "Jan 1, 2026 to Mar 31, 2026". */
export function reportTitle(report: Pick<Report, 'period'>, day: DayFormat): string {
  const { period } = report;
  return period.kind === 'year' ? `${period.start.slice(0, 4)} tax year` : `${day(period.start)} to ${day(period.end)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** " at Chase", or nothing for an account whose institution isn't known. */
const at = (institution: string) => (institution ? ` at ${institution}` : '');
/** The days of a window, "on Mar 3" or "from Mar 3 to Mar 9". */
const span = (from: string, to: string, day: DayFormat) => (from === to ? `on ${day(from)}` : `from ${day(from)} to ${day(to)}`);

/** The gaps not tied to an institution, in fixed words. */
const LOOSE: Readonly<Record<'removed_unknown' | 'own_categories' | 'own_exclusions', string>> = {
  removed_unknown: 'Whether a connection was removed couldn’t be read, so this report may be missing its transactions.',
  own_categories: 'Your own categories couldn’t be read, so these totals use the bank’s.',
  own_exclusions: 'The exclusions you carried across a reconnected account couldn’t be read, so these totals may count transactions you excluded.',
};

/**
 * Each gap as a sentence, in the order given. Gaps of one kind without a day
 * of their own are said together, as the app's month notes say them; a stale
 * connection, a late start, a missing account and a removal each have their
 * own day, and their own sentence.
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
      case 'partial':
        out.push(`An account at ${g.institution} stopped appearing on ${day(g.since)}: if it is still open, its later transactions aren’t here.`);
        break;
      case 'begins_late':
        out.push(
          `${g.institution}’s transactions in Nya ${g.from === 'stored' ? 'begin on' : 'can go back only to'} ${day(g.first)}: if its accounts were open before then, this report is missing their earlier transactions.`
        );
        break;
      case 'removed': {
        const which = joinNames(g.accounts);
        out.push(
          g.partly_back
            ? `${g.institution} was removed on or after ${day(g.last_seen)} and connected again, but not ${which}: the transactions ${g.accounts.length === 1 ? 'it' : 'they'} brought in went with the old connection, so this report may be missing some of them.`
            : `${g.institution}${which ? ` (${which})` : ''} was removed on or after ${day(g.last_seen)}, and the transactions it brought in went with it, so this report may be missing some of them.`
        );
        break;
      }
      case 'disconnected': {
        const one = g.accounts.length === 1;
        out.push(
          `${joinNames(g.accounts)} at ${g.institution} ${one ? 'was' : 'were'} disconnected on ${day(g.since)} and kept as ${one ? 'a manual account' : 'manual accounts'}, so from then on ${one ? 'its' : 'their'} transactions are only the ones you entered or imported: this report may be missing some of them.`
        );
        break;
      }
      case 'removed_unknown':
      case 'own_categories':
      case 'own_exclusions':
        out.push(LOOSE[g.kind]);
        break;
      case 'unreadable':
        out.push(`${g.note.replace(/[.\s]+$/, '')}.`);
        break;
      case 'assumed_closed':
        out.push(
          `${g.account}${at(g.institution)} stopped appearing, and as nobody said whether it closed, Nya took it as closed on ${day(g.on)}: if it is still open, its transactions from then aren’t here.`
        );
        break;
      case 'missed':
        out.push(
          g.let_go
            ? `You stopped tracking ${g.account}${at(g.institution)} before its transactions ${span(g.from, g.to, day)} came in, so this report may be missing them.`
            : `${g.account} was missing${at(g.institution)} ${span(g.from, g.to, day)}, so this report may be missing its transactions from ${g.from === g.to ? 'that day' : 'those days'}.`
        );
        break;
      case 'untracked':
        out.push(
          `You stopped following ${g.account}${at(g.institution)} from ${day(g.from)}: it is still yours, but its transactions from then aren’t in this report${
            g.not_counted > 0 ? `, ${plural(g.not_counted, 'transaction')} in Nya among them` : ''
          }.`
        );
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
    case 'partial':
      return `An account stopped appearing on ${day(g.since)}`;
    case 'importing':
      return 'Still importing older transactions';
    case 'begins_late':
      return `Its transactions in Nya ${g.from === 'stored' ? 'begin on' : 'can go back only to'} ${day(g.first)}`;
    case 'refused':
      return 'Plaid doesn’t provide its bank or card transactions';
    case 'no_consent':
      return 'You didn’t allow its bank or card transactions';
    case 'removed':
      return `Removed on or after ${day(g.last_seen)}`;
    case 'disconnected':
      return `Disconnected on ${day(g.since)}, kept as a manual account`;
    case 'removed_unknown':
    case 'own_categories':
    case 'own_exclusions':
      return LOOSE[g.kind];
    case 'unreadable':
      return g.note;
    case 'assumed_closed':
      return `${g.account} assumed closed on ${day(g.on)}`;
    case 'missed':
      return g.let_go ? `${g.account} let go before its transactions ${span(g.from, g.to, day)} came in` : `${g.account} missing ${span(g.from, g.to, day)}`;
    case 'untracked':
      return `${g.account} not followed from ${day(g.from)}`;
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

/** What settles an assumed closure: said once, after the gaps, when any is. */
export const ASSUMED_REMEDY =
  'Accounts that ended, on the Accounts tab, lists each account Nya assumed closed, to confirm or correct. Then make this report again.';

/** What may be missing: each gap, the remedy where a sync or an answer can
 *  help, and why no connection brings in spending, when none can. */
export function problemLines(report: Pick<Report, 'gaps' | 'no_spending'>, day: DayFormat): string[] {
  const lines = gapSentences(report.gaps, day);
  if (report.gaps.some((g) => g.kind === 'stale' || g.kind === 'missing' || g.kind === 'importing')) lines.push(SYNC_REMEDY);
  if (report.gaps.some((g) => g.kind === 'assumed_closed')) lines.push(ASSUMED_REMEDY);
  if (report.no_spending) lines.push(`${report.no_spending.lead}, so no bank or card transactions come in. To see spending, ${report.no_spending.remedy}.`);
  return lines;
}

/** The lines under the headline: what may be missing, then the period's own
 *  caveats. */
export function statusLines(report: Report, day: DayFormat): string[] {
  return [...problemLines(report, day), ...caveatLines(report, day)];
}

/** What the report covers, when some account holds what it doesn't: activity
 *  inside investment accounts (trades, dividends, interest) and inside loans
 *  never comes in as transactions. Null when no account does. */
export function scopeLine(scope: Report['caveats']['scope']): string | null {
  if (!scope.investment && !scope.loans) return null;
  const inside = scope.investment && scope.loans ? 'investment and loan accounts' : scope.investment ? 'investment accounts' : 'loan accounts';
  const such = scope.investment ? 'trades, dividends and interest' : 'interest charged';
  return `This report covers bank and card transactions and the ones you entered or imported. Activity inside ${inside}, such as ${such}, isn’t in it.`;
}

/** The marked categories couldn't be read: their group is left out. */
export const MARKED_UNREAD =
  'The categories you marked for taxes couldn’t be read, so their group and their transactions are left out of this report.';

/** What a manual account's transactions are. */
export const MANUAL_NOTE = 'Transactions on a manual account are the ones you entered or imported: Nya can’t tell whether any are missing.';

/** What is true of the period whatever the data: a year still running, days
 *  still settling, what the report covers, accounts left out, and what
 *  couldn't be read about the connections or the person's own choices. */
export function caveatLines(report: Report, day: DayFormat): string[] {
  const { caveats, period } = report;
  const out: string[] = [];
  // A card SimpleFIN reports as money held, waiting for an answer: its
  // balance is held in the app, never its transactions.
  for (const i of report.institutions) {
    const c = i.connector;
    if (!c || c.waiting.length === 0) continue;
    const one = c.waiting.length === 1;
    out.push(
      `${c.label} reports ${joinNames(c.waiting)} at ${i.institution_name} as money held, and Nya is waiting for your answer about ${one ? 'it' : 'them'}: that holds ${one ? 'its' : 'their'} balance in the app, not ${one ? 'its' : 'their'} transactions, which are in this report as ${c.label} reports them.`
    );
  }
  if (caveats.not_over) out.push(`${period.start.slice(0, 4)} isn’t over: this report covers ${day(period.start)} to ${day(period.through)}.`);
  if (caveats.settling) out.push('Banks can take a few days to post a transaction, so the last days of this period may still change.');
  const scope = scopeLine(caveats.scope);
  if (scope) out.push(scope);
  if (caveats.hidden) out.push('Accounts you hid are left out, as everywhere in Nya.');
  if (caveats.marked === 'unreadable') out.push(MARKED_UNREAD);
  if (caveats.names_unread) out.push('Your names for merchants couldn’t be read, so the bank’s are shown.');
  if (caveats.health_unread) out.push('How each bank connection is doing couldn’t be read, so what is said of each may be missing something.');
  return out;
}

/** What the totals leave out, as the Activity tab says it under a month: the
 *  transfers, what the person excluded and what a rule hides, what couldn't
 *  be read, and other currencies; and the transactions dated from the day
 *  their account ended (see lib/report/build.ts ENDED ACCOUNTS). */
export function totalsNote(report: Pick<Report, 'totals'> & { ended?: readonly Pick<ReportEnded, 'not_counted'>[] }): string {
  const t = report.totals;
  const afterEnd = (report.ended ?? []).reduce((n, e) => n + e.not_counted, 0);
  const byRule = t.hidden_by_rule;
  const byYou = t.excluded - byRule;
  const left = [
    ...(byYou > 0 ? [`${plural(byYou, 'transaction')} you excluded from budgets and reports`] : []),
    ...(byRule > 0 ? [byYou > 0 ? `${byRule} a rule hides` : `${plural(byRule, 'transaction')} a rule hides`] : []),
  ];
  const parts = [
    `Transfers, cash withdrawals and loan payments (paying a card off among them) aren’t counted as money in or out${
      left.length > 0 ? `, and ${left.join(' and ')} ${t.excluded === 1 ? 'is' : 'are'} left out` : ''
    }.`,
  ];
  if (t.exclusion_unknown > 0) {
    parts.push(
      `Whether you excluded ${plural(t.exclusion_unknown, 'transaction')} couldn’t be read, so ${t.exclusion_unknown === 1 ? 'it counts' : 'they count'} here.`
    );
  }
  if (t.left_out_text) parts.push(t.left_out_text);
  if (afterEnd > 0) {
    parts.push(
      `${plural(afterEnd, 'transaction')} on an account that had ended by ${afterEnd === 1 ? 'its' : 'their'} date ${afterEnd === 1 ? 'is' : 'are'} left out, as everywhere in Nya.`
    );
  }
  return parts.join(' ');
}

/** How an account ended, with its day: the Accounts tab's words
 *  (components/AccountLifecycle.tsx endText) for a day on paper. */
export function endedWords(e: Pick<ReportEnded, 'state' | 'assumed' | 'end'>, day: DayFormat): string {
  switch (e.state) {
    case 'closed':
      return e.assumed ? `Assumed closed on ${day(e.end)}` : `Closed on ${day(e.end)}`;
    case 'left':
      return `No longer yours from ${day(e.end)}`;
    case 'untracked':
      return `Not followed from ${day(e.end)}`;
  }
}

/** What of an account that ended is in the report: the days it counts on,
 *  and its later transactions in Nya, left out. */
export function endedCounted(e: Pick<ReportEnded, 'counted_through' | 'not_counted'>, day: DayFormat): string {
  const parts = [e.counted_through ? `Counted through ${day(e.counted_through)}` : 'Not counted on any day of this period'];
  if (e.not_counted > 0) parts.push(`${plural(e.not_counted, 'transaction')} dated from then ${e.not_counted === 1 ? 'is' : 'are'} in Nya and left out`);
  return parts.join('; ');
}

/** A connection whose every account had ended by the period's first day
 *  (lib/report/build.ts endedBefore), in its row. */
export function endedConnection(endedBy: string, day: DayFormat): string {
  return `Its accounts had all ended by ${day(endedBy)}: nothing of it is in this period`;
}

/** What the list of accounts that ended means. */
export const ENDED_NOTE =
  'Each of these counts on every day before the one it ended, and on none after, as everywhere in Nya. Closed: it no longer exists. No longer yours: it still exists, but isn’t yours. Not followed: it is still yours, but you stopped following it, so its later transactions aren’t here.';

/** Where an appendix row came from: a bank's, or a manual row's source as
 *  the Activity tab names it. */
export function sourceName(source: string): string {
  return source === 'plaid' ? 'from the bank' : sourceLabel(source);
}

/** The words for how an appendix row stands in the totals, or null when it
 *  counts as any other. */
export function appendixStatus(row: {
  not_counted: 'excluded' | 'hidden' | 'transfer' | 'currency' | null;
  pending: boolean;
  exclusion_unknown: boolean;
  currency: string | null;
}): string | null {
  const parts: string[] = [];
  if (row.not_counted === 'excluded') parts.push('Not counted: you excluded it');
  if (row.not_counted === 'hidden') parts.push('Not counted: hidden by a rule');
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

/** A connection that brings in no transactions, in its row: what kind it
 *  is, and what that leaves out (lib/item-products.ts). */
export const NO_TRANSACTIONS_WORDS: Readonly<Record<NoTransactionsReason, string>> = {
  investment_accounts: 'Investment accounts: their activity isn’t in this report',
  no_cash_accounts: 'No bank account or card: its accounts’ activity isn’t in this report',
  refused: 'Plaid doesn’t provide transactions for its bank or card accounts',
  no_consent: 'You didn’t allow Nya to see transactions from its bank or card accounts',
};

/** The note on a group whose categories are marked: the person's choice,
 *  never Nya's, and no word on how any of it is taxed. */
export const MARKED_NOTE =
  'You marked these categories as ones that matter for your taxes. Nya doesn’t judge how any of them is taxed: that is for you and your accountant.';
