// lib/sharing.ts
//
// Read-only sharing between people who chose to connect (#45).
//
// CONNECTIONS. Nobody can find anyone: there is no list of users, no search,
// no "does this email have an account". Two people connect only through an
// invite link one of them sends the other: a random single-use token, good
// for INVITE_HOURS, stored hashed. Accepting it creates the connection. Each
// side names the other (a per-side label); the app never shows anyone's real
// name, email or id to the other side. Each can also introduce themselves (the
// sender on the link, the other when accepting), and each side sees the
// other's introduction and the day they connected: a link that reached the
// wrong person shows up as a stranger before anything is shared with them.
//
// SHARES hang off the connection. Within one, each person shares any of their
// own accounts, freely and one by one, at a level on a ladder: exists (that
// it's there), balance, or balance and recent transactions. There is no
// accept step per share; the viewer only ever reads.
//
// A SHARE CAN END. Its owner can give it an end, expires_at: an instant, the
// start of the day after the one they chose, in their own time zone (the
// drawer works that out on their device). Every read compares it with the
// time of that read, instant to instant, so no time zone enters the
// comparison: from that instant on the share shows nothing, with nothing to
// do. Ending keeps the share's accounts and levels, so it can be renewed, and
// deletes nothing.
//
// SHOWINGS ARE RECORDED (lib/access-log.ts). Each time someone's app loads
// what a person shares with them, it is counted in the sharer's record for
// that connection, and both of them see that record. Each connection has a
// log id: random, made with the connection (or, for one made before records,
// the first time something is recorded), so a record's field name can't be
// traced to the two people, and two people who connect again start new
// records. The records live exactly as long as the connection: removing or
// blocking it, or either account being deleted, deletes them on both sides
// (forgetShowings), and the nightly pass deletes any a removal that stopped
// part way left.
//
// Stored environment-wide (connections live between containers, so in none):
//   <env>:connections  field "<id>"              {users: [a, b], status, blocked_by?, created_at}
//                      field "<id>|label|<user>" what <user> calls the other
//                      field "<id>|intro|<user>" the name <user> gave when connecting
//                      field "<id>|share|<user>" what <user> shares: {accounts: {"<account id>": level}, updated_at},
//                                                or with an end {expiring: {...}, expires_at, updated_at}
//                      field "<id>|log"          {id, since}: the connection's log id, and when its records began
//   <env>:invites:<sha256 of the token>          {from, from_name, their_label, created_at}, with an expiry
// A share with an end keeps its accounts under "expiring", not "accounts":
// a release from before shares could end reads it as sharing nothing, so
// rolling back past this can end a share early but never extend one.
// Every field of a connection is in one hash, so removing one (the breakup
// case) is a single HDEL: every share both ways ends at once, none missed.
// Blocking keeps the connection's record, marked blocked, which is what stops
// a new invite between the two from connecting them again. A connection's id
// is derived from the pair, so there is only ever one per pair; it never
// leaves the two people's own requests. Containers keep the records under the
// connection's log id instead, and downloads carry neither.
//
// THE BOUNDARY. This module is the only place that reads another person's
// container. It builds that person's Ctx itself, from the owners map. It
// passes it to read functions, which change nothing there (projectShare reads
// read-only), and to the two writes it makes in another person's container,
// both in the access log, both under the connection's own log id and nothing
// else: recordShowing, when someone's app loads what that person shares with
// them, and forgetShowings, when the connection ends. Nothing this module
// returns carries the Ctx or the other person's user id, and no route ever
// gets one to write with.
// Everything is filtered to the shared accounts here, on the server, before it
// leaves: the browser never receives an account it wasn't shared, not even to
// hide it. An account the owner has since hidden, or no longer has, is left
// out at read time.
//
// ONE PROJECTION. projectShare is the only code that works out what someone
// is shown of a share. Their own read (sharedWithMe) and the owner's preview
// of it (previewShare) both call it, so the preview is what they see, with the
// as-of dates they see, and the two can't drift apart. The preview leaves out
// what they call the owner (their words, not the owner's) and records nothing.
//
// Balances and transactions are what the owner's own loads and the nightly
// snapshot stored; this never calls Plaid on the owner's behalf. Each
// account's balance is its newest measured one, with its own date.
//
// Hiding an account pauses its sharing: the share stays, and is honoured again
// if the account is unhidden.

import { createHash, randomBytes } from 'node:crypto';
import { redis, kEnv, getItems } from './storage';
import { getContainer, isContainerId, type Ctx, type ContainerId } from './containers';
import { ownersKey } from './owners';
import { liveAccountIds, directoryParts, directoryTypes, getEffectiveHidden } from './links';
import { getManualAccounts } from './manual';
import { getAccountHistory } from './history';
import { clerkUserAllowed } from './auth-mode';
import { readStoredTxns, StateUnreadableError } from './transactions';
import { StoredDataUnreadableError, UnreadableEntriesError } from './repo';
import { accessLogStore, withShowing, keptShowings, type AccessLog, type Showing } from './access-log';
import { isLevel, SHARE_END_MAX_DAYS, type Level } from './share-rules';

export type { Level } from './share-rules';
export type Share = {
  accounts: Record<string, Level>;
  updated_at: string;
  /** When it stops showing anything: an ISO instant, or null for no end. */
  expires_at: string | null;
};

export const connectionsKey = () => kEnv('connections');
const inviteKey = (token: string) => kEnv(`invites:${createHash('sha256').update(token).digest('hex')}`);
/** How far back shared transactions go. */
export const SHARED_TXN_DAYS = 30;
/** How long an invite link works. */
export const INVITE_HOURS = 72;
const LABEL_MAX = 40;

export class SharingRefused extends Error {}

type Meta = { users: [string, string]; status: 'active' | 'blocked'; blocked_by?: string; created_at: string };

/** The one id a pair of people ever has. */
export function connectionId(a: string, b: string): string {
  return createHash('sha256').update([a, b].sort().join('\n')).digest('hex').slice(0, 24);
}
const labelField = (id: string, user: string) => `${id}|label|${user}`;
const shareField = (id: string, user: string) => `${id}|share|${user}`;
const introField = (id: string, user: string) => `${id}|intro|${user}`;
const logField = (id: string) => `${id}|log`;
/** Every field a connection can have. */
const fieldsOf = (id: string, [a, b]: [string, string]) => [
  id,
  labelField(id, a),
  labelField(id, b),
  introField(id, a),
  introField(id, b),
  shareField(id, a),
  shareField(id, b),
  logField(id),
];

function cleanLabel(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) : '';
  return s || fallback;
}

function parse<T>(raw: unknown): T | null {
  try {
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;
  } catch {
    return null;
  }
}

function parseMeta(raw: unknown): Meta | null {
  const meta = parse<Meta>(raw);
  return meta && typeof meta === 'object' && Array.isArray(meta.users) && meta.users.length === 2 ? meta : null;
}

/** An instant exactly as toISOString() writes one: how an end is stored and sent. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_MS = 86_400_000;

function isInstant(v: unknown): v is string {
  if (typeof v !== 'string' || !INSTANT.test(v)) return false;
  const t = Date.parse(v);
  // A day that doesn't exist (Feb 30) parses as another one: refused, not moved.
  return Number.isFinite(t) && new Date(t).toISOString() === v;
}

/** A stored share, in either shape (see the header), or null when it can't be
 *  read, which counts as sharing nothing, like any field here that can't be
 *  parsed. That includes an end that isn't an instant: a share whose end
 *  can't be read shows nothing, rather than risk showing past its end. */
function parseShare(raw: unknown): Share | null {
  const g = parse<Record<string, unknown>>(raw);
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  const ending = 'expiring' in g || 'expires_at' in g;
  if (ending && ('accounts' in g || !isInstant(g.expires_at))) return null;
  const levels = ending ? g.expiring : g.accounts;
  if (typeof levels !== 'object' || levels === null || Array.isArray(levels)) return null;
  const accounts: Record<string, Level> = {};
  for (const [id, level] of Object.entries(levels)) if (isLevel(level)) accounts[id] = level;
  return { accounts, updated_at: String(g.updated_at ?? ''), expires_at: ending ? (g.expires_at as string) : null };
}

/** A share as stored (see the header): with an end, its accounts go under
 *  "expiring". */
function storedShare(s: Share): string {
  return JSON.stringify(
    s.expires_at === null
      ? { accounts: s.accounts, updated_at: s.updated_at }
      : { expiring: s.accounts, expires_at: s.expires_at, updated_at: s.updated_at }
  );
}

/** Whether a share shows anything at `now`: it has no end, or its end is
 *  still ahead. From the end itself on, it shows nothing. */
export function shareShowing(share: Pick<Share, 'expires_at'>, now: number): boolean {
  return share.expires_at === null || now < Date.parse(share.expires_at);
}

/** A new end as the drawer sends it: null for none, or an instant (isInstant)
 *  still ahead and at most SHARE_END_MAX_DAYS away. */
function checkEnd(raw: unknown, now: number): string | null {
  if (raw === null) return null;
  if (!isInstant(raw)) throw new SharingRefused('That end date can’t be used. Choose it again.');
  const at = Date.parse(raw);
  if (at <= now) throw new SharingRefused('That end date has already passed. Choose a later one.');
  if (at - now > SHARE_END_MAX_DAYS * DAY_MS) throw new SharingRefused('An end date can be at most two years away.');
  return raw;
}

/** A connection's log: the random id its records of showings are kept under
 *  (lib/access-log.ts), and when the first of them could begin. */
type LogRef = { id: string; since: string };
const LOG_ID = /^[0-9a-f]{32}$/;
const newLog = (now: number): LogRef => ({ id: randomBytes(16).toString('hex'), since: new Date(now).toISOString() });

/** A stored log field, or null when it can't be read. */
function parseLog(raw: unknown): LogRef | null {
  const l = parse<LogRef>(raw);
  return l && typeof l === 'object' && typeof l.id === 'string' && LOG_ID.test(l.id) && isInstant(l.since) ? { id: l.id, since: l.since } : null;
}

type Conn = {
  id: string;
  meta: Meta;
  labels: Record<string, string>;
  intros: Record<string, string>;
  shares: Record<string, Share>;
  /** Null before anything was recorded on a connection made before records;
   *  "damaged" when its field can't be read. */
  log: LogRef | 'damaged' | null;
};

/** Labels are stored JSON-encoded: the client parses anything that looks like
 *  JSON on the way out, and a label is whatever someone typed. */
const encodeText = (s: string) => JSON.stringify(s);
const decodeText = (raw: unknown) => (typeof raw === 'string' ? (parse<string>(raw) ?? raw) : typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : String(raw));

async function allConnections(): Promise<Conn[]> {
  const raw = ((await redis().hgetall<Record<string, unknown>>(connectionsKey())) ?? {}) as Record<string, unknown>;
  const byId = new Map<string, Conn>();
  const get = (id: string) => {
    let c = byId.get(id);
    if (!c) byId.set(id, (c = { id, meta: null as unknown as Meta, labels: {}, intros: {}, shares: {}, log: null }));
    return c;
  };
  for (const [field, value] of Object.entries(raw)) {
    const [id, kind, user] = field.split('|');
    if (!kind) {
      const meta = parseMeta(value);
      if (meta) get(id).meta = meta;
    } else if (kind === 'label' && user) get(id).labels[user] = String(decodeText(value));
    else if (kind === 'intro' && user) get(id).intros[user] = String(decodeText(value));
    else if (kind === 'share' && user) {
      const share = parseShare(value);
      if (share) get(id).shares[user] = share;
    } else if (kind === 'log' && !user) get(id).log = parseLog(value) ?? 'damaged';
  }
  // Fields without a record (left by a removal that stopped part way) count for nothing.
  return [...byId.values()].filter((c) => c.meta);
}

async function connectionOf(me: string, id: string): Promise<Conn> {
  const c = (await allConnections()).find((c) => c.id === id && c.meta.users.includes(me));
  if (!c) throw new SharingRefused('No such connection.');
  return c;
}

const other = (c: Conn, me: string) => (c.meta.users[0] === me ? c.meta.users[1] : c.meta.users[0]);

// ---- Invites ----

/** A new invite link's token. `fromName` is how I'd like them to see me (they
 *  can change it); `theirLabel` is what I'll call them. */
export async function createInvite(me: string, opts: { fromName?: unknown; theirLabel?: unknown }, now: number = Date.now()): Promise<{ token: string; expires_at: string }> {
  const token = randomBytes(24).toString('base64url');
  const invite = {
    from: me,
    from_name: cleanLabel(opts.fromName, ''),
    their_label: cleanLabel(opts.theirLabel, ''),
    created_at: new Date(now).toISOString(),
  };
  await redis().set(inviteKey(token), JSON.stringify(invite), { ex: INVITE_HOURS * 3600 });
  return { token, expires_at: new Date(now + INVITE_HOURS * 3_600_000).toISOString() };
}

type Invite = { from: string; from_name: string; their_label: string; created_at: string };

async function readInvite(token: string): Promise<Invite | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const inv = parse<Invite>(await redis().get<unknown>(inviteKey(token)));
  return inv && typeof inv.from === 'string' ? inv : null;
}

/** What an invite says, for its page: how its sender would like to be seen,
 *  or null for any link that can't be used. Doesn't use it up. */
export async function describeInvite(me: string, token: string): Promise<{ from_name: string; own: boolean } | null> {
  const inv = await readInvite(token);
  if (!inv) return null;
  return { from_name: inv.from_name, own: inv.from === me };
}

const UNUSABLE = 'This invite link can’t be used. Ask for a new one.';

/** Uses the invite and connects the two people; `label` is what I call
 *  them, `myName` how I introduce myself to them. */
export async function acceptInvite(me: string, token: string, label: unknown, myName?: unknown, now: number = Date.now()): Promise<{ id: string }> {
  const peek = await readInvite(token);
  if (!peek) throw new SharingRefused(UNUSABLE);
  if (peek.from === me) throw new SharingRefused('This is your own invite link. Send it to the person you want to connect with.');
  const id = connectionId(me, peek.from);
  const existing = (await allConnections()).find((c) => c.id === id);
  // Checked before the link is used up, and a blocked pair gets the same
  // answer as any dead link: the link stays exactly as if it were ignored,
  // so its sender can't tell a block from someone not answering.
  if (existing?.meta.status === 'blocked') throw new SharingRefused(UNUSABLE);
  if (existing) throw new SharingRefused('You’re already connected.');
  // Single use: whoever takes it first has it.
  const inv = parse<Invite>(await redis().getdel<unknown>(inviteKey(token)));
  if (!inv || inv.from !== peek.from) throw new SharingRefused(UNUSABLE);
  // The sender may since have been removed from the app or deleted.
  if (!(await clerkUserAllowed(inv.from)) || !(await theirCtx(inv.from))) throw new SharingRefused(UNUSABLE);
  // Anything left from an earlier connection between the two (a save that
  // landed just after a removal) goes first: a new connection shares nothing,
  // and starts new records under a new log id.
  const pair = [me, inv.from].sort() as [string, string];
  await redis().hdel(connectionsKey(), ...fieldsOf(id, pair).slice(1));
  const intro = cleanLabel(myName, '');
  const meta: Meta = { users: pair, status: 'active', created_at: new Date(now).toISOString() };
  await redis().hset(connectionsKey(), {
    [labelField(id, me)]: encodeText(cleanLabel(label, cleanLabel(inv.from_name, 'Someone'))),
    [labelField(id, inv.from)]: encodeText(cleanLabel(inv.their_label, intro || 'Someone')),
    ...(inv.from_name ? { [introField(id, inv.from)]: encodeText(inv.from_name) } : {}),
    ...(intro ? { [introField(id, me)]: encodeText(intro) } : {}),
    [logField(id)]: JSON.stringify(newLog(now)),
    [id]: JSON.stringify(meta),
  });
  return { id };
}

// ---- Managing my connections ----

export type MyConnection = {
  id: string;
  label: string;
  /** The name they gave when connecting, if any. */
  introduced_as: string | null;
  /** When we connected: an ISO time, shown as the viewer's own day
   *  (components/Sharing.tsx shortDate). */
  since: string;
  sharing: Record<string, Level>;
  /** When what I share with them ends (an ISO instant, which may have
   *  passed: then they see none of it), or null for no end. */
  expires_at: string | null;
};

/** My active connections (what I call each, and what I share with each: all
 *  they can see about me, and until when), and the people I blocked. */
export async function myConnections(me: string): Promise<{ connections: MyConnection[]; blocked: { id: string; label: string }[] }> {
  const mine = (await allConnections()).filter((c) => c.meta.users.includes(me));
  const byLabel = <T extends { label: string }>(a: T, b: T) => a.label.localeCompare(b.label);
  return {
    connections: mine
      .filter((c) => c.meta.status === 'active')
      .map((c) => ({
        id: c.id,
        label: c.labels[me] ?? 'Someone',
        introduced_as: c.intros[other(c, me)] ?? null,
        // The full instant, not its UTC day: the app shows it in the viewer's own
        // time (components/Sharing.tsx shortDate).
        since: c.meta.created_at,
        sharing: c.shares[me]?.accounts ?? {},
        expires_at: c.shares[me]?.expires_at ?? null,
      }))
      .sort(byLabel),
    // Only the one who blocked sees it: to the other it's simply gone.
    blocked: mine
      .filter((c) => c.meta.status === 'blocked' && c.meta.blocked_by === me)
      .map((c) => ({ id: c.id, label: c.labels[me] ?? 'Someone' }))
      .sort(byLabel),
  };
}

/** A change to one of my connections: what I call them (`label`), what I
 *  share (`accounts`: each account to a level, or "none" or null for not
 *  shared) and until when (`expires_at`: an ISO instant ahead, or null for no
 *  end). Whatever is left out stays as it is: an end outlives a change of
 *  accounts, and renewing changes no account. */
export type ConnectionChange = { label?: unknown; accounts?: Record<string, unknown>; expires_at?: unknown };

/**
 * Saves a change to one of my connections, all of it or none: everything is
 * checked before anything is written. Every account must be one I can share
 * now; a share on an account I've hidden stays as it was (paused, not ended),
 * since the settings don't show it. Sharing nothing ends the share and its end
 * date, which then isn't checked: taking everything back never fails on a
 * date.
 */
export async function saveConnection(ctx: Ctx, me: string, id: string, change: ConnectionChange, now: number = Date.now()): Promise<void> {
  const c = await connectionOf(me, id);
  if (c.meta.status !== 'active') throw new SharingRefused('No such connection.');
  const set: Record<string, string> = {};
  let unshare = false;
  if (change.accounts !== undefined || change.expires_at !== undefined) {
    const share = await nextShare(ctx, me, c, change, now);
    if (share) set[shareField(id, me)] = storedShare(share);
    else unshare = true;
  }
  if (change.label !== undefined) set[labelField(id, me)] = encodeText(cleanLabel(change.label, 'Someone'));
  if (Object.keys(set).length > 0) await redis().hset(connectionsKey(), set);
  if (unshare) await redis().hdel(connectionsKey(), shareField(id, me));
}

/** What I'll share on `c` after `change`, checked, or null for nothing. */
async function nextShare(ctx: Ctx, me: string, c: Conn, change: ConnectionChange, now: number): Promise<Share | null> {
  const current = c.shares[me];
  let accounts: Record<string, Level> = current?.accounts ?? {};
  if (change.accounts !== undefined) {
    const [shareable, { hidden }] = await Promise.all([shareableAccounts(ctx), getEffectiveHidden(ctx)]);
    const allowed = new Set(shareable.map((a) => a.id));
    const clean: Record<string, Level> = {};
    for (const [acct, level] of Object.entries(current?.accounts ?? {})) if (hidden.has(acct)) clean[acct] = level;
    for (const [acct, level] of Object.entries(change.accounts ?? {})) {
      if (level === null || level === 'none') continue;
      if (!isLevel(level)) throw new SharingRefused(`Unknown level for ${acct}.`);
      if (hidden.has(acct) && acct in clean) continue; // paused: kept as it was
      if (!allowed.has(acct)) throw new SharingRefused('One of those accounts can’t be shared (hidden, or no longer yours).');
      clean[acct] = level;
    }
    accounts = clean;
  }
  if (Object.keys(accounts).length === 0) {
    if (change.accounts === undefined) throw new SharingRefused('You share nothing with them, so there is nothing to end or renew.');
    return null;
  }
  const expires_at = change.expires_at === undefined ? (current?.expires_at ?? null) : checkEnd(change.expires_at, now);
  return { accounts, updated_at: new Date(now).toISOString(), expires_at };
}

/** Removes a connection: every share both ways ends in one write, and then
 *  the records of showings on both sides go too. With `block`, the record
 *  stays, marked blocked, so neither can invite the other back; only the one
 *  who blocked can lift it (by removing it). */
export async function removeConnection(me: string, id: string, opts: { block?: boolean } = {}): Promise<void> {
  const c = await connectionOf(me, id);
  if (c.meta.status === 'blocked' && c.meta.blocked_by !== me) throw new SharingRefused('No such connection.');
  const [a, b] = c.meta.users;
  if (!opts.block) {
    await redis().hdel(connectionsKey(), ...fieldsOf(id, c.meta.users));
  } else {
    // Blocked first, so nothing is read in between; then the rest, keeping
    // only my name for them (my blocked list shows it).
    const meta: Meta = { ...c.meta, status: 'blocked', blocked_by: me };
    await redis().hset(connectionsKey(), { [id]: JSON.stringify(meta) });
    await redis().hdel(connectionsKey(), labelField(id, other(c, me)), introField(id, a), introField(id, b), shareField(id, a), shareField(id, b), logField(id));
  }
  await forgetShowings(c);
}

/** Removes every connection someone is in, blocked ones too (their account
 *  is going away), with the records of showings on them. Returns how many were
 *  active, for the deletion receipt (lib/account-deletion.ts): those are where
 *  sharing ended. */
export async function dropConnectionsOf(userId: string): Promise<number> {
  const raw = ((await redis().hgetall<Record<string, unknown>>(connectionsKey())) ?? {}) as Record<string, unknown>;
  const theirs = (await allConnections()).filter((c) => c.meta.users.includes(userId));
  const ids = new Set(theirs.map((c) => c.id));
  const fields = Object.keys(raw).filter((f) => ids.has(f.split('|')[0]));
  if (fields.length > 0) await redis().hdel(connectionsKey(), ...fields);
  await Promise.all(theirs.map(forgetShowings));
  return theirs.filter((c) => c.meta.status === 'active').length;
}

/**
 * Deletes a connection's records of showings on both sides, by its log id,
 * without reading them: they live exactly as long as the connection. One of
 * the two writes this module makes in someone else's container. Runs after
 * the connection's fields are gone, so a showing recorded meanwhile is caught
 * here or by recordShowing's own check. Never throws, since the connection is
 * already gone: a container that can't be reached now (being deleted, or
 * restored), or a delete that fails, is left to the nightly pass, which
 * deletes every record whose connection has ended (lib/access-log.ts
 * pruneAccessLog). So is a damaged log field, whose id can't be known.
 */
async function forgetShowings(c: Conn): Promise<void> {
  const log = c.log;
  if (!log || log === 'damaged') return;
  await Promise.all(
    c.meta.users.map(async (user) => {
      try {
        const ctx = await theirCtx(user);
        if (ctx) await accessLogStore.remove(ctx, log.id);
      } catch (err) {
        console.error('Sharing: a record of showings could not be deleted with its connection; the nightly pass will', err instanceof Error ? err.name : err);
      }
    })
  );
}

/**
 * The log ids of the connections there are, for the nightly pass that
 * deletes records whose connection has ended (lib/access-log.ts
 * pruneAccessLog). Null when they can't all be read, so nothing is deleted on
 * the answer: a connection whose record or log field can't be parsed could
 * own any record. A blocked connection has none (blocking deletes them).
 */
export async function connectionLogIds(): Promise<Set<string> | null> {
  try {
    const raw = ((await redis().hgetall<Record<string, unknown>>(connectionsKey())) ?? {}) as Record<string, unknown>;
    const metas = new Map<string, Meta>();
    const logs = new Map<string, unknown>();
    for (const [field, value] of Object.entries(raw)) {
      const [id, kind, user] = field.split('|');
      if (!kind) {
        const meta = parseMeta(value);
        if (!meta) return null;
        metas.set(id, meta);
      } else if (kind === 'log' && !user) logs.set(id, value);
    }
    const live = new Set<string>();
    for (const [id, value] of logs) {
      // Left behind by a removal, or blocked: ended.
      if (metas.get(id)?.status !== 'active') continue;
      const log = parseLog(value);
      if (!log) return null;
      live.add(log.id);
    }
    return live;
  } catch (err) {
    console.error('Sharing: the connections could not be read for the nightly pass', err instanceof Error ? err.name : err);
    return null;
  }
}

// ---- Records of showings ----

/** One side's record on a connection: its quarter hours, oldest first, or
 *  why it can't be had: "unreadable" (damaged), "unrecognised" (intact, but
 *  not understood), "unavailable" (couldn't be reached just now). */
export type RecordRead = { showings: Showing[] } | { showings: null; problem: 'unreadable' | 'unrecognised' | 'unavailable' };

type Records = {
  /** By connection id: its log id and when its records began (both null
   *  before the first, on a connection from before records), and its two
   *  records. */
  byConnection: Map<string, { logId: string | null; since: string | null; toThem: RecordRead; toMe: RecordRead }>;
  /** What else is in my own records: those of connections that ended, until
   *  the nightly pass deletes them, by log id. */
  ended: { entries: Map<string, AccessLog>; unreadable: string[]; unrecognised: string[] };
};

const unreadableAs = (err: unknown, id: string): RecordRead | null =>
  err instanceof UnreadableEntriesError ? { showings: null, problem: err.unreadable.includes(id) ? 'unreadable' : 'unrecognised' } : null;

/**
 * Both records on each of my active connections: mine (when what I share was
 * shown to them), from my container, and theirs (when what they share was
 * shown to me), read from theirs through the boundary, the same record they
 * see. An entry that can't be used is named, never read as no showings.
 * `strict` (the download): a failure to reach storage throws. Otherwise (the
 * drawer, which only shows them) it reads as "unavailable", so the rest of the
 * drawer still works.
 */
async function readRecords(me: string, ctx: Ctx, conns: Conn[], strict: boolean): Promise<Records> {
  const active = conns.filter((c) => c.meta.status === 'active' && c.meta.users.includes(me));
  let mine: Awaited<ReturnType<typeof accessLogStore.getAllReport>> | null = null;
  try {
    mine = await accessLogStore.getAllReport(ctx);
  } catch (err) {
    if (strict) throw err;
    console.error('Sharing: my records of showings could not be read', err instanceof Error ? err.name : err);
  }
  const byConnection: Records['byConnection'] = new Map();
  const own = new Set<string>();
  for (const c of active) {
    const log = c.log;
    if (log === 'damaged') {
      const damaged: RecordRead = { showings: null, problem: 'unreadable' };
      byConnection.set(c.id, { logId: null, since: null, toThem: damaged, toMe: damaged });
      continue;
    }
    if (!log) {
      byConnection.set(c.id, { logId: null, since: null, toThem: { showings: [] }, toMe: { showings: [] } });
      continue;
    }
    own.add(log.id);
    const toThem: RecordRead = !mine
      ? { showings: null, problem: 'unavailable' }
      : mine.unreadable.includes(log.id)
        ? { showings: null, problem: 'unreadable' }
        : mine.unrecognised.includes(log.id)
          ? { showings: null, problem: 'unrecognised' }
          : { showings: mine.entries.get(log.id)?.shown ?? [] };
    let toMe: RecordRead;
    try {
      const theirs = await theirCtx(other(c, me));
      toMe = theirs ? { showings: (await accessLogStore.get(theirs, log.id))?.shown ?? [] } : { showings: null, problem: 'unavailable' };
    } catch (err) {
      const named = unreadableAs(err, log.id);
      if (named) toMe = named;
      else if (strict) throw err;
      else {
        console.error('Sharing: a record of showings could not be read', err instanceof Error ? err.name : err);
        toMe = { showings: null, problem: 'unavailable' };
      }
    }
    byConnection.set(c.id, { logId: log.id, since: log.since, toThem, toMe });
  }
  const ended: Records['ended'] = { entries: new Map(), unreadable: [], unrecognised: [] };
  if (mine) {
    for (const [id, log] of mine.entries) if (!own.has(id)) ended.entries.set(id, log);
    ended.unreadable = mine.unreadable.filter((id) => !own.has(id));
    ended.unrecognised = mine.unrecognised.filter((id) => !own.has(id));
  }
  return { byConnection, ended };
}

/** What the drawer shows of each connection's records, by connection id. */
export type RecordFields = {
  /** The log id my record is under, to clear it by when it can't be read;
   *  null before the first record, or when the log field can't be read. */
  record_id: string | null;
  /** When its records began, or null before the first (a connection from
   *  before records). */
  record_since: string | null;
  /** When what I share was shown to them: my record. */
  shown_to_them: Showing[] | null;
  shown_to_them_problem?: 'unreadable' | 'unrecognised' | 'unavailable';
  /** When what they share was shown to me: their record, the same one they see. */
  shown_to_me: Showing[] | null;
  shown_to_me_problem?: 'unreadable' | 'unrecognised' | 'unavailable';
};

const fieldsFor = (r: RecordRead, now: number, name: 'shown_to_them' | 'shown_to_me') =>
  r.showings ? { [name]: keptShowings({ shown: r.showings }, now) } : { [name]: null, [`${name}_problem`]: r.problem };

/**
 * For my Sharing drawer: both records on each of my active connections, kept
 * quarter hours only, and the ids of any record of mine that can't be read and
 * belongs to no connection of mine now, which I can clear once I confirm
 * (lib/access-log.ts clearUnreadableAccessLog). Only shown: nothing is written
 * or deleted on what this returns.
 */
export async function myRecords(me: string, ctx: Ctx, now: number = Date.now()): Promise<{ connections: Map<string, RecordFields>; damaged: string[] }> {
  const { byConnection, ended } = await readRecords(me, ctx, await allConnections(), false);
  const connections = new Map<string, RecordFields>();
  for (const [id, r] of byConnection) {
    connections.set(id, {
      record_id: r.logId,
      record_since: r.since,
      ...fieldsFor(r.toThem, now, 'shown_to_them'),
      ...fieldsFor(r.toMe, now, 'shown_to_me'),
    } as RecordFields);
  }
  return { connections, damaged: ended.unreadable };
}

/** My side of sharing, for the download of my data (lib/user-export.ts). */
export type MySharing = {
  connections: {
    /** What I call them. */
    name: string;
    /** The name I gave when connecting, if any. */
    my_introduction: string | null;
    /** When we connected: an ISO time. */
    connected_at: string;
    /** What I share with them. */
    shared: { account_id: string; level: Level }[];
    /** When I last changed that, or null when I share nothing. */
    shared_updated_at: string | null;
    /** When it ends (an ISO time, which may have passed), or null for no end. */
    shared_until: string | null;
    /** When the records of showings on this connection began, or null
     *  before the first. */
    record_since: string | null;
    /** Each time what I share was shown to them (my record), oldest first, or
     *  null when it can't be read (shown_to_them_problem says why). */
    shown_to_them: Showing[] | null;
    shown_to_them_problem?: 'unreadable' | 'unrecognised' | 'unavailable';
    /** Each time what they share was shown to me: their record, the same one
     *  they see. */
    shown_to_me: Showing[] | null;
    shown_to_me_problem?: 'unreadable' | 'unrecognised' | 'unavailable';
  }[];
  /** People I blocked, by what I called them. */
  blocked: { name: string }[];
  /** My records of showings on connections that have ended, until the nightly
   *  pass deletes them: the quarter hours, or why a record can't be read. */
  ended: ({ shown_to_them: Showing[] } | { shown_to_them: null; problem: 'unreadable' | 'unrecognised' })[];
};

/**
 * My side of every connection: what I call each person, how I introduced
 * myself, when we connected, what I share and until when, both records of
 * showings on it, and the people I blocked. Never the other side's settings:
 * what they call me, how they introduced themselves and what they share with
 * me are their data, and a blocked connection someone else made is gone as
 * far as I can see (as in myConnections). Their record of showings to me is
 * in, being about me, as they see it. No connection id is in it: those are
 * derived from the two people's sign-in ids.
 *
 * Without a person (the shared password), only my own records, if any: there
 * is nobody to be connected with. Throws when the connections or records
 * can't be reached; a record that can't be read is named in the file, so a
 * damaged one never stops the download. A connection field that can't be
 * parsed counts for nothing, exactly as everywhere else in this module, so
 * this says what the app acts on.
 */
export async function mySharing(me: string | null, ctx: Ctx): Promise<MySharing | null> {
  const all = me ? (await allConnections()).filter((c) => c.meta.users.includes(me)) : [];
  const { byConnection, ended } = await readRecords(me ?? '', ctx, all, true);
  if (!me && ended.entries.size + ended.unreadable.length + ended.unrecognised.length === 0) return null;
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  const recordFields = (r: RecordRead, name: 'shown_to_them' | 'shown_to_me') =>
    r.showings ? { [name]: r.showings } : { [name]: null, [`${name}_problem`]: r.problem };
  return {
    connections: all
      .filter((c) => c.meta.status === 'active')
      .map((c) => {
        const r = byConnection.get(c.id)!;
        return {
          name: c.labels[me!] ?? 'Someone',
          my_introduction: c.intros[me!] ?? null,
          connected_at: c.meta.created_at,
          shared: Object.entries(c.shares[me!]?.accounts ?? {})
            .map(([account_id, level]) => ({ account_id, level }))
            .sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0)),
          shared_updated_at: c.shares[me!]?.updated_at || null,
          shared_until: c.shares[me!]?.expires_at ?? null,
          record_since: r.since,
          ...recordFields(r.toThem, 'shown_to_them'),
          ...recordFields(r.toMe, 'shown_to_me'),
        } as MySharing['connections'][number];
      })
      .sort(byName),
    blocked: all
      .filter((c) => c.meta.status === 'blocked' && c.meta.blocked_by === me)
      .map((c) => ({ name: c.labels[me!] ?? 'Someone' }))
      .sort(byName),
    ended: [
      ...[...ended.entries.values()].map((log) => ({ shown_to_them: log.shown })),
      ...ended.unreadable.map(() => ({ shown_to_them: null, problem: 'unreadable' as const })),
      ...ended.unrecognised.map(() => ({ shown_to_them: null, problem: 'unrecognised' as const })),
    ],
  };
}

/** A person's container, for reading what they shared, and for the two
 *  writes in their access log (recordShowing, forgetShowings). Null when it
 *  isn't active. */
async function theirCtx(userId: string): Promise<Ctx | null> {
  const id = await redis().hget<string>(ownersKey(), userId);
  if (typeof id !== 'string' || !isContainerId(id)) return null;
  const rec = await getContainer(id as ContainerId);
  return rec?.status === 'active' ? { container: id as ContainerId } : null;
}

export type Shareable = {
  id: string;
  /** In full, as the other side sees it ("Chase Checking ••1111"). */
  label: string;
  /** For grouping my own list: the institution, and the account within it. */
  institution: string;
  name: string;
};

/** The accounts I could share: my live and manual accounts, minus hidden ones,
 *  by institution and then name. `readOnly` changes nothing while reading (see
 *  liveAccountIds), for a read made on someone else's behalf. */
export async function shareableAccounts(ctx: Ctx, opts: { readOnly?: boolean } = {}): Promise<Shareable[]> {
  const [live, manual, { hidden }] = await Promise.all([
    liveAccountIds(ctx, { strict: true, readOnly: opts.readOnly }),
    getManualAccounts(ctx),
    getEffectiveHidden(ctx, { readOnly: opts.readOnly }),
  ]);
  const plaidIds = [...live].filter((id) => !hidden.has(id));
  const parts = await directoryParts(ctx, plaidIds);
  const out: Shareable[] = [
    ...plaidIds.map((id) => {
      const p = parts[id] ?? { institution: 'Other', name: 'Account' };
      return { id, label: `${p.institution} ${p.name}`, ...p };
    }),
    ...manual
      .filter((m) => !hidden.has(m.account_id))
      .map((m) => ({ id: m.account_id, label: `${m.institution_name} ${m.name}`, institution: m.institution_name, name: m.name })),
  ];
  const byText = (a: string, b: string) => a.localeCompare(b);
  return out.sort((a, b) => byText(a.institution, b.institution) || byText(a.name, b.name) || byText(a.id, b.id));
}

export type SharedTxn = { date: string; name: string; amount: number; pending: boolean };
export type SharedAccount = {
  id: string;
  label: string;
  level: Level;
  /** Null at the exists level, or before any balance was measured. */
  balance: number | null;
  /** When that balance was measured: an ISO time (a manual account, to the
   *  hour), or a YYYY-MM-DD (a snapshot's day). shortDate reads both. */
  as_of: string | null;
  /** Money owed (a card, a loan) rather than held. */
  debt: boolean;
  transactions?: SharedTxn[];
};
/** What someone is shown of one person's share: the projection
 *  (projectShare). */
export type ShareView = {
  accounts: SharedAccount[];
  /** When the share ends: an ISO instant, or null for no end. */
  expires_at: string | null;
};
/** One connection's shares with me: `label` is what I call them. */
export type SharedFrom = ShareView & { connection: string; label: string };

const DEBT_TYPES = new Set(['credit', 'loan']);

/** Everything shared with me, filtered to what each person shares and still
 *  has, each with when it ends. Reads only the owners' data, never touches
 *  Plaid, and counts each showing in its owner's record (recordShowing). */
export async function sharedWithMe(me: string, now: number = Date.now()): Promise<SharedFrom[]> {
  const out: SharedFrom[] = [];
  const showings: Promise<void>[] = [];
  for (const c of await allConnections()) {
    if (c.meta.status !== 'active' || !c.meta.users.includes(me)) continue;
    let shown: Projected | null;
    try {
      shown = await projectShare(c, other(c, me), now);
    } catch (err) {
      // One person's unreadable data must not hide what everyone else shares.
      console.error('Shared data could not be read for one connection', err instanceof Error ? err.name : err);
      continue;
    }
    if (!shown) continue;
    out.push({ connection: c.id, label: c.labels[me] ?? 'Someone', ...shown.view });
    showings.push(recordShowing(shown.theirs, c, shown.view, now));
  }
  await Promise.all(showings); // each one is best effort, and never throws
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** My preview of one of my connections: exactly what they are shown of mine
 *  right now (`view`, or null when they see nothing), from the projection
 *  their own read uses, without their name for me, and recording nothing.
 *  `unreadable` when my shared data can't be decoded: they see nothing then
 *  either. */
export type SharePreview = { connection: string; view: ShareView | null; unreadable?: true };

/** Whether an error says the owner's stored data can't be decoded, so their
 *  own read fails the same way and they see nothing, as opposed to storage
 *  or another service being out of reach for a moment. */
function dataUnreadable(err: unknown): boolean {
  return err instanceof StoredDataUnreadableError || (err instanceof StateUnreadableError && err.kind === 'decode');
}

export async function previewShare(me: string, id: string, now: number = Date.now()): Promise<SharePreview> {
  const c = await connectionOf(me, id);
  if (c.meta.status !== 'active') throw new SharingRefused('No such connection.');
  try {
    const shown = await projectShare(c, me, now);
    return { connection: c.id, view: shown?.view ?? null };
  } catch (err) {
    // Anything else (storage, Clerk) says nothing of what they see: the
    // route answers it as an error.
    if (!dataUnreadable(err)) throw err;
    console.error('Shared data could not be read for a preview', err instanceof Error ? err.name : err);
    return { connection: c.id, view: null, unreadable: true };
  }
}

/** A projection, and the owner's Ctx it was read from, which recordShowing
 *  needs. Never returned from this module. */
type Projected = { view: ShareView; theirs: Ctx };

/**
 * What the other person on connection `c` is shown of `owner`'s share at
 * `now`: the one projection (see the header). Null when it shows nothing: no
 * share; an ended one, checked first, before anything of the owner's is read,
 * so an ended share can't surface even through an error; the owner off the
 * allowlist or gone; or nothing shared that they still have and can share.
 * Reads read-only: it changes nothing in the owner's container. Throws when
 * the owner's data can't be read, and both callers then show nothing from it.
 */
async function projectShare(c: Conn, owner: string, now: number): Promise<Projected | null> {
  const share = c.shares[owner];
  if (!share || !shareShowing(share, now)) return null;
  if (!(await clerkUserAllowed(owner))) return null;
  const theirs = await theirCtx(owner);
  if (!theirs) return null;
  // Re-checked against what they can share now: hidden or gone since is out.
  const still = new Map((await shareableAccounts(theirs, { readOnly: true })).map((a) => [a.id, a.label]));
  const granted = Object.entries(share.accounts).filter(([id]) => still.has(id));
  if (granted.length === 0) return null;

  const manual = new Map((await getManualAccounts(theirs)).map((m) => [m.account_id, m]));
  const types = await directoryTypes(theirs, granted.map(([id]) => id).filter((id) => !manual.has(id)));

  const withTxns = new Set(granted.filter(([, level]) => level === 'transactions').map(([id]) => id));
  const txns = new Map<string, SharedTxn[]>();
  if (withTxns.size > 0) {
    const since = new Date(now - SHARED_TXN_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const item of await getItems(theirs)) {
      for (const t of await readStoredTxns(theirs, item.item_id, { shown: true })) {
        if (!withTxns.has(t.account_id) || t.date < since) continue;
        const list = txns.get(t.account_id) ?? [];
        list.push({ date: t.date, name: t.merchant_name ?? t.name, amount: t.amount, pending: t.pending });
        txns.set(t.account_id, list);
      }
    }
  }

  const accounts: SharedAccount[] = [];
  for (const [id, level] of granted) {
    const m = manual.get(id);
    let balance: number | null = null;
    let as_of: string | null = null;
    if (level === 'exists') {
      // That it's there, and nothing about how much.
    } else if (m) {
      balance = m.balance;
      // An instant, so the viewer sees their own day, cut to the hour: the sharee
      // has no need of the minute their friend last touched a balance. A
      // snapshot's date below is a UTC day.
      as_of = `${m.updated_at.slice(0, 13)}:00:00.000Z`;
    } else {
      const measured = (await getAccountHistory(theirs, id)).filter((p) => !p.estimated);
      const last = measured[measured.length - 1];
      if (last) ({ value: balance, date: as_of } = last);
    }
    accounts.push({
      id,
      label: still.get(id)!,
      level,
      balance,
      as_of,
      debt: DEBT_TYPES.has((m ? m.type : types[id]) ?? ''),
      ...(level === 'transactions'
        ? { transactions: (txns.get(id) ?? []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)) }
        : {}),
    });
  }
  return { view: { accounts, expires_at: share.expires_at }, theirs };
}

/**
 * Counts, in the owner's record (lib/access-log.ts), that the other person on
 * `c` was just shown `view`: one of the two writes this module makes in
 * someone else's container. Under the connection's log id, the quarter hour,
 * a count, and the accounts and levels the read returned, none of it taken
 * from the request. A connection from before records gets its log id here,
 * the first time (HSETNX, so two at once agree on one). Best effort: a
 * failure is logged, and never fails the read.
 */
async function recordShowing(theirs: Ctx, c: Conn, view: ShareView, now: number): Promise<void> {
  try {
    const log = await logFor(c, now);
    if (!log) {
      console.error('Sharing: a showing was not recorded: the connection’s log field can’t be read');
      return;
    }
    const read = Object.fromEntries(view.accounts.map((a) => [a.id, a.level]));
    await accessLogStore.update(theirs, log.id, (current) => withShowing(current, now, read));
    // A removal deletes the connection, then its records. One that ran in
    // between would leave this record behind it: so look again, after the
    // write, and take it back. One of the two deletes always sees it.
    if (!(await stillLogged(c.id, log.id))) await accessLogStore.remove(theirs, log.id);
  } catch (err) {
    console.error('A showing of shared data could not be recorded', err instanceof Error ? err.name : err);
  }
}

/** The connection's log, made now if it has none yet (one from before
 *  records): whoever asks first sets it, and everyone reads that one. Null
 *  when its field can't be read. */
async function logFor(c: Conn, now: number): Promise<LogRef | null> {
  if (c.log === 'damaged') return null;
  if (c.log) return c.log;
  await redis().hsetnx(connectionsKey(), logField(c.id), JSON.stringify(newLog(now)));
  return parseLog(await redis().hget(connectionsKey(), logField(c.id)));
}

/** Whether the connection is still there, active, with this log id. */
async function stillLogged(id: string, logId: string): Promise<boolean> {
  const [meta, log] = await Promise.all([redis().hget(connectionsKey(), id), redis().hget(connectionsKey(), logField(id))]);
  return parseMeta(meta)?.status === 'active' && parseLog(log)?.id === logId;
}
