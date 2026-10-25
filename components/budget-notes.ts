// components/budget-notes.ts
//
// Budgets > Month's one notice (rollout phase 6a2, design-system.md "Status
// and honesty" rule 3): what may leave the month shown short, said once at
// the top of the segment rather than in a paragraph under the budgets. As
// components/attention.ts assembles Home's rows, this assembles the notice's
// caveats for components/TotalCaveats.tsx: one shows in full, two or more
// gather into one line that names their kinds and opens in place to each.
// Each is a caution, as the stale notes they were, in the words it had:
//
//   - this month: what the page knows may be missing from it, as Activity
//     says it (lib/month-coverage.ts, lib/no-transactions.ts);
//   - a month gone by: its own reasons, as the server read them;
//   - what a carry or the pool counts: the earlier months that may be
//     incomplete, and why ("Rollover may be off where a month is ...").
//
// The month's own notes are for its total, so they are said only where
// there is one and spending to count against it; the carry notes whenever
// there are any. The Spent card's badge ("May be incomplete") is for the
// month's own notes alone: the carry notes are about earlier months.
// Pure, client-safe.

import type { Caveat } from './TotalCaveats';
import { monthGapItems, type Incomplete, type MonthGapKind, type Stopped } from '@/lib/month-coverage';
import { missingMonthItems, type NoTransactionsView } from '@/lib/no-transactions';
import type { MonthGap } from '@/lib/rollover';

/** What a note is about. */
export type NoteKind = MonthGapKind | 'begins' | 'unread' | 'exclusions' | 'refused' | 'no_consent' | 'carry';

/** One of the month's own notes, with its kind. */
export type MonthNote = { kind: NoteKind; text: string };

/** Each kind in a few words, for the gathered line ("3 notes: a bank not
 *  syncing, transactions not loaded and rollover may be off"): never an
 *  amount. */
export const KIND_WORDS: Record<NoteKind, string> = {
  missing: 'transactions not loaded',
  stopped: 'a bank not syncing',
  importing: 'older transactions still importing',
  held: 'transactions from a download waiting',
  begins: 'a bank’s history starting later',
  refused: 'accounts Plaid doesn’t cover',
  no_consent: 'transactions not allowed',
  unread: 'records that couldn’t be read',
  exclusions: 'exclusions that couldn’t be read',
  carry: 'rollover may be off',
};

/** A reason the server gave, by kind: a bank account or card without its
 *  transactions by why. */
const kindOf = (g: MonthGap): NoteKind => (g.kind === 'without' ? g.reason : g.kind);

/** This month's own notes, from what the page holds: Activity's words for
 *  the same month. `day` names a last sync's local day ("Sep 12"). */
export function thisMonthNotes(month: string, incomplete: Incomplete[], stopped: Stopped[], without: NoTransactionsView, day: (iso: string) => string): MonthNote[] {
  const out: MonthNote[] = [];
  for (const item of monthGapItems(month, incomplete, stopped, day)) out.push(item);
  for (const item of missingMonthItems(without, month)) out.push(item);
  return out;
}

/** A month gone by's own notes, from the server's reasons for it: "March may
 *  be incomplete: Chase hasn’t synced since Mar 5." `reason` puts one in
 *  words, as a sentence's start. */
export function pastMonthNotes(name: string, gaps: readonly MonthGap[], reason: (g: MonthGap) => string): MonthNote[] {
  const out: MonthNote[] = [];
  for (const g of gaps) out.push({ kind: kindOf(g), text: `${name} may be incomplete: ${reason(g)}.` });
  return out;
}

/** The notice: the month's own notes, then why a carry may be off (the
 *  reasons, each with the months it touches), each a caution. Empty when
 *  nothing is known to be missing. */
export function monthNotice(own: readonly MonthNote[], carryReasons: readonly string[]): Caveat[] {
  const items: Caveat[] = [];
  for (const n of own) items.push({ key: `${n.kind}:${n.text}`, severity: 'caution', summary: KIND_WORDS[n.kind], body: n.text });
  if (carryReasons.length > 0) {
    const text = `Rollover may be off where a month is incomplete: ${carryReasons.join('; ')}.`;
    items.push({ key: 'carry', severity: 'caution', summary: KIND_WORDS.carry, body: text });
  }
  return items;
}
