// lib/connectors/continue.ts
//
// Carrying on an account a restore brought back from a SimpleFIN or Lunch
// Flow connection with an account tracked through a connection made since,
// when the new access gives the same account other ids (a new SimpleFIN
// Bridge account after the old one lapsed, a bank added again there,
// another server, Lunch Flow in place of SimpleFIN or the reverse):
// docs/data-export.md, "Bringing it back". Behind RESTORE_CARRY_ON_ENABLED
// (lib/user-restore/enabled.ts carryOnEnabled).
//
// ASKED, NEVER ASSUMED. While a restored connector account waits (the
// restore's record is finished, and since it started no answer has held the
// account: `fetched_at` is before it, or none; one that ended doesn't wait),
// tracking any account asks which of them it is, or that it is a new one
// (TrackChoice `continues`, lib/connectors/manage.ts trackAccounts): nothing
// is preselected, and a choice without the answer is refused. The evidence
// offered beside each (evidenceOf) only orders them.
//
// ONE ACCOUNT. Carried on, the offered account is tracked under the
// restored account's id: the new connection's list gains it, then the
// restored account's entry becomes version 2 (Continued: what it was, when,
// its last day there), its connection, provider id, names and bank card the
// new one's, its kind and currency the same (the currency must match), the
// sign of a card or a loan asked again where the provider or the server
// changed, its reported balance cleared until the new one answers; then the
// old connection's list loses it. In that order: the sync finds an account
// by its entry's connection, so a stop part way leaves it fetched by nothing,
// and the same choice made again finishes it. Everything keyed by its id
// goes on: balance history, goals, its end, hiding, shares, rules, what was
// said about its rows.
//
// ROWS ON BOTH SIDES (matchCarried, for lib/connectors/sync.ts
// mergeRecords). The restored rows are the account's history and stay. A row
// the new provider sends whose id the book doesn't have, dated no later than
// MATCH_DAYS after `until`, may be one the book holds already: it is matched
// against the rows from before (the old provider's, made before the carrying
// on, not taken over yet) by the import's rule (the same amount and currency,
// within MATCH_DAYS, one to one: pairUp). Matched, the row takes the new
// provider's id, as an update by id does (its date and name follow the
// provider's; its id and everything said about it stay), and `continues`
// keeps what it was. Not matched, it is added. Once matched it is found by
// its new id ever after. With the same provider and server (`by_id`), rows
// match by id alone, as connecting again does. Across servers of one
// provider, only rows from the new connection (made since, or taken over)
// are found by id: the old ones' ids are another server's (the review's Nit
// 3), left to the match by content.
//
// UNDO marks the entry as being undone first (`undoing`): from then on no
// sync merges a row into it, since mergeRecords reads the entry again inside
// the book's compare-and-set, so a sync landing part way through can't take
// the rows over again. Then it gives the rows taken over what they were
// (their source, id, day, name, amount and content key), removes the rows
// the new provider added, with what was said about them, as letting an
// account go removes them, offers the provider's account again, and puts
// the entry back as it was (Continued `from`), on its old connection where
// that is still there, else on a connection of its own with no credential,
// waiting for a token as a restored one does. Stopped part way, it is run
// again. Balances recorded meanwhile stay where they were: history is never
// rewritten.

import type { Ctx } from '../containers';
import { addDays } from '../manual-txn-input';
import { endOf, lifecycleStore } from '../lifecycle';
import { manualTxnStore, type ManualTxn, type ManualTxnBook } from '../manual-txns';
import { forgetAnnotations } from '../txn-annotations';
import { forgetSplitsAndGroups } from '../split-gone';
import { MATCH_DAYS, pairUp } from '../history-import/match';
import { userRestoreStore } from '../user-restore/store';
import { clearBackfillDone } from '../history';
import { clearCaches } from '../cache';
import { loggable } from '../log-safe';
import { connectionsStore, connectorAccountsStore, newConnectionId, type AvailableAccount, type ConnectorAccount, type ConnectorConnection, type Continued } from './store';
import { fingerprint, institutionRef } from './institutions';
import type { ConnectorKind } from './types';
import type { ImportRow } from '../import/normalize';

export class CarryOnRefused extends Error {
  constructor(
    message: string,
    readonly status: number = 409
  ) {
    super(message);
    this.name = 'CarryOnRefused';
  }
}

/** A restored connector account that waits (see ASKED, NEVER ASSUMED), with
 *  the host its connection reached, for the evidence. */
export type WaitingAccount = { account: ConnectorAccount; host: string | null; last: string | null };

/**
 * The restored connector accounts that wait now (see ASKED, NEVER ASSUMED),
 * each with its last transaction's day there. None without a finished
 * restore. Strict: what can't be read throws (tracking is refused then,
 * never asked less).
 */
export async function waitingRestored(ctx: Ctx): Promise<WaitingAccount[]> {
  const record = await userRestoreStore.get(ctx);
  if (!record || record.status !== 'finished') return [];
  const since = record.started_at;
  const all = await connectorAccountsStore.getAll(ctx);
  const candidates = [...all.values()].filter((a) => a.version === 1 && a.created_at < since && (a.fetched_at === null || a.fetched_at < since));
  if (candidates.length === 0) return [];
  const ids = candidates.map((a) => a.account_id);
  const [ends, conns, books] = await Promise.all([
    lifecycleStore.getMany(ctx, ids),
    connectionsStore.getMany(ctx, [...new Set(candidates.map((a) => a.connection_id))]),
    manualTxnStore.getMany(ctx, ids),
  ]);
  return candidates
    .filter((a) => {
      const end = ends.get(a.account_id);
      return !end || endOf(end.lifecycle) === null;
    })
    .map((account) => ({ account, host: conns.get(account.connection_id)?.host ?? null, last: lastDay(books.get(account.account_id)?.rows ?? [], account.connector) }))
    .sort((x, y) => x.account.institution_name.localeCompare(y.account.institution_name) || x.account.name.localeCompare(y.account.name));
}

/** The day of the last row from `connector` in a book, or null. */
function lastDay(rows: readonly ManualTxn[], connector: ConnectorKind): string | null {
  return rows.reduce<string | null>((m, r) => (r.source === connector && (m === null || r.date > m) ? r.date : m), null);
}

/** How likely an offered account is a waiting one (see ASKED, NEVER
 *  ASSUMED), best first: the same provider, server and id; the same bank and
 *  name, case and spacing aside, and currency; the same currency. Another
 *  currency: never (null). Pure. */
export function evidenceOf(
  offer: { remote_id: string; name: string; institution: string; currency: string | null },
  at: { connector: ConnectorKind; host: string },
  w: WaitingAccount
): 'same' | 'likely' | 'possible' | null {
  if (!offer.currency || offer.currency !== w.account.currency) return null;
  if (at.connector === w.account.connector && at.host === w.host && offer.remote_id === w.account.remote_id) return 'same';
  if (fingerprint(offer.institution, offer.name) === fingerprint(w.account.institution_name, w.account.name)) return 'likely';
  return 'possible';
}

/**
 * Carries a waiting restored account on with an offered account of
 * `connection_id`, whose list already tracks it under the restored id (see
 * ONE ACCOUNT, the steps after the first). Run again after a stop, it
 * finishes what is left. Clears nothing: trackAccounts does.
 */
export async function carryOn(
  ctx: Ctx,
  account_id: string,
  to: { connection_id: string; conn: ConnectorConnection; offer: AvailableAccount },
  now: number = Date.now()
): Promise<void> {
  const before = await connectorAccountsStore.get(ctx, account_id);
  if (!before) throw new CarryOnRefused('That account from your download is no longer there.', 404);
  const from = before.connection_id;
  if (before.version === 1) {
    const [old, book] = await Promise.all([connectionsStore.get(ctx, from), manualTxnStore.get(ctx, account_id)]);
    const at = new Date(now).toISOString();
    const by_id = before.connector === to.conn.connector && (old?.host ?? null) === to.conn.host;
    await connectorAccountsStore.update(ctx, account_id, (cur) => {
      if (!cur || cur.version !== 1) return cur;
      const { left_out: _left, ...rest } = cur;
      const continued: Continued = {
        from: {
          connector: cur.connector,
          host: old?.host ?? null,
          connection_id: cur.connection_id,
          remote_id: cur.remote_id,
          name: cur.name,
          institution_name: cur.institution_name,
          institution_key: cur.institution_key,
          institution_ref: cur.institution_ref,
          sign: cur.sign ?? null,
        },
        at,
        until: lastDay(book?.rows ?? [], cur.connector),
        by_id,
      };
      return {
        ...rest,
        version: 2,
        connection_id: to.connection_id,
        connector: to.conn.connector,
        remote_id: to.offer.remote_id,
        name: to.offer.name,
        institution_name: to.offer.institution,
        institution_key: to.offer.institution_key,
        institution_ref: institutionRef(to.connection_id, to.offer.institution_key),
        sign: by_id ? (cur.sign ?? null) : null,
        reported_balance: null,
        reported_available: null,
        balance_at: null,
        fetched_at: null,
        ok_at: null,
        continued,
      };
    });
  }
  if (from !== to.connection_id) {
    await connectionsStore.update(ctx, from, (c) => (c ? { ...c, tracked: c.tracked.filter((t) => t.account_id !== account_id) } : c));
  }
}

/**
 * The matching of a carried-on account's new rows (see ROWS ON BOTH SIDES),
 * on the book's rows as mergeRecords holds them: of `unknown`, the rows its
 * index by id didn't find, those that take over a row from before (by its
 * index in `rows`), and those to add. Pure.
 */
export function matchCarried(continued: Continued, rows: readonly ManualTxn[], unknown: readonly ImportRow[]): { taken: { row: ImportRow; at: number }[]; added: ImportRow[] } {
  if (continued.by_id || continued.until === null) return { taken: [], added: [...unknown] };
  const reach = addDays(continued.until, MATCH_DAYS);
  const candidates = unknown.filter((r) => r.date <= reach);
  const later = unknown.filter((r) => r.date > reach);
  const old = rows.map((r, at) => ({ r, at })).filter(({ r }) => r.source === continued.from.connector && r.created_at < continued.at && !r.continues);
  if (candidates.length === 0 || old.length === 0) return { taken: [], added: [...unknown] };
  const pairs = pairUp(
    candidates.map((r, index) => ({ index, date: r.date, amount: r.amount, currency: r.currency, name: r.name })),
    old.map(({ r, at }) => ({ date: r.date, amount: r.amount, currency: r.currency, name: r.name, at }))
  );
  const taken: { row: ImportRow; at: number }[] = [];
  const added: ImportRow[] = [];
  candidates.forEach((row, index) => {
    const p = pairs.get(index);
    if (p) taken.push({ row, at: p.twin.at });
    else added.push(row);
  });
  return { taken, added: [...added, ...later] };
}

/** A row taken over by the new provider's (see ROWS ON BOTH SIDES): its id
 *  and everything said about it stay; what it was is kept. Pure. */
export function takeOver(stored: ManualTxn, row: ImportRow): ManualTxn {
  return {
    ...stored,
    source: row.source,
    source_id: row.source_id,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    name: row.name,
    ...(row.source_key ? { source_key: row.source_key } : {}),
    continues: { source: stored.source, source_id: stored.source_id, date: stored.date, name: stored.name, amount: stored.amount, ...(stored.source_key ? { source_key: stored.source_key } : {}) },
  };
}

/** What the first answers found of a carried-on account's choice (see the
 *  header of docs/data-export.md's part on it): of the new provider's rows
 *  dated up to `until`, how many took over a row from the download, and how
 *  many were added. Pure. */
export function carryEvidence(account: ConnectorAccount, rows: readonly ManualTxn[]): { until: string | null; matched: number; added: number } | null {
  const c = account.continued;
  if (!c) return null;
  const matched = rows.filter((r) => r.continues).length;
  const added = rows.filter((r) => r.source === account.connector && r.created_at >= c.at && !r.continues && (c.until === null || r.date <= c.until)).length;
  return { until: c.until, matched, added };
}

/**
 * Undoes carrying an account on (see UNDO). Returns how many of the new
 * provider's rows it removed. Refused for an account that wasn't carried
 * on. Running it again after a stop finishes it.
 */
export async function undoCarryOn(ctx: Ctx, account_id: string, now: number = Date.now()): Promise<{ removed: number }> {
  const entry = await connectorAccountsStore.get(ctx, account_id);
  if (!entry || entry.version !== 2 || !entry.continued) throw new CarryOnRefused('That account wasn’t carried on from your download.', 404);
  const c = entry.continued;
  const at = new Date(now).toISOString();
  // First marked as being undone: from then on no sync merges a row into it
  // (mergeRecords reads the entry again inside the book's compare-and-set),
  // so a sync landing part way through never takes the rows over again.
  await connectorAccountsStore.update(ctx, account_id, (cur) => (cur && cur.version === 2 && cur.continued ? { ...cur, continued: { ...cur.continued, undoing: cur.continued.undoing ?? at } } : cur));
  // The rows: taken over ones put back as they were, the new provider's removed.
  let gone: string[] = [];
  await manualTxnStore.update(ctx, account_id, (book) => {
    if (!book) return book;
    gone = [];
    const rows: ManualTxn[] = [];
    for (const r of book.rows) {
      if (r.continues) {
        const { continues, source_key: _key, ...rest } = r;
        rows.push({
          ...rest,
          source: continues.source,
          source_id: continues.source_id,
          date: continues.date,
          name: continues.name,
          amount: continues.amount,
          ...(continues.source_key ? { source_key: continues.source_key } : {}),
        });
      } else if (r.source === entry.connector && r.created_at >= c.at) gone.push(r.id);
      else rows.push(r);
    }
    return { ...book, rows } as ManualTxnBook;
  });
  if (gone.length > 0) {
    await forgetAnnotations(ctx, gone).catch((err) => console.warn('connectors: exclusions were left behind', loggable(err)));
    await forgetSplitsAndGroups(ctx, gone).catch((err) => console.warn('connectors: splits or groups were left behind', loggable(err)));
  }
  // Then the connections' lists, while the entry still names the one that
  // carried it on (so an undo stopped here, run again, finds it): off that
  // one, offered there again, and on its old connection where that is still
  // there, else on one of its own with no credential.
  const old = await connectionsStore.get(ctx, c.from.connection_id);
  const home = old ? c.from.connection_id : newConnectionId();
  if (!old) {
    await connectionsStore.set(ctx, home, {
      version: 1,
      connector: c.from.connector,
      host: c.from.host ?? '',
      created_at: at,
      last_fetch: null,
      last_answer_at: null,
      tracked: [],
      available: [],
      history: null,
    });
  }
  const carriedBy = entry.connection_id;
  const offer: AvailableAccount = { remote_id: entry.remote_id, name: entry.name, institution: entry.institution_name, institution_key: entry.institution_key, currency: entry.currency, currency_text: entry.currency };
  if (carriedBy !== home) {
    await connectionsStore.update(ctx, carriedBy, (n) =>
      n
        ? {
            ...n,
            tracked: n.tracked.filter((t) => t.account_id !== account_id),
            available: n.available.some((a) => a.remote_id === offer.remote_id) ? n.available : [...n.available, offer],
          }
        : n
    );
  }
  await connectionsStore.update(ctx, home, (h) =>
    h ? { ...h, tracked: [...h.tracked.filter((t) => t.account_id !== account_id), { remote_id: c.from.remote_id, account_id }] } : h
  );
  // Last, the entry: as it was, version 1 again.
  await connectorAccountsStore.update(ctx, account_id, (cur) => {
    if (!cur || cur.version !== 2) return cur;
    const { continued: _c, ...rest } = cur;
    return {
      ...rest,
      version: 1,
      connection_id: home,
      connector: c.from.connector,
      remote_id: c.from.remote_id,
      name: c.from.name,
      institution_name: c.from.institution_name,
      institution_key: c.from.institution_key,
      institution_ref: old ? c.from.institution_ref : institutionRef(home, c.from.institution_key),
      sign: c.from.sign,
      reported_balance: null,
      reported_available: null,
      balance_at: null,
      fetched_at: null,
      ok_at: null,
    };
  });
  await clearBackfillDone(ctx);
  await clearCaches(ctx);
  return { removed: gone.length };
}

// ---- What the connector screens are told ----

/** A restored account that waits, as Choose accounts names it. */
export type WaitingView = { account_id: string; name: string; institution_name: string; type: string; currency: string; connector: ConnectorKind; last: string | null };

/** What Choose accounts asks (see ASKED, NEVER ASSUMED): whether carrying
 *  on is turned on, the restored accounts that wait, and for each offer of
 *  each connection, the waiting accounts it may be, best evidence first
 *  (none in another currency). */
export type CarryView = {
  enabled: boolean;
  waiting: WaitingView[];
  offers: Record<string, Record<string, { account_id: string; evidence: 'same' | 'likely' | 'possible' }[]>>;
};

const RANK = { same: 0, likely: 1, possible: 2 } as const;

/**
 * What the connector screens show of carrying on: the question's choices
 * (CarryView), and for each account carried on, what the first answers
 * found (carryEvidence). LENIENT, for those screens only: what can't be
 * read asks nothing and finds nothing (tracking reads it strictly, and is
 * refused then).
 */
export async function carryOnView(
  ctx: Ctx,
  connections: ReadonlyMap<string, ConnectorConnection>,
  accounts: readonly ConnectorAccount[],
  enabled: boolean
): Promise<{ carry: CarryView; evidence: Map<string, { until: string | null; matched: number; added: number }> }> {
  const evidence = new Map<string, { until: string | null; matched: number; added: number }>();
  const carried = accounts.filter((a) => a.continued);
  if (carried.length > 0) {
    try {
      const books = await manualTxnStore.getMany(ctx, carried.map((a) => a.account_id));
      for (const a of carried) evidence.set(a.account_id, carryEvidence(a, books.get(a.account_id)?.rows ?? [])!);
    } catch (err) {
      console.warn('connectors: what carrying an account on found could not be read', loggable(err));
    }
  }
  let waiting: WaitingAccount[] = [];
  try {
    waiting = await waitingRestored(ctx);
  } catch (err) {
    console.warn('connectors: the accounts from a download that wait could not be read', loggable(err));
  }
  const offers: CarryView['offers'] = {};
  if (enabled && waiting.length > 0) {
    for (const [id, conn] of connections) {
      const byOffer: Record<string, { account_id: string; evidence: 'same' | 'likely' | 'possible' }[]> = {};
      for (const o of conn.available) {
        const fits = waiting
          .map((w) => ({ account_id: w.account.account_id, evidence: evidenceOf({ remote_id: o.remote_id, name: o.name, institution: o.institution, currency: o.currency }, conn, w) }))
          .filter((f): f is { account_id: string; evidence: 'same' | 'likely' | 'possible' } => f.evidence !== null)
          .sort((x, y) => RANK[x.evidence] - RANK[y.evidence]);
        byOffer[o.remote_id] = fits;
      }
      offers[id] = byOffer;
    }
  }
  return {
    carry: {
      enabled,
      waiting: waiting.map(({ account: a, last }) => ({ account_id: a.account_id, name: a.name, institution_name: a.institution_name, type: a.type, currency: a.currency, connector: a.connector, last })),
      offers,
    },
    evidence,
  };
}
