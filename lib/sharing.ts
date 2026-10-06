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
// Stored environment-wide (connections live between containers, so in none):
//   <env>:connections  field "<id>"              {users: [a, b], status, blocked_by?, created_at}
//                      field "<id>|label|<user>" what <user> calls the other
//                      field "<id>|intro|<user>" the name <user> gave when connecting
//                      field "<id>|share|<user>" {accounts: {"<account id>": level}, updated_at}
//   <env>:invites:<sha256 of the token>          {from, from_name, their_label, created_at}, with an expiry
// Every field of a connection is in one hash, so removing one (the breakup
// case) is a single HDEL: every share both ways ends at once, none missed.
// Blocking keeps the connection's record, marked blocked, which is what stops
// a new invite between the two from connecting them again. A connection's id
// is derived from the pair, so there is only ever one per pair.
//
// THE BOUNDARY. This module is the only place that reads another person's
// container. It builds that person's Ctx itself, from the owners map, and
// passes it only to read functions; nothing it returns carries the Ctx or the
// other person's user id, and no route ever gets one to write with.
// Everything is filtered to the shared accounts here, on the server, before it
// leaves: the browser never receives an account it wasn't shared, not even to
// hide it. An account the owner has since hidden, or no longer has, is left
// out at read time.
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
import { readStoredTxns } from './transactions';

export type Level = 'exists' | 'balance' | 'transactions';
export type Share = { accounts: Record<string, Level>; updated_at: string };

export const connectionsKey = () => kEnv('connections');
const inviteKey = (token: string) => kEnv(`invites:${createHash('sha256').update(token).digest('hex')}`);
const LEVELS = new Set<Level>(['exists', 'balance', 'transactions']);
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
/** Every field a connection can have. */
const fieldsOf = (id: string, [a, b]: [string, string]) => [
  id,
  labelField(id, a),
  labelField(id, b),
  introField(id, a),
  introField(id, b),
  shareField(id, a),
  shareField(id, b),
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

function parseShare(raw: unknown): Share | null {
  const g = parse<Share>(raw);
  if (!g || typeof g !== 'object' || typeof g.accounts !== 'object' || g.accounts === null) return null;
  const accounts: Record<string, Level> = {};
  for (const [id, level] of Object.entries(g.accounts)) if (LEVELS.has(level)) accounts[id] = level;
  return { accounts, updated_at: String(g.updated_at ?? '') };
}

type Conn = { id: string; meta: Meta; labels: Record<string, string>; intros: Record<string, string>; shares: Record<string, Share> };

/** Labels are stored JSON-encoded: the client parses anything that looks like
 *  JSON on the way out, and a label is whatever someone typed. */
const encodeText = (s: string) => JSON.stringify(s);
const decodeText = (raw: unknown) => (typeof raw === 'string' ? (parse<string>(raw) ?? raw) : typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : String(raw));

async function allConnections(): Promise<Conn[]> {
  const raw = ((await redis().hgetall<Record<string, unknown>>(connectionsKey())) ?? {}) as Record<string, unknown>;
  const byId = new Map<string, Conn>();
  const get = (id: string) => {
    let c = byId.get(id);
    if (!c) byId.set(id, (c = { id, meta: null as unknown as Meta, labels: {}, intros: {}, shares: {} }));
    return c;
  };
  for (const [field, value] of Object.entries(raw)) {
    const [id, kind, user] = field.split('|');
    if (!kind) {
      const meta = parse<Meta>(value);
      if (meta && Array.isArray(meta.users) && meta.users.length === 2) get(id).meta = meta;
    } else if (kind === 'label' && user) get(id).labels[user] = String(decodeText(value));
    else if (kind === 'intro' && user) get(id).intros[user] = String(decodeText(value));
    else if (kind === 'share' && user) {
      const share = parseShare(value);
      if (share) get(id).shares[user] = share;
    }
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
  // landed just after a removal) goes first: a new connection shares nothing.
  const pair = [me, inv.from].sort() as [string, string];
  await redis().hdel(connectionsKey(), ...fieldsOf(id, pair).slice(1));
  const intro = cleanLabel(myName, '');
  const meta: Meta = { users: pair, status: 'active', created_at: new Date(now).toISOString() };
  await redis().hset(connectionsKey(), {
    [labelField(id, me)]: encodeText(cleanLabel(label, cleanLabel(inv.from_name, 'Someone'))),
    [labelField(id, inv.from)]: encodeText(cleanLabel(inv.their_label, intro || 'Someone')),
    ...(inv.from_name ? { [introField(id, inv.from)]: encodeText(inv.from_name) } : {}),
    ...(intro ? { [introField(id, me)]: encodeText(intro) } : {}),
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
};

/** My active connections (what I call each, and what I share with each: all
 *  they can see about me), and the people I blocked. */
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
      }))
      .sort(byLabel),
    // Only the one who blocked sees it: to the other it's simply gone.
    blocked: mine
      .filter((c) => c.meta.status === 'blocked' && c.meta.blocked_by === me)
      .map((c) => ({ id: c.id, label: c.labels[me] ?? 'Someone' }))
      .sort(byLabel),
  };
}

export async function renameConnection(me: string, id: string, label: unknown): Promise<void> {
  const c = await connectionOf(me, id);
  if (c.meta.status !== 'active') throw new SharingRefused('No such connection.');
  await redis().hset(connectionsKey(), { [labelField(id, me)]: encodeText(cleanLabel(label, 'Someone')) });
}

/** Sets what I share on one connection; an empty set shares nothing. Every
 *  account must be one I can share now. A share on an account I've hidden
 *  stays as it was (paused, not ended): the settings don't show it. */
export async function setShare(ctx: Ctx, me: string, id: string, accounts: Record<string, unknown>, now: number = Date.now()): Promise<void> {
  const c = await connectionOf(me, id);
  if (c.meta.status !== 'active') throw new SharingRefused('No such connection.');
  const [shareable, { hidden }] = await Promise.all([shareableAccounts(ctx), getEffectiveHidden(ctx)]);
  const allowed = new Set(shareable.map((a) => a.id));
  const clean: Record<string, Level> = {};
  for (const [acct, level] of Object.entries(c.shares[me]?.accounts ?? {})) if (hidden.has(acct)) clean[acct] = level;
  for (const [acct, level] of Object.entries(accounts ?? {})) {
    if (level === null || level === 'none') continue;
    if (!LEVELS.has(level as Level)) throw new SharingRefused(`Unknown level for ${acct}.`);
    if (hidden.has(acct) && acct in clean) continue; // paused: kept as it was
    if (!allowed.has(acct)) throw new SharingRefused('One of those accounts can’t be shared (hidden, or no longer yours).');
    clean[acct] = level as Level;
  }
  if (Object.keys(clean).length === 0) {
    await redis().hdel(connectionsKey(), shareField(id, me));
    return;
  }
  const share: Share = { accounts: clean, updated_at: new Date(now).toISOString() };
  await redis().hset(connectionsKey(), { [shareField(id, me)]: JSON.stringify(share) });
}

/** Removes a connection: every share both ways ends in one write. With
 *  `block`, the record stays, marked blocked, so neither can invite the other
 *  back; only the one who blocked can lift it (by removing it). */
export async function removeConnection(me: string, id: string, opts: { block?: boolean } = {}): Promise<void> {
  const c = await connectionOf(me, id);
  if (c.meta.status === 'blocked' && c.meta.blocked_by !== me) throw new SharingRefused('No such connection.');
  const [a, b] = c.meta.users;
  if (!opts.block) {
    await redis().hdel(connectionsKey(), ...fieldsOf(id, c.meta.users));
    return;
  }
  // Blocked first, so nothing is read in between; then the rest, keeping
  // only my name for them (my blocked list shows it).
  const meta: Meta = { ...c.meta, status: 'blocked', blocked_by: me };
  await redis().hset(connectionsKey(), { [id]: JSON.stringify(meta) });
  await redis().hdel(connectionsKey(), labelField(id, other(c, me)), introField(id, a), introField(id, b), shareField(id, a), shareField(id, b));
}

/** Removes every connection someone is in, blocked ones too (their account
 *  is going away). Returns how many were active, for the deletion receipt
 *  (lib/account-deletion.ts): those are where sharing ended. */
export async function dropConnectionsOf(userId: string): Promise<number> {
  const raw = ((await redis().hgetall<Record<string, unknown>>(connectionsKey())) ?? {}) as Record<string, unknown>;
  const theirs = (await allConnections()).filter((c) => c.meta.users.includes(userId));
  const ids = new Set(theirs.map((c) => c.id));
  const fields = Object.keys(raw).filter((f) => ids.has(f.split('|')[0]));
  if (fields.length > 0) await redis().hdel(connectionsKey(), ...fields);
  return theirs.filter((c) => c.meta.status === 'active').length;
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
  }[];
  /** People I blocked, by what I called them. */
  blocked: { name: string }[];
};

/**
 * My side of every connection: what I call each person, how I introduced
 * myself, when we connected and what I share, and the people I blocked. Never
 * the other side's: what they call me, how they introduced themselves and
 * what they share with me are their data, and a blocked connection someone
 * else made is gone as far as I can see (as in myConnections). Throws when
 * the connections can't be read; a field that can't be parsed counts for
 * nothing, exactly as everywhere else in this module, so this says what the
 * app acts on.
 */
export async function mySharing(me: string): Promise<MySharing> {
  const mine = (await allConnections()).filter((c) => c.meta.users.includes(me));
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  return {
    connections: mine
      .filter((c) => c.meta.status === 'active')
      .map((c) => ({
        name: c.labels[me] ?? 'Someone',
        my_introduction: c.intros[me] ?? null,
        connected_at: c.meta.created_at,
        shared: Object.entries(c.shares[me]?.accounts ?? {})
          .map(([account_id, level]) => ({ account_id, level }))
          .sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0)),
        shared_updated_at: c.shares[me]?.updated_at || null,
      }))
      .sort(byName),
    blocked: mine
      .filter((c) => c.meta.status === 'blocked' && c.meta.blocked_by === me)
      .map((c) => ({ name: c.labels[me] ?? 'Someone' }))
      .sort(byName),
  };
}

/** A person's container, read-only use: only for reading what they shared. */
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
 *  by institution and then name. */
export async function shareableAccounts(ctx: Ctx): Promise<Shareable[]> {
  const [live, manual, { hidden }] = await Promise.all([liveAccountIds(ctx, { strict: true }), getManualAccounts(ctx), getEffectiveHidden(ctx)]);
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
/** One connection's shares with me: `label` is what I call them. */
export type SharedFrom = { connection: string; label: string; accounts: SharedAccount[] };

const DEBT_TYPES = new Set(['credit', 'loan']);

/** Everything shared with me, filtered to what each person shares and still
 *  has. Read only; never touches Plaid. */
export async function sharedWithMe(me: string, now: number = Date.now()): Promise<SharedFrom[]> {
  const out: SharedFrom[] = [];
  for (const c of await allConnections()) {
    if (c.meta.status !== 'active' || !c.meta.users.includes(me)) continue;
    const owner = other(c, me);
    const share = c.shares[owner];
    if (!share) continue;
    try {
      const accounts = await fromOwner(owner, share, now);
      if (accounts) out.push({ connection: c.id, label: c.labels[me] ?? 'Someone', accounts });
    } catch (err) {
      // One person's unreadable data must not hide what everyone else shares.
      console.error('Shared data could not be read for one connection', err instanceof Error ? err.name : err);
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

async function fromOwner(owner: string, share: Share, now: number): Promise<SharedAccount[] | null> {
  if (!(await clerkUserAllowed(owner))) return null;
  const theirs = await theirCtx(owner);
  if (!theirs) return null;
  // Re-checked against what they can share now: hidden or gone since is out.
  const still = new Map((await shareableAccounts(theirs)).map((a) => [a.id, a.label]));
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
  return accounts;
}
