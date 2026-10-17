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
// (lib/transactions.ts): from the rows as they were, so a row the very same
// sync modifies is kept as it stood, and no reader ever sees it unpaired. No
// read writes it, and nothing else does: undoing an import or forgetting an
// account leaves its rows' pairs to the connection's next sync, which drops
// them, and they pair nothing meanwhile (settle reads only the pairs of rows
// still held).
//
// WHAT IS KEPT. Each imported row a posted bank row stood for, as a
// duplicate's twin (lib/history-import/store.ts same_as) or as the row
// superseding it, by the bank row's id, as settle worked it out on the rows
// as they were, the pairs already kept first. Dropped: a pair whose bank row
// the sync leaves out (the bank removed it), which puts the imported row back
// as it was; and one whose imported row no book of the connection's accounts
// holds any more, once every one of those books was read. Nothing makes a
// pair the rule didn't: when what decides the rule's pairs can't be read
// (the links, a connection's accounts, an account's end, an import's summary,
// whose period is the rule's edge), nothing is kept, and the pairs stay as
// they were.
//
// BEST EFFORT, NEVER FAILING THE SYNC. A read or a write that fails leaves
// the pairs as they were, said in the log: a row the bank modifies in that
// sync is then matched by what it says now, as before anything was kept.

import type { Ctx } from '../containers';
import type { StoredItem } from '../storage';
import type { StoredTxn } from '../transactions';
import { effectiveLinks, getLinks } from '../link-core';
import { liveAccountIds } from '../links';
import { loggable } from '../log-safe';
import { countedRows, readImported } from './read';
import { importedTwinsStore, importedTxnStore, type ImportedTwins } from './store';

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

/** Whether two entries keep the same pairs. */
const samePairs = (a: ImportedTwins | null, b: ImportedTwins | null): boolean => {
  const x = Object.entries(a?.twins ?? {});
  const y = b?.twins ?? {};
  return x.length === Object.keys(y).length && x.every(([row, bank]) => y[row] === bank);
};

/**
 * Keeps which of the connection's bank rows stood for which imported rows,
 * as its rows were before this sync (`before`), for the rows it is about to
 * save (`after`): see the header. Never throws.
 */
export async function keepImportedTwins(ctx: Ctx, item: StoredItem, before: Record<string, StoredTxn>, after: Record<string, StoredTxn>): Promise<void> {
  try {
    // Nothing imported into any account, and nothing kept for this
    // connection: nothing to keep or drop, found by two small reads.
    const [books, kept] = await Promise.all([importedTxnStore.count(ctx), importedTwinsStore.has(ctx, item.item_id)]);
    if (books === 0 && !kept) return;
    const [links, live] = await Promise.all([getLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
    const read = await readImported(ctx, { items: [item], links: effectiveLinks(links, live), bankStates: new Map([[item.item_id, before]]) });
    // What decides the rule's pairs can't be read: nothing is kept, and the
    // pairs stay as they were.
    if (read.unresolved || read.summariesUnreadable.length > 0) return;
    const observed = new Map<string, string>();
    for (const a of read.accounts) {
      const settled = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, twins: a.twins });
      for (const [row, bank] of settled.superseded) observed.set(row, bank.transaction_id);
      for (const [row, st] of settled.standing) if ('bank' in st) observed.set(row, st.bank.transaction_id);
    }
    const held = read.flawed.size === 0 ? new Set(read.accounts.flatMap((a) => a.held.map((r) => r.id))) : null;
    const current = await importedTwinsStore.get(ctx, item.item_id);
    if (samePairs(nextTwins(current, observed, after, held), current)) return;
    await importedTwinsStore.update(ctx, item.item_id, (now) => nextTwins(now, observed, after, held));
  } catch (err) {
    console.warn('history import: which of a connection’s transactions stand for imported ones could not be kept', loggable(err));
  }
}
