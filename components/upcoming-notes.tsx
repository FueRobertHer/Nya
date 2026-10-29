// components/upcoming-notes.tsx
//
// Budgets > Upcoming's one notice (rollout phase 6a3, design-system.md
// "Status and honesty" rule 3): what the bills, income, planned items and
// payments coming may be missing, said once at the top of the segment
// rather than inside the forecast's card, since the list and the calendar
// under it miss the same. As components/budget-notes.ts does for Month, this
// assembles the caveats components/TotalCaveats.tsx draws: a critical one in
// full, always; the lesser ones in full when there is one, gathered into one
// line naming their kinds when there are more. Each keeps the words and the
// level it had on the forecast's card:
//
//   - transactions that couldn't be loaded (critical), or are still loading,
//     and planned items not loaded (caution): the forecast's load states;
//   - the forecast's notes about what moves it (lib/forecast.ts
//     forecastNoteItems, `of: 'items'`), each a caution.
//
// The notes about where the forecast starts (`of: 'start'`) stay on its
// card, under its "Starts from" line: they qualify that one figure (rule 1).
// With no cash accounts there is no forecast, and nothing is said here: the
// list, the calendar and Recurring say the load states in their own words.
//
// A card the notice bears on carries a badge saying so, as Month's Spent card
// does: "Incomplete" (red) when transactions couldn't be loaded, else "May be
// incomplete" (amber). The forecast's for anything the notice or its start
// notes say; the list's and the calendar's only for what can leave entries
// out of them. Pay that varies, an account of unknown type, an amount in
// another currency and a card's payment due leave none out: the list shows
// each, saying why it isn't in the day's figure (lib/calendar.ts), and a
// card's payment due is its own row. Recurring carries the list's, but not
// while transactions are loading or couldn't be, which it says in full
// itself (components/UpcomingPanel.tsx); Planned carries none.
//
// The notes name amounts (a card's payment), so they are written where the
// caveats are built, each body as <Masked>, and written again when hiding
// amounts is turned on or off.

import { useMemo } from 'react';
import type { Caveat } from './TotalCaveats';
import { Masked } from './HideAmounts';
import { useAmountsHidden } from './hide-amounts';
import { fmtDay } from './ForecastChart';
import type { ForecastInput, Forecasting } from './ForecastCard';
import { forecastNoteItems, type ForecastNote, type ForecastNoteInput, type ForecastNoteKind, type NoteDays } from '@/lib/forecast';
import { refusedNames, unallowedNames, NO_CONNECTIONS_WITHOUT } from '@/lib/no-transactions';
import type { Incomplete, Stopped } from '@/lib/month-coverage';
import { formatInstantDay } from '@/lib/format';

const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];

/** A badge for a card the segment's notice bears on, by its tone: red when
 *  transactions couldn't be loaded, amber when it may be missing something. */
export type UpcomingBadge = 'neg' | 'warn' | null;

/** That badge, in its words, at the top of its card. The words are fixed by
 *  the tone, so none of the notes it stands for is drawn in it. */
export function NoticeBadge({ tone }: { tone: 'neg' | 'warn' }) {
  return (
    <div>
      <span className={`badge ${tone}`}>{tone === 'neg' ? 'Incomplete' : 'May be incomplete'}</span>
    </div>
  );
}

/** The forecast's load states, in its words. */
export const NOT_LOADED_TEXT = "Transactions couldn't be loaded, so no bills or income are in this: it is your balance and what you planned.";
export const LOADING_TEXT = 'Transactions are still loading, so no bills or income are in this yet.';
export const PLANNED_TEXT = "Your planned items aren't loaded, so they aren't in this, and bills you marked not recurring may be.";

/** Each kind in a few words, for the gathered line ("3 notes: a bank not
 *  syncing, pay that stopped and planned items not loaded"): never an
 *  amount. The words Month uses for the same kinds (components/budget-notes.ts). */
export const KIND_WORDS: Record<ForecastNoteKind | 'not_loaded' | 'loading' | 'planned', string> = {
  not_loaded: 'transactions not loaded',
  loading: 'transactions still loading',
  planned: 'planned items not loaded',
  recovered: 'balances from an earlier day',
  unreached: 'a bank not reached',
  unshown: 'accounts not shown',
  held: 'accounts that stopped reporting',
  missing: 'a bank’s transactions not loaded',
  stopped: 'a bank not syncing',
  importing: 'older transactions still importing',
  refused: 'accounts Plaid doesn’t cover',
  no_consent: 'transactions not allowed',
  card: 'a card’s payment due',
  lapsed: 'pay that stopped',
  varies: 'pay that varies',
  typed: 'a typed balance not updated',
  no_balance: 'an account with no balance',
  accounts_currency: 'cash accounts in another currency',
  pending_currency: 'pending charges in another currency',
  amounts_currency: 'expected amounts in another currency',
  unplaced: 'an account of unknown type',
};

/** The notes that mean the list or the calendar may be leaving entries out. */
const LEAVES_OUT: ReadonlySet<ForecastNoteKind> = new Set(['missing', 'stopped', 'importing', 'refused', 'no_consent', 'lapsed']);

/** What hasn't loaded: transactions (still loading, or couldn't be), and the
 *  planned items, until they are drawn (ready, or held through a refused
 *  save's reload: components/BudgetsTab.tsx). */
export type UpcomingStates = { failed: boolean; loading: boolean; plannedDrawn: boolean };

/** How the notes name a day, on the viewer's calendar. */
const DAYS: NoteDays = {
  snapshot: (date, at) => (at ? (formatInstantDay(at, { sentence: true }) ?? fmtDay(date)) : fmtDay(date)),
  instant: (iso) => formatInstantDay(iso, { sentence: true }) ?? iso.slice(0, 10),
  day: (date) => fmtDay(date),
};

/** What the forecast's notes are written from: what it was worked out from,
 *  and what it left out (useForecast). */
export function noteInput(
  { institutions, planned, plannedDrawn, today, incomplete = NO_GAPS, stopped = NO_STOPPED, withoutTransactions = NO_CONNECTIONS_WITHOUT }: ForecastInput,
  { position, until, expected }: Forecasting
): ForecastNoteInput {
  return {
    institutions,
    position,
    eventsLeftOut: expected.leftOut,
    eventsConversion: expected.conversion,
    series: { varied: expected.varied, lapsed: expected.lapsed, unplaced: expected.unplaced, cardsPaid: expected.cardsPaid },
    until,
    planned: plannedDrawn ? planned.items : [],
    stopped,
    incomplete,
    refused: refusedNames(withoutTransactions),
    unallowed: unallowedNames(withoutTransactions),
    today,
    days: DAYS,
  };
}

/** The forecast's load states, critical first: each in its words, none
 *  naming an amount. */
export function loadStates({ failed, loading, plannedDrawn }: UpcomingStates): Caveat[] {
  const out: Caveat[] = [];
  if (failed) out.push({ key: 'not_loaded', severity: 'critical', summary: KIND_WORDS.not_loaded, body: NOT_LOADED_TEXT });
  else if (loading) out.push({ key: 'loading', severity: 'caution', summary: KIND_WORDS.loading, body: LOADING_TEXT });
  if (!plannedDrawn) out.push({ key: 'planned', severity: 'caution', summary: KIND_WORDS.planned, body: PLANNED_TEXT });
  return out;
}

/** Which cards carry a badge, and which: none without a forecast
 *  (`forecast`, cash accounts to start from), since there is no notice for
 *  one to point to. */
export function upcomingBadges(
  forecast: boolean,
  states: UpcomingStates,
  notes: readonly Pick<ForecastNote, 'kind' | 'of'>[]
): { forecast: UpcomingBadge; list: UpcomingBadge; calendar: UpcomingBadge } {
  if (!forecast) return { forecast: null, list: null, calendar: null };
  const short: UpcomingBadge = 'neg';
  const maybe: UpcomingBadge = 'warn';
  const unloaded = states.loading || !states.plannedDrawn;
  const card = states.failed ? short : unloaded || notes.length > 0 ? maybe : null;
  const list = states.failed ? short : unloaded || notes.some((n) => n.of === 'items' && LEAVES_OUT.has(n.kind)) ? maybe : null;
  return { forecast: card, list, calendar: list };
}

/** What the segment says of what it may be missing: the notice at its top
 *  (with a forecast: its load states, then its notes about what moves it,
 *  each a caution), the forecast's notes about where it starts (each a
 *  caution, for its card), and the badges. */
export type UpcomingNotes = { notice: Caveat[]; start: Caveat[]; badges: ReturnType<typeof upcomingBadges> };

/** The notes of a forecast worked out (useForecast), as the segment says
 *  them, with what transactions are doing; whether the planned items are
 *  drawn is the forecast's own (`input.plannedDrawn`). */
export function useUpcomingNotes(input: ForecastInput, work: Forecasting, { failed, loading }: Omit<UpcomingStates, 'plannedDrawn'>): UpcomingNotes {
  // `hidden` isn't read inside: it changes what formatMoney writes there.
  const hidden = useAmountsHidden();
  const { institutions, planned, plannedDrawn, today, incomplete, stopped, withoutTransactions } = input;
  return useMemo(
    () => {
      const notes = forecastNoteItems(noteInput(input, work));
      const states = { failed, loading, plannedDrawn };
      // Each note in its words, a caution: about where the forecast starts
      // for its card, the rest for the top. Built in a loop, one at a time.
      const notice: Caveat[] = work.has ? loadStates(states) : [];
      const start: Caveat[] = [];
      for (const n of notes) {
        const said: Caveat = { key: `${n.kind}:${n.text}`, severity: 'caution', summary: KIND_WORDS[n.kind], body: <Masked>{n.text}</Masked> };
        if (n.of === 'start') start.push(said);
        else if (work.has) notice.push(said);
      }
      return { notice, start, badges: upcomingBadges(work.has, states, notes) };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [institutions, planned, plannedDrawn, today, incomplete, stopped, withoutTransactions, work.has, work.position, work.until, work.expected, failed, loading, hidden]
  );
}
