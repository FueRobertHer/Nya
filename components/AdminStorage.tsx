'use client';

// Storage across accounts (app/admin/storage), for the admin only: each
// account on this copy of Nya by its random id, with its Plaid connections
// and how they are doing, its connections to SimpleFIN or Lunch Flow, its
// stored transactions against the limit of one save, what it stores in all
// and its last daily snapshot, as /api/admin/storage measures them
// (lib/admin-storage.ts). Sizes and counts only. The server decides who the
// admin is and answers anyone else with a 404, page and route alike.
//
// Read-only. A page of accounts at a time, sorted here among those loaded;
// "Load more" asks for the next page after the last one.

import { useCallback, useEffect, useState } from 'react';
import { plainNumber } from '@/lib/format';
import { sizeText } from './DataInventory';

type AdminItem = {
  item_id: string;
  institution_name: string;
  transactions_billed: boolean | null;
  txns_chars: number;
  invtxns_chars: number;
  blocked: boolean;
  unsaved: boolean;
  usage: { flagged: 'refused' | 'hidden' | null; refused_since: string | null; hidden_since: string | null; checked_at: string | null } | null;
};

export type AdminContainer = {
  container: string;
  you: boolean;
  status: 'active' | 'restoring' | 'archived';
  created_at: string;
  storage: { keys: number; total_chars: number; largest_chars: number; unmeasured: number } | null;
  items: AdminItem[] | null;
  orphaned: { item_id: string; txns_chars: number; invtxns_chars: number }[] | null;
  connectors: { connections: number; with_credential: number; accounts: number } | null;
  snapshot: { date: string; status: string; reason?: string; at: string; attempts: number; holdings_failed?: number } | null;
  snapshot_unreadable: boolean;
};

export type AdminPage = { as_of: string; ceiling_chars: number; total: number; next: string | null; containers: AdminContainer[] };

export const SORTS = [
  ['stored', 'Most stored'],
  ['ceiling', 'Nearest the limit of one save'],
  ['items', 'Most bank connections'],
  ['connectors', 'Most SimpleFIN or Lunch Flow connections'],
  ['snapshot', 'Oldest last snapshot'],
  ['made', 'Newest account'],
] as const;
export type Sort = (typeof SORTS)[number][0];

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The largest stored transaction blob of an account, the one nearest the ceiling. */
const largestBlob = (c: AdminContainer): number => Math.max(0, ...(c.items ?? []).map((i) => Math.max(i.txns_chars, i.invtxns_chars)), ...(c.orphaned ?? []).map((o) => Math.max(o.txns_chars, o.invtxns_chars)));

/** Share of the ceiling, rounded down, so a blob just under it never reads as 100%. */
export const ofCeiling = (chars: number, ceiling: number): number => (ceiling > 0 ? Math.floor((chars / ceiling) * 100) : 0);

/** The accounts in the order asked; what can't be read goes last. */
export function sortContainers(list: AdminContainer[], sort: Sort): AdminContainer[] {
  const key = (c: AdminContainer): number | string | null => {
    switch (sort) {
      case 'stored':
        return c.storage?.total_chars ?? null;
      case 'ceiling':
        return c.items === null && c.orphaned === null ? null : largestBlob(c);
      case 'items':
        return c.items?.length ?? null;
      case 'connectors':
        return c.connectors?.connections ?? null;
      case 'snapshot':
        return c.snapshot_unreadable ? null : (c.snapshot?.date ?? '');
      case 'made':
        return c.created_at;
    }
  };
  // Largest first, but the oldest snapshot first: an account never snapshotted ('') leads.
  const ascending = sort === 'snapshot';
  return [...list].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const order = x < y ? -1 : x > y ? 1 : 0;
    return (ascending ? order : -order) || (a.container < b.container ? -1 : 1);
  });
}

/** What an Item's last check and its markers say of it, in words. */
export function itemState(i: AdminItem): string[] {
  const out: string[] = [];
  if (i.usage?.flagged === 'refused') out.push('flagged as unused: Plaid has refused it for long enough');
  else if (i.usage?.flagged === 'hidden') out.push('flagged as unused: every account hidden for long enough');
  if (i.usage?.refused_since && i.usage.flagged !== 'refused') out.push(`refused by Plaid since ${day(i.usage.refused_since)}`);
  if (i.usage?.hidden_since && i.usage.flagged !== 'hidden') out.push(`every account hidden since ${day(i.usage.hidden_since)}`);
  if (i.blocked) out.push('a save of its transactions was refused for its size');
  if (i.unsaved) out.push('its last save of transactions failed');
  if (i.transactions_billed === false) out.push('Plaid wasn’t billing Transactions when it was linked');
  if (i.usage === null) out.push('not checked yet');
  return out;
}

function Container({ c, ceiling }: { c: AdminContainer; ceiling: number }) {
  const name = c.you ? 'You' : `Account ${c.container.slice(0, 8)}`;
  return (
    <section className="card admin-storage-row">
      <div className="inst-header">
        <div className="inst-name">{name}</div>
        <div className="inst-total">{c.storage ? sizeText(c.storage.total_chars) : 'Couldn’t be measured'}</div>
      </div>
      <p className="type-tag">
        {c.container}, made {day(c.created_at)}
        {c.status !== 'active' ? `, ${c.status === 'restoring' ? 'being restored' : 'being deleted'}` : ''}
      </p>
      <dl className="info-status">
        <dt>Stored</dt>
        <dd>
          {c.storage === null
            ? 'Its keys couldn’t be walked just now.'
            : `${sizeText(c.storage.total_chars)} in ${plainNumber(c.storage.keys)} ${c.storage.keys === 1 ? 'key' : 'keys'}; its largest single value ${sizeText(c.storage.largest_chars)}, ${ofCeiling(c.storage.largest_chars, ceiling)}% of the limit of one save.`}
          {c.storage && c.storage.unmeasured > 0
            ? ` ${plainNumber(c.storage.unmeasured)} ${c.storage.unmeasured === 1 ? 'key' : 'keys'} couldn’t be measured, so it stores at least this.`
            : ''}
        </dd>
        <dt>Bank connections through Plaid</dt>
        <dd>
          {c.items === null ? (
            'Couldn’t be read just now.'
          ) : c.items.length === 0 ? (
            'None.'
          ) : (
            <ul className="admin-storage-items">
              {c.items.map((i) => {
                const state = itemState(i);
                return (
                  <li key={i.item_id}>
                    <strong>{i.institution_name}</strong>: transactions {sizeText(i.txns_chars)} ({ofCeiling(i.txns_chars, ceiling)}% of the limit)
                    {i.invtxns_chars > 0 ? `, investment transactions ${sizeText(i.invtxns_chars)} (${ofCeiling(i.invtxns_chars, ceiling)}%)` : ''}
                    {state.length > 0 ? `; ${state.join('; ')}` : ''}.
                    <span className="type-tag">{i.item_id}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
        {c.orphaned && c.orphaned.length > 0 && (
          <>
            <dt>Left behind</dt>
            <dd>
              {plainNumber(c.orphaned.length)} {c.orphaned.length === 1 ? 'store' : 'stores'} of transactions whose connection is gone, costing the same:{' '}
              {c.orphaned.map((o) => sizeText(o.txns_chars + o.invtxns_chars)).join(', ')}.
            </dd>
          </>
        )}
        <dt>SimpleFIN or Lunch Flow</dt>
        <dd>
          {c.connectors === null
            ? 'Couldn’t be counted just now.'
            : c.connectors.connections === 0
              ? 'None.'
              : `${plainNumber(c.connectors.connections)} ${c.connectors.connections === 1 ? 'connection' : 'connections'}, ${plainNumber(c.connectors.with_credential)} still holding the access ${c.connectors.with_credential === 1 ? 'it was' : 'they were'} given, keeping ${plainNumber(c.connectors.accounts)} ${c.connectors.accounts === 1 ? 'account' : 'accounts'} up to date.`}
        </dd>
        <dt>Last daily snapshot</dt>
        <dd>
          {c.snapshot_unreadable
            ? 'Its record couldn’t be read just now.'
            : c.snapshot === null
              ? 'None recorded.'
              : `${day(`${c.snapshot.date}T12:00:00Z`)}: ${c.snapshot.status}${c.snapshot.reason ? ` (${c.snapshot.reason})` : ''}, at ${when(c.snapshot.at)}${c.snapshot.attempts > 1 ? `, after ${plainNumber(c.snapshot.attempts)} tries` : ''}${c.snapshot.holdings_failed ? `; holdings not recorded for ${plainNumber(c.snapshot.holdings_failed)} ${c.snapshot.holdings_failed === 1 ? 'account' : 'accounts'}` : ''}.`}
        </dd>
      </dl>
    </section>
  );
}

export function AdminStorageView({ pages, sort, onSort }: { pages: AdminPage; sort: Sort; onSort: (s: Sort) => void }) {
  const sorted = sortContainers(pages.containers, sort);
  return (
    <>
      <div className="card">
        <label className="field">
          Sort by
          <select value={sort} onChange={(e) => onSort(e.target.value as Sort)}>
            {SORTS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="as-of">
          Measured {when(pages.as_of)}. {plainNumber(pages.containers.length)} of {plainNumber(pages.total)} {pages.total === 1 ? 'account' : 'accounts'}
          {pages.next ? ', sorted among those loaded' : ''}. The limit of one save is {sizeText(pages.ceiling_chars)}.
        </p>
      </div>
      {sorted.map((c) => (
        <Container key={c.container} c={c} ceiling={pages.ceiling_chars} />
      ))}
    </>
  );
}

export default function AdminStorage() {
  const [pages, setPages] = useState<AdminPage | null>(null);
  const [sort, setSort] = useState<Sort>('stored');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (after: string | null) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/storage${after ? `?after=${encodeURIComponent(after)}` : ''}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : '');
      const page = body as AdminPage;
      setPages((prev) => (prev && after ? { ...page, containers: [...prev.containers, ...page.containers] } : page));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not read storage just now.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  return (
    <main className="wrap report-wrap">
      <div className="report-top">
        <nav className="report-nav" aria-label="Back to Nya">
          <a href="/">← Nya</a>
        </nav>
      </div>
      <h1>Storage across accounts</h1>
      <p className="sub">
        Each account on this copy of Nya, by its id: its bank connections and how they are doing, its connections to SimpleFIN or Lunch Flow, how large its stored
        transactions are against the limit of one save, what it stores in all, and its last daily snapshot. Sizes and counts only: nothing of anyone’s data is
        read to make it.
      </p>
      {error && <div className="error">{error}</div>}
      {!pages && !error && <p className="empty-note">Measuring…</p>}
      {pages && <AdminStorageView pages={pages} sort={sort} onSort={setSort} />}
      {pages?.next && (
        <button className="secondary admin-storage-more" disabled={busy} onClick={() => load(pages.next)}>
          {busy ? 'Measuring…' : 'Load more accounts'}
        </button>
      )}
    </main>
  );
}
