// lib/user-restore/answers.ts
//
// What the person answered about the accounts a restore brought back from a
// bank connected through Plaid (restored-answers, lib/user-restore/store.ts),
// and what those answers do to the accounts' transactions
// (docs/data-export.md, "Bringing it back"). Read with the rows
// (lib/history-import/read.ts readImported), so every reader takes them.
//
// COUNTED BEFORE A LINK. A restored account's rows are held until it is
// linked to its new one (lib/user-restore/restored.ts). The person can say
// instead that the bank is gone: its transactions then count as an ended
// account's, up to its end (which the answer writes when it has none), shown
// on the restored account itself. Never inferred from an end alone: a
// restore made by this release answers it only for an account the file
// says ended, as the old copy counted it (`by: 'file'`).
//
// THE HOLD BY CONNECTION. A counted account's rows are held again, counted
// nowhere, while a connection made since the restore could hold the same
// transactions and nobody has said it doesn't:
//   - every Plaid Item stored (a restore goes only into an account with
//     none, so each was made since): Plaid's institution id and the bank's
//     name can tell that a connection may be the same bank, never that it
//     isn't (a merger, a rename, a reissued card), so each Item holds every
//     counted account until it is answered for it: linked, or said not to be
//     among its accounts (`apart.items`);
//   - every account tracked through SimpleFIN or Lunch Flow since the
//     restore, and one let go and kept as a manual account while that
//     manual account is there (letting it go keeps its transactions, so it
//     goes on holding): answered by saying it isn't this bank
//     (`apart.accounts`), or by handing the restored account over to one.
// Known from what is stored the moment the connection is saved: no account
// needs to be seen first, no mask, no window of days. A read it needs that
// fails holds every counted account, said, never counted as if nothing did.
//
// HANDED OVER. A restored account a connector account carries on counts its
// rows only before that account's coverage begins (handoverCut): the later
// of the day its connection's history starts (moved past the days its
// answers left it out of) and its earliest row from its provider. Before
// that, a restored row the connector account also holds (by the import's
// rule: the same amount and currency within 5 days, one to one, its rows
// on either side of the cut, so one posted across it pairs) doesn't count
// either: the connector's row stands for it. The connector account's own
// rows are never touched, so no reader of manual books changes; as its
// history reaches back night after night, the restored rows it covers stop
// counting.

import type { Ctx } from '../containers';
import type { StoredItem } from '../storage';
import { addDays } from '../manual-txn-input';
import { manualAccountIds } from '../manual';
import { manualTxnStore, type ManualTxn } from '../manual-txns';
import { connectionsStore, connectorAccountsStore, endedAccountsStore, type ConnectorAccount, type LeftOut } from '../connectors/store';
import { isConnectorKind } from '../connectors/types';
import { MATCH_DAYS, pairUp, type Matchable } from '../history-import/match';
import { restoredAnswersStore, type RestoredAccount, type RestoredAnswer } from './store';
import type { HeldTxn } from './restored';

/** A connection made since the restore that may hold a counted account's
 *  transactions (see THE HOLD BY CONNECTION): a Plaid Item, or an account
 *  tracked through a connector (or kept as a manual account from one), with
 *  how the card names it and, for a connector's, the bank card it is on. */
export type Holder =
  | { kind: 'item'; id: string; institution: string; institution_id: string | null }
  | { kind: 'connector'; id: string; institution: string; name: string; card: string; kept: boolean };

/** The connections made since `since` (the restore) that hold counted
 *  accounts (see THE HOLD BY CONNECTION), or `unreadable` when what says so
 *  can't be read: then every counted account is held. Storage failing
 *  throws. */
export async function holdersSince(ctx: Ctx, since: string, items: readonly StoredItem[]): Promise<{ holders: Holder[]; unreadable: boolean }> {
  const holders: Holder[] = items.map((i) => ({ kind: 'item', id: i.item_id, institution: i.institution_name, institution_id: i.institution_id ?? null }));
  const [tracked, ended] = await Promise.all([connectorAccountsStore.getAllReport(ctx), endedAccountsStore.getAllReport(ctx)]);
  const unreadable = tracked.unreadable.length + tracked.unrecognised.length + ended.unreadable.length + ended.unrecognised.length > 0;
  for (const a of tracked.entries.values()) {
    if (a.created_at < since) continue;
    holders.push({ kind: 'connector', id: a.account_id, institution: a.institution_name, name: a.name, card: a.institution_ref, kept: false });
  }
  const kept = [...ended.entries].filter(([id, e]) => e.kept && e.tracked_at >= since && !tracked.entries.has(id));
  if (kept.length > 0) {
    const manual = new Set(await manualAccountIds(ctx));
    for (const [id, e] of kept) {
      if (!manual.has(id)) continue;
      holders.push({ kind: 'connector', id, institution: e.institution_name, name: e.name, card: `kept:${e.connection_id}:${e.institution_name}`, kept: true });
    }
  }
  return { holders, unreadable };
}

/** Of `holders`, those a restored account's answer leaves unanswered (see
 *  THE HOLD BY CONNECTION): an Item it isn't said to be apart from, and a
 *  connector account likewise, unless it was handed over (then every
 *  connector account is answered: one carries it on). Pure. */
export function unanswered(answer: RestoredAnswer | null | undefined, holders: readonly Holder[]): Holder[] {
  const items = new Set(answer?.apart.items ?? []);
  const accounts = new Set(answer?.apart.accounts ?? []);
  const handed = !!answer?.handed_to;
  return holders.filter((h) => (h.kind === 'item' ? !items.has(h.id) : !handed && !accounts.has(h.id)));
}

/** What the answers make of the accounts a restore brought back that aren't
 *  linked: those that count (`counted`), those counted but held for now and
 *  by what (`held`), each handover's connector account (`handed`), and
 *  whether something it needs couldn't be read (`unreadable`: the accounts
 *  it concerns are held; `unknown`: accounts whose answer can't be read,
 *  never counted). */
export type CountedState = {
  counted: Map<string, RestoredAccount>;
  held: Map<string, Holder[] | 'unread'>;
  handed: Map<string, string>;
  unreadable: boolean;
  unknown: string[];
  answers: Map<string, RestoredAnswer>;
};

export const NO_COUNTED: CountedState = { counted: new Map(), held: new Map(), handed: new Map(), unreadable: false, unknown: [], answers: new Map() };

/**
 * The restored accounts that count before a link now (see the header): of
 * those `listed` (their directory entry is there) and not linked, each whose
 * answer counts it, unless a connection made since holds it. Reads the
 * answers, and only with a counted account, what holds it. Strict: storage
 * failing throws; an answer that can't be read counts nothing (`unknown`),
 * and what holds can't be read holds every counted account (`unreadable`).
 */
export async function countedState(
  ctx: Ctx,
  opts: { restored: ReadonlyMap<string, RestoredAccount>; listed: ReadonlySet<string>; items: readonly StoredItem[]; linked: (id: string) => boolean }
): Promise<CountedState> {
  if (opts.restored.size === 0) return NO_COUNTED;
  const report = await restoredAnswersStore.getAllReport(ctx);
  const unknown = [...report.unreadable, ...report.unrecognised].filter((id) => opts.restored.has(id)).sort();
  const candidates = [...opts.restored].filter(([id]) => opts.listed.has(id) && !opts.linked(id) && report.entries.get(id)?.counted);
  if (candidates.length === 0) return { ...NO_COUNTED, unreadable: unknown.length > 0, unknown, answers: report.entries };
  const since = [...opts.restored.values()].map((a) => a.restored_at).reduce((x, y) => (y < x ? y : x));
  const { holders, unreadable } = await holdersSince(ctx, since, opts.items);
  const out: CountedState = { counted: new Map(), held: new Map(), handed: new Map(), unreadable: unreadable || unknown.length > 0, unknown, answers: report.entries };
  for (const [id, a] of candidates) {
    const answer = report.entries.get(id)!;
    if (unreadable) {
      out.held.set(id, 'unread');
      continue;
    }
    const open = unanswered(answer, holders);
    if (open.length > 0) {
      out.held.set(id, open);
      continue;
    }
    out.counted.set(id, a);
    if (answer.handed_to) out.handed.set(id, answer.handed_to.account_id);
  }
  return out;
}

// ---- Handed over ----

/** The day a connector account's coverage starts (see HANDED OVER): its
 *  connection's history start, moved past each window its answers left it
 *  out of that begins on or before it; null when none is known (no history
 *  yet, or a window that is still open). Pure. */
export function coverageStart(from: string | null, leftOut: readonly LeftOut[] = []): string | null {
  if (from === null) return null;
  let start = from;
  for (const w of [...leftOut].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))) {
    if (w.from > start) break;
    if (w.to === null) return null;
    if (w.to >= start) start = addDays(w.to, 1);
  }
  return start;
}

/** A handover's cut-off (see HANDED OVER): the later of the coverage start
 *  and the earliest row from the provider; null (no cut: every restored row
 *  is paired, none dropped by its day) when either isn't known. Pure. */
export function handoverCut(start: string | null, earliest: string | null): string | null {
  if (start === null || earliest === null) return null;
  return start > earliest ? start : earliest;
}

/** What a handover reads of its connector account: the cut-off, and its
 *  rows that can pair with a restored row dated before it (those dated
 *  before the cut and up to MATCH_DAYS after), any source (a row imported
 *  into it from a file, or entered once it is a manual account, pairs as its
 *  provider's would). `gone`: the account is no longer there (removed with
 *  its rows), so the restored rows count whole. */
export type Handover = { cut: string | null; theirs: Matchable[] } | 'gone';

/** One handover, read (see HANDED OVER). Strict: what can't be read throws
 *  (the reader holds the rows then, saying so). */
export async function readHandover(ctx: Ctx, account_id: string): Promise<Handover> {
  const [entry, ended, book] = await Promise.all([connectorAccountsStore.get(ctx, account_id), endedAccountsStore.get(ctx, account_id), manualTxnStore.get(ctx, account_id)]);
  let start: string | null;
  let provider: string;
  if (entry) {
    const conn = await connectionsStore.get(ctx, entry.connection_id);
    start = coverageStart(conn?.history?.from ?? null, entry.left_out);
    provider = entry.connector;
  } else if (ended?.kept && book) {
    start = coverageStart(ended.history_from, ended.left_out);
    provider = ended.connector;
  } else return 'gone';
  const rows: ManualTxn[] = book?.rows ?? [];
  const earliest = rows.filter((r) => r.source === provider && isConnectorKind(r.source)).reduce<string | null>((m, r) => (m === null || r.date < m ? r.date : m), null);
  const cut = handoverCut(start, earliest);
  const reach = cut === null ? null : addDays(cut, MATCH_DAYS);
  return { cut, theirs: rows.filter((r) => reach === null || r.date <= reach).map((r) => ({ date: r.date, amount: r.amount, currency: r.currency, name: r.name })) };
}

/** The restored rows a handover leaves out (see HANDED OVER): those dated on
 *  or after its cut-off, and those before it the connector account's rows
 *  pair with by the import's rule, one to one. The rows on or after the cut
 *  that can pair take part, so a connector row stands first for the
 *  restored row it is nearest, never for an earlier one beside it. Pure. */
export function handedOverRows(rows: readonly HeldTxn[], handover: Handover): Set<string> {
  const out = new Set<string>();
  if (handover === 'gone') return out;
  const reach = handover.cut === null ? null : addDays(handover.cut, MATCH_DAYS);
  const pairing: HeldTxn[] = [];
  for (const r of rows) {
    if (handover.cut !== null && r.date >= handover.cut) out.add(r.id);
    if (reach === null || r.date <= reach) pairing.push(r);
  }
  if (!pairing.some((r) => !out.has(r.id)) || handover.theirs.length === 0) return out;
  const asRows = pairing.map((r, index) => ({ index, date: r.date, amount: r.amount, currency: r.currency, name: r.name }));
  for (const [index] of pairUp(asRows, handover.theirs)) out.add(pairing[index].id);
  return out;
}

/** The connector accounts a handover may name: tracked since the restore,
 *  or kept as manual accounts from one (holdersSince). */
export const connectorHolders = (holders: readonly Holder[]) => holders.filter((h): h is Extract<Holder, { kind: 'connector' }> => h.kind === 'connector');

export type { ConnectorAccount };
