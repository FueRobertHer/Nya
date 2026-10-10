// lib/download-notice.ts
//
// The email that tells the owner their data was downloaded (app/api/my-data),
// or that an API token was made to read it (app/api/api-tokens): when, which
// format, whether a passphrase protects the file, and what to do if it
// wasn't them. A download, or a token, nobody asked for means someone else
// has signed in as them, and this is how they find out.
//
// TO THE OWNER, and nobody else, as the notices about bank connections go
// (lib/notice-recipients.ts): with Clerk, the verified primary address of
// each account that owns the container; with the shared password,
// NOTIFY_EMAIL, for the deployment's own container only.
//
// NEVER WHAT WAS DOWNLOADED. No balance, amount or account number, no name of
// an account or a bank, nothing from the file: the time (in UTC, which is
// all the server knows of the reader's day), the format, and whether it is
// protected. The time is the only number in it (test/my-data-ownership.test.ts
// checks, on a container full of amounts).
//
// NEVER IN THE WAY. The route starts it and doesn't wait (lib/background.ts):
// the download goes ahead whatever the email does. One that fails is logged
// as its status alone (Resend's HTTP status, or what kind of failure), never
// the address, the subject or the text. With mail off it does nothing and
// says nothing: the connection notices already say mail is off, once.
//
// ONCE. Each download, and each token, has an idempotency key of its own, so
// a send tried again (once, after a rate limit or no answer) is delivered
// once.

import { randomUUID } from 'node:crypto';
import type { Ctx } from './containers';
import { clerkEnabled } from './auth-mode';
import { appUrl } from './app-url';
import { MailError, isEmailAddress, mailConfigured, sendMail, type MailResult } from './mail';
import { noticeRecipients } from './notice-recipients';
import type { DownloadFormat } from './download-options';

/** What happened: a download (its format, and whether a passphrase protects
 *  it), or a new API token. */
export type AccessEvent = { kind: 'download'; format: DownloadFormat; protected: boolean } | { kind: 'api-token' };

/** What became of the email. */
export type NoticeOutcome = 'sent' | 'off' | 'no-recipient' | 'failed';

/** How long finding whom to write to may take (a Clerk lookup). */
export const NOTICE_RECIPIENTS_TIMEOUT_MS = 3_000;
/** The longest wait before the one retry. */
const RETRY_MAX_MS = 2_000;

const FORMAT_WORDS: Record<DownloadFormat, string> = {
  json: 'everything, as one JSON file',
  'transactions-csv': 'your transactions, as a CSV file',
  'balances-csv': 'your balance history, as a CSV file',
  ofx: "one account's transactions, as an OFX statement",
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Saturday, October 10, 2026, at 14:32 UTC". */
export function noticeTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[at.getUTCDay()]}, ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}, at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

/**
 * The email, in plain text. `clerk` says how people sign in here, which
 * decides what "secure your account" means; `link` is the app's address, or
 * null without APP_URL.
 */
export function composeAccessNotice(event: AccessEvent, at: Date, opts: { clerk: boolean; link: string | null }): { subject: string; text: string } {
  const when = noticeTime(at);
  const secure = opts.clerk
    ? "open your account window in Nya (your picture or initial at the top right, then Manage account), sign out every device you don't recognize, and change your password."
    : 'use Sign out everywhere in Nya (beside Log out) to end every session, and change the app password, or ask whoever runs Nya to.';
  const open = opts.link ? `Open Nya: ${opts.link}/` : 'Open Nya to do it.';
  const footer =
    'Nya emails you each time your data is downloaded or an API token is made to read it. Its emails never include balances, amounts or account numbers.';
  if (event.kind === 'download') {
    return {
      subject: 'Your Nya data was downloaded',
      text:
        [
          `Your Nya data was downloaded on ${when}: ${FORMAT_WORDS[event.format]}${event.protected ? ', protected with a passphrase' : ''}.`,
          "If that was you, there's nothing to do.",
          `If it wasn't you, someone else has signed in as you: ${secure}`,
          open,
          footer,
        ].join('\n\n') + '\n',
    };
  }
  return {
    subject: 'An API token was made for your Nya data',
    text:
      [
        `An API token that can read your Nya data was made on ${when}.`,
        "If that was you, there's nothing to do.",
        `If it wasn't you, revoke it now: in Nya, open Manage on the Accounts tab, and revoke it under API tokens. A token keeps working after every session ends, so revoking it is what stops it. Someone else has also signed in as you: ${secure}`,
        open,
        footer,
      ].join('\n\n') + '\n',
  };
}

export type NoticeDeps = {
  /** Whom to write to: the owners (noticeRecipients) unless given. */
  recipients?: (ctx: Ctx) => Promise<string[]>;
  /** What reaches Resend. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/** Rejects after `ms`, so a slow lookup can't hold the email up forever. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** A failure as the log may say it: a status or a kind, nothing sent. */
function statusOf(err: unknown): string {
  if (err instanceof MailError) return err.status === null ? 'no answer from the email service' : `email service status ${err.status}`;
  return err instanceof Error ? err.name : typeof err;
}

/** Whether a failed send is worth one more try: no answer, a rate limit, or
 *  the email service's own error. A refusal of this email (a 4xx) is not. */
const retryable = (err: unknown) => err instanceof MailError && (err.status === null || err.status === 429 || err.status >= 500);

/**
 * Emails the owner about this download or token (see the header). Never
 * throws: what became of it is the answer, and the log says why it wasn't
 * sent. `at` is when it happened.
 */
export async function sendAccessNotice(ctx: Ctx, event: AccessEvent, at: Date, deps: NoticeDeps = {}): Promise<NoticeOutcome> {
  const label = event.kind === 'download' ? 'Download notice' : 'API token notice';
  if (!mailConfigured()) return 'off';
  let to: string[];
  try {
    to = (await within((deps.recipients ?? noticeRecipients)(ctx), NOTICE_RECIPIENTS_TIMEOUT_MS)).filter(isEmailAddress);
  } catch (err) {
    console.error(`${label}: not sent, whom to email could not be found (${statusOf(err)}).`);
    return 'failed';
  }
  if (to.length === 0) {
    console.warn(`${label}: not sent, nobody to email (see NOTIFY_EMAIL in docs/deployment.md).`);
    return 'no-recipient';
  }
  const { subject, text } = composeAccessNotice(event, at, { clerk: clerkEnabled(), link: appUrl() });
  const mail = { to, subject, text, idempotencyKey: `nya-${event.kind}-${randomUUID()}` };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result: MailResult;
  try {
    try {
      result = await sendMail(mail, { fetch: deps.fetch });
    } catch (err) {
      if (!retryable(err)) throw err;
      // The same key: delivered once, however the first try ended.
      await sleep(Math.min(RETRY_MAX_MS, (err as MailError).retryAfterMs ?? 1_000));
      result = await sendMail(mail, { fetch: deps.fetch });
    }
  } catch (err) {
    console.error(`${label}: not sent (${statusOf(err)}).`);
    return 'failed';
  }
  if (!result.sent) return 'off';
  console.log(`${label}: emailed.`);
  return 'sent';
}
