// lib/mail.ts
//
// Sending email, for the notices about bank connections (#51). Resend's HTTP
// API through fetch, one POST per message, with no SDK. Configured by
// RESEND_API_KEY and MAIL_FROM; with either unset, nothing is sent, the app's
// connection health view is the only place a broken connection shows, and one
// log line says mail is off.
//
// What goes in a message is the caller's to decide (lib/connection-notices.ts),
// under a strict rule: the institution's name and what to do, never a balance,
// an amount or an account number. This module never logs a message's text, its
// recipients or the key: a failure is logged as Resend's HTTP status and its
// error's name.
//
// A message can carry an idempotency key, which Resend honours for 24 hours:
// the same key sent again is not delivered twice, so a retry after an answer
// that never arrived cannot double an email.

const ENDPOINT = 'https://api.resend.com/emails';
/** How long a send may take. It runs inside the daily snapshot, whose time is
 *  counted (START_BUDGET_MS in lib/snapshot-job.ts). */
export const MAIL_TIMEOUT_MS = 8_000;

export type Mail = {
  to: string[];
  subject: string;
  text: string;
  /** At most 256 characters, per Resend. */
  idempotencyKey?: string;
};

/** Sent, with Resend's id for it; or not sent because mail is off. A failure
 *  throws MailError instead, so it can never be mistaken for either. */
export type MailResult = { sent: true; id: string | null } | { sent: false; reason: 'off' };

export class MailError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = 'MailError';
  }
}

/** An address on its own: no name, no list, nothing a header could split. */
export function isEmailAddress(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@<>,;"()\[\]\\]+@[^\s@<>,;"()\[\]\\]+\.[^\s@<>,;"()\[\]\\]+$/.test(s);
}

/** MAIL_FROM as Resend takes it: an address, or a name and one in <>. */
function isSender(s: string): boolean {
  if (s.length > 320 || /[\r\n]/.test(s)) return false;
  const named = /^[^<>\r\n]*<([^<>]+)>$/.exec(s);
  return isEmailAddress(named ? named[1] : s);
}

/** The key and sender, or null when mail is off (either unset, or a sender
 *  that isn't an address). */
export function mailConfig(): { apiKey: string; from: string } | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!apiKey || !from || !isSender(from)) return null;
  return { apiKey, from };
}

export function mailConfigured(): boolean {
  return mailConfig() !== null;
}

let offSaid = false;

/** For tests: say "mail is off" again. */
export function forgetMailOffLogged(): void {
  offSaid = false;
}

/** Whether mail is off, saying so in the log the first time this process finds
 *  it off, so a sender can stop before looking up whom to write to. */
export function mailOff(): boolean {
  if (mailConfigured()) return false;
  if (!offSaid) {
    offSaid = true;
    console.log('mail: RESEND_API_KEY and MAIL_FROM are not both set, so no email is sent; connection problems show in the app only.');
  }
  return true;
}

/**
 * Sends one plain-text message, or does nothing when mail is off (and says so
 * once). Throws MailError when the message was not accepted: no usable
 * recipient, no answer within MAIL_TIMEOUT_MS, or a refusal.
 */
export async function sendMail(mail: Mail, opts: { fetch?: typeof fetch } = {}): Promise<MailResult> {
  const config = mailConfig();
  if (!config) {
    mailOff();
    return { sent: false, reason: 'off' };
  }
  const to = [...new Set(mail.to)].filter(isEmailAddress);
  if (to.length === 0) throw new MailError('The email has no usable recipient.', null);

  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...(mail.idempotencyKey ? { 'Idempotency-Key': mail.idempotencyKey.slice(0, 256) } : {}),
      },
      body: JSON.stringify({ from: config.from, to, subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MailError(`The email service could not be reached (${err instanceof Error ? err.name : typeof err}).`, null);
  }
  if (!res.ok) {
    // Resend answers { statusCode, name, message }: the name is a short code;
    // the message can quote what was sent, so it is not kept.
    const name = await res
      .json()
      .then((b: any) => (typeof b?.name === 'string' && /^[a-z_]{1,60}$/.test(b.name) ? b.name : null))
      .catch(() => null);
    throw new MailError(`The email service refused the email (${res.status}${name ? `, ${name}` : ''}).`, res.status);
  }
  const id = await res
    .json()
    .then((b: any) => (typeof b?.id === 'string' ? b.id : null))
    .catch(() => null);
  return { sent: true, id };
}
