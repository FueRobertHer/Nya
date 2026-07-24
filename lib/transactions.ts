// lib/transactions.ts
//
// Per-Item transaction store backed by Plaid's cursor-based /transactions/sync.
//
// Each Item's sync cursor and its transactions are persisted in Redis
// (encrypted, like every other financial payload — see lib/crypto.ts). Every
// call resumes from the stored cursor and applies only the deltas Plaid
// returns, so after the one-time initial pull we transfer next to nothing.
//
// This replaces /transactions/get offset pagination, which could silently
// *skip* rows when the underlying data shifted between page requests (a large
// recurring transaction like rent was a classic casualty). Sync pages are
// internally consistent, and the reconciliation is idempotent — added/modified
// upsert by transaction_id, removed deletes by id — so a replayed page (after
// a failed persist) or a mid-pagination restart can't corrupt the set.
//
// We retain history indefinitely rather than to a fixed age. /transactions/sync
// only reports `removed` when a bank deletes a transaction, never when one
// simply ages out of the bank's window, so once we've stored a row it stays —
// which is the point: it lets the store outlive short-history institutions
// (e.g. a card that only exposes 90 days to Plaid) and accumulate a long trend
// the bank alone can't give us. The only bound is a *size* guard: the blob is
// gzip-compressed at rest, and if one would still exceed Upstash's request-size
// ceiling we trim the oldest rows until it fits (see writeState). At personal
// volume the compressed blob stays far under that for many years, so in
// practice nothing is ever dropped. Trimming is safe because the deltas are
// idempotent: if Plaid later modifies a trimmed row we re-add it, and a removal
// of one is a no-op.

import { TransactionsUpdateStatus, type Transaction, type AccountBase } from 'plaid';
import { plaidClient } from './plaid';
import { encrypt, decrypt } from './crypto';
import { redis, k, type StoredItem } from './storage';

// Bump when the shape of a persisted row changes in a way that historical rows
// can't satisfy (a newly captured field). readState treats a stored blob whose
// version differs as unreadable and re-pulls the Item's full history from Plaid
// with the current mapping — so a field addition backfills automatically on the
// next sync, with no manual migration. See readState / toStored.
export const TXN_SCHEMA_VERSION = 2;

// Lean display shape sent to the client. Kept intentionally small: the wire
// payload shouldn't carry every captured field. `name` here is the *display*
// name (merchant_name || raw name); the full-fidelity data lives in StoredTxn.
export type Txn = {
  transaction_id: string;
  date: string; // YYYY-MM-DD
  name: string;
  amount: number; // Plaid convention: positive = money leaving the account
  pending: boolean;
  account_name: string;
  institution_name: string;
  category: string | null;
};

// Full-fidelity persisted form. We capture nearly everything Plaid returns per
// transaction rather than a display subset: adding a field later would cost a
// full re-sync (see TXN_SCHEMA_VERSION), and the blob is gzip-compressed at rest
// where this repetitive data compresses heavily, so the space cost is small.
// Read paths derive whatever narrower shape they need (e.g. the display Txn).
export type StoredTxn = {
  // Identity / linkage.
  transaction_id: string;
  pending_transaction_id: string | null; // pending row → its later posted row
  account_id: string;

  // Money.
  amount: number; // positive = money leaving the account
  iso_currency_code: string | null; // amounts are meaningless without this
  unofficial_currency_code: string | null;

  // Dates. `date` is the posting date; datetime fields are the true event time.
  date: string; // YYYY-MM-DD
  authorized_date: string | null;
  authorized_datetime: string | null;
  datetime: string | null;

  // Names & branding. Raw `name` and `merchant_name` are kept SEPARATELY (the
  // display name folds them, but grouping/search may want either), and
  // merchant_entity_id is the stable per-merchant key for vendor-level features.
  name: string; // raw bank descriptor (Plaid `name`)
  merchant_name: string | null; // Plaid-normalized merchant
  merchant_entity_id: string | null;
  website: string | null;
  logo_url: string | null;

  // Categorization: full PFC object (primary/detailed/confidence), not just
  // primary, plus the icon URL for display.
  personal_finance_category: Transaction['personal_finance_category'] | null;
  personal_finance_category_icon_url: string | null;

  // Classification.
  pending: boolean;
  payment_channel: string | null; // online | in store | other
  transaction_code: Transaction['transaction_code'] | null; // transfer | atm | purchase | payroll …
  transaction_type: string | null;
  check_number: string | null;
  account_owner: string | null;

  // Rich nested objects, stored as-is.
  location: Transaction['location'] | null; // address, city, region, lat/lon, store_number
  payment_meta: Transaction['payment_meta'] | null; // payee, payer, reference_number, processor …
  counterparties: NonNullable<Transaction['counterparties']>; // real merchant behind a processor

  // Derived / resolved, retained for existing consumers.
  category: string | null; // PFC primary, humanized (back-compat)
  account_name: string;
  institution_name: string;
};

// Per-account metadata, captured from each sync's `accounts[]` (we previously
// kept only the display name). Enables balance/net-worth and account-list views.
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
  schema_version: number; // mismatch → treat as unreadable and re-sync
  cursor: string; // '' = never synced → pull full history
  accounts: Record<string, StoredAccount>; // account_id → metadata, merged over time
  txns: Record<string, StoredTxn>; // keyed by transaction_id
};

// Trailing window callers display / reconstruct by default.
export const LOOKBACK_DAYS = 365;
// Max size of a stored (compressed + encrypted) blob. Upstash's free-plan
// *request-size* ceiling is 10 MB, and a get/set of an Item's blob is a single
// request, so that — not the 100 MB max-record size — is the real wall. We keep
// a margin below it; writeState trims oldest rows only if a blob would cross it.
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
// Runaway guard for a single call: 50 * 500 = 25k updates. The initial pull of
// a very large Item can exceed this; we persist progress and finish on the
// next call (see the partial-history note).
const MAX_PAGES = 50;
const MAX_MUTATION_RETRIES = 3;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function stateKey(item_id: string): string {
  return k(`txns:${item_id}`);
}

function emptyState(): ItemState {
  return { schema_version: TXN_SCHEMA_VERSION, cursor: '', accounts: {}, txns: {} };
}

// Blobs are gzip-compressed before encryption — financial JSON is highly
// repetitive (field names, categories, institution names repeat on every row),
// so it shrinks ~10×, which both saves Upstash storage/bandwidth and keeps each
// blob well under the request-size ceiling. We use the Web CompressionStream
// API rather than node:zlib to stay runtime-portable, matching lib/crypto.ts.
// Compression runs *before* encryption because ciphertext is high-entropy and
// wouldn't compress.

async function gzipString(input: string): Promise<Uint8Array> {
  const stream = new Response(input).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipToString(data: Uint8Array): Promise<string> {
  // Pass the backing ArrayBuffer (a valid BodyInit) rather than the typed array
  // itself, which trips the strict BodyInit generic.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const stream = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// encrypt/decrypt operate on UTF-8 strings, so the binary gzip output is
// base64-wrapped going in and unwrapped coming out (same technique as crypto.ts).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function encodeState(state: ItemState): Promise<string> {
  return encrypt(bytesToBase64(await gzipString(JSON.stringify(state))));
}

async function decodeState(blob: string): Promise<Partial<ItemState>> {
  const inner = await decrypt(blob);
  // Legacy blobs (written before compression) stored the JSON string directly.
  // base64-decoding real JSON throws (it starts with '{', not a base64 char),
  // so a failed unwrap means legacy: parse the decrypted string as-is.
  let json: string;
  try {
    json = await gunzipToString(base64ToBytes(inner));
  } catch {
    json = inner;
  }
  return JSON.parse(json) as Partial<ItemState>;
}

async function readState(item_id: string): Promise<ItemState> {
  try {
    const blob = await redis().get<string>(stateKey(item_id));
    if (!blob) return emptyState();
    const parsed = await decodeState(blob);
    // A blob written under an older schema lacks fields we capture now. Rather
    // than serve sparse rows, treat the version mismatch as unreadable: return
    // an empty state so the cursor-based sync re-pulls full history with the
    // current mapping. One-time per Item; the deltas are idempotent.
    if (parsed.schema_version !== TXN_SCHEMA_VERSION) return emptyState();
    return {
      schema_version: TXN_SCHEMA_VERSION,
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
      accounts: parsed.accounts ?? {},
      txns: parsed.txns ?? {},
    };
  } catch {
    // Rotated key / corrupted / unreadable value: start clean and re-sync.
    return emptyState();
  }
}

async function writeState(item_id: string, state: ItemState): Promise<void> {
  try {
    let encoded = await encodeState(state);
    // Keep the blob under the request-size ceiling. Over budget: drop the
    // oldest transactions — far older than anything the UI shows — until it
    // fits, re-encoding to re-check. The keep-count is scaled to the overage
    // (with margin) so this converges in one or two passes; at personal volume
    // the compressed blob never approaches the limit, so this loop never runs.
    while (encoded.length > MAX_BLOB_BYTES) {
      const ids = Object.keys(state.txns);
      if (ids.length === 0) break;
      ids.sort((a, b) => (state.txns[a].date < state.txns[b].date ? -1 : 1));
      const keep = Math.floor(ids.length * (MAX_BLOB_BYTES / encoded.length) * 0.9);
      for (const id of ids.slice(0, ids.length - keep)) delete state.txns[id];
      encoded = await encodeState(state);
    }
    await redis().set(stateKey(item_id), encoded);
  } catch (err) {
    // Persist failures are non-fatal for the current request (the in-memory
    // state is still returned), and the deltas are idempotent so the next call
    // resumes safely. But a *persistent* failure silently degrades into
    // re-pulling the item's full history from Plaid on every sync, so log it
    // rather than swallow it.
    console.warn(
      `transactions: failed to persist sync state for ${item_id} (${Object.keys(state.txns).length} txns); will re-sync next call`,
      err
    );
  }
}

/** Delete an Item's stored transactions. Call when the Item is disconnected. */
export async function clearItemTransactions(item_id: string): Promise<void> {
  try {
    await redis().del(stateKey(item_id));
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
async function syncItem(
  item: StoredItem
): Promise<{ state: ItemState | null; note: string | null }> {
  let access_token: string;
  try {
    access_token = await decrypt(item.encrypted_access_token);
  } catch {
    return { state: null, note: `${item.institution_name}: could not decrypt stored credentials` };
  }

  const stored = await readState(item.item_id);

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
      console.error(err?.response?.data || err);
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

    // Advance the cursor and persist. writeState compresses the blob and, only
    // if it would exceed the request-size ceiling, trims oldest rows to fit.
    if (cursor) state.cursor = cursor;
    await writeState(item.item_id, state);

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

  // Unreachable: every attempt either returns or (on the non-final mutation
  // race) `continue`s, and the final attempt's catch returns. Here only to
  // satisfy the compiler's exhaustiveness check.
  return { state: null, note: `${item.institution_name}: could not fetch transactions` };
}

/**
 * Sync + return the display-shaped transactions for the Activity tab, sliced to
 * the trailing LOOKBACK window. Account names are re-resolved from the merged
 * map (an account can arrive on a later page than a transaction referencing it).
 */
export async function syncItemTransactions(
  item: StoredItem
): Promise<{ txns: Txn[]; note: string | null }> {
  const { state, note } = await syncItem(item);
  if (!state) return { txns: [], note };
  const cutoff = daysAgoIso(LOOKBACK_DAYS);
  // Project the lean display shape. `name` is the display name (merchant_name
  // preferred, raw descriptor as fallback) — matching the prior behavior that
  // recurring detection and search depend on — while StoredTxn keeps both raw
  // parts. Account name is re-resolved from the merged accounts map.
  const txns: Txn[] = Object.values(state.txns)
    .filter((t) => t.date >= cutoff)
    .map((t) => ({
      transaction_id: t.transaction_id,
      date: t.date,
      name: t.merchant_name || t.name,
      amount: t.amount,
      pending: t.pending,
      account_name: state.accounts[t.account_id]?.name || t.account_name || '',
      institution_name: t.institution_name,
      category: t.category,
    }));
  return { txns, note };
}

/**
 * Sync + return the detailed transactions (with `account_id`) for a trailing
 * window, defaulting to LOOKBACK days. Used by the estimated-history backfill,
 * which walks balances per account. Reads straight from the same persisted
 * store, so the two features share one Plaid pull.
 */
export async function readItemTransactions(
  item: StoredItem,
  sinceDays: number = LOOKBACK_DAYS
): Promise<{ txns: StoredTxn[]; note: string | null }> {
  const { state, note } = await syncItem(item);
  if (!state) return { txns: [], note };
  const cutoff = daysAgoIso(sinceDays);
  return { txns: Object.values(state.txns).filter((t) => t.date >= cutoff), note };
}
