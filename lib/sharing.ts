// lib/sharing.ts
//
// Read-only sharing between accounts (#45). A grant is one person letting
// another see some of their accounts: per account, either its balance or its
// balance and recent transactions. Nothing is shared unless chosen; only the
// owner changes a grant; revoking takes effect on the next request.
//
// Stored environment-wide (grants live between containers, so in none):
//   <env>:grants  field "<owner user id>><grantee user id>"
//                 value {"accounts": {"<account id>": "balance" | "transactions"}, "updated_at": ISO}
//
// THE BOUNDARY. This module is the only place that reads another person's
// container. It builds that person's Ctx itself, from the owners map, and
// passes it only to read functions; nothing it returns carries the Ctx, and
// no route ever gets one to write with. Everything is filtered to the granted
// accounts here, on the server, before it leaves: the browser never receives
// an account it wasn't granted, not even to hide it. An account the owner has
// since hidden, or no longer has, is left out at read time.
//
// Balances and transactions are what the owner's own loads and the nightly
// snapshot stored; this never calls Plaid on the owner's behalf.

import { redis, kEnv, getItems } from './storage';
import { getContainer, isContainerId, type Ctx, type ContainerId } from './containers';
import { ownersKey } from './owners';
import { liveAccountIds, directoryLabels, getEffectiveHidden } from './links';
import { getManualAccounts } from './manual';
import { getLatestAccountSnapshot } from './history';
import { readStoredTxns } from './transactions';

export type Level = 'balance' | 'transactions';
export type Grant = { accounts: Record<string, Level>; updated_at: string };

export const grantsKey = () => kEnv('grants');
const field = (owner: string, grantee: string) => `${owner}>${grantee}`;
const LEVELS = new Set<Level>(['balance', 'transactions']);
/** How far back shared transactions go. */
export const SHARED_TXN_DAYS = 30;

export class SharingRefused extends Error {}

function parseGrant(raw: unknown): Grant | null {
  const g = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!g || typeof g !== 'object' || typeof (g as Grant).accounts !== 'object' || (g as Grant).accounts === null) return null;
  const accounts: Record<string, Level> = {};
  for (const [id, level] of Object.entries((g as Grant).accounts)) if (LEVELS.has(level)) accounts[id] = level;
  return { accounts, updated_at: String((g as Grant).updated_at ?? '') };
}

async function allGrants(): Promise<{ owner: string; grantee: string; grant: Grant }[]> {
  const raw = ((await redis().hgetall<Record<string, unknown>>(grantsKey())) ?? {}) as Record<string, unknown>;
  const out: { owner: string; grantee: string; grant: Grant }[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const [owner, grantee] = key.split('>');
    const grant = parseGrant(value);
    if (owner && grantee && grant) out.push({ owner, grantee, grant });
  }
  return out;
}

/** The other people in the app: every account that owns a container. */
export async function people(me: string): Promise<string[]> {
  const owners = ((await redis().hgetall<Record<string, string>>(ownersKey())) ?? {}) as Record<string, string>;
  return Object.keys(owners).filter((id) => id !== me).sort();
}

/** A person's container, read-only use: only for reading what they granted. */
async function theirCtx(userId: string): Promise<Ctx | null> {
  const id = await redis().hget<string>(ownersKey(), userId);
  if (typeof id !== 'string' || !isContainerId(id)) return null;
  const rec = await getContainer(id as ContainerId);
  return rec?.status === 'active' ? { container: id as ContainerId } : null;
}

export type Shareable = { id: string; label: string };

/** The accounts I could share: my live and manual accounts, minus hidden ones. */
export async function shareableAccounts(ctx: Ctx): Promise<Shareable[]> {
  const [live, manual, { hidden }] = await Promise.all([liveAccountIds(ctx, { strict: true }), getManualAccounts(ctx), getEffectiveHidden(ctx)]);
  const plaidIds = [...live].filter((id) => !hidden.has(id));
  const labels = await directoryLabels(ctx, plaidIds);
  return [
    ...plaidIds.map((id) => ({ id, label: labels[id] ?? 'Account' })),
    ...manual.filter((m) => !hidden.has(m.account_id)).map((m) => ({ id: m.account_id, label: `${m.institution_name} ${m.name}` })),
  ].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** What I share with each person. */
export async function outgoing(me: string): Promise<Record<string, Record<string, Level>>> {
  const out: Record<string, Record<string, Level>> = {};
  for (const g of await allGrants()) if (g.owner === me) out[g.grantee] = g.grant.accounts;
  return out;
}

/** Sets what I share with one person; an empty set removes the grant. Every
 *  account must be one I can share now, and the person someone in the app. */
export async function setGrant(ctx: Ctx, me: string, to: string, accounts: Record<string, unknown>, now: number = Date.now()): Promise<void> {
  if (to === me) throw new SharingRefused('You can’t share with yourself.');
  if (!(await people(me)).includes(to)) throw new SharingRefused('That person isn’t in the app.');
  const allowed = new Set((await shareableAccounts(ctx)).map((a) => a.id));
  const clean: Record<string, Level> = {};
  for (const [id, level] of Object.entries(accounts ?? {})) {
    if (level === null || level === 'none') continue;
    if (!LEVELS.has(level as Level)) throw new SharingRefused(`Unknown level for ${id}.`);
    if (!allowed.has(id)) throw new SharingRefused('One of those accounts can’t be shared (hidden, or no longer yours).');
    clean[id] = level as Level;
  }
  if (Object.keys(clean).length === 0) {
    await redis().hdel(grantsKey(), field(me, to));
    return;
  }
  const grant: Grant = { accounts: clean, updated_at: new Date(now).toISOString() };
  await redis().hset(grantsKey(), { [field(me, to)]: JSON.stringify(grant) });
}

export type SharedTxn = { date: string; name: string; amount: number; pending: boolean };
export type SharedAccount = { id: string; label: string; level: Level; balance: number | null; transactions?: SharedTxn[] };
export type SharedFrom = { from: string; as_of: string | null; accounts: SharedAccount[] };

/** Everything shared with me, filtered to what each owner granted and still
 *  has. Read only; never touches Plaid. */
export async function sharedWithMe(me: string, now: number = Date.now()): Promise<SharedFrom[]> {
  const out: SharedFrom[] = [];
  for (const { owner, grantee, grant } of await allGrants()) {
    if (grantee !== me) continue;
    const theirs = await theirCtx(owner);
    if (!theirs) continue;
    // Re-checked against what they can share now: hidden or gone since is out.
    const still = new Map((await shareableAccounts(theirs)).map((a) => [a.id, a.label]));
    const granted = Object.entries(grant.accounts).filter(([id]) => still.has(id));
    if (granted.length === 0) continue;

    const [snapshot, manual] = await Promise.all([getLatestAccountSnapshot(theirs), getManualAccounts(theirs)]);
    const manualBalance = new Map(manual.map((m) => [m.account_id, m.balance]));

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

    out.push({
      from: owner,
      as_of: snapshot?.date ?? null,
      accounts: granted.map(([id, level]) => ({
        id,
        label: still.get(id)!,
        level,
        balance: manualBalance.get(id) ?? snapshot?.balances[id] ?? null,
        ...(level === 'transactions'
          ? { transactions: (txns.get(id) ?? []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)) }
          : {}),
      })),
    });
  }
  return out;
}

/** Removes every grant to or from someone (their account is going away). */
export async function dropGrantsOf(userId: string): Promise<void> {
  const fields = (await allGrants()).filter((g) => g.owner === userId || g.grantee === userId).map((g) => field(g.owner, g.grantee));
  if (fields.length > 0) await redis().hdel(grantsKey(), ...fields);
}

