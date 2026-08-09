// lib/manual.ts
//
// Manually-tracked accounts, for institutions Plaid can't reach (small credit
// unions, HSAs, 401k recordkeepers, foreign banks, crypto, real estate). You
// type the balance; everything downstream treats it like a Plaid account.
//
// Stored as a Redis hash keyed by account_id -- one encrypted field per
// account, the same shape as `plaid:items` in lib/storage.ts and for the same
// reason: the ingest endpoint (app/api/ingest/balance) lets an external script
// write on a schedule, concurrently with edits in the app. A single-blob
// read-modify-write (the lib/goals.ts shape) would silently drop one of them.
//
// READ FAILURES MUST THROW. This is the one place where the codebase's usual
// "swallow the error and return empty" habit is actively dangerous: manual
// balances feed net worth, and a net worth that's silently short by the whole
// manual total gets written into the REAL history layer (lib/history.ts),
// which nothing ever rewrites for a past date. A transient Redis blip would
// permanently corrupt that day's point. Callers depend on the throw to mark
// the read as failed instead -- see computeNetWorth() in lib/networth.ts.

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';

const ACCOUNTS_HASH = k('manual:accounts');

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
 * The shape check is not paranoia. A cast alone (`as ManualAccount`) would let
 * a record with `balance: null` through, and computeNetWorth() skips null
 * balances silently -- so a single drifted record would understate net worth
 * with no error raised, and that wrong total gets written to the real history
 * layer for the day. A `balance` stored as a *string* is worse still: `0 +
 * "500"` concatenates, poisoning the running total for every account. Both are
 * exactly the silent shortfall this module exists to prevent, so they throw
 * like a decrypt failure does.
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
 * Every manual account. Throws if Redis is unreachable, or if ANY field fails
 * to decrypt, parse, or validate -- a partial list is indistinguishable from a
 * shorter one, and silently dropping an account understates net worth. See the
 * file header for why that matters more here than elsewhere.
 */
export async function getManualAccounts(): Promise<ManualAccount[]> {
  // Deliberately uncaught: a Redis error propagates to the caller.
  const map = await redis().hgetall<Record<string, string>>(ACCOUNTS_HASH);
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
export async function getManualAccount(account_id: string): Promise<ManualAccount | null> {
  const blob = await redis().hget<string>(ACCOUNTS_HASH, account_id);
  if (!blob) return null;
  try {
    return parseStoredAccount(account_id, await decrypt(blob));
  } catch (err) {
    throw new Error(`Manual account ${account_id} could not be read`, { cause: err });
  }
}

/** Creates or replaces one account. Single-field HSET, so concurrent writes to
 *  *different* accounts can't clobber each other. */
export async function saveManualAccount(account: ManualAccount): Promise<void> {
  await redis().hset(ACCOUNTS_HASH, { [account.account_id]: await encrypt(JSON.stringify(account)) });
}

export async function removeManualAccount(account_id: string): Promise<void> {
  await redis().hdel(ACCOUNTS_HASH, account_id);
}

/**
 * Updates just the balance, leaving every other field alone. Used by the
 * ingest endpoint so an automated push can't accidentally rewrite the name or
 * type. Returns false if the account doesn't exist (the caller reports that
 * rather than silently succeeding).
 */
export async function setManualBalance(account_id: string, balance: number): Promise<boolean> {
  const existing = await getManualAccount(account_id);
  if (!existing) return false;
  await saveManualAccount({ ...existing, balance, updated_at: new Date().toISOString() });
  return true;
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
 * Groups manual accounts into synthetic institutions so the Accounts tab can
 * render them with the same card markup as Plaid institutions. `holdings` is
 * always present (never undefined) because Dashboard dereferences
 * `inst.holdings.length` unguarded.
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
      // Fields a Plaid account carries that a typed one has no equivalent for.
      // Explicitly null rather than absent so the synthetic account is the same
      // shape as a real one: `available` is pending-hold specific, `mask` is the
      // last 4 of a real account number, and `limit` drives the credit
      // utilization meter, which needs a real credit line to mean anything.
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
