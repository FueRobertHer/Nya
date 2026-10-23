// lib/weekly-summary/send-now.ts
//
// The weekly summary from the app (app/api/weekly-summary, the Weekly summary
// card in Settings, Preferences, components/WeeklySummaryCard.tsx):
// whether this copy of Nya can send one at all, saving the setting, the
// preview, and "Send me one now".
//
// THE PREVIEW is the summary the daily job would send for this week (the week
// whose send day is the latest one on or before today), worked out the same
// way (gather.ts, compose.ts) from what is stored now, for the day and time
// zone the sheet shows, saved or not, as it would go with the summary on
// that day. Only its link to turn the summary off is left out ("..."), since
// each email's is made for it. The one that goes is worked out when it goes,
// after its transactions are brought up to date, so it can say more; the page
// says both.
//
// SEND ME ONE NOW sends the summary for the day and time zone the sheet shows,
// to the same people the daily job writes to (lib/notice-recipients.ts),
// under the same rules: never a figure (checkedSummary), never to a demo
// account, and at most SENDS_NOW_PER_DAY a day per container
// (weekly-summary-sends), so it never makes a burst. One retry, under the same
// idempotency key, after a rate limit, no answer, or the email service's own
// error, as the download notices do. Its footer says when the next comes from
// the setting as saved, never the sheet's day before it is saved. It counts as
// the week's, so the daily job doesn't send the week again, only with the
// summary on, for its own day and time zone, and only when it could say how
// the week's spending went (compared, or none at all): one asked for before
// a bank's transactions are in (a SimpleFIN bank is brought in by the daily
// job alone) leaves the week's full one to come. Asked for while off, it
// carries no link to turn it off, and says it isn't on.

import { createHash } from 'node:crypto';
import type { Ctx } from '../containers';
import { appUrl } from '../app-url';
import { clerkEnabled } from '../auth-mode';
import { MailError, isEmailAddress, mailConfigured, sendMail, type Mail, type MailResult } from '../mail';
import { noticeRecipients, notifyEmails } from '../notice-recipients';
import { NOTICE_RECIPIENTS_TIMEOUT_MS } from '../download-notice';
import { weeklySettingStore, weeklyStateStore, sendNowCount, SENDS_NOW_PER_DAY, type WeeklyState } from './store';
import { WEEKLY_SETTING_VERSION, type WeeklyChoice, type WeeklySetting } from './settings';
import { gatherWeekly } from './gather';
import { checkedSummary, composeWeekly, spendingKnown } from './compose';
import { isUnread } from './content';
import { ensureState, recordSent, stopLinks } from './job';
import { newLinkKey } from './unsubscribe';

/** Why a demo account can't have one: everyone who tries the demo shares its
 *  data, and demo accounts are never emailed (lib/notice-recipients.ts). */
export const DEMO_REFUSAL = 'Demo accounts can’t get the weekly summary: everyone who tries the demo shares its data, and demo accounts are never emailed.';

/** Why this copy of Nya can't send a summary at all, in the person's words,
 *  or null when it can. A summary needs mail set up (lib/mail.ts), someone to
 *  write to, and APP_URL, for its link to turn it off. */
export function cannotSend(): string | null {
  if (!mailConfigured()) return 'This copy of Nya isn’t set up to send email, so no summary is sent. You can still see what it would say.';
  if (!clerkEnabled() && notifyEmails().length === 0) return 'This copy of Nya has nobody to email: with the shared password, whoever runs it sets NOTIFY_EMAIL.';
  if (!appUrl()) return 'This copy of Nya has no APP_URL set, which each summary needs for its link to turn it off, so no summary is sent.';
  return null;
}

/**
 * Saves what the person chose (settings.ts parseWeeklyChoice checked it). The
 * same choice again changes nothing, so the day it was chosen stays (the job's
 * catch-up reads it, week.ts). Turned on after being off, or for the first
 * time, the key the links are signed with is made anew, so a link from before
 * never turns off a summary turned on since; the rest of the record is kept,
 * so a goal told of isn't told of again. Strict: a setting or record that
 * can't be read throws, and is left as it is.
 */
export async function saveSetting(ctx: Ctx, choice: WeeklyChoice, now: number = Date.now()): Promise<WeeklySetting> {
  const current = await weeklySettingStore.get(ctx);
  if (current && current.enabled === choice.enabled && current.weekday === choice.weekday && current.time_zone === choice.time_zone) return current;
  if (choice.enabled && !current?.enabled) {
    // A new key, and only that: the weeks sent, one that got no answer and
    // the goals told of stay as they were. Only computes, as update() asks:
    // it may run again on a conflict.
    await weeklyStateStore.update(ctx, (state): WeeklyState => ({ ...(state ?? { v: 1, sent: null, sent_at: null }), key: newLinkKey() }));
  }
  const next: WeeklySetting = { v: WEEKLY_SETTING_VERSION, ...choice, updated_at: new Date(now).toISOString() };
  await weeklySettingStore.set(ctx, next);
  return next;
}

/** A week's summary as the app shows it, and what it covers. */
export type Preview = { send_day: string; first: string; last: string; subject: string; text: string };

/** This week's summary for `choice` (see THE PREVIEW). */
export async function previewWeekly(ctx: Ctx, choice: Pick<WeeklyChoice, 'weekday' | 'time_zone'>, now: number = Date.now()): Promise<Preview> {
  const state = await weeklyStateStore.get(ctx);
  const facts = await gatherWeekly(ctx, { now, timeZone: choice.time_zone, weekday: choice.weekday, goalsTold: state?.goals_told ?? null });
  const link = appUrl();
  const { subject, text } = checkedSummary(
    composeWeekly(facts, { link, unsubscribe: link ? `${link}/unsubscribe?t=...` : null, requested: false, schedule: choice.weekday, now })
  );
  return { send_day: facts.send_day, first: facts.first, last: facts.last, subject, text };
}

export type SendNowResult =
  | { kind: 'sent'; send_day: string }
  /** This copy of Nya can't send one (cannotSend). */
  | { kind: 'unable'; why: string }
  /** SENDS_NOW_PER_DAY used up: when the next can go. */
  | { kind: 'limited'; retryAfterSeconds: number }
  /** Nobody to send it to (a demo account, an unverified address). */
  | { kind: 'no-recipient' }
  /** The email service didn't take it. */
  | { kind: 'failed' };

export type SendNowOptions = {
  now?: number;
  /** For tests: what reaches Resend, whom to write to, the pause before the retry. */
  fetch?: typeof fetch;
  recipients?: (ctx: Ctx) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
};

/** Rejects after `ms`, so a slow lookup can't hold the request up. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const retryable = (err: unknown) => err instanceof MailError && (err.status === null || err.status === 429 || err.status >= 500);

/**
 * Sends this week's summary now (see SEND ME ONE NOW). Throws only what says
 * nothing about the summary: a setting or a count that can't be read
 * (StoredDataUnreadableError), storage out of reach. `choice` is the day and
 * time zone the sheet shows.
 */
export async function sendNow(ctx: Ctx, choice: Pick<WeeklyChoice, 'weekday' | 'time_zone'>, opts: SendNowOptions = {}): Promise<SendNowResult> {
  const why = cannotSend();
  if (why) return { kind: 'unable', why };
  const now = opts.now ?? Date.now();
  // Counted first, the request that is turned away too: the count is what
  // decides, so two at once can't both take the last one.
  const { count, secondsLeft } = await sendNowCount.take(ctx);
  if (count > SENDS_NOW_PER_DAY) return { kind: 'limited', retryAfterSeconds: secondsLeft };

  const [setting, state] = await Promise.all([weeklySettingStore.get(ctx), weeklyStateStore.get(ctx)]);
  const enabled = !!setting?.enabled;
  const facts = await gatherWeekly(ctx, { now, timeZone: choice.time_zone, weekday: choice.weekday, goalsTold: state?.goals_told ?? null });
  const link = appUrl()!;
  const stop = enabled ? stopLinks(link, ctx.container, (await ensureState(ctx)).key, now) : null;
  const summary = checkedSummary(
    composeWeekly(facts, { link, unsubscribe: stop?.page ?? null, requested: true, schedule: enabled ? setting!.weekday : null, now })
  );

  let to: string[];
  try {
    to = (await within((opts.recipients ?? noticeRecipients)(ctx), NOTICE_RECIPIENTS_TIMEOUT_MS)).filter(isEmailAddress);
  } catch (err) {
    console.error('Weekly summary: whom to email could not be found for a summary asked for now.', err instanceof Error ? err.name : typeof err);
    return { kind: 'failed' };
  }
  if (to.length === 0) return { kind: 'no-recipient' };

  // Its own key per summary asked for, so it never stands in for the week's.
  const key = `nya-weekly-now-${createHash('sha256').update(`${ctx.container}:${facts.send_day}:${count}`).digest('hex').slice(0, 48)}`;
  const mail: Mail = { to, subject: summary.subject, text: summary.text, idempotencyKey: key, ...(stop ? { headers: stop.headers } : {}) };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result: MailResult;
  try {
    try {
      result = await sendMail(mail, { fetch: opts.fetch });
    } catch (err) {
      if (!retryable(err)) throw err;
      await sleep(Math.min(2_000, (err as MailError).retryAfterMs ?? 1_000));
      result = await sendMail(mail, { fetch: opts.fetch });
    }
  } catch (err) {
    console.error('Weekly summary: a summary asked for now was not sent.', err instanceof MailError ? err.message : err instanceof Error ? err.name : typeof err);
    return { kind: 'failed' };
  }
  if (!result.sent) return { kind: 'unable', why: cannotSend() ?? 'This copy of Nya isn’t set up to send email.' };
  // This week's, for the summary's own day and time zone, when it could say
  // how the week's spending went: the job won't send it again.
  if (enabled && setting!.weekday === choice.weekday && setting!.time_zone === choice.time_zone && spendingKnown(facts)) {
    await recordSent(ctx, facts.send_day, now, isUnread(facts.goals) ? null : facts.goals.complete).catch((err) =>
      console.error('Weekly summary: a summary asked for now could not be recorded as the week’s.', err instanceof Error ? err.name : typeof err)
    );
  }
  console.log('Weekly summary: emailed one asked for now.');
  return { kind: 'sent', send_day: facts.send_day };
}

