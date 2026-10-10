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
//   - the categories the person marked (lib/report/store.ts).
//
// READ ONLY, and for display: nothing here writes, deletes or records anything
// on what it reads (readOnly). Every read that can't be made is said on the
// report, never passed off as nothing to say: connections' health that can't
// be read, a directory that can't, marked categories that can't (the group is
// left out, and the report says why), the person's own categories, names and
// carried exclusions that can't (the assembly's own_read), each manual
// account whose rows can't (never counted as having none), and whatever else
// the assembly couldn't read (its notes, which the report lists as gaps).
// Storage that can't be reached at all fails the whole report.

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
import { reportSettingsStore } from './store';
import { buildReport, type KeptFacts, type LiveAccountFacts, type ManualFacts, type RemovedFacts, type Report, type SourceFacts } from './build';
import { dayIn, type Period } from './period';
import { connectorBanksReport, needsSign, type ConnectorBanksReport } from '../connectors/institutions';
import { connectorBadge } from '../connectors/health';
import { endedAccountsStore, type EndedAccount } from '../connectors/store';
import { connectorOf } from '../connectors/registry';
import type { TxnCoverage } from '../transactions';

/** An instant a record holds, unless it is the stand-in a reader puts where a
 *  record had none (lib/manual.ts writes 1970-01-01). */
const realTime = (iso: string | null | undefined): string | null => (iso && Date.parse(iso) > 0 ? iso : null);

export async function readReport(
  ctx: Ctx,
  period: Period,
  opts: { currency?: string | null; now?: number; appendixLimit?: number } = {}
): Promise<Report> {
  const now = opts.now ?? Date.now();
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, since: period.start });
  const [activity, facts, manual, items, settings, remembered, links, fed, ended] = await Promise.all([
    finishActivity(ctx, bank.payload, bank.hidden, { since: period.start }),
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
    // its banks saying when they last synced isn't known.
    connectorBanksReport(ctx, now),
    // LENIENT, for this display only: one that can't be read is said, as a
    // directory entry is (removed_unknown).
    endedAccountsStore.getAllReport(ctx),
  ]);
  const hidden = bank.hidden;
  const live = new Set(items.map((i) => i.item_id));
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
    };
  });

  sources.push(...connectorSources(fed, hidden, period));
  const gone = connectorEnded(ended.entries, fed, hidden, period, new Set([...manual.accounts.map((a) => a.account_id), ...manual.unreadable, ...manual.unrecognised, ...manual.unavailable]));

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
    notes: activity.notes,
    manual: manualFacts,
    manualUnread: activity.manual_unread,
    removed,
    kept: gone.kept,
    removedUnreadable: (directory ? directory.unreadable : 1) + ended.unreadable.length + ended.unrecognised.length,
    liveAccounts,
    links: new Map([...links].map(([old, link]) => [old, link.to])),
    ownRead: bank.own_read,
    marked: settings.ok ? (settings.value?.marked ?? null) : null,
    markedUnreadable: !settings.ok,
    hidden: hidden.size > 0,
    healthUnread: facts.note !== null,
    appendixLimit: opts.appendixLimit,
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
 * isn't known.
 */
function connectorSources(fed: ConnectorBanksReport, hidden: ReadonlySet<string>, period: Period): SourceFacts[] {
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
 * The accounts a SimpleFIN connection fed that the person let go
 * (connector-ended), but not hidden ones, nor one tracked again (the same
 * account on the same host: its own gaps say how far back it reaches now):
 * removed, its transactions gone with it, as a removed connection is, by
 * connection and bank; or kept as a manual account (`own`, still there), its
 * later transactions only the ones entered or imported, by bank and day.
 */
function connectorEnded(
  ended: ReadonlyMap<string, EndedAccount>,
  fed: ConnectorBanksReport,
  hidden: ReadonlySet<string>,
  period: Period,
  own: ReadonlySet<string>
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
