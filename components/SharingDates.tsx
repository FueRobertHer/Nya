'use client';

// Dates in sharing (#45 step 2), for the Sharing drawer and the "Shared by"
// cards (components/Sharing.tsx):
//   - when a share ends. A share runs through the last day its owner chose and
//     ends at the start of the next one, in their own time zone; that instant
//     is worked out here, on their device, and the server compares it with the
//     time of each read (lib/sharing.ts). The choices: no end, 7 or 30 days,
//     the end of tax season (Apr 30), or a date.
//   - when they looked: the access log's hours (lib/access-log.ts), grouped
//     into the owner's own days, "Viewed 3 times on Oct 4, balances of 2
//     accounts". The server keeps hours in UTC and doesn't know the owner's
//     time zone, so the days are made here.

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

/** The end of a share that runs through the day `days` after today: the start
 *  of the day after that one, here. */
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

/** The end of tax season, for the accountant: through Apr 30, this year's
 *  until it has passed, then next year's. */
export function taxSeasonEnd(now: Date = new Date()): string {
  const year = now.getMonth() > 3 ? now.getFullYear() + 1 : now.getFullYear(); // after April: next year's
  return new Date(year, 4, 1).toISOString();
}

/** How an end reads here: the last day it runs through ("Apr 30") when it
 *  falls at the start of a day here, as one chosen in this time zone does, else
 *  the day and time it falls ("May 1, 6:00 AM"), as one chosen in another
 *  time zone may. */
export function endLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) {
    return shortDate(localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)), now);
  }
  return `${shortDate(iso, now)}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
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
 *  the end as it is ("keep", or a date not picked yet). */
export function endFor(choice: EndChoice, day: string, now: Date = new Date()): string | null | undefined {
  if (choice === 'none') return null;
  if (choice === '7') return endAfterDays(7, now);
  if (choice === '30') return endAfterDays(30, now);
  if (choice === 'tax') return taxSeasonEnd(now);
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
  // "As saved" only means something when there is an end saved.
  const value = choice === 'keep' && saved === null ? 'none' : choice;
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
          <option value="tax">{`Tax season, until ${endLabel(taxSeasonEnd(now), now)}`}</option>
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

// ---- When they looked ----

/** One hour of the access log, as the server sends it. */
export type LoggedHour = { hour: string; views: number; read: Record<string, Level> };
/** One of the owner's days: its looks, and each account at the widest level
 *  shown that day. */
export type LookedDay = { day: string; views: number; read: Record<string, Level> };

/** The hours grouped into this device's days, newest first. An hour belongs to
 *  the day it starts in here. */
export function lookedDays(hours: LoggedHour[]): LookedDay[] {
  const days = new Map<string, LookedDay>();
  for (const h of hours) {
    const at = new Date(h.hour);
    if (Number.isNaN(at.getTime())) continue;
    const day = localDay(at);
    const d = days.get(day) ?? { day, views: 0, read: {} };
    d.views += h.views;
    for (const [id, level] of Object.entries(h.read)) d.read[id] = d.read[id] ? widerLevel(d.read[id], level) : level;
    days.set(day, d);
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** "once", "twice", "3 times". */
export function timesText(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** What they were shown, widest first: "the balance and transactions of 1
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

/** "Viewed 3 times on Oct 4, balances of 2 accounts." */
export function lookedText(d: LookedDay, now: Date = new Date()): string {
  const what = describeRead(d.read);
  return `Viewed ${timesText(d.views)} on ${shortDate(d.day, now)}${what ? `, ${what}` : ''}.`;
}

/** Days shown before "Show all". */
const FIRST_DAYS = 5;

/** "When they looked", for one connection: their looks by day, or why they
 *  can't be shown. `views` is null when the record can't be used, and
 *  `problem` says why; only an unreadable (damaged) one can be cleared. */
export function WhenTheyLooked({
  who,
  since,
  views,
  problem,
  busy,
  onClear,
}: {
  /** What I call them. */
  who: string;
  /** When we connected: an ISO time. */
  since: string;
  views: LoggedHour[] | null;
  problem?: 'unreadable' | 'unrecognised' | 'unavailable';
  busy: boolean;
  onClear: () => void;
}) {
  const [all, setAll] = useState(false);
  if (views === null) {
    if (problem === 'unreadable') {
      return (
        <>
          <p className="stale-note" style={{ marginTop: 0 }}>
            The record of when {who} looked can’t be read, so new looks aren’t being recorded. Clearing it starts a new one; nothing readable is lost.
          </p>
          <button className="secondary" onClick={onClear} disabled={busy} style={{ marginTop: 10 }}>
            Clear the record
          </button>
        </>
      );
    }
    if (problem === 'unrecognised') {
      return <p className="stale-note" style={{ marginTop: 0 }}>The record of when {who} looked was saved by another version of Nya and can’t be shown here. It is kept as it is.</p>;
    }
    return <p className="stale-note" style={{ marginTop: 0 }}>The record of when {who} looked couldn’t be loaded. Try again later.</p>;
  }
  const days = lookedDays(views);
  if (days.length === 0) {
    const young = Date.now() - Date.parse(since) < ACCESS_LOG_DAYS * 86_400_000;
    return <p className="panel-note" style={{ marginTop: 0 }}>{young ? `${who} hasn’t looked yet.` : `${who} hasn’t looked in the last ${ACCESS_LOG_DAYS} days.`}</p>;
  }
  const shown = all ? days : days.slice(0, FIRST_DAYS);
  return (
    <>
      <ul className="looked-list">
        {shown.map((d) => (
          <li key={d.day}>{lookedText(d)}</li>
        ))}
      </ul>
      {days.length > FIRST_DAYS && (
        <button className="link-btn" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${days.length} days`}
        </button>
      )}
    </>
  );
}
