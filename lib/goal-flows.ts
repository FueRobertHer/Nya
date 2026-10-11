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
// WHERE A MONTH MAY BE SHORT (MonthGap), by the account's own connection
// (never its institution's name, which two connections can share): a
// connection that stopped syncing before the month ended, which makes every
// month that began after its last good sync unknown (no data at all is not
// nothing in), an institution still importing older transactions, and the
// month an account's transactions in Nya begin in. An account whose
// transactions couldn't be read is paced by its recorded balance, and says
// whose couldn't be read (AccountFlow.fallback).

import { ContainerError, type Ctx } from './containers';
import { readAccounts, type ApiAccount } from './api-read';
import { lastEndDay } from './lifecycle';
import { assembleBankRows, finishActivity } from './activity';
import { rememberedAccountsReport } from './last-known';
import { readMeasuredBalances } from './history';
import { sameAccountIds, type Link } from './links';
import { stoppedConnections } from './month-coverage';
import { localDate } from './local-date';
import { addDays } from './manual-txn-input';
import { addMonths, flowsFromBalances, flowsFromRows, lastDay, trailingMonths, MONTH_END_DAYS, type AccountFlow, type FlowRow, type MonthGap } from './goal-projection';
import type { KnownAccount } from './goal-save';
import type { GoalAccountEnd } from './goal-view';
import { loggable } from './log-safe';

/** An account's end (lib/lifecycle.ts), once it has come: from it the account
 *  counts in nothing, as the API's net worth has it. Null while it is open. */
export function accountEnd(a: Pick<ApiAccount, 'lifecycle'>): GoalAccountEnd | null {
  const l = a.lifecycle;
  if (!l || l.date > lastEndDay()) return null;
  return { state: l.state, on: l.date, ...(l.assumed ? { assumed: true } : {}) };
}

/** An account as the goals know it, from the read-only API's account. */
export const knownAccount = (a: ApiAccount): KnownAccount => ({
  account_id: a.id,
  name: a.name,
  institution: a.institution,
  balance: a.balance,
  currency: a.currency,
  type: a.type,
  hidden: a.hidden,
  ended: accountEnd(a),
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

/**
 * When an account's own connection stopped bringing transactions in: the
 * instant of its last good sync, or null when it has none recorded (it may
 * have stopped at any time); undefined while it is working. By the account's
 * own connection, never its institution's name: two connections can share a
 * name (lib/month-coverage.ts). A manual account has no connection.
 */
function stoppedSince(a: ApiAccount): string | null | undefined {
  const problem = a.connection?.problem;
  if (!problem) return undefined;
  const last = a.connection!.last_ok_at;
  const stopped = stoppedConnections([{ institution_name: a.institution, health: { state: problem.state, last_ok_at: last } }]);
  if (stopped.length === 0) return undefined;
  return last && !Number.isNaN(Date.parse(last)) ? last : null;
}

/** The days whose recorded balances end each month, for the months and the
 *  one before them. */
function monthEndDays(months: readonly string[]): string[] {
  const all = [addMonths(months[0], -1), ...months];
  return all.flatMap((m) => Array.from({ length: MONTH_END_DAYS }, (_, i) => addDays(lastDay(m), -i)));
}

/**
 * The last complete months before `month` (YYYY-MM: the viewer's own in the
 * app, UTC in the API) for each of `accounts` (lib/api-read.ts readAccounts),
 * as GoalFlows. A credit card or a loan has none, nor has an account that
 * ended (lib/lifecycle.ts): no goal counts one. Hidden accounts' rows are
 * read only when a hidden account is among `accounts`.
 * Storage that can't be reached throws; a part that can't be read is left out
 * and named in `notes`, and its months read as unknown, never as zero.
 */
export async function readGoalFlows(ctx: Ctx, opts: { month: string; accounts: readonly ApiAccount[]; links: ReadonlyMap<string, Link> }): Promise<GoalFlows> {
  const months = trailingMonths(opts.month);
  const links = opts.links as Map<string, Link>;
  const accounts = opts.accounts.filter((a) => !a.is_debt && !accountEnd(a));
  const flows = new Map<string, AccountFlow>();
  const notes: string[] = [];
  if (accounts.length === 0) return { months, flows, notes };

  const includeHidden = accounts.some((a) => a.hidden);
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden, withAccountIds: true });
  // The bank rows whose category the person chose, or carried across a
  // re-link (Txn.category_set): read before they are filed, which drops what
  // says so. A rule's category is marked on the row after (category_by_rule).
  // Either wins over Plaid's label, as everywhere (FlowRow.chosen).
  const chosen = new Set(bank.payload.transactions.filter((t) => t.category_set).map((t) => t.transaction_id));
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
  // What moved on each account (#39, lib/split-rows.ts): a group's
  // transactions each on its own account at its own amount, never the
  // group's net on one of them (a dinner on a card, its payback into
  // checking); a split transaction's parts, which add up to it, each filed
  // as the person filed it (a part's category is theirs; the difference the
  // bank made since is filed as the transaction is).
  const moved = activity.transactions.flatMap((t) => t.group_members ?? [t]);
  for (const t of moved) {
    if (!t.account_id) continue;
    const list = rowsOf.get(t.account_id) ?? [];
    const own = t.split_of !== undefined && !t.split_remainder;
    list.push({
      date: t.date,
      amount: t.amount,
      pending: t.pending,
      account_id: t.account_id,
      subcategory: t.subcategory,
      category: t.category,
      ...(own || chosen.has(t.split_of ?? t.transaction_id) || t.category_by_rule ? { chosen: true } : {}),
    });
    rowsOf.set(t.account_id, list);
  }
  const unread = activity.manual_unread;
  // The banks of a SimpleFIN connection still bringing in older history, by
  // name (a Plaid institution's is its Item's coverage, below).
  const fedImporting = new Set(activity.incomplete.filter((i) => i.coverage === 'importing').map((i) => i.institution_name));

  const byBalances: { account: ApiAccount; fallback?: AccountFlow['fallback'] }[] = [];
  for (const a of accounts) {
    const ids = sameAccountIds(a.id, links);
    const rows = ids.flatMap((id) => rowsOf.get(id) ?? []);
    const item = a.source === 'plaid' ? sources.get(itemOf.get(a.id) ?? '') : undefined;
    // Its transactions couldn't be read: a manual account's book, or its
    // Item's stored rows (missing from the read, though stored before).
    const bookUnread = a.source !== 'plaid' && (unread === 'all' || unread.includes(a.id));
    const itemUnread = !!item && item.coverage === 'missing' && !item.never_synced;
    if (bookUnread || itemUnread) {
      byBalances.push({ account: a, fallback: { unreadable: itemUnread ? item!.institution_name : a.name } });
      continue;
    }
    const firstRow = rows.length > 0 ? rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date) : null;
    const quiet = !!item && item.no_transactions === null && !item.never_synced && item.coverage !== 'missing' && !!item.first_date && item.first_date <= `${months[0]}-01`;
    if (rows.length === 0 && !quiet) {
      byBalances.push({ account: a });
      continue;
    }
    const start = item?.first_date ?? firstRow;
    const flow: AccountFlow = { source: 'transactions', months: flowsFromRows(rows, new Set(ids), months, { start, currency: a.currency }) };
    const importing = a.source === 'plaid' ? item?.coverage === 'importing' : fedImporting.has(a.institution);
    const stoppedAt = stoppedSince(a);
    for (const m of flow.months) {
      const gaps: MonthGap[] = [];
      if (stoppedAt !== undefined) {
        const lastOk = stoppedAt === null ? null : localDate(new Date(stoppedAt));
        // A month that began after the last good sync has no data at all:
        // unknown, never zero. The month it stopped in is partly known.
        if (lastOk !== null && lastOk < `${m.month}-01`) m.amount = null;
        if (lastOk === null || lastOk < `${addMonths(m.month, 1)}-01`) gaps.push({ kind: 'stopped', institution: a.institution, since: stoppedAt });
      }
      if (importing && m.amount !== null) gaps.push({ kind: 'importing', institution: a.institution });
      if (gaps.length > 0) m.gaps = [...(m.gaps ?? []), ...gaps];
    }
    flows.set(a.id, flow);
  }

  if (byBalances.length > 0) {
    const { balances, unreadable } = await readMeasuredBalances(ctx, monthEndDays(months));
    if (unreadable.length > 0) notes.push('Some recorded balances couldn’t be read, so a month whose end they hold reads as unknown');
    for (const { account: a, fallback } of byBalances) {
      const ids = sameAccountIds(a.id, links);
      const points: { date: string; value: number }[] = [];
      for (const [date, map] of balances) {
        const id = ids.find((i) => typeof map[i] === 'number');
        if (id !== undefined) points.push({ date, value: map[id] });
      }
      flows.set(a.id, { source: 'balances', months: flowsFromBalances(points, months, a.currency), ...(fallback ? { fallback } : {}) });
    }
  }
  return { months, flows, notes };
}
