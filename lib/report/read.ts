// lib/report/read.ts
//
// What a report is made of, read the way the app and the read-only API read
// it, never a second way, then built by lib/report/build.ts:
//
//   - the Activity tab's rows, from the one assembly the app and the API share
//     (lib/activity.ts), from the period's first day on: the person's
//     categories, names and exclusions, exclusions carried across a re-link,
//     the rows entered on manual accounts, hidden accounts left out. From
//     storage, as the API reads them: making a report never calls Plaid, so it
//     costs nothing there and works while a bank or Plaid is down, and says as
//     of when each institution's transactions are;
//   - each connection's health from the records the API reads
//     (lib/api-read.ts connectionFacts);
//   - the manual accounts, as the API lists them (lib/manual.ts);
//   - the connections removed since, from the account directory, which
//     outlives a disconnect (lib/links.ts removedConnections), with the
//     accounts connected now (as each connection last reported them,
//     lib/last-known.ts) and the person's links (lib/link-core.ts), so each
//     removed account can be told back or not;
//   - each bank a SimpleFIN connection reaches, as its card says it
//     (lib/connectors/institutions.ts connectorBanksReport), and the accounts
//     a connection fed that the person let go (connector-ended): removed with
//     their transactions, or kept as manual accounts, unless tracked again;
//   - the categories the person marked (lib/report/store.ts), found among
//     their categories as the rows were filed by them (finishActivity, which
//     files without writing: the report never grows the stored categories);
//   - the days the files imported into each linked account cover (#52,
//     lib/history-import/read.ts importedCoverage), with each connection's
//     bank accounts and cards, so where those files reach, the bank's own
//     transactions needn't (lib/report/build.ts IMPORTED).
//   - the accounts that ended (lib/lifecycle.ts), read by the assembly
//     through the same links as the hidden set, strictly, as the Activity tab
//     reads them: its rows come with theirs kept (keepEnded) and each row's
//     account (withAccountIds), so the report leaves out what the Activity
//     tab leaves out, by the same rule, and says what it did (lib/report/
//     build.ts ENDED ACCOUNTS); and the windows an account was missing. An
//     end is the person's word on an account, wherever it comes from: one
//     SimpleFIN keeps up to date is placed under its bank, as a Plaid one is
//     under its connection. Letting an account go from SimpleFIN is
//     something else (`letGo` here, connector-ended): it says where its
//     transactions come from after, never that it stopped counting; one that
//     had ended by the day it was let go has nothing after to come. One that
//     ended holds nothing at its bank, so its bank's history can move on
//     without it: the days before its end it may be missing transactions
//     from, though its bank's history covers them, are said as days it was
//     missing from its bank's answer (connectorMissed), and so are those of
//     an account let go and kept by hand that its connection's history has
//     since reached back past.
//
// READ ONLY, and for display: nothing here writes, deletes or records anything
// on what it reads (readOnly). Every read that can't be made is said on the
// report, never passed off as nothing to say: connections' health that can't
// be read, a directory that can't, marked categories that can't (the group is
// left out, and the report says why), the person's own categories, names and
// carried exclusions that can't (the assembly's own_read), each manual
// account whose rows can't (never counted as having none), and whatever else
// the assembly couldn't read: the transactions it couldn't (its unread_notes,
// which the report lists as gaps), and how a rule, a category, a split or a
// group applies when something of theirs couldn't be (its other notes, which
// leave no transaction out: caveats on the totals).
// Storage that can't be reached at all fails the whole report, and so do
// account closures that can't be read, as they fail the Activity tab: never
// a report counting an account the person closed.

import type { Ctx } from '../containers';
import { getItems } from '../storage';
import { assembleBankRows, finishActivity } from '../activity';
import { connectionFacts } from '../api-read';
import { getManualAccountsReport, toInstitutions } from '../manual';
import { removedConnections } from '../links';
import { readLinks } from '../link-core';
import { rememberedAccountsReport } from '../last-known';
import { isInvestmentType } from '../balance';
import { StoredDataUnreadableError } from '../repo';
import { accountWords, endDays, endedNowIds, endOf, type LifecycleView } from '../lifecycle';
import { reportSettingsStore } from './store';
import {
  buildReport,
  notesBesides,
  type EndedFacts,
  type KeptFacts,
  type LiveAccountFacts,
  type ManualFacts,
  type MissedFacts,
  type RemovedFacts,
  type Report,
  type SourceFacts,
} from './build';
import { addDays, dayIn, type Period } from './period';
import { connectorBanksReport, connectorCardId, needsSign, type ConnectorBanksReport } from '../connectors/institutions';
import { connectorBadge } from '../connectors/health';
import { endedAccountsStore, type EndedAccount } from '../connectors/store';
import { connectorOf } from '../connectors/registry';
import type { TxnCoverage } from '../transactions';
import { coveredAccountsOf, importedCoverage } from '../history-import/read';

/** An instant a record holds, unless it is the stand-in a reader puts where a
 *  record had none (lib/manual.ts writes 1970-01-01). */
const realTime = (iso: string | null | undefined): string | null => (iso && Date.parse(iso) > 0 ? iso : null);

/** Whether a connection holds a bank account or card (what its transactions
 *  are of: lib/history-import/read.ts coveredAccountsOf), and every one it is
 *  remembered to hold is hidden. */
const everyBankAccountHidden = (accounts: readonly { account_id: string; type: string }[], hidden: ReadonlySet<string>): boolean => {
  const banking = accounts.filter((a) => a.type === 'depository' || a.type === 'credit');
  return banking.length > 0 && banking.every((a) => hidden.has(a.account_id));
};

/**
 * The accounts that ended and the windows any was missing from its bank's
 * answer, as the report says them (lib/report/build.ts ENDED ACCOUNTS): a
 * hidden account left out, as everywhere; each under every id it has had,
 * its current one first; named as its entry names it (a closed account soon
 * leaves every live list); placed under the connection it is at now, if any
 * (`connectionOf`). A window is said only on the days the account counts
 * (lib/lifecycle.ts shortDays): from its end on, none. Pure.
 */
export function lifecycleFacts(
  view: LifecycleView,
  hidden: ReadonlySet<string>,
  connectionOf: (ids: readonly string[], item_id: string | null) => string | null
): { ended: EndedFacts[]; missed: MissedFacts[] } {
  const idsOf = new Map<string, string[]>();
  for (const [id, root] of view.rootOf) {
    const ids = idsOf.get(root) ?? [root];
    if (id !== root) ids.push(id);
    idsOf.set(root, ids);
  }
  const ended: EndedFacts[] = [];
  for (const [root, { entry }] of view.accounts) {
    const l = entry.lifecycle;
    if (l.state === 'active') continue;
    const ids = idsOf.get(root) ?? [root];
    if (ids.some((id) => hidden.has(id))) continue;
    ended.push({
      ids,
      account: accountWords(entry.label),
      institution: entry.label.institution,
      item_id: connectionOf(ids, entry.item_id),
      type: entry.type,
      state: l.state,
      assumed: entry.assumed === true,
      end: endOf(l)!,
    });
  }
  const missed: MissedFacts[] = [];
  for (const [id, entry] of view.entries) {
    if (!entry.missed?.length) continue;
    const root = view.rootOf.get(id) ?? id;
    const ids = idsOf.get(root) ?? [root];
    if (hidden.has(id) || ids.some((x) => hidden.has(x))) continue;
    const applies = view.accounts.get(root)?.entry ?? entry;
    const end = endOf(applies.lifecycle);
    for (const w of entry.missed) {
      const to = end !== null && w.to >= end ? addDays(end, -1) : w.to;
      if (w.from > to) continue;
      missed.push({
        account: accountWords(applies.label),
        institution: applies.label.institution,
        item_id: connectionOf(ids, applies.item_id),
        type: applies.type,
        from: w.from,
        to,
      });
    }
  }
  return { ended, missed };
}

export async function readReport(
  ctx: Ctx,
  period: Period,
  opts: { currency?: string | null; now?: number; appendixLimit?: number } = {}
): Promise<Report> {
  const now = opts.now ?? Date.now();
  // Each row with its account, and an ended account's later rows kept: left
  // out by buildReport, by the Activity tab's rule, and said.
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, since: period.start, withAccountIds: true, keepEnded: true });
  const [activity, facts, manual, items, settings, remembered, links, fed, letGo] = await Promise.all([
    // The ends too, so a split or a group leaves an ended account's later
    // rows whole and out of its net, for buildReport to leave out and count.
    finishActivity(ctx, bank.payload, bank.hidden, { since: period.start, keepEnded: true, endedFrom: endDays(bank.lifecycle) }),
    connectionFacts(ctx),
    // LENIENT, for this display only, as the API lists them: an account that
    // can't be read is left out here and named by the assembly's notes.
    getManualAccountsReport(ctx),
    getItems(ctx),
    // Strict underneath: marked categories that can't be read leave the group
    // out, and the report says so; never "none marked".
    reportSettingsStore.get(ctx).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => {
        if (err instanceof StoredDataUnreadableError) return { ok: false as const };
        throw err;
      }
    ),
    // LENIENT, for this display only: a connection whose accounts can't be
    // read has none here, so none of a removed connection's accounts is taken
    // to be back through it, and its kinds don't widen what the report says
    // it covers. Storage out of reach still throws.
    rememberedAccountsReport(ctx),
    // LENIENT, for this display only: a link that can't be read brings no
    // removed account back, so its transactions stay a gap; links that can't
    // be read at all bring none back.
    readLinks(ctx).then(
      (read) => read.links,
      () => new Map<string, { to: string }>()
    ),
    // LENIENT, for this display only: an account entry that can't be read is
    // named by the assembly's notes; a connection's that can't be read leaves
    // its banks saying when they last synced isn't known. One that ended
    // holds no bank (lib/connectors/institutions.ts).
    connectorBanksReport(ctx, now, endedNowIds(bank.lifecycle, now)),
    // LENIENT, for this display only: one that can't be read is said, as a
    // directory entry is (removed_unknown).
    endedAccountsStore.getAllReport(ctx),
  ]);
  const hidden = bank.hidden;
  // The manual accounts, those that can't be read too: one kept on a
  // disconnect that stopped part way is in both stores, and is the manual one.
  const own = new Set([...manual.accounts.map((a) => a.account_id), ...manual.unreadable, ...manual.unrecognised, ...manual.unavailable]);
  const live = new Set(items.map((i) => i.item_id));
  // LENIENT, for this display only: an import whose summary can't be read
  // covers nothing here, so a report says no less than without it.
  const covered = await importedCoverage(ctx, links).catch((err: unknown) => {
    console.error('Report: what imported files cover could not be read', err instanceof Error ? err.name : typeof err);
    return new Map<string, { from: string; to: string }[]>();
  });
  // LENIENT, for this display only: a directory that can't be read is said on
  // the report (a gap), never read as no removals.
  const directory = await removedConnections(ctx, live).catch((err: unknown) => {
    console.error('Report: the account directory could not be read', err instanceof Error ? err.name : typeof err);
    return null;
  });

  // Each stored connection's accounts: as it last reported them, and as the
  // directory saw them (an account seen there and not reported since still
  // counts as connected).
  const itemOf = new Map(items.map((i) => [i.item_id, i]));
  const liveAccounts: LiveAccountFacts[] = [];
  const holds = new Map<string, { investment: boolean; loans: boolean }>();
  for (const item of items) {
    const accounts = remembered.byItem[item.item_id] ?? [];
    const shown = accounts.filter((a) => !hidden.has(a.account_id));
    holds.set(item.item_id, { investment: shown.some((a) => isInvestmentType(a.type)), loans: shown.some((a) => a.type === 'loan') });
    for (const a of accounts) {
      liveAccounts.push({ account_id: a.account_id, institution_id: item.institution_id ?? null, institution_name: item.institution_name, mask: a.mask, type: a.type });
    }
  }
  const firstSeen = new Map<string, string>();
  for (const a of directory?.live ?? []) {
    const item = itemOf.get(a.item_id);
    if (item && !liveAccounts.some((l) => l.account_id === a.account_id)) {
      liveAccounts.push({ account_id: a.account_id, institution_id: item.institution_id ?? null, institution_name: item.institution_name, mask: a.mask, type: a.type });
    }
    const seen = firstSeen.get(a.item_id);
    if (!seen || a.first_seen < seen) firstSeen.set(a.item_id, a.first_seen);
  }

  // The connection each account is at now: an ended account's gaps are said
  // in its row too.
  const connectionOfAccount = new Map<string, string>();
  for (const item of items) for (const a of remembered.byItem[item.item_id] ?? []) connectionOfAccount.set(a.account_id, item.item_id);
  for (const a of directory?.live ?? []) if (itemOf.has(a.item_id) && !connectionOfAccount.has(a.account_id)) connectionOfAccount.set(a.account_id, a.item_id);
  // A SimpleFIN account's is its bank's card.
  for (const a of fed.accounts.values()) if (!own.has(a.account_id)) connectionOfAccount.set(a.account_id, connectorCardId(a));
  const lifecycle = lifecycleFacts(bank.lifecycle, hidden, (ids, item_id) => {
    for (const id of ids) {
      const item = connectionOfAccount.get(id);
      if (item) return item;
    }
    return item_id !== null && itemOf.has(item_id) ? item_id : null;
  });
  // A connection whose every account it is known to hold (not hidden) has
  // ended: the last of their ends, from which nothing of it counts.
  const endDay = endDays(bank.lifecycle);
  const accountsOf = new Map<string, Set<string>>();
  for (const [account_id, item_id] of connectionOfAccount) accountsOf.set(item_id, (accountsOf.get(item_id) ?? new Set()).add(account_id));
  const endedBy = (item_id: string): string | null => {
    const ids = [...(accountsOf.get(item_id) ?? [])].filter((id) => !hidden.has(id));
    if (ids.length === 0 || !ids.every((id) => endDay.has(id))) return null;
    return ids.map((id) => endDay.get(id)!).sort().at(-1)!;
  };

  const sources: SourceFacts[] = bank.sources.map((s) => {
    const f = facts.of(s.item_id);
    return {
      item_id: s.item_id,
      institution_name: s.institution_name,
      institution_id: itemOf.get(s.item_id)?.institution_id ?? null,
      coverage: s.coverage,
      synced_at: s.synced_at,
      first_date: s.first_date,
      first_seen: firstSeen.get(s.item_id) ?? null,
      never_synced: s.never_synced,
      no_transactions: s.no_transactions,
      last_ok_at: f.last_ok_at,
      problem: f.problem,
      records_unreadable: f.records_unreadable === true,
      holds: holds.get(s.item_id) ?? { investment: false, loans: false },
      // Its bank accounts and cards, as it last reported them, and those
      // that ended that it no longer reports (a bank stops returning a closed
      // account), not hidden, with what files imported into each cover and
      // the day each that ended stopped counting, up to which it needs them.
      accounts: coveredAccountsOf(s.item_id, remembered.byItem[s.item_id] ?? [], bank.lifecycle, covered, hidden).map(({ name, covers, end }) => ({ name, covers, end })),
      ended_by: endedBy(s.item_id),
      // Every bank account and card it is remembered to hold hidden (what its
      // rows are of, as for coveredAccountsOf; an investment account or a loan
      // beside them brings none): none of its rows is read, so how far back
      // they reach says nothing of the report.
      every_hidden: everyBankAccountHidden(remembered.byItem[s.item_id] ?? [], hidden),
    };
  });

  sources.push(...connectorSources(fed, hidden, period, endedBy));
  const gone = connectorEnded(letGo.entries, fed, hidden, period, own, endDay);
  const fedMissed = connectorMissed(letGo.entries, fed, hidden, period, own, endDay);

  const manualFacts: ManualFacts[] = toInstitutions(manual.accounts).flatMap((inst) =>
    inst.accounts
      .filter((a) => !hidden.has(a.account_id))
      .map((a) => ({ account_id: a.account_id, name: a.name, institution: inst.institution_name, type: a.type, updated_at: realTime(a.updated_at) }))
  );

  // A removed connection's hidden accounts would be left out anyway: nothing
  // missing from what was asked. One with every account hidden isn't listed.
  // A SimpleFIN account let go is known from its own record, whatever the
  // directory's read came to (a directory that can't be read is still said,
  // as removed_unknown).
  const removed: RemovedFacts[] = [
    ...(directory?.removed ?? []).flatMap((r) => {
      const accounts = r.accounts.filter((a) => !hidden.has(a.account_id));
      return accounts.length === 0
        ? []
        : [{ institution_name: r.institution_name, institution_id: r.institution_id, first_seen: r.first_seen, last_seen: r.last_seen, accounts }];
    }),
    ...gone.removed,
  ];

  return buildReport({
    period,
    generatedAt: new Date(now).toISOString(),
    rows: activity.transactions,
    currency: opts.currency ?? null,
    sources,
    notes: activity.unread_notes,
    caveatNotes: notesBesides(activity.notes, activity.unread_notes),
    manual: manualFacts,
    manualUnread: activity.manual_unread,
    removed,
    kept: gone.kept,
    removedUnreadable: (directory ? directory.unreadable : 1) + letGo.unreadable.length + letGo.unrecognised.length,
    liveAccounts,
    links: new Map([...links].map(([old, link]) => [old, link.to])),
    ownRead: bank.own_read,
    marked: settings.ok ? (settings.value?.marked ?? null) : null,
    markedUnreadable: !settings.ok,
    // The categories the rows were filed by, read without writing anything.
    taxonomy: activity.taxonomy,
    hidden: hidden.size > 0,
    healthUnread: facts.note !== null,
    appendixLimit: opts.appendixLimit,
    ended: lifecycle.ended,
    missed: [...lifecycle.missed, ...fedMissed],
  });
}

/** "My Bank (through SimpleFIN)": a bank a connection reaches, as a report
 *  names it, apart from a Plaid connection to the same bank. */
const throughName = (institution: string, label: string) => `${institution} (through ${label})`;

/**
 * Each bank a SimpleFIN connection reaches, as a report's institution (see
 * SIMPLEFIN in lib/report/build.ts), unless every account there is hidden:
 * its transactions as of the latest answer while its card is current (held
 * only for a card's question counts: that holds a balance, never rows), else
 * as of its last clean sync, so a request that failed, a problem SimpleFIN
 * reported or an old bank balance shows as a bank that hasn't synced since;
 * still importing only when the period starts before the history that has
 * come; and, when its connection's entry can't be read, when it last synced
 * isn't known. Every account there that had ended (`endedBy`) says so, as a
 * Plaid connection's do.
 */
function connectorSources(fed: ConnectorBanksReport, hidden: ReadonlySet<string>, period: Period, endedBy: (item_id: string) => string | null): SourceFacts[] {
  const label = connectorOf('simplefin').label;
  const out: SourceFacts[] = [];
  for (const card of fed.cards) {
    const shown = card.accounts.filter((a) => !hidden.has(a.account_id));
    if (shown.length === 0) continue;
    const conn = card.connection_id ? fed.connections.get(card.connection_id) : undefined;
    const unread = !!card.connection_id && fed.unreadableConnections.has(card.connection_id);
    const history = unread ? null : (conn?.history ?? null);
    const coverage: TxnCoverage = unread ? 'complete' : history === null ? 'missing' : !history.complete && history.from > period.start ? 'importing' : 'complete';
    const issue = card.health?.detail?.issue;
    const current = issue === 'ok' || issue === 'sign';
    const synced = unread ? null : current ? (conn?.last_answer_at ?? null) : (card.health?.last_ok_at ?? null);
    out.push({
      item_id: card.item_id,
      institution_name: throughName(card.institution_name, label),
      institution_id: null,
      coverage,
      synced_at: synced,
      first_date: history?.from ?? null,
      first_seen: conn ? dayIn(conn.created_at, period.time_zone) : null,
      never_synced: !unread && history === null,
      no_transactions: null,
      last_ok_at: unread ? null : (card.health?.last_ok_at ?? null),
      problem: null,
      records_unreadable: unread,
      // Their rows are all in the report, investment and loan accounts' too.
      holds: { investment: false, loans: false },
      ended_by: endedBy(card.item_id),
      connector: {
        label,
        host: conn?.host ?? card.health?.detail?.host ?? null,
        state: unread ? 'Its records couldn’t all be read' : card.health ? connectorBadge(card.health) : 'Not known',
        waiting: shown.filter((a) => {
          const raw = fed.accounts.get(a.account_id);
          return !!raw && needsSign(raw);
        }).map((a) => a.name),
      },
    });
  }
  return out;
}

/**
 * The days an account a SimpleFIN connection fed may be missing transactions
 * from although its bank's history covers them (see the header), on the days
 * it counts (before its end, or every day once it is reopened, since what
 * didn't come then won't come by itself), unless it is hidden:
 *   - one tracked that ended, the days answers moving its connection's
 *     history on left it out of and none has held it for since
 *     (lib/connectors/sync.ts ConnectorAccount `left_out`; one still open
 *     runs to the last day the history reached), as days it was missing from
 *     its bank's answer, under its bank;
 *   - one let go and kept by hand (`own`), not tracked again: those it had
 *     when it was let go, up to that day (from which its transactions are the
 *     ones entered or imported, said as `disconnected`); and the days its
 *     connection's history has reached back to since, before the first day
 *     it had then, which it was let go before (`let_go`).
 * One removed went with its transactions, which `removed` says.
 */
function connectorMissed(
  letGo: ReadonlyMap<string, EndedAccount>,
  fed: ConnectorBanksReport,
  hidden: ReadonlySet<string>,
  period: Period,
  own: ReadonlySet<string>,
  endDay: ReadonlyMap<string, string>
): MissedFacts[] {
  const label = connectorOf('simplefin').label;
  const out: MissedFacts[] = [];
  const say = (id: string, facts: Omit<MissedFacts, 'from' | 'to'>, from: string, to: string) => {
    const end = endDay.get(id);
    const last = end !== undefined && to >= end ? addDays(end, -1) : to;
    if (from <= last) out.push({ ...facts, from, to: last });
  };
  for (const a of fed.accounts.values()) {
    if (own.has(a.account_id) || hidden.has(a.account_id) || !a.left_out?.length) continue;
    const reached = fed.connections.get(a.connection_id)?.history?.to;
    const facts = { account: a.name, institution: throughName(a.institution_name, label), item_id: connectorCardId(a), type: a.type };
    for (const w of a.left_out) {
      const to = w.to ?? reached;
      if (to) say(a.account_id, facts, w.from, to);
    }
  }
  const tracked = new Set([...fed.accounts.values()].map((a) => `${fed.connections.get(a.connection_id)?.host ?? ''}\n${a.remote_id}`));
  for (const [id, e] of letGo) {
    if (!e.kept || !own.has(id) || hidden.has(id) || (e.host !== null && tracked.has(`${e.host}\n${e.remote_id}`))) continue;
    const facts = { account: e.name, institution: throughName(e.institution_name, label), item_id: null, type: e.type };
    const before = addDays(dayIn(e.ended_at, period.time_zone) ?? e.ended_at.slice(0, 10), -1);
    for (const w of e.left_out ?? []) {
      const to = w.to === null || w.to > before ? before : w.to;
      say(id, facts, w.from, to);
    }
    const history = fed.connections.get(e.connection_id)?.history;
    if (e.history_from && history && history.from < e.history_from) say(id, { ...facts, let_go: true }, history.from, addDays(e.history_from, -1));
  }
  return out;
}

/**
 * The accounts a SimpleFIN connection fed that the person let go
 * (connector-ended), but not hidden ones, nor one tracked again (the same
 * account on the same host: its own gaps say how far back it reaches now):
 * removed, its transactions gone with it, as a removed connection is, by
 * connection and bank; or kept as a manual account (`own`, still there), its
 * later transactions only the ones entered or imported, by bank and day, but
 * one that had ended by then (`endDay`, lib/lifecycle.ts), which counts on
 * none of them.
 */
function connectorEnded(
  ended: ReadonlyMap<string, EndedAccount>,
  fed: ConnectorBanksReport,
  hidden: ReadonlySet<string>,
  period: Period,
  own: ReadonlySet<string>,
  endDay: ReadonlyMap<string, string>
): { removed: RemovedFacts[]; kept: KeptFacts[] } {
  const label = connectorOf('simplefin').label;
  const tracked = new Set([...fed.accounts.values()].map((a) => `${fed.connections.get(a.connection_id)?.host ?? ''}\n${a.remote_id}`));
  const removed = new Map<string, RemovedFacts>();
  const kept = new Map<string, KeptFacts>();
  const dayOf = (iso: string) => dayIn(iso, period.time_zone) ?? iso.slice(0, 10);
  for (const [id, e] of [...ended].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Hidden: left out, as everywhere. Tracked again: back.
    if (hidden.has(id) || (e.host !== null && tracked.has(`${e.host}\n${e.remote_id}`))) continue;
    const institution = throughName(e.institution_name, label);
    const day = dayOf(e.ended_at);
    if (e.kept && own.has(id)) {
      const end = endDay.get(id);
      if (end !== undefined && end <= day) continue;
      const key = `${institution}\n${day}`;
      const k = kept.get(key) ?? { institution, since: day, accounts: [] };
      k.accounts.push(e.name);
      kept.set(key, k);
      continue;
    }
    const key = `${e.connection_id}\n${e.institution_name}`;
    const first = dayOf(e.tracked_at);
    const r = removed.get(key) ?? { institution_name: institution, institution_id: null, first_seen: first, last_seen: day, accounts: [] };
    if (first < r.first_seen) r.first_seen = first;
    if (day > r.last_seen) r.last_seen = day;
    // Removed, or kept and since deleted (its rows went with it).
    r.accounts.push({ account_id: id, name: e.name, mask: null, type: e.type });
    removed.set(key, r);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  return {
    removed: [...removed.values()].map((r) => ({ ...r, accounts: [...r.accounts].sort((a, b) => byName(a.name ?? '', b.name ?? '')) })),
    kept: [...kept.values()].map((k) => ({ ...k, accounts: [...k.accounts].sort(byName) })),
  };
}
