// lib/connection-notices.ts
//
// The emails about bank connections that need the person (#51), sent from the
// daily snapshot (lib/snapshot-job.ts), which already fetches every
// institution of every container once a day.
//
// ONE NOTICE PER BREAK, AND ONE REMINDER. A break is an episode: it begins at
// the first daily run that finds a connection in a state worth an email, and
// ends at the first run that finds it fine again, or when it is repaired here
// or removed (lib/connection-health.ts). An episode gets at most one notice,
// and one reminder a week later if it is still not fine. Nothing else: alert
// fatigue makes people stop reading. A change of state within an episode (a
// warned connection that then does end) sends nothing new; the reminder speaks
// of the state it finds. Only the daily run starts an episode, so a dashboard
// load that saw a failure first sends nothing.
//
// WHAT IS WORTH AN EMAIL. What only the person can fix: their sign-in
// (needs_reauth), a connection to remove and make again (relink), a bank
// reporting no open accounts (closed), and Plaid's warning that a connection
// will end on a date (reconnect_soon). An outage needs nothing from them, so
// it is told only once it has lasted OUTAGE_NOTICE_DAYS, counted from when it
// last answered: a three-week silence found by accident is what this is for.
// An account missing from a good answer settles itself within days
// (lib/vanished.ts), and is not emailed.
//
// NEVER TWICE. The episode is stored (connection-notices,
// lib/connection-records.ts) before any email about it goes, and marked sent
// only once the email was accepted: a failed send leaves it unmarked for the
// next run. Runs for one container never overlap (the snapshot's lock), and the
// catch-up run two hours later, which runs again the containers that came back
// unclean, finds the episode marked and sends nothing. Each email carries an
// idempotency key built from its episodes and its text, so one whose answer was
// lost is not delivered twice when it is retried.
//
// STRICT. The stores are read strictly: a connection whose warning or episode
// can't be read is left exactly as it is, with nothing sent, never read as
// "never told" (which could send twice) or as "no warning" (which could end
// its episode). Only readable records are ever removed.
//
// One email per container per run, naming each connection that is due and
// what to do, with a link to the app. Never a balance, an amount or an account
// number: the institution's name, the action, and a date where Plaid gave one.

import { createHash, randomUUID } from 'node:crypto';
import type { Ctx } from './containers';
import type { InstitutionResult } from './networth';
import { warningsStore, syncsStore, noticesStore, type ConnectionNotice } from './connection-records';
import { healthOf, utcDaysBetween, warningLapsed, type ConnectionHealth, type HealthState } from './connection-state';
import { recordSyncs } from './connection-health';
import { mailOff, sendMail } from './mail';
import { noticeRecipients } from './notice-recipients';

/** Days an outage lasts, from the last good answer, before it is emailed. */
export const OUTAGE_NOTICE_DAYS = 3;
/** Days after the notice that the one reminder goes, if still not fine. */
export const REMINDER_DAYS = 7;
/** How long finding whom to write to may take (a Clerk lookup). */
const RECIPIENTS_TIMEOUT_MS = 5_000;

/** The states an episode is made of. */
const BREAKS: ReadonlySet<HealthState> = new Set<HealthState>(['reconnect_soon', 'needs_reauth', 'outage', 'relink', 'closed']);

export type NoticeKind = 'notice' | 'reminder';

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One connection's episode after this run, and whether an email about it is
 * due. Pure: what is stored and sent is the caller's. `prev` is the episode as
 * stored, `newEpisode` makes the id of a new one.
 */
export function decideNotice(
  prev: ConnectionNotice | null,
  health: ConnectionHealth,
  now: number,
  newEpisode: () => string = randomUUID
): { next: ConnectionNotice | null; send: NoticeKind | null } {
  if (!BREAKS.has(health.state)) return { next: null, send: null };
  const current: ConnectionNotice = prev ?? { episode: newEpisode(), since: iso(now), state: health.state, notified_at: null, reminded_at: null };
  const next = { ...current, state: health.state };
  if (current.notified_at === null) return { next, send: worthTelling(health, current.since, now) ? 'notice' : null };
  if (current.reminded_at === null && utcDaysBetween(current.notified_at, now) >= REMINDER_DAYS) return { next, send: 'reminder' };
  return { next, send: null };
}

/** An outage is told once it has lasted OUTAGE_NOTICE_DAYS since the last good
 *  answer (or since the episode began, when that was never recorded); anything
 *  else at once. */
function worthTelling(h: ConnectionHealth, since: string, now: number): boolean {
  if (h.state !== 'outage') return true;
  return utcDaysBetween(h.last_ok_at ?? since, now) >= OUTAGE_NOTICE_DAYS;
}

/** Whether two stored episodes are the same, field by field. */
function same(a: ConnectionNotice | null, b: ConnectionNotice | null): boolean {
  if (a === null || b === null) return a === b;
  return a.episode === b.episode && a.since === b.since && a.state === b.state && a.notified_at === b.notified_at && a.reminded_at === b.reminded_at;
}

/**
 * The app's public address, from APP_URL, for the link in an email: https, or
 * http on this machine for local development. Null when unset or unusable, and
 * then the email says to open Nya without a link.
 */
export function appUrl(): string | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Where an email sends the person: the connection health view. */
export const CONNECTIONS_PATH = '/?view=connections';

/** An institution's name as an email may carry it: no control characters,
 *  one line, and not too long. */
function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'A bank';
}

/** "October 15": a UTC day, which is all the server knows of a reader's day,
 *  so the emails say "around" it. */
function utcDay(at: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(at));
}

/** One connection due an email, as the email describes it. */
export type DueNotice = { institution_name: string; health: ConnectionHealth; since: string; kind: NoticeKind };

function subjectFor(name: string, h: ConnectionHealth): string {
  switch (h.state) {
    case 'reconnect_soon':
      return `Reconnect ${name} soon`;
    case 'needs_reauth':
      return `${name} needs reconnecting`;
    case 'relink':
      return h.cause === 'unsupported' ? `${name} can no longer be updated` : `${name} needs connecting again`;
    case 'closed':
      return `${name} reports no open accounts`;
    default:
      return `${name} isn't updating`;
  }
}

/** What to say about one connection: what is wrong and what to do. */
function lineFor(name: string, d: DueNotice, now: number): string {
  const h = d.health;
  const again = `connect ${name} again: its history carries over when you link the new accounts to the old ones`;
  switch (h.cause) {
    case 'consent_ending':
    case 'disconnect_pending':
      return `Plaid says ${name}'s connection will end ${h.ends_at ? `around ${utcDay(h.ends_at)}` : 'soon'}. Reconnect it before then to keep it updating: it takes a minute.`;
    case 'login':
      return `${name} needs you to sign in again before Nya can update it. Reconnect it: it takes a minute.`;
    case 'access':
      return `${name} isn't sharing everything Nya needs. Reconnect it and allow access to your accounts.`;
    case 'locked':
      return `${name} has locked the sign-in Nya uses. Unlock it with ${name}, then reconnect it.`;
    case 'bank_action':
      return `${name} needs something done on its own website first, such as a new password or terms to accept. Do that, then reconnect it.`;
    case 'revoked':
      return `Access to ${name} was withdrawn, so this connection can't be repaired. Remove it and ${again}.`;
    case 'gone':
      return `Plaid no longer has this connection to ${name}, so it can't be repaired. Remove it and ${again}.`;
    case 'token':
      return `Plaid doesn't accept Nya's access to ${name}. If Nya's Plaid settings changed, put them back; otherwise remove it and ${again}.`;
    case 'unsupported':
      return `Plaid can no longer reach ${name}, so reconnecting won't help. Remove the connection; its history is kept.`;
    case 'no_accounts':
      return `${name} reports no open accounts. If you closed them, remove the connection; their history is kept.`;
    case 'credentials':
      return `Nya can't read the sign-in it keeps for ${name}, a problem on Nya's side, not the bank's. Whoever runs Nya should check its encryption keys.`;
    default: {
      const days = utcDaysBetween(h.last_ok_at ?? d.since, now);
      const why =
        h.cause === 'institution_down'
          ? `${name} isn't answering`
          : h.cause === 'provider'
            ? `Plaid, which Nya reaches ${name} through, is having trouble`
            : `Nya can't get an answer from ${name}`;
      return `${name} hasn't updated for ${days} days: ${why}. There's nothing to do yet, as this usually clears on its own. Until it does, Nya shows its last known balances, marked as such.`;
    }
  }
}

/**
 * The email for the connections due one, in plain text. Names and actions
 * only: whatever the institutions hold, nothing here reads a balance, an
 * amount or an account number.
 */
export function composeNotice(due: DueNotice[], link: string | null, now: number): { subject: string; text: string } {
  const allReminders = due.every((d) => d.kind === 'reminder');
  const subject =
    due.length === 1
      ? `${due[0].kind === 'reminder' ? 'Reminder: ' : ''}${subjectFor(cleanName(due[0].institution_name), due[0].health)}`
      : allReminders
        ? `Reminder: ${due.length} bank connections still need attention`
        : `${due.length} bank connections need attention`;
  const lines = due.map((d) => `${d.kind === 'reminder' ? 'Reminder: ' : ''}${lineFor(cleanName(d.institution_name), d, now)}`);
  const open = link ? `Open Nya to see the details and act on ${due.length === 1 ? 'it' : 'them'}: ${link}${CONNECTIONS_PATH}` : 'Open Nya to see the details.';
  const footer =
    'Nya sends one email when a bank connection needs you, and one reminder a week later if it still does. Its emails never include balances, amounts or account numbers.';
  return { subject, text: [...lines, open, footer].join('\n\n') + '\n' };
}

/** Rejects after `ms`, so a slow lookup can't hold up the daily run. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export type CheckOptions = {
  now?: number;
  /** For tests: what reaches Resend, and whom to write to. */
  fetch?: typeof fetch;
  recipients?: (ctx: Ctx) => Promise<string[]>;
  newEpisode?: () => string;
};

export type CheckReport = {
  /** Connections whose records could not be read or saved, left for the next run. */
  skipped: number;
  /** Notices and reminders that were due this run. */
  due: number;
  /** What became of the email: none was due, it was sent, mail is off, there
   *  was nobody to send it to, or it failed (and is tried again next run). */
  mail: 'none' | 'sent' | 'off' | 'no-recipient' | 'failed';
};

const nameOf = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/**
 * The daily run's part in connection health, for one container, after its
 * fetch: records each connection's last good sync, tidies the records of
 * connections that are gone and warnings that lapsed, moves every episode on,
 * and sends one email for the connections due one. Reads strictly; throws only
 * if the records can't be read at all (the caller logs it, and the next run
 * tries again). Never touches a balance or the history layer.
 */
export async function checkConnections(ctx: Ctx, institutions: InstitutionResult[], opts: CheckOptions = {}): Promise<CheckReport> {
  const now = opts.now ?? Date.now();
  const nowIso = iso(now);
  const linked = institutions.filter((i) => !i.manual);
  await recordSyncs(ctx, linked, now);

  const [warnings, syncs, notices] = await Promise.all([warningsStore.getAllReport(ctx), syncsStore.getAllReport(ctx), noticesStore.getAllReport(ctx)]);
  const unusable = new Set([...warnings.unreadable, ...warnings.unrecognised, ...notices.unreadable, ...notices.unrecognised]);
  const live = new Set(linked.map((i) => i.item_id));
  const lastOkOf = (inst: InstitutionResult) => (inst.error ? syncs.entries.get(inst.item_id)?.at ?? null : nowIso);

  // Records of connections no longer linked (a disconnect removes its own; this
  // catches one a run in flight wrote back), and warnings that have lapsed.
  // Readable entries only: nothing is removed on the strength of a read that
  // failed.
  const gone = (ids: Iterable<string>) => [...ids].filter((id) => !live.has(id));
  const lapsed = linked
    .filter((inst) => {
      const w = warnings.entries.get(inst.item_id);
      return w !== undefined && warningLapsed(w, lastOkOf(inst), inst.consent_expires_at);
    })
    .map((inst) => inst.item_id);
  await Promise.all([
    warningsStore.remove(ctx, ...gone(warnings.entries.keys()), ...lapsed),
    syncsStore.remove(ctx, ...gone(syncs.entries.keys())),
    noticesStore.remove(ctx, ...gone(notices.entries.keys())),
  ]);

  let skipped = 0;
  let unreadable = 0;
  const due: (DueNotice & { item_id: string; episode: string })[] = [];
  for (const inst of linked) {
    const id = inst.item_id;
    if (unusable.has(id)) {
      skipped++;
      unreadable++;
      continue;
    }
    // healthOf passes over a lapsed warning by the same rule as above.
    const health = healthOf(inst, warnings.entries.get(id) ?? null, lastOkOf(inst), now);
    const prev = notices.entries.get(id) ?? null;
    const { next, send } = decideNotice(prev, health, now, opts.newEpisode);
    let stored = prev;
    if (!same(prev, next)) {
      try {
        // Only over what was read: anything that changed it since (a reconnect
        // clearing it) wins, and this run then sends nothing for it.
        stored = await noticesStore.update(ctx, id, (current) => (same(current, prev) ? next : current));
      } catch (err) {
        console.error(`Connection notices: an episode could not be saved for container ${ctx.container}.`, nameOf(err));
        skipped++;
        continue;
      }
      if (!same(stored, next)) continue;
    }
    if (send && stored) due.push({ item_id: id, episode: stored.episode, institution_name: inst.institution_name, health, since: stored.since, kind: send });
  }
  if (unreadable > 0) {
    console.error(`Connection notices: ${unreadable} connection(s) in container ${ctx.container} have records that could not be read; left as they are.`);
  }

  const report = (mail: CheckReport['mail']): CheckReport => ({ skipped, due: due.length, mail });
  if (due.length === 0) return report('none');
  if (mailOff()) return report('off');

  let to: string[];
  try {
    to = await within((opts.recipients ?? noticeRecipients)(ctx), RECIPIENTS_TIMEOUT_MS, 'Finding the recipient');
  } catch (err) {
    console.error(`Connection notices: the recipient for container ${ctx.container} could not be found; trying again next run.`, nameOf(err));
    return report('failed');
  }
  if (to.length === 0) {
    console.warn(`Connection notices: nobody to email for container ${ctx.container} (see NOTIFY_EMAIL in docs/deployment.md).`);
    return report('no-recipient');
  }

  const { subject, text } = composeNotice(due, appUrl(), now);
  const key = createHash('sha256')
    .update(JSON.stringify({ e: due.map((d) => `${d.episode}:${d.kind}`).sort(), to: [...to].sort(), subject, text }))
    .digest('hex')
    .slice(0, 48);
  try {
    const result = await sendMail({ to, subject, text, idempotencyKey: `nya-connections-${key}` }, { fetch: opts.fetch });
    if (!result.sent) return report('off');
  } catch (err) {
    // Not marked: the next run sends it again.
    console.error(`Connection notices: the email for container ${ctx.container} was not sent; trying again next run.`, err instanceof Error ? err.message : nameOf(err));
    return report('failed');
  }

  // Marked sent, each only while it is still the episode the email was about.
  for (const d of due) {
    const field = d.kind === 'notice' ? 'notified_at' : 'reminded_at';
    try {
      await noticesStore.update(ctx, d.item_id, (current) => (current && current.episode === d.episode ? { ...current, [field]: nowIso } : current));
    } catch (err) {
      console.error(`Connection notices: a sent email could not be recorded for container ${ctx.container}.`, nameOf(err));
    }
  }
  console.log(`Connection notices: emailed about ${due.length} connection(s) in container ${ctx.container}.`);
  return report('sent');
}
