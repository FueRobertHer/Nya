// lib/transactions.ts
//
// Per-Item transaction store backed by Plaid's cursor-based /transactions/sync.
//
// Each Item's sync cursor and transactions are persisted in Redis (encrypted,
// see lib/crypto.ts). Every call resumes from the stored cursor and applies only
// the deltas Plaid returns. Reconciliation is idempotent (added/modified upsert
// by transaction_id, removed deletes by id), so a replayed page or a
// mid-pagination restart can't corrupt the set.
//
// History is retained indefinitely, not to a fixed age. Sync only reports
// `removed` when a bank deletes a transaction, never when one ages out of the
// bank's window, so a stored row stays. That lets the store outlive
// short-history institutions and accumulate a long trend the bank can't give.
// The only bound is a size guard: the blob is gzip-compressed at rest, and if it
// would still exceed Upstash's request-size ceiling, writeState REFUSES to write
// it rather than trimming. Trimming oldest-first would drop precisely the rows
// no bank will re-serve, silently; refusing is recoverable.

import { TransactionsUpdateStatus, type Transaction, type AccountBase } from 'plaid';
import { plaidClient } from './plaid';
import { decrypt } from './crypto';
import { encodeJsonBlob, decodeJsonBlob, maxBlobChars, blobWarnChars } from './blob';
import { redis, kc, type StoredItem } from './storage';
import type { Ctx } from './containers';
import { loggable } from './log-safe';

// Bump when a persisted row gains a field historical rows can't satisfy. A blob
// at an older version is upgraded in place on read (see readState / migrateLegacyState).
export const TXN_SCHEMA_VERSION = 2;

// Display shape sent to the client: a flat set of scalars projected from
// StoredTxn (`name` is merchant_name || raw name), so the Activity views get
// subcategory, channel, location, time and the real merchant behind a
// processor without shipping the whole StoredTxn.
export type Txn = {
  transaction_id: string;
  date: string; // YYYY-MM-DD
  name: string;
  amount: number; // Plaid convention: positive = money leaving the account
  pending: boolean;
  account_name: string;
  institution_name: string;
  category: string | null;
  iso_currency_code: string | null; // so amounts aren't blindly rendered as USD
  // Plaid's code for a currency with no ISO one (a cryptocurrency); absent on
  // a payload cached before it was sent.
  unofficial_currency_code?: string | null;
  vendor_key: string; // stable per-merchant key for vendor renames (see vendorKey)
  logo_url: string | null; // merchant logo for the row
  category_icon_url: string | null; // Plaid category icon

  subcategory: string | null; // PFC detailed, humanized and de-prefixed
  category_confidence: string | null; // VERY_HIGH … UNKNOWN; flags low-confidence rows
  transaction_code: string | null; // transfer | atm | purchase | payroll … (reliable transfer signal)
  payment_channel: string | null; // online | in store | other
  datetime: string | null; // true event time (posting date is coarser); drives intra-day order
  website: string | null;
  check_number: string | null;
  account_owner: string | null;
  city: string | null;
  region: string | null;
  counterparty: string | null; // real merchant behind a processor, when it differs
  payment_processor: string | null; // e.g. the PayPal/Square in front of the merchant
  payment_reference: string | null; // payment_meta reference number, for "what is this charge?"

  // Set by /api/transactions on rows that aren't a bank's, and on any row the
  // person excluded; absent otherwise, so a payload cached before they existed
  // reads the same.
  source?: string; // a manual row's source: 'manual' for one entered by hand (lib/manual-txns.ts)
  account_id?: string; // a manual row's account, for editing it
  note?: string | null; // a manual row's note
  excluded?: boolean | null; // left out of budgets and reports (lib/spending.ts); null: couldn't be read
};

// Full-fidelity persisted form: nearly everything Plaid returns per transaction.
// Adding a field later would cost a full re-sync (see TXN_SCHEMA_VERSION), and
// the gzip-compressed blob makes the space cost small. Read paths derive
// narrower shapes (e.g. the display Txn).
export type StoredTxn = {
  transaction_id: string;
  pending_transaction_id: string | null; // pending row → its later posted row
  account_id: string;

  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;

  date: string; // posting date, YYYY-MM-DD; datetime fields are the true event time
  authorized_date: string | null;
  authorized_datetime: string | null;
  datetime: string | null;

  // Raw `name` and `merchant_name` kept separately; merchant_entity_id is the
  // stable per-merchant key for vendor-level features.
  name: string; // raw bank descriptor (Plaid `name`)
  merchant_name: string | null;
  merchant_entity_id: string | null;
  website: string | null;
  logo_url: string | null;

  personal_finance_category: Transaction['personal_finance_category'] | null; // primary/detailed/confidence
  personal_finance_category_icon_url: string | null;

  pending: boolean;
  payment_channel: string | null; // online | in store | other
  transaction_code: Transaction['transaction_code'] | null; // transfer | atm | purchase | payroll …
  transaction_type: string | null;
  check_number: string | null;
  account_owner: string | null;

  location: Transaction['location'] | null; // address, city, region, lat/lon, store_number
  payment_meta: Transaction['payment_meta'] | null; // payee, payer, reference_number, processor …
  counterparties: NonNullable<Transaction['counterparties']>; // real merchant behind a processor

  // Derived / resolved, retained for existing consumers.
  category: string | null; // PFC primary, humanized
  account_name: string;
  institution_name: string;
};

// Per-account metadata captured from each sync's `accounts[]`.
export type StoredAccount = {
  name: string;
  official_name: string | null;
  type: string | null; // depository | credit | loan | investment
  subtype: string | null; // checking | savings | credit card …
  mask: string | null; // last 4
  balances: {
    available: number | null;
    current: number | null;
    limit: number | null;
    iso_currency_code: string | null;
    unofficial_currency_code: string | null;
  } | null;
};

type ItemState = {
  schema_version: number; // older value → upgraded in place on read
  cursor: string; // '' = never synced → pull full history
  accounts: Record<string, StoredAccount>; // account_id → metadata, merged over time
  txns: Record<string, StoredTxn>; // keyed by transaction_id
};

// Trailing window callers display / reconstruct by default.
export const LOOKBACK_DAYS = 365;
// Runaway guard for one call: 50 * 500 = 25k updates. A very large Item's
// initial pull can exceed it; progress is persisted and finishes on the next call.
const MAX_PAGES = 50;
const MAX_MUTATION_RETRIES = 3;

// Stable grouping key for vendor-level features (renames applied in
// /api/transactions). Prefers Plaid's merchant entity id (unique per merchant,
// stable across institutions). Falls back to institution + merchant/display name
// when there is none, which scopes the rename to that institution.
export function vendorKey(t: {
  merchant_entity_id: string | null;
  merchant_name: string | null;
  name: string;
  institution_name: string;
}): string {
  if (t.merchant_entity_id) return `mid:${t.merchant_entity_id}`;
  const nm = (t.merchant_name || t.name).toLowerCase().trim();
  return `nm:${t.institution_name.toLowerCase().trim()}::${nm}`;
}

/**
 * What identifies one real-world transaction across a re-link, when its
 * transaction_id doesn't survive: the account (as known now, following links),
 * posting date, amount in cents and the bank's own descriptor (Plaid's raw
 * `name`), normalized. Raw descriptor rather than the enriched merchant, since a
 * fresh pull re-runs enrichment and may name the merchant differently while the
 * bank's text for a posted transaction doesn't change.
 *
 * Two genuinely identical rows share a key; lib/overrides.ts treats a key it
 * can't attribute to one category as ambiguous and carries nothing for it.
 */
export function contentKey(account_id: string, t: { date: string; amount: number; name: string }): string {
  const descriptor = t.name.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${account_id}|${t.date}|${Math.round(t.amount * 100)}|${descriptor}`;
}

// PFC `detailed` humanized and stripped of its `primary` prefix
// ("FOOD_AND_DRINK_COFFEE" becomes "coffee").
function humanizeSubcategory(pfc: StoredTxn['personal_finance_category']): string | null {
  const detailed = pfc?.detailed;
  if (!detailed) return null;
  const primary = pfc?.primary ?? '';
  const rest = primary && detailed.startsWith(primary) ? detailed.slice(primary.length) : detailed;
  const s = rest.replace(/_/g, ' ').trim().toLowerCase();
  return s || null;
}

// The real merchant behind a payment processor, split from the raw descriptor
// via Plaid's counterparty `type` (`merchant` vs `payment_app`).
function resolveCounterparty(t: StoredTxn): string | null {
  const merchant = t.counterparties.find((c) => c.type === 'merchant');
  const name = merchant?.name ?? null;
  // Only interesting when it differs from what we already show as the name.
  const display = (t.merchant_name || t.name).toLowerCase().trim();
  return name && name.toLowerCase().trim() !== display ? name : null;
}

function resolveProcessor(t: StoredTxn): string | null {
  if (t.payment_meta?.payment_processor) return t.payment_meta.payment_processor;
  const app = t.counterparties.find((c) => c.type === 'payment_app');
  return app?.name ?? null;
}

// Ids of pending rows that a later posted row supersedes: a posted row carries
// the pending one's id in pending_transaction_id (and usually removes the
// original, but the two can briefly coexist). Suppressing the pending original
// avoids counting a purchase twice. Exported for the download of my data
// (lib/user-export.ts), which keeps such rows but marks them.
export function supersededPendingIds(txns: Record<string, StoredTxn>): Set<string> {
  const superseded = new Set<string>();
  for (const t of Object.values(txns)) {
    if (t.pending_transaction_id && txns[t.pending_transaction_id]) {
      superseded.add(t.pending_transaction_id);
    }
  }
  return superseded;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function stateKey(ctx: Ctx, item_id: string): string {
  return kc(ctx, `txns:${item_id}`);
}

// Set when an Item's blob is too large to persist (see writeState). Its own key
// because the blob is what we could not write.
//
// It breaks a loop: refusing to persist means the cursor never advances, so
// without this every dashboard load would re-pull the Item's whole history.
//
// Deliberately NOT under the `txns:` prefix: it is metadata about a blob, so a
// walk of `txns:*` (export, backup, migration) must not match it.
function blockedKey(ctx: Ctx, item_id: string): string {
  return kc(ctx, `txns-blocked:${item_id}`);
}

// Set when a write of the store failed for any other reason, and cleared by
// the next write that lands: while it is set, rows on screen may not be
// stored. Expires in a week, in case the Item is never synced again.
function unsavedKey(ctx: Ctx, item_id: string): string {
  return kc(ctx, `txns-unsaved:${item_id}`);
}

/** Whether an Item's store is behind what it shows: its last write was
 *  refused as too large, or failed, so rows on screen may not be stored.
 *  Throws on a failed read, for callers that delete on the answer. */
export async function storeIsBehind(ctx: Ctx, item_id: string): Promise<boolean> {
  const [blocked, unsaved] = await Promise.all([redis().get(blockedKey(ctx, item_id)), redis().get(unsavedKey(ctx, item_id))]);
  return blocked !== null || unsaved !== null;
}

/** What the marker records: when the write was refused, and how big the blob
 *  was. The size is what lets a raised ceiling actually unblock the Item. */
type BlockedMarker = { at: string; chars: number };

function parseBlocked(raw: string): BlockedMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BlockedMarker>;
    if (typeof parsed?.at === 'string' && typeof parsed?.chars === 'number') {
      return { at: parsed.at, chars: parsed.chars };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function emptyState(): ItemState {
  return { schema_version: TXN_SCHEMA_VERSION, cursor: '', accounts: {}, txns: {} };
}

// Encoding and the size ceiling live in lib/blob.ts, shared with lib/invstore.ts.
const encodeState = (state: ItemState) => encodeJsonBlob(state);
const decodeState = (blob: string) => decodeJsonBlob<Partial<ItemState>>(blob);

// Shape of a pre-v2 stored blob: an account_id→name map and the lean 9-field
// rows. Kept only for the one-time in-place upgrade in readState.
type LegacyStoredTxn = {
  transaction_id: string;
  date: string;
  name: string; // was merchant_name || name, already merged (unrecoverable split)
  amount: number;
  pending: boolean;
  account_name: string;
  institution_name: string;
  category: string | null;
  account_id: string;
};
type LegacyItemState = {
  cursor?: string;
  accountNames?: Record<string, string>;
  txns?: Record<string, LegacyStoredTxn>;
};

function migrateLegacyTxn(t: LegacyStoredTxn): StoredTxn {
  return {
    transaction_id: t.transaction_id,
    pending_transaction_id: null,
    account_id: t.account_id,

    amount: t.amount,
    iso_currency_code: null,
    unofficial_currency_code: null,

    date: t.date,
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,

    // Legacy `name` was already merchant_name||name and can't be un-merged;
    // keep it as `name` with the merchant fields null. Display is unchanged.
    name: t.name,
    merchant_name: null,
    merchant_entity_id: null,
    website: null,
    logo_url: null,

    personal_finance_category: null,
    personal_finance_category_icon_url: null,

    pending: t.pending,
    payment_channel: null,
    transaction_code: null,
    transaction_type: null,
    check_number: null,
    account_owner: null,

    location: null,
    payment_meta: null,
    counterparties: [],

    category: t.category ?? null,
    account_name: t.account_name ?? '',
    institution_name: t.institution_name,
  };
}

function migrateLegacyState(old: LegacyItemState): ItemState {
  const accounts: Record<string, StoredAccount> = {};
  for (const [id, name] of Object.entries(old.accountNames ?? {})) {
    accounts[id] = {
      name,
      official_name: null,
      type: null,
      subtype: null,
      mask: null,
      balances: null,
    };
  }
  const txns: Record<string, StoredTxn> = {};
  for (const [id, t] of Object.entries(old.txns ?? {})) txns[id] = migrateLegacyTxn(t);
  return {
    schema_version: TXN_SCHEMA_VERSION,
    cursor: typeof old.cursor === 'string' ? old.cursor : '',
    accounts,
    txns,
  };
}

/**
 * The stored blob exists but could not be turned back into state. Thrown rather
 * than swallowed: carrying on with an empty state would have the next writeState
 * persist that emptiness over the real thing. See readState.
 */
class StateUnreadableError extends Error {
  constructor(
    readonly item_id: string,
    readonly kind: 'read' | 'decode',
    readonly reason: unknown
  ) {
    super(`transactions: stored state for ${item_id} is unreadable (${kind})`);
    this.name = 'StateUnreadableError';
  }
}

async function readState(ctx: Ctx, item_id: string): Promise<ItemState> {
  let blob: string | null;
  try {
    blob = await redis().get<string>(stateKey(ctx, item_id));
  } catch (err) {
    // A Redis blip is NOT an empty store: treating it as one would re-pull and
    // persist the bank's short window over years of retained rows.
    throw new StateUnreadableError(item_id, 'read', err);
  }

  // Genuinely absent (a new Item, or one deliberately cleared): the ONLY case
  // that starts from empty.
  if (!blob) return emptyState();

  try {
    const parsed = await decodeState(blob);
    const version = typeof parsed.schema_version === 'number' ? parsed.schema_version : 0;
    if (version >= TXN_SCHEMA_VERSION) {
      // Current or newer. A newer blob (read by an older deploy after a
      // rollback) is a superset: pass it through and never downgrade it or feed
      // it to the legacy migrator, which would null fields it doesn't know.
      return {
        schema_version: version,
        cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
        accounts: parsed.accounts ?? {},
        txns: parsed.txns ?? {},
      };
    }
    // Older or unversioned: upgrade in place, keeping every row and the cursor.
    // Re-pulling would recover only what each bank still exposes, dropping the
    // long-tail history this store retains. New fields stay null on old rows
    // until Plaid next `modified`s them.
    return migrateLegacyState(parsed as unknown as LegacyItemState);
  } catch (err) {
    // Rotated key, corrupted value, or a cipher format this build predates.
    // Never return emptyState() here: it would go straight to writeState and
    // overwrite the stored blob, losing everything older than the bank's window
    // with nothing on screen to say so. This includes the rollback path of an
    // encryption change, where an older deploy can't decrypt newer values.
    throw new StateUnreadableError(item_id, 'decode', err);
  }
}

/** Why a write did not land, when it didn't. `oversize` is the only outcome a
 *  caller must surface: the others resolve themselves on the next sync. */
type WriteOutcome = { persisted: true } | { persisted: false; reason: 'oversize' | 'error' };

async function writeState(ctx: Ctx, item_id: string, state: ItemState): Promise<WriteOutcome> {
  try {
    const encoded = await encodeState(state);

    // OVER THE CEILING: refuse, and do not touch `state`.
    //
    // Trimming the oldest rows to fit would mutate the caller's object, and
    // syncItem returns that same object, so the RESPONSE would be shortened too
    // and lib/backfill.ts would reconstruct balances from a set with a hole in
    // it, persisting a wrong history over the real estimated layer. The dropped
    // rows are also the ones no bank will re-serve.
    //
    // Refusing is recoverable: the cursor doesn't advance, deltas are
    // idempotent, and the stored blob stays as it was.
    if (encoded.length > maxBlobChars()) {
      console.error(
        `transactions: refusing to persist ${item_id} in container ${ctx.container}: blob is ${encoded.length} chars, over the ${maxBlobChars()} ceiling (${Object.keys(state.txns).length} txns). Nothing was written or dropped.`
      );
      try {
        const marker: BlockedMarker = { at: new Date().toISOString(), chars: encoded.length };
        await redis().set(blockedKey(ctx, item_id), JSON.stringify(marker));
      } catch {
        // Best effort. Without the marker the next sync re-pulls and refuses
        // again: wasteful, still correct.
      }
      return { persisted: false, reason: 'oversize' };
    }

    if (encoded.length > blobWarnChars()) {
      console.warn(
        `transactions: ${item_id} blob is ${encoded.length} chars, past ${Math.round((encoded.length / maxBlobChars()) * 100)}% of the ceiling`
      );
    }

    await redis().set(stateKey(ctx, item_id), encoded);
    // Caught up: what is shown is stored again.
    await redis().del(unsavedKey(ctx, item_id)).catch(() => {});
    return { persisted: true };
  } catch (err) {
    // Non-fatal for this request (the in-memory state is still returned) and
    // the deltas are idempotent. Logged because a persistent failure silently
    // becomes a full re-pull of the Item's history on every sync.
    console.warn(
      `transactions: failed to persist sync state for ${item_id} (${Object.keys(state.txns).length} txns); will re-sync next call`,
      err
    );
    // The rows about to be shown aren't stored. Says so for the one reader that
    // must know (lib/overrides.ts pruneOrphanOverrides, which would otherwise
    // take a category set on one of them for an orphan).
    await redis().set(unsavedKey(ctx, item_id), new Date().toISOString(), { ex: 7 * 86_400 }).catch(() => {});
    return { persisted: false, reason: 'error' };
  }
}

/**
 * An Item's stored transactions, read without syncing (no Plaid call), for
 * the paths that must not reach Plaid: a disconnect (the Item is already
 * removed there) and the Accounts tab. Throws when the store can't be read.
 */
export async function readStoredTxns(ctx: Ctx, item_id: string, opts: { shown?: boolean } = {}): Promise<StoredTxn[]> {
  const txns = (await readState(ctx, item_id)).txns;
  if (!opts.shown) return Object.values(txns);
  // Only what /api/transactions would display: inside the lookback, and not a
  // pending row its posted row has replaced.
  const cutoff = daysAgoIso(LOOKBACK_DAYS);
  const superseded = supersededPendingIds(txns);
  return Object.values(txns).filter((t) => t.date >= cutoff && !superseded.has(t.transaction_id));
}

/**
 * Everything an Item's store holds, for the download of my data
 * (lib/user-export.ts): its accounts as last synced and every stored row,
 * read without syncing, all of history rather than the lookback, pending rows
 * a posted row replaced included. The sync cursor is left out: it is Plaid's
 * bookmark, not data. Strict: throws when the store can't be read, since a
 * download must never pass off an unreadable store as an empty one.
 */
export async function readStoredItem(
  ctx: Ctx,
  item_id: string
): Promise<{ accounts: Record<string, StoredAccount>; txns: Record<string, StoredTxn> }> {
  const { accounts, txns } = await readState(ctx, item_id);
  return { accounts, txns };
}

/**
 * The account ids this Item is known to own, straight from the persisted state
 * (no Plaid call). A partial answer: an investments-only Item, or one linked
 * and never synced, persists no transaction state, so this is empty for it.
 */
export async function getItemAccountIds(ctx: Ctx, item_id: string): Promise<string[]> {
  try {
    return Object.keys((await readState(ctx, item_id)).accounts);
  } catch {
    return [];
  }
}

/**
 * Every account id an Item's store mentions: its account map and every
 * stored row's account. Strict (throws when it can't be read), for a caller
 * that deletes on the answer: forgetting an earlier account must not take an
 * unreadable store for one that doesn't have it.
 */
export async function storedAccountIds(ctx: Ctx, item_id: string): Promise<Set<string>> {
  const state = await readState(ctx, item_id);
  return new Set([...Object.keys(state.accounts), ...Object.values(state.txns).map((t) => t.account_id)]);
}

/**
 * Delete an Item's stored transactions. Call when the Item is disconnected.
 * Clears the oversize marker too: reconnecting is the fix that marker's note
 * recommends, so a marker left behind would block the relinked Item forever.
 */
export async function clearItemTransactions(ctx: Ctx, item_id: string): Promise<void> {
  try {
    await redis().del(stateKey(ctx, item_id), blockedKey(ctx, item_id), unsavedKey(ctx, item_id));
  } catch {
    // Best effort; a stale key is harmless once the Item is gone.
  }
}

function toStored(
  t: Transaction,
  accounts: Record<string, StoredAccount>,
  institution_name: string
): StoredTxn {
  return {
    transaction_id: t.transaction_id,
    pending_transaction_id: t.pending_transaction_id ?? null,
    account_id: t.account_id,

    amount: t.amount,
    iso_currency_code: t.iso_currency_code ?? null,
    unofficial_currency_code: t.unofficial_currency_code ?? null,

    date: t.date,
    authorized_date: t.authorized_date ?? null,
    authorized_datetime: t.authorized_datetime ?? null,
    datetime: t.datetime ?? null,

    name: t.name,
    merchant_name: t.merchant_name ?? null,
    merchant_entity_id: t.merchant_entity_id ?? null,
    website: t.website ?? null,
    logo_url: t.logo_url ?? null,

    personal_finance_category: t.personal_finance_category ?? null,
    personal_finance_category_icon_url: t.personal_finance_category_icon_url ?? null,

    pending: t.pending,
    payment_channel: t.payment_channel ?? null,
    transaction_code: t.transaction_code ?? null,
    transaction_type: t.transaction_type ?? null,
    check_number: t.check_number ?? null,
    account_owner: t.account_owner ?? null,

    location: t.location ?? null,
    payment_meta: t.payment_meta ?? null,
    counterparties: t.counterparties ?? [],

    category: t.personal_finance_category?.primary?.replace(/_/g, ' ').toLowerCase() ?? null,
    account_name: accounts[t.account_id]?.name || '',
    institution_name,
  };
}

function toStoredAccount(a: AccountBase): StoredAccount {
  return {
    name: a.name,
    official_name: a.official_name ?? null,
    type: a.type ?? null,
    subtype: a.subtype ?? null,
    mask: a.mask ?? null,
    balances: a.balances
      ? {
          available: a.balances.available ?? null,
          current: a.balances.current ?? null,
          limit: a.balances.limit ?? null,
          iso_currency_code: a.balances.iso_currency_code ?? null,
          unofficial_currency_code: a.balances.unofficial_currency_code ?? null,
        }
      : null,
  };
}

/**
 * Sync one Item from Plaid and persist the reconciled set + cursor. Returns the
 * full retained `state` (callers slice to the window they need), plus a `note`
 * when something is off. `state` is null only on a hard stop (reauth, fresh
 * Item still syncing, unrecoverable error); a non-null `state` with a `note`
 * means usable-but-partial (e.g. the initial pull hit the page cap). Prior
 * stored state is left untouched on a hard stop.
 */
async function syncItem(ctx: Ctx, 
  item: StoredItem
): Promise<{ state: ItemState | null; note: string | null }> {
  let access_token: string;
  try {
    access_token = await decrypt(item.encrypted_access_token);
  } catch {
    return { state: null, note: `${item.institution_name}: could not decrypt stored credentials` };
  }

  // A previous sync could not persist this Item's blob (see writeState). Stop
  // before the Plaid call: pulling again would rebuild the same oversized state
  // and refuse to write it again, at full cost, on every dashboard load.
  try {
    const raw = await redis().get<string>(blockedKey(ctx, item.item_id));
    if (raw) {
      const marker = parseBlocked(raw);

      // Raising the ceiling is the legitimate fix (a bigger Upstash plan allows
      // a bigger request). Without this comparison the short-circuit would fire
      // before any size is computed, leaving reconnecting, which discards the
      // Item's stored history, as the only way out.
      //
      // An unparseable marker clears too, rather than blocking forever. The cost
      // is one wasted pull; writeState re-sets the marker if the blob is still
      // too big.
      if (!marker || marker.chars <= maxBlobChars()) {
        await redis().del(blockedKey(ctx, item.item_id));
      } else {
        return {
          state: null,
          note: `${item.institution_name}: stored history is too large to save (since ${marker.at.slice(0, 10)}) — raise the storage limit to resume, or reconnect to start over, which discards this institution's saved history`,
        };
      }
    }
  } catch {
    // Can't read the marker: sync anyway. Worst case is the wasted pull the
    // marker prevents, which beats refusing to sync because Redis hiccuped.
  }

  // Hard stop on an unreadable blob, like the undecryptable-credentials stop
  // above: syncing from empty and persisting it would overwrite history no bank
  // will re-serve, so this must never reach writeState.
  let stored: ItemState;
  try {
    stored = await readState(ctx, item.item_id);
  } catch (err) {
    if (err instanceof StateUnreadableError) {
      console.error(err.message, err.reason);
      return {
        state: null,
        note: `${item.institution_name}: stored history could not be read — refusing to re-sync over it`,
      };
    }
    throw err;
  }

  for (let attempt = 0; attempt < MAX_MUTATION_RETRIES; attempt++) {
    // Fresh working copy per attempt so a mid-pagination restart can't apply a
    // page's deltas onto an already-mutated set.
    const state: ItemState = JSON.parse(JSON.stringify(stored));
    let cursor: string | undefined = state.cursor || undefined;
    let hasMore = true;
    let pages = 0;
    let lastStatus: TransactionsUpdateStatus | undefined;

    try {
      while (hasMore && pages < MAX_PAGES) {
        const res = await plaidClient.transactionsSync({ access_token, cursor, count: 500 });
        pages++;
        lastStatus = res.data.transactions_update_status;
        res.data.accounts.forEach((a) => (state.accounts[a.account_id] = toStoredAccount(a)));
        for (const t of res.data.added) {
          state.txns[t.transaction_id] = toStored(t, state.accounts, item.institution_name);
        }
        for (const t of res.data.modified) {
          state.txns[t.transaction_id] = toStored(t, state.accounts, item.institution_name);
        }
        for (const r of res.data.removed) {
          if (r.transaction_id) delete state.txns[r.transaction_id];
        }
        hasMore = res.data.has_more;
        cursor = res.data.next_cursor;
      }
    } catch (err: any) {
      const code = err?.response?.data?.error_code;
      // Data changed under us mid-pagination: discard this attempt's work and
      // restart from the stored cursor. Once retries are exhausted, report it
      // specifically rather than as a generic fetch failure.
      if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
        if (attempt < MAX_MUTATION_RETRIES - 1) continue;
        return {
          state: null,
          note: `${item.institution_name}: could not fetch transactions (data kept changing — try again)`,
        };
      }
      if (code === 'ITEM_LOGIN_REQUIRED') {
        return { state: null, note: `${item.institution_name}: needs to be reconnected` };
      }
      if (code === 'PRODUCT_NOT_READY') {
        return {
          state: null,
          note: `${item.institution_name}: transactions are still syncing — try again in a minute`,
        };
      }
      console.error(loggable(err));
      return { state: null, note: `${item.institution_name}: could not fetch transactions` };
    }

    // Fresh Item whose initial pull hasn't produced anything yet: report the
    // syncing state and DON'T persist, so the next call re-pulls from scratch.
    if (
      stored.cursor === '' &&
      Object.keys(state.txns).length === 0 &&
      lastStatus === TransactionsUpdateStatus.NotReady
    ) {
      return {
        state: null,
        note: `${item.institution_name}: transactions are still syncing — try again in a minute`,
      };
    }

    // Advance the cursor and persist. writeState refuses, rather than dropping
    // rows, if the blob would exceed the request-size ceiling.
    if (cursor) state.cursor = cursor;
    const write = await writeState(ctx, item.item_id, state);

    // Too large to persist. `state` is still complete (nothing was trimmed), so
    // return it: accurate figures this request plus a note that they won't
    // stick, rather than blanking the institution over a storage problem.
    if (!write.persisted && write.reason === 'oversize') {
      return {
        state,
        note: `${item.institution_name}: too much stored history to save an update — showing live data, but it won't persist until this is resolved`,
      };
    }

    // Hit the page cap mid-history: intermediate cursors are valid, so we
    // persisted progress and will finish next call. Surface it rather than
    // silently returning a short list.
    if (hasMore) {
      return {
        state,
        note: `${item.institution_name}: still importing older transactions — refresh again shortly`,
      };
    }
    return { state, note: null };
  }

  // Unreachable: every attempt returns or continues, and the final attempt's
  // catch returns. Here only to satisfy the compiler.
  return { state: null, note: `${item.institution_name}: could not fetch transactions` };
}

/**
 * Sync + return the display-shaped transactions for the Activity tab, sliced to
 * the trailing LOOKBACK window. Account names are re-resolved from the merged
 * map (an account can arrive on a later page than a transaction referencing it).
 *
 * `hiddenAccountIds` drops rows of hidden accounts (lib/hidden.ts). It has to be
 * filtered here: Txn has no `account_id` afterwards. Hidden rows are then never
 * sent to the client, and everything derived from the array (Activity list,
 * month totals, budgets, insights, recurring bills) follows. The persisted store
 * is untouched, so unhiding brings every row back.
 */
export async function syncItemTransactions(ctx: Ctx, 
  item: StoredItem,
  hiddenAccountIds?: Set<string>,
  /** Categories carried across a re-link, by contentKey (lib/overrides.ts).
   *  Applied here because this is the last place account_id exists; a
   *  category set on the row itself still wins, in /api/transactions. */
  carriedIn?: Map<string, string> | Promise<Map<string, string>>,
  /** Exclusions carried across a re-link, by contentKey
   *  (lib/txn-annotations.ts), marked `excluded` on posted rows here for the
   *  same reason; what the person says on the row itself still wins. */
  carriedExclusionsIn?: Set<string> | Promise<Set<string>>
): Promise<{ txns: Txn[]; note: string | null }> {
  const { state, note } = await syncItem(ctx, item);
  if (!state) return { txns: [], note };
  const carried = await carriedIn;
  const carriedExclusions = await carriedExclusionsIn;
  const cutoff = daysAgoIso(LOOKBACK_DAYS);
  const superseded = supersededPendingIds(state.txns);
  // `name` is merchant_name || raw name, which recurring detection and search
  // depend on; StoredTxn keeps both parts.
  const txns: Txn[] = Object.values(state.txns)
    .filter(
      (t) =>
        t.date >= cutoff &&
        !superseded.has(t.transaction_id) &&
        !hiddenAccountIds?.has(t.account_id)
    )
    .map((t) => ({
      transaction_id: t.transaction_id,
      date: t.date,
      name: t.merchant_name || t.name,
      amount: t.amount,
      pending: t.pending,
      account_name: state.accounts[t.account_id]?.name || t.account_name || '',
      institution_name: t.institution_name,
      category: (carried?.size ? carried.get(contentKey(t.account_id, t)) : undefined) ?? t.category,
      iso_currency_code: t.iso_currency_code,
      unofficial_currency_code: t.unofficial_currency_code ?? null,
      vendor_key: vendorKey(t),
      logo_url: t.logo_url,
      category_icon_url: t.personal_finance_category_icon_url,
      subcategory: humanizeSubcategory(t.personal_finance_category),
      category_confidence: t.personal_finance_category?.confidence_level ?? null,
      transaction_code: t.transaction_code ?? null,
      payment_channel: t.payment_channel,
      datetime: t.datetime ?? t.authorized_datetime,
      website: t.website,
      check_number: t.check_number,
      account_owner: t.account_owner,
      city: t.location?.city ?? null,
      region: t.location?.region ?? null,
      counterparty: resolveCounterparty(t),
      payment_processor: resolveProcessor(t),
      payment_reference: t.payment_meta?.reference_number ?? null,
      ...(carriedExclusions?.size && !t.pending && carriedExclusions.has(contentKey(t.account_id, t)) ? { excluded: true } : {}),
    }));
  return { txns, note };
}

/**
 * Sync + return the detailed transactions (with `account_id`) for a trailing
 * window, defaulting to LOOKBACK days. Used by the estimated-history backfill,
 * which walks balances per account. Reads straight from the same persisted
 * store, so the two features share one Plaid pull.
 */
export async function readItemTransactions(ctx: Ctx, 
  item: StoredItem,
  sinceDays: number = LOOKBACK_DAYS
): Promise<{ txns: StoredTxn[]; note: string | null }> {
  const { state, note } = await syncItem(ctx, item);
  if (!state) return { txns: [], note };
  const cutoff = daysAgoIso(sinceDays);
  const superseded = supersededPendingIds(state.txns);
  return {
    txns: Object.values(state.txns).filter(
      (t) => t.date >= cutoff && !superseded.has(t.transaction_id)
    ),
    note,
  };
}
