// lib/connection-notices.ts
//
// The emails about bank connections that need the person (#51), sent from the
// daily snapshot (lib/snapshot-job.ts), which already fetches every
// institution of every container once a day.
//
// IN TWO STEPS. Each container's snapshot decides what is due about its own
// connections (prepareNotices, under that container's lock), and the emails go
// once every container has run (sendNotices). So a fault many containers share
// is seen before anybody is written to (A SHARED FAULT, below), and the emails
// have a time budget of their own, which can never push the run past its limit
// (TIME, below).
//
// ONE NOTICE PER THING TO DO, AND ONE REMINDER. A break is an episode: it
// begins at the first daily run that finds a connection in a state worth an
// email, and ends at the first run that finds it fine again, or when it is
// repaired here or removed (lib/connection-health.ts). An episode gets one
// notice, and one reminder a week later if it is still not fine. If it then
// turns into something the person has to do that they haven't been told of (an
// outage that comes back needing a sign-in, a warned end that has come), that
// gets a notice of its own at once, and a reminder of its own. Each state is
// told at most once an episode, so a connection that flaps between two never
// repeats itself. Nothing else: alert fatigue makes people stop reading. Only
// the daily run starts an episode, so a dashboard load that saw a failure
// first sends nothing.
//
// WHAT IS WORTH AN EMAIL, AND WHEN. At once, what is plainly the person's or
// their bank's and needs them: their sign-in (needs_reauth), a connection to
// remove and make again (relink), a bank reporting no open accounts (closed),
// and Plaid's warning that a connection will end on a date (reconnect_soon).
// Only once the connection has gone OUTAGE_NOTICE_DAYS without answering: an
// outage, which needs nothing from them (a three-week silence found by
// accident is what this is for), and anything on Plaid's side or that Nya
// can't place, which one fault can bring to everyone at once, so whoever runs
// Nya has days to see it first. Never: a problem on Nya's side (a key it can't
// read, Plaid refusing its settings or its access token, which is what a
// PLAID_ENV or PLAID_SECRET for the wrong environment looks like). The person
// can do nothing about it, so the log tells whoever runs Nya instead. An
// account missing from a good answer settles itself within days
// (lib/vanished.ts), and is not emailed.
//
// A SHARED FAULT. A deployment mistake, or a fault at Plaid, gives many
// containers the same Plaid code at once. So when notices about a cause on
// Plaid's side or one Nya can't place first become due on the same run in
// MASS_BREAK_CONTAINERS or more containers with the same code, those notices
// are held back for HOLD_DAYS, and the log tells whoever runs Nya, with the
// day they go. A held notice is never held again: once its days are up it
// goes, once, like any other, if its break is still open (fixed, the break
// ends and nothing goes). Holds are recorded within the run's mail deadline;
// one left unrecorded only means that email is not held, and goes next run. Only notices first due on this run can start a
// hold, and only those that share the code are held, so a hold never latches
// on breaks that stay open, and a different problem maturing the same day,
// or a later one, is never caught in it. Nothing on the person's or their
// bank's side is ever held: no deployment mistake makes a bank ask for a new
// sign-in, and a bank asking everyone at once is when each person should be
// told.
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
// TIME. The emails of a run have a budget (MAIL_BUDGET_MS, within the run's own
// deadline, MAIL_DEADLINE_MS in lib/snapshot-job.ts), and each call a short
// timeout of its own: finding whom to write to, and the send (lib/mail.ts). An
// email is started only if both can end in time. They go one at a time, at
// most two a second (Resend's default limit), and a 429 is waited out once
// when its Retry-After is short. Whatever doesn't fit, and everything after a
// failure of the email service itself, waits for the next run, unmarked.
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
import type { ContainerId, Ctx } from './containers';
import type { InstitutionResult } from './networth';
import { warningsStore, syncsStore, noticesStore, type ConnectionNotice } from './connection-records';
import { CONNECTIONS_PATH, healthOf, utcDaysBetween, warningLapsed, type ConnectionHealth, type HealthState } from './connection-state';
import { recordSyncs } from './connection-health';
import { MAIL_TIMEOUT_MS, MailError, isEmailAddress, mailOff, sendMail, type Mail } from './mail';
import { noticeRecipients, type RecipientDeps } from './notice-recipients';
import { appUrl } from './app-url';
import { ownersByContainer } from './owners';

/** Days a connection goes without answering before an outage, or a problem on
 *  Plaid's side or one Nya can't place, is emailed. */
export const OUTAGE_NOTICE_DAYS = 3;
/** Days after a notice that its one reminder goes, if still not fine. */
export const REMINDER_DAYS = 7;
/** How many containers whose notices first become due on one run with the
 *  same Plaid code, about a cause on Plaid's side or one Nya can't place, make
 *  that a shared fault, whose notices are held back. */
export const MASS_BREAK_CONTAINERS = 3;
/** How long a notice held back by a shared fault waits, before it goes anyway
 *  if its break is still open: whoever runs Nya has had the log line that long. */
export const HOLD_DAYS = 3;
/** How long the emails of one run may take in all. */
export const MAIL_BUDGET_MS = 30_000;
/** How long finding whom to write to may take (a Clerk lookup). */
export const RECIPIENTS_TIMEOUT_MS = 3_000;
/** The least time between the starts of two sends: Resend's default limit is
 *  two requests a second. */
export const SEND_INTERVAL_MS = 500;
/** The longest Retry-After a rate-limited send is waited out for, once. */
export const RETRY_AFTER_MAX_MS = 2_000;
/** How many holds of a shared fault are recorded at once. */
const HOLD_WRITES_AT_ONCE = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The daily job's own timing (a cron that starts late, a fetch that takes a
 *  while): this much short of a whole day still counts as one. */
const DAY_SLACK_MS = 60 * 60 * 1000;

/** The states an episode is made of. */
const BREAKS: ReadonlySet<HealthState> = new Set<HealthState>(['reconnect_soon', 'needs_reauth', 'outage', 'relink', 'closed']);
/** The ones that need the person to do something. */
const NEEDS_YOU: ReadonlySet<HealthState> = new Set<HealthState>(['reconnect_soon', 'needs_reauth', 'relink', 'closed']);

export type NoticeKind = 'notice' | 'reminder';

const iso = (ms: number) => new Date(ms).toISOString();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whole days from an ISO time to `now`, as elapsed time, allowing the daily
 *  job's own timing (DAY_SLACK_MS). */
export function elapsedDays(fromIso: string, now: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return NaN;
  return Math.max(0, Math.floor((now - from + DAY_SLACK_MS) / DAY_MS));
}

/** The states an episode's notices were about. A record from before they were
 *  kept reads as its own state, once notified. */
function toldOf(n: ConnectionNotice): HealthState[] {
  return n.told ?? (n.notified_at === null ? [] : [n.state]);
}

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
  const current: ConnectionNotice = prev ?? { episode: newEpisode(), since: iso(now), state: health.state, side: health.side, notified_at: null, reminded_at: null, told: [] };
  const next: ConnectionNotice = { ...current, state: health.state, side: health.side };
  // Never about a problem on Nya's side: there is nothing the person can do,
  // and one deployment mistake must not email everybody. The log tells whoever
  // runs Nya instead (sendNotices).
  if (health.side === 'nya' || !worthTelling(health, current.since, now)) return { next, send: null };
  if (current.notified_at === null) return { next, send: 'notice' };
  // Told before, and now it needs them in a way they haven't been told of.
  if (NEEDS_YOU.has(health.state) && !toldOf(current).includes(health.state)) return { next, send: 'notice' };
  if (current.reminded_at === null && utcDaysBetween(current.notified_at, now) >= REMINDER_DAYS) return { next, send: 'reminder' };
  return { next, send: null };
}

/** What is plainly the person's or their bank's, and needs them, is told at
 *  once. An outage, or a cause on Plaid's side or that Nya can't place, only
 *  once the connection has gone OUTAGE_NOTICE_DAYS without answering (counted
 *  from the episode's start when its last good answer was never recorded). */
function worthTelling(h: ConnectionHealth, since: string, now: number): boolean {
  if (h.state !== 'outage' && (h.side === 'you' || h.side === 'bank')) return true;
  return elapsedDays(h.last_ok_at ?? since, now) >= OUTAGE_NOTICE_DAYS;
}

/** Whether two stored episodes are the same, field by field. */
function same(a: ConnectionNotice | null, b: ConnectionNotice | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.episode === b.episode &&
    a.since === b.since &&
    a.state === b.state &&
    a.side === b.side &&
    a.notified_at === b.notified_at &&
    a.reminded_at === b.reminded_at &&
    JSON.stringify(a.told ?? null) === JSON.stringify(b.told ?? null) &&
    a.due_since === b.due_since &&
    a.held_at === b.held_at
  );
}

// The app's public address, for the link in an email (lib/app-url.ts): null
// when APP_URL is unset or unusable, and then the email says to open Nya
// without a link.
export { appUrl };


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

/** Whether the end Plaid warned of has already come. */
const ended = (h: ConnectionHealth, now: number) => !!h.ends_at && Date.parse(h.ends_at) <= now;

function subjectFor(name: string, h: ConnectionHealth, now: number): string {
  switch (h.state) {
    case 'reconnect_soon':
      return ended(h, now) ? `Reconnect ${name} now` : `Reconnect ${name} soon`;
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
      if (h.ends_at && ended(h, now)) {
        return `Plaid said ${name}'s connection would end around ${utcDay(h.ends_at)}. Reconnect it now to keep it updating: it takes a minute.`;
      }
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
    case 'unsupported':
      return `Plaid can no longer reach ${name}, so reconnecting won't help. Remove the connection; its history is kept.`;
    case 'no_accounts':
      return `${name} reports no open accounts. If you closed them, remove the connection; their history is kept.`;
    // Never due (decideNotice): worded all the same, asking nothing of the
    // person, should one ever be composed.
    case 'credentials':
    case 'token':
    case 'setup':
      return `${name} isn't updating because of a problem on Nya's side, not the bank's or yours. There's nothing for you to do: whoever runs Nya puts it right, and the connection then works as before.`;
    default: {
      // Counted from the last good answer, or from when the daily job first saw
      // the break, which it may have begun before: then "at least".
      const days = elapsedDays(h.last_ok_at ?? d.since, now);
      const why =
        h.cause === 'institution_down'
          ? `${name} isn't answering`
          : h.cause === 'provider'
            ? `Plaid, which Nya reaches ${name} through, is having trouble`
            : `Nya can't get an answer from ${name}`;
      return `${name} hasn't updated for ${h.last_ok_at ? '' : 'at least '}${days} days: ${why}. There's nothing to do yet, as this usually clears on its own, and if it turns into something you need to do, Nya will email you about that. Until then, Nya shows its last known balances, marked as such.`;
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
      ? `${due[0].kind === 'reminder' ? 'Reminder: ' : ''}${subjectFor(cleanName(due[0].institution_name), due[0].health, now)}`
      : allReminders
        ? `Reminder: ${due.length} bank connections still need attention`
        : `${due.length} bank connections need attention`;
  const lines = due.map((d) => `${d.kind === 'reminder' ? 'Reminder: ' : ''}${lineFor(cleanName(d.institution_name), d, now)}`);
  const open = link ? `Open Nya to see the details and act on ${due.length === 1 ? 'it' : 'them'}: ${link}${CONNECTIONS_PATH}` : 'Open Nya to see the details.';
  const footer =
    'Nya emails you once when a bank connection needs you, and again only if what it needs from you changes, with one reminder a week later if it still does. Its emails never include balances, amounts or account numbers.';
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

const nameOf = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/** One connection's email that is due, with what marks it sent. `label` is
 *  Plaid's code (or the cause, without one); `fresh` says it is a notice
 *  about a cause on Plaid's side or one Nya can't place that first became due
 *  on this run, which alone can join a shared fault (A SHARED FAULT). */
type Due = DueNotice & { item_id: string; episode: string; label: string; fresh: boolean };

/** One container's part of a run, decided and waiting for its email
 *  (prepareNotices), which sendNotices sends with every other's. */
export type PendingNotices = {
  ctx: Ctx;
  /** The run's time, as the records give it. */
  now: number;
  due: Due[];
  /** Notices a shared fault held back on an earlier run, whose days are not
   *  up: their code (or cause), and when they go. */
  held: { label: string; until: number }[];
  /** The codes (or causes) of its connections failing on Nya's side, which
   *  nobody is emailed about: for the operator's log. */
  nyaSide: string[];
  /** Connections whose records could not be read or saved, left for the next run. */
  skipped: number;
};

export type PrepareOptions = {
  now?: number;
  /** For tests: the id of a new episode. */
  newEpisode?: () => string;
};

/**
 * The daily run's first part in connection health, for one container, after
 * its fetch: records each connection's last good sync, tidies the records of
 * connections that are gone and warnings that lapsed, moves every episode on,
 * and returns what is due, for sendNotices. Reads strictly; throws only if the
 * records can't be read at all (the caller logs it, and the next run tries
 * again). Never touches a balance or the history layer.
 */
export async function prepareNotices(ctx: Ctx, institutions: InstitutionResult[], opts: PrepareOptions = {}): Promise<PendingNotices> {
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
  // failed. A lapsed warning goes only if it is still the one read: a webhook
  // can record a fresh one meanwhile, and that one stays.
  const gone = (ids: Iterable<string>) => [...ids].filter((id) => !live.has(id));
  const lapsed = linked.flatMap((inst) => {
    const w = warnings.entries.get(inst.item_id);
    return w !== undefined && warningLapsed(w, lastOkOf(inst), inst.consent_expires_at) ? [[inst.item_id, JSON.stringify(w)] as const] : [];
  });
  try {
    await Promise.all([
      warningsStore.remove(ctx, ...gone(warnings.entries.keys())),
      ...lapsed.map(([id, read]) => warningsStore.update(ctx, id, (current) => (current && JSON.stringify(current) === read ? null : current))),
      syncsStore.remove(ctx, ...gone(syncs.entries.keys())),
      noticesStore.remove(ctx, ...gone(notices.entries.keys())),
    ]);
  } catch (err) {
    // Tidying only: what is decided below never reads a lapsed warning or a
    // gone connection's record, and the next run tidies again.
    console.error(`Connection notices: old records could not be dropped for container ${ctx.container}.`, nameOf(err));
  }

  let skipped = 0;
  let unreadable = 0;
  const due: Due[] = [];
  const held: PendingNotices['held'] = [];
  const nyaSide: string[] = [];
  for (const inst of linked) {
    const id = inst.item_id;
    if (unusable.has(id)) {
      skipped++;
      unreadable++;
      continue;
    }
    // healthOf passes over a lapsed warning by the same rule as above.
    const health = healthOf(inst, warnings.entries.get(id) ?? null, lastOkOf(inst), now);
    const label = health.code ?? health.cause;
    if (health.side === 'nya') nyaSide.push(label);
    const prev = notices.entries.get(id) ?? null;
    const decided = decideNotice(prev, health, now, opts.newEpisode);
    const { send } = decided;
    // When a notice first becomes due, so a later run knows it is not new.
    const next = send === 'notice' && decided.next && !decided.next.due_since ? { ...decided.next, due_since: nowIso } : decided.next;
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
    if (!send || !stored) continue;
    // Held back by an earlier run's shared fault, while its days are not up.
    // A cause that has since moved to the person's or their bank's side goes
    // now: nothing there is ever held.
    if (send === 'notice' && stored.held_at && faultSide(health) && elapsedDays(stored.held_at, now) < HOLD_DAYS) {
      held.push({ label, until: Date.parse(stored.held_at) + HOLD_DAYS * DAY_MS });
      continue;
    }
    const fresh = send === 'notice' && faultSide(health) && !prev?.due_since && !stored.held_at;
    due.push({ item_id: id, episode: stored.episode, institution_name: inst.institution_name, health, since: stored.since, kind: send, label, fresh });
  }
  if (unreadable > 0) {
    console.error(`Connection notices: ${unreadable} connection(s) in container ${ctx.container} have records that could not be read; left as they are.`);
  }
  return { ctx, now, due, held, nyaSide, skipped };
}

/** What became of a container's email: none was due, it was sent, mail is off,
 *  there was nobody to send it to, it failed, all it was due was held back by
 *  a shared fault, or there was no time left; all but "sent" and "none" are
 *  tried again by the next run (a held one once its days are up). An email
 *  sent while some of what was due was held back is "sent". */
export type MailOutcome = 'none' | 'sent' | 'off' | 'no-recipient' | 'failed' | 'held' | 'deferred';

export type SendOptions = {
  /** By `clock`: when every call must have ended. Unset, MAIL_BUDGET_MS from
   *  now. The daily job passes its own deadline. */
  deadline?: number;
  clock?: () => number;
  /** For tests: the pause between sends and before a retry. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: what reaches Resend, whom to write to (or, through the real
   *  lookup, Clerk's side of it), and the timeouts. */
  fetch?: typeof fetch;
  recipients?: (ctx: Ctx) => Promise<string[]>;
  recipientDeps?: Omit<RecipientDeps, 'owners'>;
  sendTimeoutMs?: number;
  recipientsTimeoutMs?: number;
};

/** "INVALID_ACCESS_TOKEN (3), ITEM_NOT_FOUND": Plaid's codes, which are its
 *  public vocabulary, never data, with how many of each. */
function tally(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([l, n]) => (n > 1 ? `${l} (${n})` : l))
    .join(', ');
}

/** Whether a cause is one a fault in Nya's setup or at Plaid can bring to
 *  everybody at once: on Plaid's side, or one Nya can't place (Nya's own side
 *  is never emailed at all). Only notices about these are ever held back. */
const faultSide = (h: ConnectionHealth) => h.side === 'plaid' || h.side === 'unknown';

/** The first call starts it; every later one gets the same answer, or the
 *  same failure. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}

/** The idempotency key of an email: its episodes, its recipients and its text. */
function idempotencyKey(due: Due[], to: string[], subject: string, text: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ e: due.map((d) => `${d.episode}:${d.kind}`).sort(), to: [...to].sort(), subject, text }))
    .digest('hex')
    .slice(0, 48);
  return `nya-connections-${hash}`;
}

/** An episode once its email was accepted: a notice is marked with the state it
 *  was about, and starts its own reminder's week. */
function marked(current: ConnectionNotice, d: Due, at: string): ConnectionNotice {
  if (d.kind === 'reminder') return { ...current, reminded_at: at };
  const { due_since: _due, held_at: _held, ...rest } = current;
  const told = toldOf(current);
  return { ...rest, notified_at: at, reminded_at: null, told: told.includes(d.health.state) ? told : [...told, d.health.state] };
}

/** Says, for whoever runs Nya, which notices an earlier run held back are
 *  still waiting, and from when they go. */
function logStillHeld(batch: PendingNotices[]): void {
  const held = batch.flatMap((p) => p.held);
  if (held.length === 0) return;
  const from = Math.min(...held.map((h) => h.until));
  console.warn(
    `Connection notices: ${held.length} email(s) held back by an earlier run for a fault many containers shared (${tally(held.map((h) => h.label))}) go from ${utcDay(iso(from))} (UTC), if the problem is still there.`
  );
}

/**
 * The daily run's second part: the emails, once every container has decided
 * its own (prepareNotices). Looks first for a shared fault among the notices
 * first due on this run, and holds those back (A SHARED FAULT); then sends
 * each container's one email about the rest, one at a time, within the
 * deadline, marking each episode sent once Resend accepted it. Never throws:
 * each container's outcome is its own, and the log says why.
 */
export async function sendNotices(batch: PendingNotices[], opts: SendOptions = {}): Promise<Map<ContainerId, MailOutcome>> {
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? wait;
  const deadline = opts.deadline ?? clock() + MAIL_BUDGET_MS;
  const sendTimeout = opts.sendTimeoutMs ?? MAIL_TIMEOUT_MS;
  const lookupTimeout = opts.recipientsTimeoutMs ?? RECIPIENTS_TIMEOUT_MS;
  const outcomes = new Map<ContainerId, MailOutcome>(batch.map((p) => [p.ctx.container, 'none']));

  // For whoever runs Nya: what nobody is emailed about.
  const onNya = batch.filter((p) => p.nyaSide.length > 0);
  if (onNya.length > 0) {
    console.error(
      `Connection notices: ${onNya.reduce((n, p) => n + p.nyaSide.length, 0)} connection(s) in ${onNya.length} container(s) fail for a reason on Nya's side (${tally(onNya.flatMap((p) => p.nyaSide))}), and nobody is emailed about them. Check that PLAID_ENV, PLAID_CLIENT_ID and PLAID_SECRET are the ones the connections were made with, and the encryption keys (docs/deployment.md).`
    );
  }

  // A shared fault: notices first due on this run in MASS_BREAK_CONTAINERS or
  // more containers with the same code are held back, and only those.
  const containersOf = new Map<string, Set<ContainerId>>();
  for (const p of batch) for (const d of p.due) if (d.fresh) containersOf.set(d.label, (containersOf.get(d.label) ?? new Set()).add(p.ctx.container));
  const sharedCodes = new Set([...containersOf].filter(([, cs]) => cs.size >= MASS_BREAK_CONTAINERS).map(([label]) => label));
  const holdNow = (d: Due) => d.fresh && sharedCodes.has(d.label);
  const items = new Map(batch.map((p) => [p.ctx.container, p.due.filter((d) => !holdNow(d))]));
  for (const p of batch) {
    if (items.get(p.ctx.container)!.length === 0 && (p.due.length > 0 || p.held.length > 0)) outcomes.set(p.ctx.container, 'held');
  }
  const due = batch.filter((p) => items.get(p.ctx.container)!.length > 0);
  const holding = batch.some((p) => p.due.some(holdNow));
  if (due.length === 0 && !holding) {
    logStillHeld(batch);
    return outcomes;
  }
  if (mailOff()) {
    for (const p of batch) if (p.due.length > 0) outcomes.set(p.ctx.container, 'off');
    return outcomes;
  }

  if (holding) {
    const now = Math.max(...batch.map((p) => p.now));
    const count = batch.reduce((n, p) => n + p.due.filter(holdNow).length, 0);
    console.error(
      `Connection notices: new problems with the same Plaid code in ${MASS_BREAK_CONTAINERS} or more containers at once (${[...sharedCodes].map((l) => `${l} in ${containersOf.get(l)!.size}`).join(', ')}). That looks like a fault in Nya's setup or at Plaid rather than at each person's bank, so those ${count} email(s) are held back until ${utcDay(iso(now + HOLD_DAYS * DAY_MS))} (UTC), and go with that day's run if the problem is still there. Check PLAID_ENV, PLAID_CLIENT_ID and PLAID_SECRET, and Plaid's status page; each connection shows on its Connection health card.`
    );
    // Recorded on each held notice, so it waits out its days and is never
    // held again; only while it is still the episode, and not held already. A
    // few at a time, and none once the deadline has passed: a hold left
    // unrecorded only means that email is not held, and it goes with the next
    // run, since it is no longer first due then.
    const holds = batch.flatMap((p) => p.due.filter(holdNow).map((d) => ({ p, d })));
    let next = 0;
    let unrecorded = 0;
    const lane = async () => {
      while (next < holds.length) {
        const { p, d } = holds[next++];
        if (clock() >= deadline) {
          unrecorded++;
          continue;
        }
        try {
          await noticesStore.update(p.ctx, d.item_id, (current) => (current && current.episode === d.episode && !current.held_at ? { ...current, held_at: iso(p.now) } : current));
        } catch (err) {
          unrecorded++;
          console.error(`Connection notices: a held email could not be recorded for container ${p.ctx.container}.`, nameOf(err));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(HOLD_WRITES_AT_ONCE, holds.length) }, lane));
    if (unrecorded > 0) {
      console.warn(`Connection notices: ${unrecorded} of those holds could not be recorded in time; those emails are not held after this run, and go with the next.`);
    }
  }
  logStillHeld(batch);
  if (due.length === 0) return outcomes;

  // The owners mapping read once for the run, not once per container.
  const owners = once(ownersByContainer);
  const recipients = opts.recipients ?? ((ctx: Ctx) => noticeRecipients(ctx, { ...opts.recipientDeps, owners: async (c) => (await owners()).get(c) ?? [] }));

  let lastStart = -Infinity;
  const attempt = async (mail: Mail): Promise<'sent' | 'off' | Error> => {
    // At most two a second.
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
  for (const [i, p] of due.entries()) {
    const c = p.ctx.container;
    // Started only if finding whom to write to and the send can both end in time.
    if (stopped || clock() + SEND_INTERVAL_MS + lookupTimeout + sendTimeout > deadline) {
      if (!stopped) console.warn(`Connection notices: no time left for this run's emails; ${due.length - i} container(s) wait for the next run.`);
      stopped = true;
      outcomes.set(c, 'deferred');
      continue;
    }

    let to: string[];
    try {
      to = (await within(recipients(p.ctx), lookupTimeout, 'Finding the recipient')).filter(isEmailAddress);
    } catch (err) {
      console.error(`Connection notices: the recipient for container ${c} could not be found; trying again next run.`, nameOf(err));
      outcomes.set(c, 'failed');
      continue;
    }
    if (to.length === 0) {
      console.warn(`Connection notices: nobody to email for container ${c} (see NOTIFY_EMAIL in docs/deployment.md).`);
      outcomes.set(c, 'no-recipient');
      continue;
    }

    const these = items.get(c)!;
    const { subject, text } = composeNotice(these, appUrl(), p.now);
    const mail: Mail = { to, subject, text, idempotencyKey: idempotencyKey(these, to, subject, text) };
    let result = await attempt(mail);
    // Rate limited: waited out once, when Resend asks for a pause short enough
    // to fit. The same key makes the second try safe.
    if (result instanceof MailError && result.status === 429) {
      const pause = result.retryAfterMs ?? 1_000;
      if (pause <= RETRY_AFTER_MAX_MS && clock() + pause + sendTimeout <= deadline) {
        await sleep(pause);
        result = await attempt(mail);
      }
    }
    if (result === 'off') {
      outcomes.set(c, 'off');
      continue;
    }
    if (result !== 'sent') {
      // Not marked: the next run sends it again.
      console.error(`Connection notices: the email for container ${c} was not sent; trying again next run.`, result instanceof MailError ? result.message : nameOf(result));
      outcomes.set(c, 'failed');
      // The email service itself failing (no answer, an error of its own, still
      // rate limited): the rest wait for the next run rather than each waiting
      // out its own timeout. A refusal of this one email (a 4xx) is its own.
      if (!(result instanceof MailError) || result.status === null || result.status === 429 || result.status >= 500) {
        stopped = true;
        if (i + 1 < due.length) console.warn(`Connection notices: the email service is failing, so ${due.length - i - 1} other container(s) wait for the next run.`);
      }
      continue;
    }

    // Marked sent, each only while it is still the episode the email was about.
    const at = iso(p.now);
    for (const d of these) {
      try {
        await noticesStore.update(p.ctx, d.item_id, (current) => (current && current.episode === d.episode ? marked(current, d, at) : current));
      } catch (err) {
        console.error(`Connection notices: a sent email could not be recorded for container ${c}.`, nameOf(err));
      }
    }
    console.log(`Connection notices: emailed about ${these.length} connection(s) in container ${c}.`);
    outcomes.set(c, 'sent');
  }
  return outcomes;
}

export type CheckOptions = PrepareOptions & SendOptions;

export type CheckReport = {
  /** Connections whose records could not be read or saved, left for the next run. */
  skipped: number;
  /** Notices and reminders that were due this run. */
  due: number;
  /** What became of the email (MailOutcome). */
  mail: MailOutcome;
};

/**
 * Both parts for one container on its own: what the daily job does for every
 * container, without the others to compare with. For a caller outside the
 * daily run, and the tests.
 */
export async function checkConnections(ctx: Ctx, institutions: InstitutionResult[], opts: CheckOptions = {}): Promise<CheckReport> {
  const pending = await prepareNotices(ctx, institutions, opts);
  const mail = (await sendNotices([pending], opts)).get(ctx.container) ?? 'none';
  return { skipped: pending.skipped, due: pending.due.length, mail };
}
