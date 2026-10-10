// lib/manual.ts
//
// Manually-tracked accounts, for institutions Plaid can't reach (small credit
// unions, HSAs, 401k recordkeepers, foreign banks, crypto, real estate). You
// type the balance; everything downstream treats it like a Plaid account.
//
// Stored as a Redis hash keyed by account_id, one encrypted field per account,
// like `plaid:items` in lib/storage.ts and for the same reason: the ingest
// endpoint (app/api/ingest/balance) lets an external script write on a schedule,
// concurrently with edits in the app, and a single-blob read-modify-write (the
// lib/goals.ts shape) would silently drop one of them.
//
// READ FAILURES MUST THROW. Here the usual "swallow the error and return empty"
// habit is dangerous: manual balances feed net worth, and a total silently short
// by the whole manual sum gets written into the REAL history layer
// (lib/history.ts), which nothing rewrites for a past date. Callers rely on the
// throw to mark the read as failed (see computeNetWorth() in lib/networth.ts).

import { createHash } from 'node:crypto';
import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt } from './crypto';
import { READ_ENTRIES, UPDATE_ENTRY, openStored } from './repo';

const ACCOUNTS_HASH = (ctx: Ctx) => kc(ctx, 'manual:accounts');

/** account_id prefix. Ids are random, never derived from the name -- they key
 *  balance history, so a name-derived id would let a recreated account inherit
 *  a deleted one's series. */
export const MANUAL_ID_PREFIX = 'manual_';
/** Synthetic institution item_id prefix, so routes can tell these apart from
 *  real Plaid Items (see app/api/disconnect/route.ts). */
export const MANUAL_ITEM_PREFIX = 'manual:';

export const MANUAL_TYPES = ['depository', 'credit', 'investment', 'loan', 'other'] as const;
export type ManualType = (typeof MANUAL_TYPES)[number];

/** Guards against a fat-fingered paste blowing up the chart scale. Shared by
 *  every write path so the UI, the PUT and the ingest route agree. */
export const MAX_BALANCE = 1e12;

export type ManualAccount = {
  account_id: string;
  name: string;
  institution_name: string;
  type: ManualType;
  subtype: string | null;
  balance: number;
  updated_at: string; // ISO
};

/** Collapses whitespace and trims, so "Ally  Bank" and "Ally Bank " group into
 *  one institution card instead of two. */
export function normalizeInstitutionName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

export function newManualId(): string {
  return `${MANUAL_ID_PREFIX}${crypto.randomUUID()}`;
}

export function isManualId(id: string): boolean {
  return id.startsWith(MANUAL_ID_PREFIX);
}

/**
 * Decrypts and validates one stored record.
 *
 * The shape check matters: a bare cast would let a record with `balance: null`
 * through, computeNetWorth() skips null balances silently, and one drifted
 * record would understate net worth into the real history layer. A string
 * `balance` is worse (`0 + "500"` concatenates and poisons the running total).
 * Both throw, like a decrypt failure.
 */
function parseStoredAccount(id: string, plaintext: string): ManualAccount {
  const raw = JSON.parse(plaintext) as Partial<ManualAccount>;
  if (
    typeof raw.account_id !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.institution_name !== 'string' ||
    typeof raw.balance !== 'number' ||
    !Number.isFinite(raw.balance) ||
    typeof raw.type !== 'string' ||
    !MANUAL_TYPES.includes(raw.type as ManualType)
  ) {
    throw new Error(`Manual account ${id} is stored in an unexpected shape`);
  }
  return {
    account_id: raw.account_id,
    name: raw.name,
    institution_name: raw.institution_name,
    type: raw.type as ManualType,
    subtype: typeof raw.subtype === 'string' ? raw.subtype : null,
    balance: raw.balance,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date(0).toISOString(),
  };
}

/**
 * Every manual account. Throws if Redis is unreachable or ANY field fails to
 * decrypt, parse or validate: a partial list is indistinguishable from a shorter
 * one, and dropping an account understates net worth (see the file header).
 */
export async function getManualAccounts(ctx: Ctx): Promise<ManualAccount[]> {
  // Deliberately uncaught: a Redis error propagates to the caller.
  const map = await redis().hgetall<Record<string, string>>(ACCOUNTS_HASH(ctx));
  if (!map) return []; // genuinely empty hash, the only clean empty result

  const accounts = await Promise.all(
    Object.entries(map).map(async ([id, blob]) => {
      try {
        return parseStoredAccount(id, await decrypt(blob));
      } catch (err) {
        throw new Error(`Manual account ${id} could not be read`, { cause: err });
      }
    })
  );
  return accounts.sort((a, b) => a.name.localeCompare(b.name));
}

/** One account by id, or null if it doesn't exist. Throws on read failure, same as above. */
export async function getManualAccount(ctx: Ctx, account_id: string): Promise<ManualAccount | null> {
  const blob = await redis().hget<string>(ACCOUNTS_HASH(ctx), account_id);
  if (!blob) return null;
  try {
    return parseStoredAccount(account_id, await decrypt(blob));
  } catch (err) {
    throw new Error(`Manual account ${account_id} could not be read`, { cause: err });
  }
}

/**
 * Every manual account that can be read, and the ids of those that can't, for
 * the download of my data (lib/user-export.ts), which names what it can't read
 * rather than stopping. By the storage seam's rules (lib/repo.ts openStored),
 * as its stores report entries: `unreadable`, an account whose stored bytes
 * are damaged; `unrecognised`, one stored intact in a form this code does not
 * know (not JSON, not an account's shape). Anything that says nothing about
 * the data still throws: storage out of reach, a key this deployment can't
 * load, a failed decrypt under k0. Never for a figure that is recorded or
 * written on, which must use getManualAccounts (see the file header). The
 * accounts in name order, the ids in id order.
 */
export async function readManualAccountsForExport(ctx: Ctx): Promise<{ accounts: ManualAccount[]; unreadable: string[]; unrecognised: string[] }> {
  // Deliberately uncaught: a Redis error is never "no accounts".
  const map = (await redis().hgetall<Record<string, unknown>>(ACCOUNTS_HASH(ctx))) ?? {};
  const accounts: ManualAccount[] = [];
  const unreadable: string[] = [];
  const unrecognised: string[] = [];
  await Promise.all(
    Object.entries(map).map(async ([id, blob]) => {
      const opened = await openStored(blob);
      if (!opened.ok) {
        (opened.flaw === 'unreadable' ? unreadable : unrecognised).push(id);
        return;
      }
      try {
        accounts.push(parseStoredAccount(id, opened.text));
      } catch {
        unrecognised.push(id); // intact, but not JSON or not an account's shape
      }
    })
  );
  return { accounts: accounts.sort((a, b) => a.name.localeCompare(b.name)), unreadable: unreadable.sort(), unrecognised: unrecognised.sort() };
}

/** Creates or replaces one account. Single-field HSET, so concurrent writes to
 *  *different* accounts can't clobber each other. */
export async function saveManualAccount(ctx: Ctx, account: ManualAccount): Promise<void> {
  await redis().hset(ACCOUNTS_HASH(ctx), { [account.account_id]: await encrypt(JSON.stringify(account)) });
}

export async function removeManualAccount(ctx: Ctx, account_id: string): Promise<void> {
  await redis().hdel(ACCOUNTS_HASH(ctx), account_id);
}

/**
 * Updates just the balance, leaving every other field alone, so an automated push
 * (the ingest endpoint) can't rewrite the name or type. Returns false if the
 * account doesn't exist, for the caller to report.
 */
export async function setManualBalance(ctx: Ctx, account_id: string, balance: number): Promise<boolean> {
  const existing = await getManualAccount(ctx, account_id);
  if (!existing) return false;
  await saveManualAccount(ctx, { ...existing, balance, updated_at: new Date().toISOString() });
  return true;
}

/** What moveManualBalance did. */
export type BalanceMove = 'moved' | 'already' | 'changed' | 'missing';

/**
 * Moves an account's balance from the figure a form showed (`from`) to the one
 * it said it would become (`to`), to the cent, for the transaction `mover`
 * (a manual row's id), as one compare-and-set on this hash's field (the
 * storage seam's scripts, lib/repo.ts: read exactly, then write only if
 * unchanged since). The write stamps the record with the mover's id
 * (`balance_moved_by`), and only the move writes it: any other save of the
 * account (the Update form, a scripted push) writes the record without it.
 * Answers 'moved' when it held `from` and now holds `to`, stamped now;
 * 'already' when this mover's own move is the last write, as when the same
 * add is sent again (another add of the same amount, which leaves the same
 * figure, is not this one: 'changed'); 'changed' when it holds anything else,
 * left as it is; 'missing' when the account is gone. A write landing between
 * the read and the write (a scripted push, another device) is read again,
 * never overwritten. Throws if the account can't be read.
 */
export async function moveManualBalance(
  ctx: Ctx,
  account_id: string,
  from: number,
  to: number,
  mover: string,
  now: Date = new Date()
): Promise<BalanceMove> {
  const cents = (n: number) => Math.round(n * 100);
  const key = ACCOUNTS_HASH(ctx);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [raw] = (await redis().eval(READ_ENTRIES, [key], [account_id])) as string[];
    if (!raw) return 'missing';
    const stored = raw.slice(1); // exactly as stored, past READ_ENTRIES's "v"
    let account: ManualAccount;
    let movedBy: unknown;
    try {
      const plaintext = await decrypt(stored);
      account = parseStoredAccount(account_id, plaintext);
      movedBy = (JSON.parse(plaintext) as { balance_moved_by?: unknown }).balance_moved_by;
    } catch (err) {
      throw new Error(`Manual account ${account_id} could not be read`, { cause: err });
    }
    if (cents(account.balance) === cents(to) && movedBy === mover) return 'already';
    if (cents(account.balance) !== cents(from)) return 'changed';
    const next = await encrypt(JSON.stringify({ ...account, balance: to, updated_at: now.toISOString(), balance_moved_by: mover }));
    const seen = createHash('sha1').update(stored, 'utf8').digest('hex');
    if (Number(await redis().eval(UPDATE_ENTRY, [key], [account_id, seen, next])) === 1) return 'moved';
  }
  // It kept changing: whatever it holds now, it isn't what the form showed.
  return 'changed';
}

// The synthetic-institution shape mirrors InstitutionResult in lib/networth.ts.
// It's declared structurally here rather than imported to keep the dependency
// pointing one way (networth imports manual, not the reverse).
export type ManualInstitution = {
  institution_name: string;
  item_id: string;
  accounts: {
    account_id: string;
    name: string;
    official_name: string | null;
    mask: null;
    type: string;
    subtype: string | null;
    balance: number;
    available: null;
    limit: null;
    currency: string;
    updated_at: string;
  }[];
  holdings: never[];
  error: null;
  needs_reauth: false;
  // Typed-by-hand balances have no Plaid Item behind them, so there is no
  // liabilities product to fetch or enable. 'unavailable' keeps the Enable
  // button off these cards.
  liabilities: 'unavailable';
  manual: true;
};

/**
 * Groups manual accounts into synthetic institutions so the Accounts tab renders
 * them with the same card markup as Plaid institutions. `holdings` is always
 * present because Dashboard dereferences `inst.holdings.length` unguarded.
 */
export function toInstitutions(accounts: ManualAccount[]): ManualInstitution[] {
  const byInstitution = new Map<string, ManualInstitution>();

  for (const a of accounts) {
    const institution_name = normalizeInstitutionName(a.institution_name) || 'Manual';
    // Group case-insensitively so "Ally" and "ally" land on one card, but keep
    // the first spelling seen for display rather than forcing a casing.
    const key = institution_name.toLowerCase();
    let inst = byInstitution.get(key);
    if (!inst) {
      inst = {
        institution_name,
        // Keyed off the case-folded name so the React key stays stable even if
        // the displayed spelling changes.
        item_id: `${MANUAL_ITEM_PREFIX}${key}`,
        accounts: [],
        holdings: [],
        error: null,
        needs_reauth: false,
        liabilities: 'unavailable',
        manual: true,
      };
      byInstitution.set(key, inst);
    }
    inst.accounts.push({
      account_id: a.account_id,
      name: a.name,
      official_name: null,
      // Fields a Plaid account carries that a typed one has no equivalent for,
      // explicitly null so the synthetic account has the same shape as a real one.
      // `limit` drives the credit utilization meter, which needs a real credit
      // line to mean anything.
      mask: null,
      available: null,
      limit: null,
      type: a.type,
      subtype: a.subtype,
      balance: a.balance,
      // Manual accounts are USD-only for now, matching the rest of the
      // account-level figures (net worth, balances, goals).
      currency: 'USD',
      updated_at: a.updated_at,
    });
  }

  return [...byInstitution.values()];
}
