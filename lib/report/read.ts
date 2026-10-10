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
//     outlives a disconnect (lib/links.ts removedConnections);
//   - the categories the person marked (lib/report/store.ts).
//
// READ ONLY, and for display: nothing here writes, deletes or records anything
// on what it reads (readOnly). Every read that can't be made is said on the
// report, never passed off as nothing to say: connections' health that can't
// be read, a directory that can't, marked categories that can't (the group is
// left out, and the report says why), and whatever the assembly couldn't read
// (its notes, which the report lists as gaps). Storage that can't be reached
// at all fails the whole report.

import type { Ctx } from '../containers';
import { getItems } from '../storage';
import { assembleBankRows, finishActivity } from '../activity';
import { connectionFacts } from '../api-read';
import { getManualAccountsReport, toInstitutions } from '../manual';
import { removedConnections } from '../links';
import { StoredDataUnreadableError } from '../repo';
import { reportSettingsStore } from './store';
import { buildReport, type ManualFacts, type RemovedFacts, type Report, type SourceFacts } from './build';
import type { Period } from './period';

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
  const [activity, facts, manual, items, settings] = await Promise.all([
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
  ]);
  const hidden = bank.hidden;
  const live = new Set(items.map((i) => i.item_id));
  // LENIENT, for this display only: a directory that can't be read is said on
  // the report (removed_unread), never read as no removals.
  const directory = await removedConnections(ctx, live).catch((err: unknown) => {
    console.error('Report: the account directory could not be read', err instanceof Error ? err.name : typeof err);
    return null;
  });

  const idOf = new Map(items.map((i) => [i.item_id, i.institution_id ?? null]));
  const sources: SourceFacts[] = bank.sources.map((s) => {
    const f = facts.of(s.item_id);
    return {
      item_id: s.item_id,
      institution_name: s.institution_name,
      institution_id: idOf.get(s.item_id) ?? null,
      coverage: s.coverage,
      synced_at: s.synced_at,
      first_date: s.first_date,
      no_transactions: s.no_transactions,
      last_ok_at: f.last_ok_at,
      problem: f.problem,
      records_unreadable: f.records_unreadable === true,
    };
  });

  const manualFacts: ManualFacts[] = toInstitutions(manual.accounts).flatMap((inst) =>
    inst.accounts
      .filter((a) => !hidden.has(a.account_id))
      .map((a) => ({ account_id: a.account_id, name: a.name, institution: inst.institution_name, updated_at: realTime(a.updated_at) }))
  );

  // A removed connection whose every account is hidden would be left out
  // anyway: nothing missing from what was asked.
  const removed: RemovedFacts[] | null = directory
    ? directory.removed
        .filter((r) => !r.account_ids.every((id) => hidden.has(id)))
        .map((r) => ({ institution_name: r.institution_name, institution_id: r.institution_id, first_seen: r.first_seen, last_seen: r.last_seen }))
    : null;

  return buildReport({
    period,
    generatedAt: new Date(now).toISOString(),
    rows: activity.transactions,
    currency: opts.currency ?? null,
    sources,
    notes: activity.notes,
    manual: manualFacts,
    removed,
    removedUnreadable: directory?.unreadable ?? 0,
    marked: settings.ok ? (settings.value?.marked ?? null) : null,
    markedUnreadable: !settings.ok,
    hidden: hidden.size > 0,
    healthUnread: facts.note !== null,
    appendixLimit: opts.appendixLimit,
  });
}
