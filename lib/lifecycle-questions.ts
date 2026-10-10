// lib/lifecycle-questions.ts
//
// Detection (#50): Nya ASKS whether an account ended, and never guesses. Two
// signals raise a question on the account and in connection health, with
// three answers: Closed (the day prefilled), Still open, and Stop tracking.
//
//   MISSING. An account absent from an otherwise healthy answer of its bank
//   (lib/vanished.ts). "Chase Savings ••4821 hasn't appeared since Mar 12.
//   Closed?" The day prefilled for Closed is the day after it was last
//   measured, so the last day its money was seen stays untouched.
//
//   ZERO. A linked account whose balance has been exactly zero on every day
//   it was measured for at least ZERO_DAYS (and on at least
//   ZERO_MEASURED_DAYS of them), with no transaction on it since. Some banks
//   return a closed account at zero rather than leaving it out. The day
//   prefilled is the first day of the zeros.
//
// UNTIL A MISSING ACCOUNT'S QUESTION IS ANSWERED it is HELD, exactly as a
// fetch error is: shown and counted at its last known balance, marked as
// such (holdMissingAccounts, display only, after the snapshot gate, as
// lib/last-known.ts recovers a failed institution), and its institution
// keeps the snapshot gate closed (`unconfirmed_missing`, lib/networth.ts
// isRecordable), so no total is recorded. A pending question is an
// unresolved measurement, not a measured zero: recording a total without the
// account would write its disappearance into the real history layer as
// though it had been measured, and a closed card would read as good news.
// The accounts the institution did return are still recorded to the
// per-account layer, as they always were: they were measured.
//
// A ZERO HOLDS NOTHING, by choice. The hold exists so that an unresolved
// account never moves net worth; a zero can't move it whichever way the
// question is answered (closed from the first day of the zeros subtracts
// zero), and every day of the zeros was measured and is already recorded at
// zero. Closing the gate would cost days of real history to protect nothing.
// Its "last known balance" is the zero it shows. So the question is asked,
// and stays on the account and in connection health until it is answered or
// the account shows a balance or a transaction again, which withdraws it.
//
// THE WAY OUT (nobody answers a missing account). Holding forever needs a way
// out: one account nobody looks at must not stop net worth being recorded for
// good. So the grace window stays (lib/vanished.ts CONFIRM_AFTER_DAYS), and
// when it passes with no answer, the outcome is RECORDED as an ASSUMED
// closure (assumeClosed): closed from the day after it was last measured,
// marked assumed, with an auto note on the timeline saying so ("assumed
// closed: it stopped appearing at Chase"), shown as assumed on the Accounts
// tab with the same three answers, so the person can confirm or correct it.
// The gate then reopens. Nothing is silently moved: the account is
// subtracted only from the day it stopped being measured, so the days it was
// measured keep it, and the days after hold no measurement of it to remove;
// the real layer is never written with a guess (the gate stayed shut
// throughout the window, and an assumption writes only lib/lifecycle.ts's own
// store). If the account comes back in a healthy answer, the assumption was
// wrong, and it is lifted by itself (lib/lifecycle.ts liftAssumedClosures).
// An assumed closure that can't be recorded (its store unreachable or
// unreadable) is not accepted silently either: the account stays held, and
// it is tried again on the next load or snapshot.
//
// "Still open" on a missing account is the person's word against the bank's
// answer: the account stays held, for as long as it is missing (as a broken
// connection stays held), and is never assumed closed. Connection health
// says what to do: reconnect, or answer again.

import type { Ctx } from './containers';
import { sameAccountIds, type Link } from './link-core';
import { directoryEntries, type DirectoryEntry } from './links';
import { latestMeasuredBalances, readMeasuredBalances } from './history';
import { readStoredTxns } from './transactions';
import { bankCurrencies } from './sharing';
import { clearCaches } from './cache';
import { addDays } from './manual-txn-input';
import {
  recordAssumedClosures,
  lifecycleOf,
  utcDay,
  type AccountAbout,
  type LifecycleView,
  type QuestionKind,
} from './lifecycle';

/** How long a balance must have been zero before Nya asks. */
export const ZERO_DAYS = 28;
/** How many days of those it must have been measured on, so a few
 *  measurements weeks apart never pass for a dormant month. */
export const ZERO_MEASURED_DAYS = 14;
/** How far back the zeros are read: the start of a longer run is reported
 *  as this many days ago, and the question says "since" then. */
export const ZERO_SCAN_DAYS = 60;
/** How old a last known balance may be and still be held and counted, as
 *  lib/last-known.ts limits a recovered one (MAX_SNAPSHOT_AGE_DAYS). */
export const HELD_MAX_AGE_DAYS = 35;

/** A question on an account, as the app reads it (on the account's row). */
export type AccountQuestion = {
  kind: QuestionKind;
  /** The day to prefill as the end: the day after it was last measured
   *  (missing), or the first day of the zeros (zero). */
  end: string;
  /** Missing: the last day it was measured, or null when none is recorded.
   *  Zero: the first day of the zeros. */
  since: string | null;
  /** Missing, answered "Still open": held until it comes back. */
  still_open?: true;
};

// ---- The way out: assumed closures ----

/** What the directory says of an account, for naming and signing it. */
export function aboutFromDirectory(entry: DirectoryEntry | undefined, item_id: string): AccountAbout {
  return {
    type: entry?.type ?? null,
    label: { name: entry?.name ?? entry?.official_name ?? 'Account', institution: entry?.institution_name ?? '', mask: entry?.mask ?? null },
    item_id,
  };
}

/**
 * The days each missing account was last measured (any id it has had), or
 * null when that can't be read: the caller then falls back to when it was
 * first seen missing.
 */
async function lastMeasured(ctx: Ctx, ids: string[], links: ReadonlyMap<string, Link>): Promise<Map<string, { date: string; value: number }> | null> {
  try {
    return await latestMeasuredBalances(ctx, new Map(ids.map((id) => [id, sameAccountIds(id, links as Map<string, Link>)])));
  } catch (err) {
    console.error('Account lifecycle: when a missing account was last measured could not be read', err instanceof Error ? err.name : typeof err);
    return null;
  }
}

/**
 * Records an assumed closure for each account missing past the grace window
 * with no answer (see THE WAY OUT), and returns the ids that now have an
 * answer. Each is closed from the day after it was last measured, or from the
 * day it was first seen missing when no measurement is recorded. Throws only
 * what says nothing about the accounts (storage out of reach); the caller
 * then holds them all.
 */
export async function assumeClosed(
  ctx: Ctx,
  item_id: string,
  missing: { account_id: string; missing_since: string }[],
  links: ReadonlyMap<string, Link>,
  now: number = Date.now()
): Promise<Set<string>> {
  if (missing.length === 0) return new Set();
  const ids = missing.map((m) => m.account_id);
  const [entries, measured] = await Promise.all([directoryEntries(ctx, ids), lastMeasured(ctx, ids, links)]);
  const answered = await recordAssumedClosures(
    ctx,
    missing.map(({ account_id, missing_since }) => {
      const last = measured?.get(account_id)?.date ?? null;
      const firstMissing = Number.isFinite(Date.parse(missing_since)) ? utcDay(Date.parse(missing_since)) : utcDay(now);
      return { account_id, on: last ? addDays(last, 1) : firstMissing, about: aboutFromDirectory(entries[account_id], item_id) };
    }),
    now
  );
  // The dashboard's cached payload may hold the account as it was.
  if (answered.size > 0) await clearCaches(ctx).catch(() => {});
  return answered;
}

// ---- Holding a missing account (the dashboard only) ----

/** What holdMissingAccounts needs of an institution: its server-only list of
 *  missing ids (lib/networth.ts), and its rows to add the held ones to. */
type HoldingInstitution = { item_id: string; manual?: boolean; error: string | null; accounts: any[]; missing_ids?: string[] };

/**
 * Adds a row for each account missing from a healthy answer and not yet
 * answered (or answered "Still open"): HELD at its last known balance, marked
 * `stale` (display only: never recorded, lib/networth.ts accountBalanceMap)
 * and `held`, with its question. For the dashboard, after the snapshot gate
 * and after the accounts were remembered: a held row must never be recorded,
 * remembered or written to the directory as if it had answered. A balance
 * older than HELD_MAX_AGE_DAYS, or one of an account whose kind isn't known
 * (it can't be signed), is held without a balance: the row says so, and it
 * isn't counted. Reads only when something is missing. Never throws: a hold
 * that can't be drawn leaves the institution's own note to say it is short.
 */
export async function holdMissingAccounts(
  ctx: Ctx,
  institutions: HoldingInstitution[],
  view: LifecycleView,
  links: ReadonlyMap<string, Link>,
  now: number = Date.now()
): Promise<void> {
  const missing = institutions.flatMap((inst) => (inst.error || inst.manual ? [] : (inst.missing_ids ?? []).map((id) => ({ inst, id }))));
  if (missing.length === 0) return;
  try {
    const ids = missing.map((m) => m.id);
    const [entries, measured, currencies] = await Promise.all([
      directoryEntries(ctx, ids),
      lastMeasured(ctx, ids, links),
      // A currency is how a balance is drawn: lenient (a display convenience).
      bankCurrencies(ctx, ids).catch(() => new Map<string, string>()),
    ]);
    const oldest = addDays(utcDay(now), -HELD_MAX_AGE_DAYS);
    for (const { inst, id } of missing) {
      if (inst.accounts.some((a) => a?.account_id === id)) continue;
      const about = aboutFromDirectory(entries[id], inst.item_id);
      const last = measured?.get(id) ?? null;
      const usable = last && last.date >= oldest && about.type !== null ? last : null;
      const answer = lifecycleOf(view, id);
      const stillOpen = answer?.lifecycle.state === 'active' && answer.answered?.kind === 'missing';
      const question: AccountQuestion = {
        kind: 'missing',
        end: last ? addDays(last.date, 1) : utcDay(now),
        since: last?.date ?? null,
        ...(stillOpen ? { still_open: true as const } : {}),
      };
      inst.accounts.push({
        account_id: id,
        name: about.label.name,
        official_name: entries[id]?.official_name ?? null,
        mask: about.label.mask,
        type: about.type ?? 'other',
        subtype: entries[id]?.subtype ?? null,
        balance: usable ? usable.value : null,
        available: null,
        limit: null,
        currency: currencies.get(id) ?? null,
        stale: true,
        held: { as_of: usable ? usable.date : null, ...(last && !usable ? { too_old: last.date } : {}) },
        question,
      });
    }
  } catch (err) {
    console.error('Account lifecycle: a missing account could not be held at its last balance', err instanceof Error ? err.name : typeof err);
  }
}

// ---- Asking about a zero ----

/**
 * The run of zeros a balance history ends with, from per-day measurements of
 * one account (newest last is not assumed: any order). Null unless the
 * newest measurement is zero. `start` is the first day of the run within the
 * days given; `clamped` says it reaches back to the first day given without a
 * non-zero day, so the run may be longer. Pure.
 */
export function zeroRun(measured: ReadonlyMap<string, number>, firstDay: string): { start: string; days: number; clamped: boolean } | null {
  const days = [...measured.keys()].sort().reverse();
  if (days.length === 0 || measured.get(days[0]) !== 0) return null;
  let start = days[0];
  let count = 0;
  for (const day of days) {
    if (measured.get(day) !== 0) return { start, days: count, clamped: false };
    start = day;
    count++;
  }
  return { start: start <= firstDay ? firstDay : start, days: count, clamped: true };
}

type AskingInstitution = { item_id: string; manual?: boolean; error: string | null; accounts: any[] };

/**
 * Asks about each linked account whose balance has been zero for weeks with
 * no transaction since (see ZERO): sets `question` on its row. Skips hidden
 * and ended accounts, and those the person said are still open while the
 * zeros they answered about go on. Reads only when an account shows exactly
 * zero now. Never throws, and a store it can't read asks nothing: a question
 * is a convenience, never a hold.
 */
export async function askAboutZeroBalances(
  ctx: Ctx,
  institutions: AskingInstitution[],
  view: LifecycleView,
  links: ReadonlyMap<string, Link>,
  hidden: ReadonlyMap<string, unknown>,
  now: number = Date.now()
): Promise<void> {
  const candidates = institutions.flatMap((inst) =>
    inst.error || inst.manual
      ? []
      : inst.accounts
          .filter((a) => a && a.balance === 0 && !a.stale && !a.question && !hidden.has(a.account_id) && !view.ended.has(a.account_id))
          .map((a) => ({ inst, a }))
  );
  if (candidates.length === 0) return;
  try {
    const today = utcDay(now);
    const firstDay = addDays(today, -(ZERO_SCAN_DAYS - 1));
    const dates = Array.from({ length: ZERO_SCAN_DAYS }, (_, i) => addDays(firstDay, i));
    const { balances } = await readMeasuredBalances(ctx, dates);
    const latest = addDays(today, -ZERO_DAYS);
    const asked: { inst: AskingInstitution; a: any; ids: string[]; start: string }[] = [];
    for (const { inst, a } of candidates) {
      const ids = sameAccountIds(a.account_id, links as Map<string, Link>);
      const mine = new Map<string, number>();
      for (const [date, map] of balances) {
        const v = ids.map((id) => map[id]).find((b) => typeof b === 'number');
        if (typeof v === 'number') mine.set(date, v);
      }
      const run = zeroRun(mine, firstDay);
      if (!run || run.days < ZERO_MEASURED_DAYS || run.start > latest) continue;
      const answer = lifecycleOf(view, a.account_id);
      if (answer?.lifecycle.state === 'active' && answer.answered?.kind === 'zero' && (run.start <= answer.answered.since || run.clamped)) continue;
      asked.push({ inst, a, ids, start: run.start });
    }
    if (asked.length === 0) return;
    // No transaction on it since the zeros began. Read once per institution;
    // one whose store can't be read asks nothing.
    const quiet = new Map<string, Set<string> | null>();
    for (const item_id of new Set(asked.map((q) => q.inst.item_id))) {
      try {
        const rows = await readStoredTxns(ctx, item_id);
        quiet.set(item_id, new Set(rows.map((t) => `${t.account_id}|${t.date}`)));
      } catch {
        quiet.set(item_id, null);
      }
    }
    for (const { inst, a, ids, start } of asked) {
      const rows = quiet.get(inst.item_id);
      if (!rows) continue;
      const active = [...rows].some((key) => {
        const [account, date] = key.split('|');
        return ids.includes(account) && date >= start;
      });
      if (active) continue;
      const question: AccountQuestion = { kind: 'zero', end: start, since: start };
      a.question = question;
    }
  } catch (err) {
    console.error('Account lifecycle: zero balances could not be checked', err instanceof Error ? err.name : typeof err);
  }
}
