// lib/goal-flows.ts
//
// The months behind a goal's pace (#42), gathered on the server from stored
// data: for each account, what went into it over its last complete months
// (lib/goal-projection.ts says what counts). Read only: Plaid is never asked
// and nothing is written, so the Goals card and the read-only API can read it
// as often as they like.
//
// WHERE EACH ACCOUNT'S FIGURES COME FROM:
//   - its transactions, through the Activity tab's own assembly
//     (lib/activity.ts assembleBankRows and finishActivity: the rows of every
//     bank, every manual account and every account SimpleFIN feeds, each with
//     its account id), when Nya has any for it; or when it has none but its
//     bank brings transactions in and has since before the months averaged
//     (a quiet savings account: nothing went in, which is not the same as
//     not knowing);
//   - otherwise its recorded balances (lib/history.ts readMeasuredBalances:
//     measured only, never an estimate): an investment account, a connection
//     that brings in balances only, a manual account with no transactions
//     entered, or one whose transactions couldn't be read.
// An account reconnected under a new id reads its earlier ids too
// (lib/links.ts sameAccountIds): a transaction or a balance recorded under one
// is the same account's.
//
// WHERE A MONTH MAY BE SHORT (MonthGap), as Activity says it of its months
// (lib/month-coverage.ts): an institution whose transactions couldn't be
// loaded or are still importing, a connection that stopped syncing before the
// month ended, and the month an account's transactions in Nya begin in.

import { ContainerError, type Ctx } from './containers';
import { readAccounts, type ApiAccount } from './api-read';
import { assembleBankRows, finishActivity } from './activity';
import { rememberedAccountsReport } from './last-known';
import { readMeasuredBalances } from './history';
import { sameAccountIds, type Link } from './links';
import { monthGaps, stoppedConnections, type Stopped } from './month-coverage';
import { addDays } from './manual-txn-input';
import { addMonths, flowsFromBalances, flowsFromRows, lastDay, trailingMonths, MONTH_END_DAYS, type AccountFlow, type FlowRow, type MonthGap } from './goal-projection';
import type { KnownAccount } from './goal-save';
import { loggable } from './log-safe';

/** An account as the goals know it, from the read-only API's account. */
export const knownAccount = (a: ApiAccount): KnownAccount => ({
  account_id: a.id,
  name: a.name,
  institution: a.institution,
  balance: a.balance,
  currency: a.currency,
  type: a.type,
  hidden: a.hidden,
  as_of: a.as_of,
});

/**
 * Every account as the server knows it, hidden ones too: the newest balance it
 * measured, from stored data alone (lib/api-read.ts readAccounts), for a
 * save's checks (lib/goal-save.ts). Null when they can't be read, which
 * refuses a new allocation and leaves what the save works out unknown, rather
 * than stopping a save that needs none of it. A container that can't be used
 * still throws.
 */
export async function knownGoalAccounts(ctx: Ctx): Promise<Map<string, KnownAccount> | null> {
  try {
    const { accounts } = await readAccounts(ctx, { includeHidden: true });
    return new Map(accounts.map((a) => [a.id, knownAccount(a)]));
  } catch (err) {
    if (err instanceof ContainerError) throw err;
    console.error('Goals: the accounts could not be read for a save', loggable(err));
    return null;
  }
}

export type GoalFlows = {
  /** The complete months averaged, oldest first. */
  months: string[];
  /** Each account's months, by its id now. */
  flows: Map<string, AccountFlow>;
  /** What couldn't be read, in words. */
  notes: string[];
};

/** The days whose recorded balances end each month, for the months and the
 *  one before them. */
function monthEndDays(months: readonly string[]): string[] {
  const all = [addMonths(months[0], -1), ...months];
  return all.flatMap((m) => Array.from({ length: MONTH_END_DAYS }, (_, i) => addDays(lastDay(m), -i)));
}

/**
 * The last complete months before `month` (YYYY-MM: the viewer's own in the
 * app, UTC in the API) for each of `accounts` (lib/api-read.ts readAccounts),
 * as GoalFlows. A credit card or a loan has none: no goal counts one. Hidden
 * accounts' rows are read only when a hidden account is among `accounts`.
 * Storage that can't be reached throws; a part that can't be read is left out
 * and named in `notes`, and its months read as unknown, never as zero.
 */
export async function readGoalFlows(ctx: Ctx, opts: { month: string; accounts: readonly ApiAccount[]; links: ReadonlyMap<string, Link> }): Promise<GoalFlows> {
  const months = trailingMonths(opts.month);
  const links = opts.links as Map<string, Link>;
  const accounts = opts.accounts.filter((a) => !a.is_debt);
  const flows = new Map<string, AccountFlow>();
  const notes: string[] = [];
  if (accounts.length === 0) return { months, flows, notes };

  const includeHidden = accounts.some((a) => a.hidden);
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden, withAccountIds: true });
  const [activity, remembered] = await Promise.all([
    finishActivity(ctx, bank.payload, includeHidden ? new Set() : bank.hidden),
    // Only which Item each account is at, for when its rows begin: without
    // it, an account's own first row says.
    rememberedAccountsReport(ctx).catch(() => null),
  ]);
  const itemOf = new Map<string, string>();
  for (const [item, list] of Object.entries(remembered?.byItem ?? {})) for (const a of list) itemOf.set(a.account_id, item);
  const sources = new Map(bank.sources.map((s) => [s.item_id, s]));
  const rowsOf = new Map<string, FlowRow[]>();
  for (const t of activity.transactions) {
    if (!t.account_id) continue;
    const list = rowsOf.get(t.account_id) ?? [];
    list.push(t);
    rowsOf.set(t.account_id, list);
  }
  const unread = activity.manual_unread;
  // Connections whose transactions stopped arriving, once per institution.
  const stopped: Stopped[] = [];
  for (const s of stoppedConnections(
    opts.accounts.flatMap((a) =>
      a.connection?.problem ? [{ institution_name: a.institution, health: { state: a.connection.problem.state, last_ok_at: a.connection.last_ok_at } }] : []
    )
  )) {
    if (!stopped.some((o) => o.institution_name === s.institution_name)) stopped.push(s);
  }

  const byBalances: ApiAccount[] = [];
  for (const a of accounts) {
    const ids = sameAccountIds(a.id, links);
    const rows = ids.flatMap((id) => rowsOf.get(id) ?? []);
    const bookUnread = a.source !== 'plaid' && (unread === 'all' || unread.includes(a.id));
    if (bookUnread) notes.push(`${a.name}: its transactions couldn’t be read, so its pace is from its recorded balance`);
    const item = a.source === 'plaid' ? sources.get(itemOf.get(a.id) ?? '') : undefined;
    const firstRow = rows.length > 0 ? rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date) : null;
    const quiet = !!item && item.no_transactions === null && !item.never_synced && item.coverage !== 'missing' && !!item.first_date && item.first_date <= `${months[0]}-01`;
    if (bookUnread || (rows.length === 0 && !quiet)) {
      byBalances.push(a);
      continue;
    }
    const start = item?.first_date ?? firstRow;
    const flow: AccountFlow = { source: 'transactions', months: flowsFromRows(rows, new Set(ids), months, { start, currency: a.currency }) };
    for (const m of flow.months) {
      if (m.amount === null) continue;
      const gaps = monthGaps(m.month, activity.incomplete, stopped);
      const extra: MonthGap[] = [
        ...(gaps.missing.includes(a.institution) ? [{ kind: 'missing' as const, institution: a.institution }] : []),
        ...(gaps.importing.includes(a.institution) ? [{ kind: 'importing' as const, institution: a.institution }] : []),
        ...gaps.stopped.filter((s) => s.institution_name === a.institution).map((s) => ({ kind: 'stopped' as const, institution: a.institution, since: s.last_ok_at })),
      ];
      if (extra.length > 0) m.gaps = [...(m.gaps ?? []), ...extra];
    }
    flows.set(a.id, flow);
  }

  if (byBalances.length > 0) {
    const { balances, unreadable } = await readMeasuredBalances(ctx, monthEndDays(months));
    if (unreadable.length > 0) notes.push('Some recorded balances couldn’t be read, so a month whose end they hold reads as unknown');
    for (const a of byBalances) {
      const ids = sameAccountIds(a.id, links);
      const points: { date: string; value: number }[] = [];
      for (const [date, map] of balances) {
        const id = ids.find((i) => typeof map[i] === 'number');
        if (id !== undefined) points.push({ date, value: map[id] });
      }
      flows.set(a.id, { source: 'balances', months: flowsFromBalances(points, months, a.currency) });
    }
  }
  return { months, flows, notes };
}
