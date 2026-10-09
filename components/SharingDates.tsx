'use client';

// Dates in sharing (#45 step 2), for the Sharing drawer and the "Shared by"
// cards (components/Sharing.tsx):
//   - when a share ends. A share runs through the last day its owner chose and
//     ends at the first instant of the next one, in their own time zone; that
//     instant is worked out here, on their device, and the server compares it
//     with the time of each read (lib/sharing.ts). An end always reads as the
//     last day the share is shown, in the reader's own time zone, never with a
//     time. The choices: no end, 7 or 30 days, tax season (from January to
//     April only, through Apr 30), or a date.
//   - when it was shown: the records of showings (lib/access-log.ts), counted
//     by the quarter hour in UTC, grouped into the reader's own days, "Shown
//     3 times on Oct 4, balances of 2 accounts". Every time zone in use is a
//     whole number of quarter hours from UTC, so each quarter hour falls in
//     exactly one of the reader's days.

import { useState } from 'react';
import { ACCESS_LOG_DAYS, widerLevel, type Level } from '@/lib/share-rules';

/** "Sep 28", with the year only when it isn't this one. Takes a YYYY-MM-DD
 *  (a calendar day, shown as it is) or a full ISO time (an instant, shown as the
 *  day it was in the viewer's own time zone, not its UTC day). */
export function shortDate(iso: string, now: Date = new Date()): string {
  const isInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:/.test(iso);
  const d = isInstant ? new Date(iso) : new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** A day in this device's time zone, as YYYY-MM-DD. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---- When a share ends ----

/** How long a renewal runs, from today. */
export const RENEW_DAYS = 30;

/** The end of a share that runs through the day `days` after today: the first
 *  instant of the day after that one, here (midnight, or later where the
 *  clocks skip midnight). */
export function endAfterDays(days: number, now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days + 1).toISOString();
}

/** The end of a share that runs through `day` (YYYY-MM-DD, from the date
 *  picker), or null for anything else. */
export function endOfDay(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  // A day that doesn't exist (Feb 30) would roll into the next month.
  if (localDay(new Date(y, mo, d)) !== day) return null;
  return new Date(y, mo, d + 1).toISOString();
}

/** The end of tax season, for the accountant: through Apr 30 of this year,
 *  offered only from January through April, so it never runs most of a year.
 *  Null the rest of the year. */
export function taxSeasonEnd(now: Date = new Date()): string | null {
  return now.getMonth() <= 3 ? new Date(now.getFullYear(), 4, 1).toISOString() : null;
}

/** The last day a share is shown, here: the day of the instant just before
 *  its end. An end chosen in this time zone is the first instant of the day
 *  after, so this is the day chosen; one chosen elsewhere is the day it ends
 *  here. Never a time. */
export function lastDay(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : localDay(new Date(t - 1));
}

/** How an end reads: the last day it is shown, here ("Apr 30"). */
export function endLabel(iso: string, now: Date = new Date()): string {
  const day = lastDay(iso);
  return day ? shortDate(day, now) : iso;
}

/** The same, always with its year ("Apr 30, 2027"). */
export function endLabelWithYear(iso: string): string {
  const day = lastDay(iso);
  return day ? new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : iso;
}

/** Whether an end has come. The server's clock decides what is shown; this
 *  is only for saying so. */
export function ended(iso: string | null, now: number = Date.now()): boolean {
  return iso !== null && Date.parse(iso) <= now;
}

/** The end chosen in the drawer: as saved ("keep"), none, 7 or 30 days, tax
 *  season, or a date. */
export type EndChoice = 'keep' | 'none' | '7' | '30' | 'tax' | 'date';

/** What saving a choice sends: an end, null for none, or undefined to leave
 *  the end as it is ("keep", a date not picked yet, or tax season outside its
 *  months). */
export function endFor(choice: EndChoice, day: string, now: Date = new Date()): string | null | undefined {
  if (choice === 'none') return null;
  if (choice === '7') return endAfterDays(7, now);
  if (choice === '30') return endAfterDays(30, now);
  if (choice === 'tax') return taxSeasonEnd(now) ?? undefined;
  if (choice === 'date') return endOfDay(day) ?? undefined;
  return undefined;
}

/** The end choice: a select, and a date picker for "a date you choose", from
 *  today to two years from today (the server allows that, and a little more:
 *  SHARE_END_MAX_DAYS in lib/share-rules.ts). */
export function EndPicker({
  saved,
  choice,
  day,
  onChoice,
  onDay,
}: {
  /** The end as saved, or null for none. */
  saved: string | null;
  choice: EndChoice;
  day: string;
  onChoice: (c: EndChoice) => void;
  onDay: (day: string) => void;
}) {
  const now = new Date();
  const tax = taxSeasonEnd(now);
  // "As saved" only means something when there is an end saved, and tax
  // season only in its months.
  const value = (choice === 'keep' && saved === null) || (choice === 'tax' && !tax) ? 'none' : choice;
  return (
    <>
      <label className="field end-picker" style={{ marginTop: 12 }}>
        How long they can see it
        <select value={value} onChange={(e) => onChoice(e.target.value as EndChoice)}>
          {saved !== null && (
            <option value="keep">{ended(saved) ? `Ended ${endLabel(saved, now)}, as saved` : `Until ${endLabel(saved, now)}, as saved`}</option>
          )}
          <option value="none">No end date</option>
          <option value="7">{`7 days, until ${endLabel(endAfterDays(7, now), now)}`}</option>
          <option value="30">{`30 days, until ${endLabel(endAfterDays(30, now), now)}`}</option>
          {tax && <option value="tax">{`Tax season, until ${endLabelWithYear(tax)}`}</option>}
          <option value="date">Until a date you choose</option>
        </select>
      </label>
      {value === 'date' && (
        <label className="field end-picker">
          The last day they can see it
          <input
            type="date"
            value={day}
            min={localDay(now)}
            max={localDay(new Date(now.getFullYear() + 2, now.getMonth(), now.getDate()))}
            onChange={(e) => onDay(e.target.value)}
          />
        </label>
      )}
    </>
  );
}

// ---- When it was shown ----

/** One quarter hour of a record, as the server sends it. */
export type Showing = { at: string; times: number; read: Record<string, Level> };
/** One of the reader's days: how many times it was shown, and each account
 *  at the widest level shown that day. */
export type ShownDay = { day: string; times: number; read: Record<string, Level> };

/** The quarter hours grouped into this device's days, newest first. */
export function shownDays(shown: Showing[]): ShownDay[] {
  const days = new Map<string, ShownDay>();
  for (const s of shown) {
    const at = new Date(s.at);
    if (Number.isNaN(at.getTime())) continue;
    const day = localDay(at);
    const d = days.get(day) ?? { day, times: 0, read: {} };
    d.times += s.times;
    for (const [id, level] of Object.entries(s.read)) d.read[id] = d.read[id] ? widerLevel(d.read[id], level) : level;
    days.set(day, d);
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** "once", "twice", "3 times". */
export function timesText(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** What was shown, widest first: "the balance and transactions of 1
 *  account, balances of 2 accounts and that 1 account exists". */
export function describeRead(read: Record<string, Level>): string {
  const n = { exists: 0, balance: 0, transactions: 0 };
  for (const level of Object.values(read)) n[level]++;
  const parts = [
    n.transactions === 1 ? 'the balance and transactions of 1 account' : n.transactions > 1 ? `balances and transactions of ${n.transactions} accounts` : '',
    n.balance === 1 ? 'the balance of 1 account' : n.balance > 1 ? `balances of ${n.balance} accounts` : '',
    n.exists === 1 ? 'that 1 account exists' : n.exists > 1 ? `that ${n.exists} accounts exist` : '',
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
}

/** "Shown 3 times on Oct 4, balances of 2 accounts." */
export function shownText(d: ShownDay, now: Date = new Date()): string {
  const what = describeRead(d.read);
  return `Shown ${timesText(d.times)} on ${shortDate(d.day, now)}${what ? `, ${what}` : ''}.`;
}

/** Days shown before "Show all". */
const FIRST_DAYS = 5;

/**
 * One record of showings on a connection: by day, or, when it has none, that
 * nothing was recorded (never that nothing was shown: a record only knows what
 * it counted, and only since it began), or why it can't be shown. `mine` is
 * my own record (when what I share was shown to them), which only I can
 * clear, and only when it is unreadable; otherwise theirs, of showings to me.
 */
export function ShowingsRecord({
  who,
  mine,
  since,
  showings,
  problem,
  busy,
  onClear,
}: {
  /** What I call them. */
  who: string;
  mine: boolean;
  /** When the connection's records began, or null before the first. */
  since: string | null;
  showings: Showing[] | null;
  problem?: 'unreadable' | 'unrecognised' | 'unavailable';
  busy: boolean;
  /** Clears my unreadable record (after confirming); absent when it can't be. */
  onClear?: () => void;
}) {
  const [all, setAll] = useState(false);
  if (showings === null) {
    if (problem === 'unreadable') {
      return mine ? (
        <>
          <p className="stale-note" style={{ marginTop: 0 }}>
            This record can’t be read, so new showings aren’t being recorded. Clearing it starts a new one; nothing readable is lost.
          </p>
          {onClear && (
            <button className="secondary" onClick={onClear} disabled={busy} style={{ marginTop: 10 }}>
              Clear the record
            </button>
          )}
        </>
      ) : (
        <p className="stale-note" style={{ marginTop: 0 }}>
          {who}’s record of this can’t be read, so new showings aren’t being recorded.
        </p>
      );
    }
    if (problem === 'unrecognised') {
      return (
        <p className="stale-note" style={{ marginTop: 0 }}>
          {mine ? 'This record' : `${who}’s record of this`} was saved by another version of Nya and can’t be shown here. It is kept as it is, and new
          showings aren’t recorded until it can be read.
        </p>
      );
    }
    return <p className="stale-note" style={{ marginTop: 0 }}>This record couldn’t be loaded. Try again later.</p>;
  }
  const days = shownDays(showings);
  if (days.length === 0) {
    const recent = since !== null && Date.now() - Date.parse(since) < ACCESS_LOG_DAYS * 86_400_000;
    return (
      <p className="panel-note" style={{ marginTop: 0 }}>
        {since === null ? 'Nothing recorded yet.' : recent ? `Nothing recorded since ${shortDate(since)}.` : `Nothing recorded in the last ${ACCESS_LOG_DAYS} days.`}
      </p>
    );
  }
  const shown = all ? days : days.slice(0, FIRST_DAYS);
  return (
    <>
      <ul className="shown-list">
        {shown.map((d) => (
          <li key={d.day}>{shownText(d)}</li>
        ))}
      </ul>
      {days.length > FIRST_DAYS && (
        <button className="link-btn" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${days.length} days`}
        </button>
      )}
    </>
  );
}
