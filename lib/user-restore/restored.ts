// lib/user-restore/restored.ts
//
// What the readers need to know of what a restore brought back
// (docs/data-export.md, "Bringing it back"; lib/user-restore/store.ts): which
// restored accounts' rows count, how a restored row is read beside the rows
// imported from files, whether net worth totals are held, and whether a
// restore is still being written. The read side, live whether or not
// restores are turned on (RESTORE_ENABLED, docs/operations.md), so a release
// that can be rolled back to already knows every store a restore writes.
//
// HELD UNTIL LINKED (the first step). A bank connected through Plaid can't
// come back connected: its accounts come back as earlier accounts, and their
// bank rows in restored-transactions. Those rows are held, counted nowhere,
// as an earlier account's imported rows are (lib/history-import/read.ts
// WHOSE ROWS), until the person links the account to its new one after
// connecting the bank again (lib/links.ts). From then on they are rows of
// the linked account, read with the rows imported into it from files: as an
// earlier import's, ranked before every file's, the newest restore's first.
// A restored account is read only while its directory entry exists, so
// forgetting it on any release ends it.
//
// PAIRED ON READ, NEVER REWRITTEN. In the old copy, a bank row could stand
// for a row imported from a file (a duplicate the person named, a row the
// bank's window superseded, a pair the sync kept). The restore writes every
// record as the file had it, so that pairing is worked out again on every
// read, in two stages (restoredHeld): first the file rows whose review never
// read the restored rows against them, taken as the account's bank rows then
// (where they began, the old connection's kept pairs read through
// restoredId), which reproduces the old copy's pairing from the same inputs;
// each file row a restored row stood for is then read as a duplicate of it
// (same_as_row, in memory only). Then, as for any account, the restored
// rows and the file rows still counted against the new connection's rows
// (lib/history-import/match.ts settle), the restored rows claiming the new
// bank rows by the bank's own key first (same_as, bankKey, as kept), then by
// the amount rule, never across the restore's own period (`covers`: the
// first restored day to the download's), so a bank row dated after the
// download never takes a restored row's place. What a file row's twin
// stands for, it stands for too (standsFor), so what was said about a row
// carries as it did.
//
// WHICH FILE ROWS THE FIRST STAGE PAIRS (pairable). Those whose review never
// read a restored account's rows: the old copy's imports (made before the
// restore), and an import made here into an account before the restored one
// joined it (by the time of the link that did, and of every link on the way:
// a file imported into the new account, then the restored one linked to it,
// would otherwise count beside the restored rows for good). Never an import
// whose review was matched against them, as it says itself
// (`matched_restored`, lib/history-import/store.ts): what the person
// answered there (a row of its own beside a restored one) stands, however
// often the accounts are unlinked and linked again. Its summary repeats it,
// and every writer of a summary keeps it (summaryOfEntry, and the undo's
// spread of what is stored, the release before's too). An import made before
// that was kept, during a link that has changed since (undone and made
// again, or made to another account), is judged by its time alone, so a row
// the person said was new beside a restored one could be paired with it.
//
// THE TOTALS HOLD (totalsHold). While a restore is still being written or
// undone, or a restored account is neither linked nor ended (Stop following),
// hidden ones too, since stored totals include hidden accounts, no net worth
// total is recorded (lib/networth.ts recordFetch): a total without that bank
// would be recorded as the person's net worth that day, short for good. It
// fails closed: a read it needs that fails holds the total, and says so.

import type { Ctx } from '../containers';
import type { StoredTxn } from '../transactions';
import type { ImportedTxn } from '../history-import/store';
import { bankKey, settle, type BankRow } from '../history-import/match';
import { effectiveLinks, getLinks, resolveId, type Link } from '../link-core';
import { endOf, lifecycleStore } from '../lifecycle';
import { directoryIds } from '../links';
import { restoredAccountsStore, restoredId, userRestoreStore, type RestoredAccount, type RestoredTxn, type UserRestoreRecord } from './store';

/** A row as the read layer holds it: imported from a file, or, with
 *  `restored`, a bank row brought back from a download, read as an earlier
 *  import's row whose import is the restore. */
export type HeldTxn = ImportedTxn & { restored?: StoredTxn };

/** The source a restored row is held under, for matching: dated by its
 *  posting, as the bank dates its rows (lib/history-import/match.ts
 *  POSTED_DATED). Shown as the bank's own (lib/history-import/read.ts
 *  toDisplay). */
export const RESTORED_SOURCE = 'restored';

/** A restored row as the read layer holds it (HeldTxn): the bank's day,
 *  amount, currency and own words, its import the restore, and the bank's
 *  key as a claim on the bank row with the same key (see the header). */
export function heldOf(r: RestoredTxn): HeldTxn {
  const b = r.bank;
  return {
    id: r.id,
    account_id: r.account_id,
    date: b.date,
    amount: b.amount,
    currency: b.iso_currency_code ?? b.unofficial_currency_code ?? 'USD',
    name: b.name,
    category: b.category,
    note: null,
    source: RESTORED_SOURCE,
    source_id: b.transaction_id,
    ...(b.transaction_code ? { transaction_code: b.transaction_code } : {}),
    import_id: r.import_id,
    same_as: bankKey(b),
    created_at: r.created_at,
    restored: b,
  };
}

/** The restores whose rows are read, newest first: they rank before every
 *  file's import (see the header). */
export function restoreOrder(accounts: Iterable<RestoredAccount>): string[] {
  const at = new Map<string, string>();
  for (const a of accounts) if (!at.has(a.restore_id) || at.get(a.restore_id)! < a.restored_at) at.set(a.restore_id, a.restored_at);
  return [...at].sort(([a, x], [b, y]) => (x > y ? -1 : x < y ? 1 : a < b ? -1 : a > b ? 1 : 0)).map(([id]) => id);
}

/** The period each restore's rows cover: from its first restored day to the
 *  day its download was made (see the header). */
export function restoreCovers(accounts: Iterable<RestoredAccount>): Map<string, { from: string; to: string }> {
  const out = new Map<string, { from: string; to: string }>();
  for (const a of accounts) {
    const was = out.get(a.restore_id);
    const from = a.rows?.first ?? a.downloaded;
    out.set(a.restore_id, {
      from: was && was.from < from ? was.from : from,
      to: was && was.to > a.downloaded ? was.to : a.downloaded,
    });
  }
  return out;
}

/** The ids of a restored account's books (lib/user-restore/store.ts
 *  restoredBookId). */
export function bookIdsOf(account_id: string, a: RestoredAccount): string[] {
  const n = a.rows?.books ?? 0;
  return Array.from({ length: n }, (_, i) => `${account_id}.${i + 1}`);
}

/** Whether a restored account is linked to a live account: its rows are read
 *  as that account's (HELD UNTIL LINKED). An account live under its own id
 *  (which a new connection never gives) is not linked. */
export function linkedTo(id: string, links: ReadonlyMap<string, Pick<Link, 'to'>>, live: { has(id: string): boolean }): string | null {
  const current = resolveId(id, links);
  return current !== id && live.has(current) ? current : null;
}

/** What the first stage reads (see PAIRED ON READ) for one live account:
 *  its restored rows, and of the old copy's, the kept pairs (by the file
 *  row's id, the restored row's id), where its bank's rows began, and from
 *  when each id a file could be imported into had each restored account's
 *  rows (joinedAt). */
export type RestoredForAccount = {
  rows: HeldTxn[];
  twins: Map<string, string>;
  bankFrom: string | null;
  /** For each restored account whose rows these are, joinedAt. */
  joined: Map<string, Map<string, string>>;
};

/** When each id on a restored account's way to the account it is now
 *  (through the links that apply) had that restored account's rows: the
 *  restored account itself from the restore, and each id it was linked on to
 *  from the later of that and every link up to it. An import into one of
 *  those ids made since read those rows in its review (readAccountContext
 *  reads the restored accounts linked to the account it imports into). A link
 *  the old copy made is older than the restore: the restore's time stands.
 *  Pure. */
export function joinedAt(id: string, restoredAt: string, links: ReadonlyMap<string, Pick<Link, 'to' | 'linked_at'>>): Map<string, string> {
  const out = new Map([[id, restoredAt]]);
  let at = restoredAt;
  let current = id;
  // As resolveId follows them: stops at a repeat, so a cycle ends.
  for (let i = 0; i < 50; i++) {
    const link = links.get(current);
    if (!link || out.has(link.to)) break;
    if (link.linked_at > at) at = link.linked_at;
    current = link.to;
    out.set(current, at);
  }
  return out;
}

/** What the first stage needs to know of each import: when it was made, by
 *  its summary, and which restored accounts its review was matched against
 *  (HistoryImportSummary `matched_restored`). */
export type ImportFacts = { importedAt: ReadonlyMap<string, string>; matched?: ReadonlyMap<string, ReadonlySet<string>> };

/**
 * Whether the first stage may pair a file row with a restored account's rows
 * (see WHICH FILE ROWS THE FIRST STAGE PAIRS): not when its import says its
 * review was matched against them; else only when it was made before the id
 * it was imported into (the row's `account_id`, its book) had them, or into
 * an id never on that restored account's way (whose review never had them).
 * An import whose time can't be read is never paired: what its review read
 * can't be told. Pure.
 */
export function pairable(
  row: Pick<ImportedTxn, 'import_id' | 'account_id'>,
  restoredAccount: string,
  joined: ReadonlyMap<string, ReadonlyMap<string, string>>,
  facts: ImportFacts
): boolean {
  if (facts.matched?.get(row.import_id)?.has(restoredAccount)) return false;
  const at = facts.importedAt.get(row.import_id);
  if (at === undefined) return false;
  const since = joined.get(restoredAccount)?.get(row.account_id);
  return since === undefined || at < since;
}

/** Each file row a restored row stood for, of the imports whose review never
 *  read it (pairable), read as a duplicate of that restored row
 *  (same_as_row), in memory (see the header): the first stage. Every other
 *  row as it is. Pure. */
export function pairedWithRestored(
  fileRows: readonly ImportedTxn[],
  restored: RestoredForAccount,
  order: readonly string[],
  opts: { covers: ReadonlyMap<string, { from: string; to: string }> } & ImportFacts
): ImportedTxn[] {
  if (restored.rows.length === 0 || fileRows.length === 0) return [...fileRows];
  const accounts = [...new Set(restored.rows.map((r) => r.account_id))];
  const pairableWith = (r: ImportedTxn, account: string) => pairable(r, account, restored.joined, opts);
  const old = fileRows.filter((r) => accounts.some((a) => pairableWith(r, a)));
  if (old.length === 0) return [...fileRows];
  const banks: BankRow[] = restored.rows.map((r) => ({
    transaction_id: r.id,
    account_id: r.account_id,
    date: r.date,
    amount: r.amount,
    currency: r.restored?.iso_currency_code ?? r.restored?.unofficial_currency_code ?? null,
    name: r.name,
    merchant_name: r.restored?.merchant_name ?? null,
    pending: false,
  }));
  // Each row only with the rows of a restored account its review never read.
  const first = settle(old, banks, order, { bankFrom: restored.bankFrom, covers: opts.covers, twins: restored.twins, allowed: (r, b) => pairableWith(r, b.account_id) });
  const twin = new Map<string, string>();
  for (const [id, b] of first.superseded) twin.set(id, b.transaction_id);
  for (const [id, st] of first.standing) if ('bank' in st) twin.set(id, st.bank.transaction_id);
  if (twin.size === 0) return [...fileRows];
  return fileRows.map((r) => {
    const r2 = twin.get(r.id);
    return r2 === undefined ? r : { ...r, same_as: null, same_as_row: r2 };
  });
}

/** An account's held rows with its restored ones (see the header): the
 *  restored rows, then the file rows, the old copy's paired with them. */
export function heldWithRestored(
  fileRows: readonly ImportedTxn[],
  restored: RestoredForAccount | null | undefined,
  order: readonly string[],
  opts: { covers: ReadonlyMap<string, { from: string; to: string }> } & ImportFacts
): HeldTxn[] {
  if (!restored || restored.rows.length === 0) return [...fileRows];
  return [...restored.rows, ...pairedWithRestored(fileRows, restored, order, opts)];
}

/** What pairs an account's file rows with the rows a restore brought back
 *  (heldWithRestored): read once with the account's context
 *  (lib/history-import/read.ts readAccountContext), applied to its books as
 *  they are each time they are read (the commit reads them again). */
export type RestoredContext = {
  account: RestoredForAccount;
  order: string[];
  covers: Map<string, { from: string; to: string }>;
  importedAt: Map<string, string>;
  matched: Map<string, Set<string>>;
};

/** An account's file rows, as read now, with the rows a restore brought back,
 *  as its review read them. */
export function withRestoredRows(fileRows: readonly ImportedTxn[], restored: RestoredContext | null | undefined): HeldTxn[] {
  return restored ? heldWithRestored(fileRows, restored.account, restored.order, { covers: restored.covers, importedAt: restored.importedAt, matched: restored.matched }) : [...fileRows];
}

/** The old copy's pairs at one of its connections, read through restoredId:
 *  each file row's id to the restored row's id, where that row is here. */
export function oldTwins(entry: { twins: Record<string, string> } | null | undefined, here: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [row, bank] of Object.entries(entry?.twins ?? {})) {
    let id: string;
    try {
      id = restoredId(bank);
    } catch {
      continue;
    }
    if (here.has(id)) out.set(row, id);
  }
  return out;
}

// ---- Holds ----

/** Whether a restore is being written or undone here: what every reader that
 *  sends figures out of the person's own app refuses while it is (the
 *  read-only API, the MCP server, shares, the weekly summary). Strict, and
 *  closed: a record that can't be read counts as unfinished, since whether
 *  one is can't be told. Storage failing throws. */
export async function restoreUnfinished(ctx: Ctx): Promise<boolean> {
  const report = await userRestoreStore.getReport(ctx);
  if (report.unreadable || report.unrecognised) return true;
  return unfinished(report.value);
}

export const unfinished = (record: UserRestoreRecord | null): boolean => record !== null && (record.status === 'writing' || record.status === 'undoing');

/** Why no net worth total is recorded now, if one isn't (see the header):
 *  a restore still being written or undone; the banks of restored accounts
 *  neither linked nor ended, by name, each with its last restored day; or
 *  something it needs that can't be read. */
export type TotalsHold = {
  unfinished: boolean;
  waiting: { institution_name: string; last: string | null }[];
  unreadable: boolean;
  /** The last day of the balance history a restore brought back, or null:
   *  the backfill never estimates over it (app/api/backfill). */
  history_last: string | null;
};

export const holdsTotals = (h: TotalsHold): boolean => h.unfinished || h.unreadable || h.waiting.length > 0;

/** A restored account still waiting for an answer: one that counts (not
 *  ended: Stop following) and isn't linked to a new one. `last` is its last
 *  restored day. */
export type WaitingAccount = { account_id: string; institution_name: string; name: string | null; mask: string | null; last: string | null };

/**
 * The restored accounts still waiting (see WaitingAccount), by bank and
 * name, and what it needs that couldn't be read: entries whose bytes are
 * damaged (`entries`, their ids), entries this version doesn't know
 * (`unrecognised`: a newer version wrote them, or a fault, sealed under
 * another account's key, say; never offered for removal, lib/repo.ts), or
 * the end of an account that would otherwise wait (`ends`). Either kind of
 * entry holds the totals.
 * Linked is answered, whatever the account it is linked to became since (a
 * bank disconnected after the link): reading its rows asks for a live
 * account (linkedTo), the answer doesn't. Only accounts the directory still
 * lists wait, as only they are read for their rows (readImported): one
 * forgotten has nothing left to answer by. Reads the links, the live
 * accounts, the directory and the ends only when a restore brought accounts
 * back. Storage failing throws.
 */
export async function waitingAccounts(
  ctx: Ctx,
  liveIds: () => Promise<Set<string>>
): Promise<{ accounts: WaitingAccount[]; unreadable: boolean; unread: { entries: string[]; unrecognised: string[]; ends: boolean } }> {
  const report = await restoredAccountsStore.getAllReport(ctx);
  const unread = { entries: [...report.unreadable].sort(), unrecognised: [...report.unrecognised].sort(), ends: false };
  const entriesUnread = unread.entries.length > 0 || unread.unrecognised.length > 0;
  if (report.entries.size === 0) return { accounts: [], unreadable: entriesUnread, unread };
  const [links, live, ends, listed] = await Promise.all([getLinks(ctx), liveIds(), lifecycleStore.getAllReport(ctx), directoryIds(ctx)]);
  const applied = effectiveLinks(links, live);
  const unreadEnds = new Set([...ends.unreadable, ...ends.unrecognised]);
  const accounts: WaitingAccount[] = [];
  for (const [id, a] of report.entries) {
    if (!listed.has(id)) continue;
    if (resolveId(id, applied) !== id) continue;
    const end = ends.entries.get(id);
    if (end && endOf(end.lifecycle) !== null) continue;
    if (unreadEnds.has(id)) unread.ends = true;
    accounts.push({ account_id: id, institution_name: a.institution_name, name: a.name, mask: a.mask, last: a.rows?.last ?? null });
  }
  accounts.sort((x, y) => x.institution_name.localeCompare(y.institution_name) || (x.name ?? '').localeCompare(y.name ?? '') || x.account_id.localeCompare(y.account_id));
  return { accounts, unreadable: entriesUnread || unread.ends, unread };
}

/**
 * The totals hold (see the header). Reads the restore's record and the
 * restored accounts, and only with restored accounts, the links, the live
 * accounts and the account ends. Never throws for what it reads: a read that
 * fails holds the total (`unreadable`), as storage failing does, since a
 * total recorded without a waiting bank can't be taken back.
 */
export async function totalsHold(ctx: Ctx, liveIds: () => Promise<Set<string>>): Promise<TotalsHold> {
  const none: TotalsHold = { unfinished: false, waiting: [], unreadable: false, history_last: null };
  try {
    const [record, waiting] = await Promise.all([userRestoreStore.getReport(ctx), waitingAccounts(ctx, liveIds)]);
    const byBank = new Map<string, string | null>();
    const later = (a: string | null | undefined, b: string | null) => (a === undefined || a === null ? b : b === null || a > b ? a : b);
    for (const a of waiting.accounts) byBank.set(a.institution_name, later(byBank.get(a.institution_name), a.last));
    return {
      unfinished: record.unreadable || record.unrecognised || unfinished(record.value),
      waiting: [...byBank].sort(([a], [b]) => a.localeCompare(b)).map(([institution_name, last]) => ({ institution_name, last })),
      unreadable: waiting.unreadable,
      history_last: record.value?.history?.last ?? null,
    };
  } catch {
    return { ...none, unreadable: true };
  }
}
