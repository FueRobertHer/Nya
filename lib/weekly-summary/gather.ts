// lib/weekly-summary/gather.ts
//
// The weekly summary's facts (content.ts), read with the readers the app and
// the read-only API answer with, so the email and the app never tell the week
// differently:
//
//   readActivity (lib/api-read.ts)       the Activity tab's rows as stored, and
//                                        the rows before them recurring
//                                        detection needs: spending, bills,
//                                        what has no category;
//   readBudgetMonth (lib/budget-month.ts) the month as the Budgets tab works it
//                                        out, rollover and all, and what says
//                                        whether a month is complete;
//   readGoals (lib/api-goals.ts)         each goal as the Goals card tells it;
//   the planned items (lib/planned-store.ts), and the connection records
//   (lib/connection-records.ts) the daily job keeps.
// Hidden accounts are left out, an account that ended counts nothing from its
// end, and what the person excluded is left out of every total, by those
// readers, as in the app. Nothing here writes, and nothing calls Plaid: the
// daily job brings the transactions up to date before it gathers
// (lib/weekly-summary/job.ts).
//
// WHAT CAN'T BE READ. A reader that finds stored data it can't use throws
// StoredDataUnreadableError (lib/repo.ts), and that section is UNREAD: left
// out, and the email says so (compose.ts). Anything else (storage out of
// reach, a key this deployment can't use) is thrown as it is, and nothing is
// sent: the same line every route draws between a 409 and a 500.

import type { Ctx } from '../containers';
import { getItems } from '../storage';
import { readActivity } from '../api-read';
import { readGoals } from '../api-goals';
import { readBudgetMonth, readMonthActivity, windowStart } from '../budget-month';
import { plannedStore } from '../planned-store';
import { noticesStore, syncsStore, warningsStore } from '../connection-records';
import { StoredDataUnreadableError, describeUnreadable } from '../repo';
import { detectRecurring } from '../recurring';
import { monthOf } from '../rollover';
import { totalsCurrency } from '../spending';
import { noSpending } from '../no-transactions';
import { canonicalTimeZone } from '../report/period';
import type { Weekday } from './settings';
import { sendDayOn, todayIn, weekBefore } from './week';
import {
  UNREAD,
  billsFact,
  budgetFact,
  connectionsFact,
  goalsFact,
  isUnread,
  monthsFact,
  spendingFact,
  uncategorizedFact,
  type Unread,
  type WeeklyFacts,
} from './content';

/** A reader's answer, or UNREAD when it found stored data it can't use. */
async function section<T>(ctx: Ctx, what: string, read: Promise<T>): Promise<T | Unread> {
  try {
    return await read;
  } catch (err) {
    if (!(err instanceof StoredDataUnreadableError)) throw err;
    console.error(`Weekly summary: ${what} could not be read for container ${ctx.container}, so that part is left out.`, describeUnreadable(err));
    return UNREAD;
  }
}

export type GatherOptions = {
  now: number;
  /** The person's time zone and day (lib/weekly-summary/settings.ts). */
  timeZone: string;
  weekday: Weekday;
  /** The send day of the week to gather; this week's (week.ts sendDayOn) unless given. */
  sendDay?: string;
  /** The goals the last summary that went said were at their target, by id
   *  (lib/weekly-summary/store.ts goals_told), or null before any. */
  goalsTold?: readonly string[] | null;
};

/** A time zone this runtime doesn't know: no day can be placed in it. */
export class UnknownTimeZoneError extends Error {
  constructor() {
    super('The weekly summary’s time zone is not one this copy of Nya knows.');
    this.name = 'UnknownTimeZoneError';
  }
}

/** Everything a summary says, for the week given (see the header). */
export async function gatherWeekly(ctx: Ctx, opts: GatherOptions): Promise<WeeklyFacts> {
  const zone = canonicalTimeZone(opts.timeZone);
  const today = zone ? todayIn(opts.now, zone) : null;
  if (!zone || !today) throw new UnknownTimeZoneError();
  const sendDay = opts.sendDay ?? sendDayOn(today, opts.weekday);
  const { first, last } = weekBefore(sendDay);
  const month = monthOf(last);
  const thisMonth = monthOf(today);

  const [activity, budgets, planned, goals, connections] = await Promise.all([
    section(ctx, 'transactions', readActivity(ctx, false)),
    section(ctx, 'budgets', readBudgetMonth(ctx, { month, today: thisMonth })),
    section(ctx, 'planned items', plannedStore.get(ctx)),
    section(ctx, 'goals', readGoals(ctx, { today })),
    section(ctx, 'connection records', readConnections(ctx)),
  ]);
  // What says whether a month is complete: the budgets' own read has it;
  // without that read, the same read of the year on its own.
  const coverage = isUnread(budgets) ? await section(ctx, 'transactions', readMonthActivity(ctx, { since: windowStart(opts.now) })) : budgets.activity;
  const facts = isUnread(coverage) ? null : coverage.facts;
  // Something every total counts on couldn't be read (a manual account's
  // rows, the person's own categories or carried exclusions, how a
  // connection is doing): spending would be a guess.
  const unreadFacts = facts !== null && facts.unread.some((u) => !u.until || u.until > first);

  const spending =
    isUnread(activity) || facts === null || unreadFacts
      ? UNREAD
      : spendingFact({
          rows: activity.rows,
          currency: totalsCurrency(activity.rows),
          send_day: sendDay,
          first,
          last,
          time_zone: zone,
          sources: activity.sources.map((s) => ({ name: s.institution, brings: s.no_transactions === null, synced_at: s.synced_at, complete: s.complete })),
          facts,
          none_come_in: noSpending(activity.view, activity.rows.length) !== null,
        });

  const bills =
    isUnread(activity) || isUnread(planned)
      ? UNREAD
      : billsFact({ series: detectRecurring([...activity.rows, ...activity.history]), dismissed: planned?.dismissed ?? [], planned: planned?.items ?? [], today });

  return {
    send_day: sendDay,
    first,
    last,
    today,
    time_zone: zone,
    weekday: opts.weekday,
    spending,
    budgets: isUnread(budgets) ? UNREAD : budgetFact({ ix: budgets.ix, view: budgets.view, spent: budgets.spent, month, running: month === thisMonth }),
    bills,
    goals: isUnread(goals)
      ? UNREAD
      : goalsFact(
          goals.goals.map((g) => ({ id: g.id, name: g.name, archived: g.archived, state: g.state, status: g.projection?.status ?? null })),
          opts.goalsTold ?? null
        ),
    connections: isUnread(connections) ? UNREAD : connectionsFact({ ...connections, now: opts.now }),
    months: facts === null ? UNREAD : monthsFact([monthOf(first), month, thisMonth], facts),
    uncategorized: isUnread(activity) ? UNREAD : uncategorizedFact(activity.rows, first, last),
  };
}

/** The Plaid connections and what the daily job keeps about each. Strict: a
 *  record that can't be used makes the whole section unread, since a missing
 *  one would read as "nothing wrong". */
async function readConnections(ctx: Ctx) {
  const [items, notices, warnings, syncs] = await Promise.all([getItems(ctx), noticesStore.getAllReport(ctx), warningsStore.getAllReport(ctx), syncsStore.getAllReport(ctx)]);
  const bad = [notices, warnings, syncs].find((r) => r.unreadable.length > 0 || r.unrecognised.length > 0);
  if (bad) throw new StoredDataUnreadableError('connection records');
  return {
    items: items.map((i) => ({ item_id: i.item_id, institution_name: i.institution_name })),
    notices: notices.entries,
    warnings: warnings.entries,
    syncs: syncs.entries,
  };
}
