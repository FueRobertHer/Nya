// lib/weekly-summary/job.ts
//
// Sending the weekly summaries, from the daily snapshot (lib/snapshot-job.ts),
// after every container has run and the emails about connections have gone
// (lib/connection-notices.ts), within what is left of the same deadline.
//
// WHO IS DUE. Each active container whose snapshot is done for the day
// (recorded now or earlier that day, or run and found something it couldn't
// read, or with nothing linked), whose summary is on, and whose send day it
// is on the person's calendar, or one of the days after it that a summary
// still catches up on (lib/weekly-summary/week.ts), unless a summary already
// went for that week. A container whose snapshot failed, was deferred, or is
// being run by another invocation waits for the catch-up run two hours later,
// which runs this again, and the days after, so the week is complete when it
// is summed. Each container's setting and record are read a few at a time;
// one that can't be read is left out, and logged.
//
// "Today" on the person's calendar is judged at the day's own run
// (`scheduledFor`, at DAILY_RUN_UTC_HOUR, lib/weekly-summary/when.ts), or now
// if that is earlier: so the catch-up run, two hours later, only catches up
// what its day's run should have sent. Judged at its own hour, it would be
// the first run of the day from UTC+9 to UTC+11 (Tokyo, Brisbane, Sydney in
// winter), and send each summary there just after midnight, from a run that
// syncs no SimpleFIN bank (the catch-up reruns no snapshot that was
// recorded), so every one would say spending isn't compared. A run made
// before its day's hour judges at its own, so no week is summed before it
// ends.
//
// ONE A WEEK, NEVER TWICE. The week's send day is recorded once the email
// service accepted the summary (weekly-summary-state), and a week recorded is
// never sent again by any run, nor, after a move of the day, one that would
// mostly repeat it (week.ts). Each summary carries an idempotency key built
// from the container and the week (hashed, so it names neither), which Resend
// keeps for 24 hours (resend.com/docs/dashboard/emails/idempotency-keys): one
// whose answer never arrived, sent again by the next run, is not delivered
// twice. Resend refuses the same key with a different email (the week's facts
// moved since) with a 409, invalid_idempotent_request
// (resend.com/docs/api-reference/errors). Its docs don't say whether a key is
// kept after a request it refused or failed, so that refusal counts as sent
// only when an earlier try under the key got no answer at all, which the
// record marks (`unanswered`): it may have gone. Otherwise the week waits for
// the key to lapse, and goes then. One still being sent by another invocation
// (concurrent_idempotent_requests, a cron delivered twice) is left to it.
//
// BROUGHT UP TO DATE FIRST. The snapshot fetches balances, not transactions,
// which the app brings in when it is opened. So each due summary first brings
// the container's bank transactions up to date the way opening the app does
// (lib/activity.ts, one /transactions/sync per connection, which Plaid doesn't
// bill per call), within SYNC_TIMEOUT_MS, and drops the dashboard's copies so
// the app shows what the email says. A sync that fails or runs out of time
// only leaves the summary saying how fresh its transactions are
// (content.ts). Then everything is read as the app reads it (gather.ts).
//
// TIME. The summaries have a budget (WEEKLY_BUDGET_MS), never past the run's
// own mail deadline (MAIL_DEADLINE_MS in lib/snapshot-job.ts), and each step
// a timeout of its own: the sync, the reads, finding whom to write to, the
// send. A summary is started only if all four can end in time. They go one at
// a time, at most two a second (Resend's default limit), and a 429 is waited
// out once when its Retry-After is short. Whatever doesn't fit, and
// everything after a failure of the email service itself, waits for the next
// run, unrecorded. A step that runs out of time says which, and how long it
// had, in the log. A sync that ran out of time is still going: the run waits
// for those, as long as its deadline allows (STRAGGLERS_MS at most), before
// it ends, so none is left to write an older state once a later request
// wakes the function again. The next sync puts right one that outlives that.
//
// WHO GETS IT: whom the connection notices go to (lib/notice-recipients.ts):
// the verified owners of the container, never a demo account, and with the
// shared password NOTIFY_EMAIL for the deployment's own container only.
// Nobody it is shared with. Without APP_URL, no summary goes at all: each
// must carry its link to turn it off, and the log says why once a run.
//
// NEVER A FIGURE: compose.ts writes it, and checkedSummary refuses one that
// would carry a figure, which is then logged and not sent.

import { createHash } from 'node:crypto';
import type { ContainerId, ContainerRecord, Ctx } from '../containers';
import { assembleBankRows } from '../activity';
import { clearCaches } from '../cache';
import { appUrl } from '../app-url';
import { MAIL_TIMEOUT_MS, MailError, isEmailAddress, mailConfigured, sendMail, type Mail } from '../mail';
import { noticeRecipients, type RecipientDeps } from '../notice-recipients';
import { ownersByContainer } from '../owners';
import { RECIPIENTS_TIMEOUT_MS, RETRY_AFTER_MAX_MS, SEND_INTERVAL_MS } from '../connection-notices';
import { StoredDataUnreadableError } from '../repo';
import { checkContainerKey, ContainerKeyError } from '../crypto';
import { canonicalTimeZone } from '../report/period';
import { weeklySettingStore, weeklyStateStore, type WeeklyState } from './store';
import type { WeeklySetting } from './settings';
import { dueSendDay, todayIn } from './week';
import { gatherWeekly } from './gather';
import { isUnread, type WeeklyFacts } from './content';
import { checkedSummary, composeWeekly, FigureError } from './compose';
import { linkExpiry, linkToken, newLinkKey, oneClickUrl, pageUrl } from './unsubscribe';
import { DAILY_RUN_UTC_HOUR } from './when';
import { restoreUnfinished } from '../user-restore/restored';

/** How long the summaries of one run may take in all. */
export const WEEKLY_BUDGET_MS = 120_000;
/** How long bringing a container's transactions up to date may take. */
export const SYNC_TIMEOUT_MS = 20_000;
/** How long reading everything a summary says may take. */
export const GATHER_TIMEOUT_MS = 15_000;
/** How many containers' settings are read at once. */
const SETTINGS_AT_ONCE = 5;
/** The longest the run waits, before it ends, for syncs that ran out of time. */
export const STRAGGLERS_MS = 15_000;

/** What became of a container's summary this run: none due, sent, mail off,
 *  no APP_URL, nobody to send it to, failed, deferred for want of time or
 *  for another invocation sending it, or its setting or record unreadable.
 *  All but "sent" and "none" are tried again by the next run that finds it
 *  due. */
export type WeeklyOutcome = 'none' | 'sent' | 'off' | 'no-link' | 'no-recipient' | 'failed' | 'deferred' | 'unreadable';

export type WeeklyRunOptions = {
  /** By `clock`: when every call must have ended. Unset, WEEKLY_BUDGET_MS from now. */
  deadline?: number;
  clock?: () => number;
  /** The UTC day the run is for (lib/snapshot-job.ts scheduledFor): "today"
   *  is judged at that day's run (see WHO IS DUE). Unset, at `clock`. */
  scheduledFor?: string;
  /** For tests: the pause between sends and before a retry. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: what reaches Resend, whom to write to, how transactions are
   *  brought up to date, how a summary is read, and the timeouts. */
  fetch?: typeof fetch;
  recipients?: (ctx: Ctx) => Promise<string[]>;
  recipientDeps?: Omit<RecipientDeps, 'owners'>;
  sync?: (ctx: Ctx) => Promise<void>;
  gather?: typeof gatherWeekly;
  syncTimeoutMs?: number;
  gatherTimeoutMs?: number;
  sendTimeoutMs?: number;
  recipientsTimeoutMs?: number;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A step that ran out of time: its message says which, and how long it had,
 *  and nothing else, so the log can carry it whole. */
export class StepTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} took longer than ${ms} ms`);
    this.name = 'StepTimeoutError';
  }
}

/** What the log says of an error: a step's timeout whole, otherwise only its
 *  name, which carries nothing of the person's. */
const nameOf = (err: unknown) => (err instanceof StepTimeoutError ? err.message : err instanceof Error ? err.name : typeof err);

/** Rejects after `ms`, so a slow step can't hold up the daily run. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(what, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Brings the container's bank transactions up to date as opening the app
 *  does, and drops the dashboard's copies of them (see BROUGHT UP TO DATE). */
export async function bringUpToDate(ctx: Ctx): Promise<void> {
  await assembleBankRows(ctx, { sync: true });
  await clearCaches(ctx);
}

/** A week's idempotency key: the container and the send day, hashed. */
export function weekKey(container: ContainerId, sendDay: string): string {
  return `nya-weekly-${createHash('sha256').update(`${container}:${sendDay}`).digest('hex').slice(0, 48)}`;
}

/** The record, made with a key if there is none yet. Strict: one that can't
 *  be read throws, and is left as it is. */
export async function ensureState(ctx: Ctx): Promise<WeeklyState> {
  const state = await weeklyStateStore.update(ctx, (current) => current ?? { v: 1, key: newLinkKey(), sent: null, sent_at: null });
  return state!;
}

/** Records that the week's summary went, unless a later one is recorded,
 *  with the goals it found at their target (`goals`, null when it couldn't
 *  read them: those told before stay told). */
export async function recordSent(ctx: Ctx, sendDay: string, at: number, goals: readonly string[] | null = null): Promise<void> {
  await weeklyStateStore.update(ctx, (current) =>
    current === null || (current.sent !== null && current.sent >= sendDay)
      ? current
      : { ...current, sent: sendDay, sent_at: new Date(at).toISOString(), unanswered: null, ...(goals ? { goals_told: [...goals] } : {}) }
  );
}

/** Marks the week as sent without an answer: it may have gone (see ONE A
 *  WEEK, NEVER TWICE). */
async function markUnanswered(ctx: Ctx, sendDay: string): Promise<void> {
  await weeklyStateStore.update(ctx, (current) => (current === null ? current : { ...current, unanswered: sendDay }));
}

/** The links and headers that turn a summary off (lib/weekly-summary/unsubscribe.ts). */
export function stopLinks(link: string, container: ContainerId, key: string, now: number): { page: string; headers: Mail['headers'] } {
  const token = linkToken(container, key, linkExpiry(now));
  return {
    page: pageUrl(link, token),
    headers: { 'List-Unsubscribe': `<${oneClickUrl(link, token)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

type Due = { ctx: Ctx; setting: WeeklySetting; zone: string; sendDay: string; state: WeeklyState | null };

/** `fn` over every item, at most `limit` at a time. `fn` must not throw. */
async function inPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

/**
 * The run's summaries (see the header): `registry` is the run's, `ready` says
 * whether a container's snapshot is done for the day. Never throws: each
 * container's outcome is its own, and the log says why.
 */
export async function sendWeeklySummaries(
  registry: (ContainerRecord & { id: ContainerId })[],
  opts: WeeklyRunOptions & { ready: (container: ContainerId) => boolean }
): Promise<Map<ContainerId, WeeklyOutcome>> {
  const outcomes = new Map<ContainerId, WeeklyOutcome>();
  // Silent: the connection notices already say once that mail is off.
  if (!mailConfigured()) return outcomes;
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? wait;
  const deadline = opts.deadline ?? clock() + WEEKLY_BUDGET_MS;
  const syncTimeout = opts.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
  const gatherTimeout = opts.gatherTimeoutMs ?? GATHER_TIMEOUT_MS;
  const sendTimeout = opts.sendTimeoutMs ?? MAIL_TIMEOUT_MS;
  const lookupTimeout = opts.recipientsTimeoutMs ?? RECIPIENTS_TIMEOUT_MS;
  const now = clock();
  // When "today" is judged, on each person's calendar (see WHO IS DUE).
  const dayRun = opts.scheduledFor && /^\d{4}-\d{2}-\d{2}$/.test(opts.scheduledFor) ? Date.parse(`${opts.scheduledFor}T${String(DAILY_RUN_UTC_HOUR).padStart(2, '0')}:00:00.000Z`) : NaN;
  const judgedAt = Number.isFinite(dayRun) ? Math.min(now, dayRun) : now;

  // Who is due, each container's setting and record read strictly, a few at
  // once, then put back in the registry's order: which read ends first never
  // decides who waits when time runs short.
  const found: Due[] = [];
  const candidates = registry.filter((c) => c.status === 'active' && opts.ready(c.id));
  await inPool(candidates, SETTINGS_AT_ONCE, async (c) => {
    const ctx: Ctx = { container: c.id };
    try {
      const setting = await weeklySettingStore.get(ctx);
      if (!setting?.enabled) return;
      // Its data key opened first, as the snapshot does: a key that can't be
      // used stops it here, before anything that reads leniently runs.
      await checkContainerKey(ctx);
      // Never from part of the data: while a restore is being written or
      // undone here (lib/user-restore/restored.ts), the summary waits for a
      // later run.
      if (await restoreUnfinished(ctx)) {
        outcomes.set(c.id, 'deferred');
        return;
      }
      const zone = canonicalTimeZone(setting.time_zone);
      const today = zone ? todayIn(judgedAt, zone) : null;
      if (!zone || !today) {
        console.error(`Weekly summary: the time zone set for container ${c.id} is not one this runtime knows, so its summary waits.`);
        outcomes.set(c.id, 'failed');
        return;
      }
      const state = await weeklyStateStore.get(ctx);
      const sendDay = dueSendDay(today, setting.weekday, state?.sent ?? null, todayIn(Date.parse(setting.updated_at), zone));
      if (sendDay) found.push({ ctx, setting, zone, sendDay, state });
    } catch (err) {
      const unreadable = err instanceof StoredDataUnreadableError;
      console.error(
        err instanceof ContainerKeyError
          ? `Weekly summary: the data key of container ${c.id} can't be used, so no summary goes for it.`
          : `Weekly summary: the setting or record of container ${c.id} could not be read, so no summary goes for it.`,
        nameOf(err)
      );
      outcomes.set(c.id, unreadable ? 'unreadable' : 'failed');
    }
  });
  const order = new Map(candidates.map((c, i) => [c.id, i]));
  const due = found.sort((a, b) => order.get(a.ctx.container)! - order.get(b.ctx.container)!);
  if (due.length === 0) return outcomes;

  const link = appUrl();
  if (!link) {
    console.warn(`Weekly summary: ${due.length} summar${due.length === 1 ? 'y is' : 'ies are'} due, but APP_URL is not set, and each needs its link to turn it off: none was sent (docs/deployment.md).`);
    for (const d of due) outcomes.set(d.ctx.container, 'no-link');
    return outcomes;
  }

  // The owners mapping read once for the run, not once per container.
  let owners: Promise<Map<ContainerId, string[]>> | undefined;
  const recipients =
    opts.recipients ?? ((ctx: Ctx) => noticeRecipients(ctx, { ...opts.recipientDeps, owners: async (c) => (await (owners ??= ownersByContainer())).get(c) ?? [] }));
  const sync = opts.sync ?? bringUpToDate;
  const gather = opts.gather ?? gatherWeekly;

  let lastStart = clock();
  const attempt = async (mail: Mail): Promise<'sent' | 'off' | Error> => {
    const gap = lastStart + SEND_INTERVAL_MS - clock();
    if (gap > 0) await sleep(gap);
    lastStart = clock();
    try {
      return (await sendMail(mail, { fetch: opts.fetch, timeoutMs: sendTimeout })).sent ? 'sent' : 'off';
    } catch (err) {
      return err instanceof Error ? err : new Error(typeof err);
    }
  };

  let stopped = false;
  let sent = 0;
  // Syncs that ran out of time, still going (see TIME).
  const stragglers: Promise<unknown>[] = [];
  for (const [i, d] of due.entries()) {
    const c = d.ctx.container;
    if (stopped || clock() + SEND_INTERVAL_MS + syncTimeout + gatherTimeout + lookupTimeout + sendTimeout > deadline) {
      if (!stopped) console.warn(`Weekly summary: no time left for this run's summaries; ${due.length - i} container(s) wait for the next run.`);
      stopped = true;
      outcomes.set(c, 'deferred');
      continue;
    }
    // Brought up to date first; a failure only leaves it saying how fresh
    // its transactions are.
    const syncing = Promise.resolve().then(() => sync(d.ctx));
    await within(syncing, syncTimeout, 'Bringing transactions up to date').catch((err) => {
      if (err instanceof StepTimeoutError) stragglers.push(syncing.catch(() => {}));
      console.warn(`Weekly summary: the transactions of container ${c} could not all be brought up to date; its summary says how fresh they are.`, nameOf(err));
    });

    let mail: Mail;
    let facts: WeeklyFacts;
    let state: WeeklyState;
    try {
      facts = await within(
        gather(d.ctx, { now, timeZone: d.zone, weekday: d.setting.weekday, sendDay: d.sendDay, goalsTold: d.state?.goals_told ?? null }),
        gatherTimeout,
        'Reading the summary'
      );
      state = await ensureState(d.ctx);
      const stop = stopLinks(link, c, state.key, now);
      const summary = checkedSummary(composeWeekly(facts, { link, unsubscribe: stop.page, requested: false, schedule: d.setting.weekday, now }));
      const to = (await within(recipients(d.ctx), lookupTimeout, 'Finding the recipient')).filter(isEmailAddress);
      if (to.length === 0) {
        console.warn(`Weekly summary: nobody to email for container ${c} (see NOTIFY_EMAIL in docs/deployment.md).`);
        outcomes.set(c, 'no-recipient');
        continue;
      }
      mail = { to, subject: summary.subject, text: summary.text, idempotencyKey: weekKey(c, d.sendDay), headers: stop.headers };
    } catch (err) {
      if (err instanceof FigureError) console.error(`Weekly summary: the summary for container ${c} was not sent: ${err.message}`);
      else console.error(`Weekly summary: the summary for container ${c} could not be made; trying again next run.`, nameOf(err));
      outcomes.set(c, 'failed');
      continue;
    }

    let result = await attempt(mail);
    // Rate limited: waited out once, when Resend asks for a pause short
    // enough to fit. The same key makes the second try safe.
    if (result instanceof MailError && result.status === 429) {
      const pause = result.retryAfterMs ?? 1_000;
      if (pause <= RETRY_AFTER_MAX_MS && clock() + pause + sendTimeout <= deadline) {
        await sleep(pause);
        result = await attempt(mail);
      }
    }
    // Resend refusing the key for another email: one went under it, if an
    // earlier try under it got no answer (see ONE A WEEK, NEVER TWICE).
    const refusedKey = result instanceof MailError && result.status === 409 && result.code === 'invalid_idempotent_request';
    const already = refusedKey && state.unanswered === d.sendDay;
    if (result instanceof MailError && result.status === 409 && result.code === 'concurrent_idempotent_requests') {
      outcomes.set(c, 'deferred');
      continue;
    }
    if (result === 'off') {
      outcomes.set(c, 'off');
      continue;
    }
    if (refusedKey && !already) {
      console.error(`Weekly summary: the email service refused this week's key for container ${c}, and no earlier try under it went unanswered, so nothing is recorded; it goes once the key lapses, a day after it was first used.`);
      outcomes.set(c, 'failed');
      continue;
    }
    if (result !== 'sent' && !already) {
      const unanswered = !(result instanceof MailError) || result.status === null;
      console.error(`Weekly summary: the summary for container ${c} was not sent; trying again next run.`, result instanceof MailError ? result.message : nameOf(result));
      outcomes.set(c, 'failed');
      // No answer at all: it may have gone, under its key (see ONE A WEEK).
      if (unanswered) {
        await markUnanswered(d.ctx, d.sendDay).catch((err) => console.error(`Weekly summary: a summary that got no answer could not be marked for container ${c}.`, nameOf(err)));
      }
      // The email service itself failing: the rest wait for the next run.
      if (!(result instanceof MailError) || result.status === null || result.status === 429 || result.status >= 500) {
        stopped = true;
        if (i + 1 < due.length) console.warn(`Weekly summary: the email service is failing, so ${due.length - i - 1} other container(s) wait for the next run.`);
      }
      continue;
    }
    if (already) console.log(`Weekly summary: the summary for container ${c} went before under this week's key; recorded now.`);
    try {
      await recordSent(d.ctx, d.sendDay, now, isUnread(facts.goals) ? null : facts.goals.complete);
    } catch (err) {
      // The key keeps a resend within a day from arriving twice.
      console.error(`Weekly summary: a sent summary could not be recorded for container ${c}.`, nameOf(err));
    }
    sent++;
    outcomes.set(c, 'sent');
  }
  if (sent > 0) console.log(`Weekly summary: emailed ${sent} summar${sent === 1 ? 'y' : 'ies'}.`);
  if (stragglers.length > 0) {
    const room = Math.min(STRAGGLERS_MS, Math.max(0, deadline - clock()));
    const ended = await within(Promise.all(stragglers), room, 'Finishing the syncs that ran out of time').then(
      () => true,
      () => false
    );
    if (!ended) console.warn(`Weekly summary: ${stragglers.length} sync(s) that ran out of time were still going when the run ended; the next sync puts right what they write.`);
  }
  return outcomes;
}
