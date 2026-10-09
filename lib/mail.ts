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
/** How long a send may take: Resend answers in well under a second. The daily
 *  job's emails have a budget of their own (lib/connection-notices.ts), and a
 *  send is started only when this much of it is left. */
export const MAIL_TIMEOUT_MS = 4_000;

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

/** A message that was not accepted. `status` is Resend's HTTP status, or null
 *  when no answer came (a timeout, the network, no usable recipient);
 *  `retryAfterMs` is how long a 429 asked to wait, when it said. */
export class MailError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'MailError';
  }
}

/** A Retry-After header in milliseconds: seconds, or an HTTP date. Null when
 *  absent or unusable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  const v = header?.trim();
  if (!v) return null;
  if (/^\d{1,6}$/.test(v)) return Number(v) * 1000;
  // An HTTP date, as in "Fri, 09 Oct 2026 12:00:03 GMT".
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
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
 * recipient, no answer within the timeout (MAIL_TIMEOUT_MS unless given), or a
 * refusal, a rate limit (429) among them.
 */
export async function sendMail(mail: Mail, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<MailResult> {
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
      signal: AbortSignal.timeout(opts.timeoutMs ?? MAIL_TIMEOUT_MS),
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
    const wait = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null;
    throw new MailError(`The email service refused the email (${res.status}${name ? `, ${name}` : ''}).`, res.status, wait);
  }
  const id = await res
    .json()
    .then((b: any) => (typeof b?.id === 'string' ? b.id : null))
    .catch(() => null);
  return { sent: true, id };
}
