// lib/history-import/without-files.ts
//
// What the files imported into a connection's bank accounts and cards (#52)
// cover, for the connections whose transactions don't come in: those Plaid
// doesn't provide for, and those the person didn't allow (lib/item-products.ts
// `refused`, `no_consent`). Sent with each of them to the Activity tab
// (app/api/transactions, `without_transactions`), so a month the files cover
// for every one of its bank accounts and cards isn't said to be missing its
// transactions, under the month's totals or beside the cash flow chart
// (lib/no-transactions.ts coveredOutOf), by the rule a report's gaps
// (lib/report/build.ts IMPORTED) and the months budget rollover counts
// (lib/budget-month.ts, lib/rollover.ts Filed) follow: lib/history-import/
// coverage.ts filesCoverAll, with each account's days read as both of those
// read them (lib/history-import/read.ts coveredAccountsOf: hidden accounts
// need no covering, and one that ended only up to its end).
//
// LENIENT, for display only, as a report and rollover read them: what can't
// be read (the links, an import's summary, a connection's accounts, the
// hidden set, an account's end) covers nothing here, so a month is never
// said to be more complete for it; the note says it may be missing them, as
// before. Nothing more is read while no such connection has an id, or while
// no file was imported into any account.

import type { Ctx } from '../containers';
import { readLinks } from '../link-core';
import { getEffectiveHidden } from '../links';
import { getEffectiveLifecycle } from '../lifecycle';
import { rememberedAccountsReport } from '../last-known';
import { loggable } from '../log-safe';
import type { WithoutTransactions } from '../no-transactions';
import { coveredAccountsOf, importedCoverage } from './read';

/** Whether a connection's transactions exist and don't come in: what files
 *  imported into its accounts can stand for. */
const standsIn = (w: WithoutTransactions): boolean => (w.reason === 'refused' || w.reason === 'no_consent') && !!w.item_id;

/**
 * The connections without transactions, each that doesn't bring its
 * transactions in with its bank accounts and cards (`files`) as the files
 * imported into them cover them, when any was imported into one (see the
 * header). Never throws: what can't be read leaves `files` off.
 */
export async function withImportedFiles(ctx: Ctx, without: readonly WithoutTransactions[]): Promise<WithoutTransactions[]> {
  if (!without.some(standsIn)) return [...without];
  try {
    const covered = await importedCoverage(ctx, (await readLinks(ctx)).links);
    if (covered.size === 0) return [...without];
    const [remembered, effective] = await Promise.all([rememberedAccountsReport(ctx), getEffectiveHidden(ctx, { readOnly: true })]);
    const lifecycle = await getEffectiveLifecycle(ctx, effective.links);
    const hidden = new Set(effective.hidden.keys());
    return without.map((w) => {
      if (!standsIn(w) || remembered.unreadable.includes(w.item_id!)) return w;
      const accounts = coveredAccountsOf(w.item_id!, remembered.byItem[w.item_id!] ?? [], lifecycle, covered, hidden);
      return accounts.some((a) => a.covers.length > 0) ? { ...w, files: accounts.map(({ covers, end }) => ({ covers, end })) } : w;
    });
  } catch (err) {
    console.error('Activity: what imported files cover could not be read', loggable(err));
    return [...without];
  }
}
