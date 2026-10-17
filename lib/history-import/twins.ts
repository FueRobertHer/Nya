// lib/history-import/twins.ts
//
// Keeping the pairs the matching rule made between a connection's bank rows
// and the rows imported into its accounts from the bank's files (#52;
// lib/history-import/match.ts KEPT ONCE MADE), so that the bank changing one
// of its rows later (Plaid keeps a transaction's id when it modifies it)
// never lets the imported row count beside it. Kept in the imported-twins
// store (lib/history-import/store.ts), one entry per connection.
//
// WRITTEN BY THE SYNC, before it saves the connection's rows
// (lib/transactions.ts), when it changes a row a pair may rest on: a posted
// row it removes, or whose account, day, amount, currency, words or pending
// state it changes, which is everything matching reads of a row
// (changedRows). Until then a pair the rule made holds by the rule itself,
// its bank row saying what it said, and only the sync changes the bank's
// rows: so the sync that changes one works settle out on the rows as they
// were, with the pairs already kept, and keeps every pair it finds at the
// connection's accounts, before it saves the change. A row it modifies is
// kept as it stood, and no reader ever sees it unpaired. A sync that only
// adds rows, or changes what matching doesn't read (a category, a logo),
// reads nothing for it; one that does reads only the books of the
// connection's accounts, under every id they have had, the summaries of the
// imports their rows came from, and the connection's own pairs. No read
// writes it, and nothing else does but a disconnect (below).
//
// WHAT IS KEPT. Each imported row a posted bank row stood for, as a
// duplicate's twin (lib/history-import/store.ts same_as) or as the row
// superseding it, by the bank row's id, as settle worked it out on the rows
// as they were, the pairs already kept first. Dropped: a pair whose bank row
// the sync leaves out (the bank removed it), which puts the imported row back
// as it was; and one whose imported row no book of the connection's accounts
// holds any more (an undo, a forget), once a sync that keeps pairs read every
// one of those books: meanwhile it pairs nothing (settle reads only the pairs
// of rows still held). Nothing makes a pair the rule didn't: when what
// decides the rule's pairs at the connection's accounts can't be read (the
// links, the connection's accounts, an end of one of them, a summary of one
// of their imports, whose period is the rule's edge), none is kept, and the
// pairs stay as they were, but for those whose bank row is gone.
//
// CARRIED ACROSS A RE-LINK. A re-link gives every transaction a new id, so a
// pair kept by its bank row's id would go with the connection, and the
// re-added connection's row, at the amount the bank changed it to, would
// count beside the imported one. So a disconnect (lib/disconnect-item.ts)
// records each pair kept at the connection by the content its bank row has
// (lib/transactions.ts contentKey: the account, the day, the amount, the
// bank's own words), under that row's account, in the carried-imported-twins
// store, as the person's categories and what they said about transactions
// carry (lib/overrides.ts, lib/txn-annotations.ts), and its entry here goes.
// Once the person links the earlier account to the re-added one
// (lib/links.ts), each sync of the re-added connection pairs those imported
// rows with its posted rows that have exactly that content (as they were
// before the sync, or as it brings them), one to one, unless either is paired
// already, and each carried pair kept here goes. One whose bank row hasn't
// come yet waits for it (a new connection's history arrives over its first
// syncs); one whose bank row the bank changed again before it was added back
// can't be told any more, and both count, as before pairs were kept. Every
// sync looks for them in one small read: almost always there is none.
//
// BEST EFFORT, NEVER FAILING THE SYNC. A read or a write that fails leaves
// the pairs as they were, said in the log: a row the bank modifies in that
// sync is then matched by what it says now, as before anything was kept.

import type { Ctx } from '../containers';
import type { StoredItem } from '../storage';
import { contentKey, type StoredTxn } from '../transactions';
import { effectiveLinks, getLinks, resolveId, sameAccountIds, type Link } from '../link-core';
import { liveAccountIds } from '../links';
import { loggable } from '../log-safe';
import { countedRows, readImported } from './read';
import { carriedTwinsStore, importedTwinsStore, importedTxnStore, type CarriedTwins, type ImportedTwins } from './store';

/** Whether a row still says everything matching reads of it
 *  (lib/history-import/read.ts bankRowsOf). */
const readsAlike = (a: StoredTxn, b: StoredTxn): boolean =>
  a.account_id === b.account_id &&
  a.date === b.date &&
  a.amount === b.amount &&
  a.name === b.name &&
  a.merchant_name === b.merchant_name &&
  a.pending === b.pending &&
  (a.iso_currency_code ?? a.unofficial_currency_code ?? null) === (b.iso_currency_code ?? b.unofficial_currency_code ?? null);

/**
 * The posted rows of `before` that a sync leaving `after` removes, or changes
 * in what matching reads of them: the rows a pair may rest on that it
 * changes. Pure.
 */
export function changedRows(before: Readonly<Record<string, StoredTxn>>, after: Readonly<Record<string, StoredTxn>>): StoredTxn[] {
  const out: StoredTxn[] = [];
  for (const [id, was] of Object.entries(before)) {
    if (was.pending) continue;
    const now = Object.prototype.hasOwnProperty.call(after, id) ? after[id] : undefined;
    if (!now || !readsAlike(now, was)) out.push(was);
  }
  return out;
}

/**
 * A connection's pairs as they should be kept now: those kept before, less
 * any whose bank row `after` doesn't hold and, with `held` (every row the
 * connection's accounts' books hold, all of them read), any whose imported
 * row isn't among them; then the pairs `observed`, whose bank row `after`
 * holds, over any other kept pair of the same bank row. Pure.
 */
export function nextTwins(
  current: ImportedTwins | null,
  observed: ReadonlyMap<string, string>,
  after: Readonly<Record<string, unknown>>,
  held: ReadonlySet<string> | null
): ImportedTwins | null {
  const there = (bank: string) => Object.prototype.hasOwnProperty.call(after, bank);
  const twins: Record<string, string> = {};
  const byBank = new Map<string, string>();
  for (const [row, bank] of Object.entries(current?.twins ?? {})) {
    if (!there(bank) || (held && !held.has(row))) continue;
    twins[row] = bank;
    byBank.set(bank, row);
  }
  for (const [row, bank] of observed) {
    if (!there(bank)) continue;
    const other = byBank.get(bank);
    if (other !== undefined && other !== row) delete twins[other];
    twins[row] = bank;
    byBank.set(bank, row);
  }
  return Object.keys(twins).length > 0 ? { version: 1, twins } : null;
}

/**
 * The pairs carried across a re-link (CARRIED ACROSS A RE-LINK) that one
 * connection's rows make again, under the links that apply: each carried
 * imported row's to the posted row here with exactly the content its earlier
 * bank row had (the row as `before` has it, else as `after` brings it), one
 * to one, in id order among rows alike. Only the pairs of an earlier account
 * linked to an account here carry; `from` names, by that earlier account,
 * every pair carried from it, so the caller can let go of those it keeps.
 * Pure.
 */
export function carriedPairs(
  carried: ReadonlyMap<string, CarriedTwins>,
  links: ReadonlyMap<string, Link>,
  before: Readonly<Record<string, StoredTxn>>,
  after: Readonly<Record<string, StoredTxn>>
): { pins: Map<string, string>; from: Map<string, string[]> } {
  const pins = new Map<string, string>();
  const from = new Map<string, string[]>();
  if (carried.size === 0) return { pins, from };
  // The rows here by content, under the id each one's account is known by now.
  const byKey = new Map<string, string[]>();
  const accounts = new Set<string>();
  for (const id of Object.keys(after).sort()) {
    if (after[id].pending) continue;
    const was = Object.prototype.hasOwnProperty.call(before, id) ? before[id] : undefined;
    const t = was && !was.pending ? was : after[id];
    const account = resolveId(t.account_id, links);
    accounts.add(account);
    const k = contentKey(account, t);
    const list = byKey.get(k);
    if (list) list.push(id);
    else byKey.set(k, [id]);
  }
  const taken = new Set<string>();
  for (const [earlier, entry] of carried) {
    // Nothing carries until the person has said it is the same account.
    const current = resolveId(earlier, links);
    if (current === earlier || !accounts.has(current)) continue;
    from.set(earlier, Object.keys(entry.twins));
    for (const [row, key] of Object.entries(entry.twins)) {
      if (pins.has(row) || !key.startsWith(`${earlier}|`)) continue;
      const bank = byKey.get(current + key.slice(earlier.length))?.find((id) => !taken.has(id));
      if (bank === undefined) continue;
      taken.add(bank);
      pins.set(row, bank);
    }
  }
  return { pins, from };
}

/** Pairs carried across a re-link added to a connection's: each where
 *  neither its imported row nor its bank row is paired already. Pure. */
export function withCarried(twins: ImportedTwins | null, pins: ReadonlyMap<string, string>): ImportedTwins | null {
  if (pins.size === 0) return twins;
  const out: Record<string, string> = { ...(twins?.twins ?? {}) };
  const banks = new Set(Object.values(out));
  for (const [row, bank] of pins) {
    if (Object.prototype.hasOwnProperty.call(out, row) || banks.has(bank)) continue;
    out[row] = bank;
    banks.add(bank);
  }
  return Object.keys(out).length > 0 ? { version: 1, twins: out } : null;
}

/** Whether two entries keep the same pairs. */
const samePairs = (a: ImportedTwins | null, b: ImportedTwins | null): boolean => {
  const x = Object.entries(a?.twins ?? {});
  const y = b?.twins ?? {};
  return x.length === Object.keys(y).length && x.every(([row, bank]) => y[row] === bank);
};

/**
 * The pairs settle works out at a connection's accounts on its rows as they
 * were (`before`), the pairs already kept first, and every imported row those
 * accounts' books hold, when every one of them was read (else null). Null
 * when what decides the pairs can't be read. Reads only those books, under
 * every id their accounts have had, and what goes with them.
 */
async function observedPairs(
  ctx: Ctx,
  item: StoredItem,
  before: Record<string, StoredTxn>,
  links: Map<string, Link>
): Promise<{ observed: Map<string, string>; held: Set<string> | null } | null> {
  const accounts = new Set<string>();
  for (const t of Object.values(before)) if (!t.pending) accounts.add(resolveId(t.account_id, links));
  const bookIds = [...accounts].flatMap((id) => sameAccountIds(id, links));
  const read = await readImported(ctx, { items: [item], links, bankStates: new Map([[item.item_id, before]]), bookIds });
  if (read.unresolved || read.summariesUnreadable.length > 0) return null;
  const observed = new Map<string, string>();
  for (const a of read.accounts) {
    const settled = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, twins: a.twins });
    for (const [row, bank] of settled.superseded) observed.set(row, bank.transaction_id);
    for (const [row, st] of settled.standing) if ('bank' in st) observed.set(row, st.bank.transaction_id);
  }
  return { observed, held: read.flawed.size === 0 ? new Set(read.accounts.flatMap((a) => a.held.map((r) => r.id))) : null };
}

/**
 * Keeps which of the connection's bank rows stood for which imported rows,
 * as its rows were before this sync (`before`), for the rows it is about to
 * save (`after`), and makes again the pairs carried to it across a re-link:
 * see the header. Never throws.
 */
export async function keepImportedTwins(ctx: Ctx, item: StoredItem, before: Record<string, StoredTxn>, after: Record<string, StoredTxn>): Promise<void> {
  try {
    const changing = changedRows(before, after).length > 0;
    const [carried, books, kept] = await Promise.all([
      carriedTwinsStore.getAllReport(ctx),
      changing ? importedTxnStore.count(ctx) : Promise.resolve(0),
      changing ? importedTwinsStore.has(ctx, item.item_id) : Promise.resolve(false),
    ]);
    // Pairs to keep only where something was imported, or is kept here; and
    // carried pairs only from an earlier account linked to another.
    const observing = changing && (books > 0 || kept);
    if (!observing && carried.entries.size === 0) return;
    const links = await getLinks(ctx);
    if (!observing && ![...carried.entries.keys()].some((id) => links.has(id))) return;
    const active = effectiveLinks(links, await liveAccountIds(ctx, { strict: true, readOnly: true }));
    const carry = carriedPairs(carried.entries, active, before, after);
    if (!observing && carry.pins.size === 0) return;
    const seen = observing ? await observedPairs(ctx, item, before, active) : null;
    const next = (now: ImportedTwins | null) => withCarried(nextTwins(now, seen?.observed ?? new Map(), after, seen?.held ?? null), carry.pins);
    const current = await importedTwinsStore.get(ctx, item.item_id);
    const written = samePairs(next(current), current) ? current : await importedTwinsStore.update(ctx, item.item_id, next);
    // A carried pair kept here now, made again or paired already, goes.
    for (const [earlier, rows] of carry.from) {
      const made = new Set(rows.filter((row) => written?.twins[row] !== undefined));
      if (made.size === 0) continue;
      await carriedTwinsStore.update(ctx, earlier, (now) => {
        const left = Object.entries(now?.twins ?? {}).filter(([row]) => !made.has(row));
        return left.length > 0 ? { version: 1, twins: Object.fromEntries(left) } : null;
      });
    }
  } catch (err) {
    console.warn('history import: which of a connection’s transactions stand for imported ones could not be kept', loggable(err));
  }
}

/**
 * At a disconnect (lib/disconnect-item.ts), before the connection's rows are
 * deleted: records each pair kept at it by the content its bank row has,
 * under that row's account (CARRIED ACROSS A RE-LINK), merged into what was
 * carried for that account before, a row carried again taking its new
 * content. Posted rows only, as pairs are. Throws if something can't be read
 * or written; the caller must not let that stop the disconnect. Returns how
 * many it carried.
 */
export async function retireImportedTwins(ctx: Ctx, item_id: string, stored: readonly StoredTxn[]): Promise<number> {
  const kept = await importedTwinsStore.get(ctx, item_id);
  if (!kept) return 0;
  const byId = new Map(stored.map((t) => [t.transaction_id, t]));
  const byAccount = new Map<string, Record<string, string>>();
  for (const [row, bank] of Object.entries(kept.twins)) {
    const t = byId.get(bank);
    if (!t || t.pending) continue;
    const rows = byAccount.get(t.account_id) ?? {};
    rows[row] = contentKey(t.account_id, t);
    byAccount.set(t.account_id, rows);
  }
  let n = 0;
  for (const [account_id, rows] of byAccount) {
    await carriedTwinsStore.update(ctx, account_id, (current) => ({ version: 1, twins: { ...(current?.twins ?? {}), ...rows } }));
    n += Object.keys(rows).length;
  }
  return n;
}

/** A disconnected connection's kept pairs gone, readable or not: what they
 *  carry is recorded first (retireImportedTwins), and no sync of it runs
 *  again. */
export async function forgetImportedTwins(ctx: Ctx, item_id: string): Promise<void> {
  await importedTwinsStore.remove(ctx, item_id);
}
