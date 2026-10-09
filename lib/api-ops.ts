// lib/api-ops.ts
//
// The read-only API's operations: each one's declaration (lib/api-spec.ts:
// its path, summary and arguments) with what it runs, a thin call into the
// read layer (lib/api-read.ts), which does all the reading. A REST endpoint
// (app/api/v1, through lib/api-http.ts) and an MCP tool (lib/mcp.ts) both run
// these, so the two take the same arguments the same way and answer alike.
// Defaults and the checks between arguments (from before to, a month or a
// range) are applied here, once.

import { createHash } from 'node:crypto';
import type { Authenticated } from './api-tokens';
import { isCalendarDay } from './manual-txn-input';
import {
  readMe,
  readAccounts,
  readNetWorth,
  readBalanceHistory,
  queryTransactions,
  readCategories,
  readBudgets,
  readSpending,
  readRecurring,
  readHoldings,
  firstDay,
  type Interval,
  type PageKey,
} from './api-read';
import { DEFAULT_PAGE_SIZE } from './api-limits';
import { OPERATION_SPECS, BadRequest, NotFound, type Args, type OperationSpec } from './api-spec';

export { argsFromQuery, argsFromJson, inputSchema, BadRequest, NotFound, type Arg, type Args } from './api-spec';

export type Operation = OperationSpec & {
  run: (auth: Authenticated, args: Args) => Promise<unknown>;
};

// ---- Pages of transactions ----

/** What a cursor is bound to: the query it was made for, so it can't be
 *  carried to another. */
function fingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 16);
}

/** A cursor: where the page before ended, and the query it belongs to.
 *  Opaque to callers (base64url JSON). */
function encodeCursor(key: PageKey, print: string): string {
  return Buffer.from(JSON.stringify([key.date, key.datetime, key.id, print])).toString('base64url');
}

function decodeCursor(cursor: string, print: string): PageKey {
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parts = null;
  }
  if (!Array.isArray(parts) || parts.length !== 4 || !isCalendarDay(parts[0]) || !parts.slice(1).every((p) => typeof p === 'string' && p.length <= 200)) {
    throw new BadRequest('cursor is not one this API gave.');
  }
  if (parts[3] !== print) throw new BadRequest('cursor belongs to another query: ask again with the same parameters, or without one.');
  return { date: parts[0], datetime: parts[1], id: parts[2] };
}

// ---- What each runs ----

const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
const lastOfMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

const flag = (a: Args, name: string) => a[name] === true;
const str = (a: Args, name: string) => a[name] as string | undefined;
const num = (a: Args, name: string) => a[name] as number | undefined;

/** from and to, in order, defaulting to the `days` days up to today. */
function range(a: Args, days: number): { from: string; to: string } {
  const to = str(a, 'to') ?? today();
  const from = str(a, 'from') ?? daysBefore(to, days);
  if (from > to) throw new BadRequest('from is after to.');
  return { from, to };
}

const RUNS: Record<string, Operation['run']> = {
  me: async (auth) => readMe(auth),

  accounts: async (auth, a) => readAccounts(auth.ctx, { includeHidden: flag(a, 'include_hidden') }),

  'net-worth': async (auth, a) => readNetWorth(auth.ctx, { includeHidden: flag(a, 'include_hidden') }),

  'balance-history': async (auth, a) => {
    if (str(a, 'from') && str(a, 'to') && str(a, 'from')! > str(a, 'to')!) throw new BadRequest('from is after to.');
    const history = await readBalanceHistory(auth.ctx, {
      accountId: str(a, 'account_id'),
      from: str(a, 'from'),
      to: str(a, 'to'),
      includeEstimated: flag(a, 'include_estimated'),
      includeHidden: flag(a, 'include_hidden'),
      interval: (str(a, 'interval') as Interval | undefined) ?? 'day',
    });
    if (!history) throw new NotFound('That account is hidden: ask with include_hidden=true to see it.');
    return history;
  },

  transactions: async (auth, a) => {
    const { from, to } = range(a, 30);
    const min = num(a, 'min_amount');
    const max = num(a, 'max_amount');
    if (min !== undefined && max !== undefined && min > max) throw new BadRequest('min_amount is more than max_amount.');
    const accountIds = a.account_id as string[] | undefined;
    const includeHidden = flag(a, 'include_hidden');
    const text = str(a, 'q');
    const category = str(a, 'category');
    const print = fingerprint([from, to, accountIds ? [...new Set(accountIds)].sort() : null, includeHidden, text ?? null, category?.toLowerCase() ?? null, min ?? null, max ?? null]);
    const cursor = str(a, 'cursor');
    const page = await queryTransactions(auth.ctx, {
      from,
      to,
      accountIds: accountIds ? new Set(accountIds) : undefined,
      includeHidden,
      text,
      category,
      minAmount: min,
      maxAmount: max,
      limit: num(a, 'limit') ?? DEFAULT_PAGE_SIZE,
      after: cursor ? decodeCursor(cursor, print) : null,
    });
    const notes = [...page.notes];
    if (from < firstDay()) notes.push(`Only transactions from ${firstDay()} on are read, as the app shows them; the data download has every one stored.`);
    return {
      from,
      to,
      transactions: page.transactions,
      has_more: page.next !== null,
      next_cursor: page.next ? encodeCursor(page.next, print) : null,
      sources: page.sources,
      notes,
    };
  },

  categories: async (auth, a) => readCategories(auth.ctx, { includeHidden: flag(a, 'include_hidden') }),

  budgets: async (auth, a) => readBudgets(auth.ctx, { month: str(a, 'month') ?? today().slice(0, 7), includeHidden: flag(a, 'include_hidden') }),

  spending: async (auth, a) => {
    const month = str(a, 'month');
    if (month && (str(a, 'from') || str(a, 'to'))) throw new BadRequest('Give a month, or from and to, not both.');
    let from: string;
    let to: string;
    if (str(a, 'from') || str(a, 'to')) ({ from, to } = range(a, 30));
    else {
      const m = month ?? today().slice(0, 7);
      [from, to] = [`${m}-01`, lastOfMonth(m)];
    }
    return readSpending(auth.ctx, { from, to, currency: str(a, 'currency'), includeHidden: flag(a, 'include_hidden') });
  },

  recurring: async (auth, a) => readRecurring(auth.ctx, { includeHidden: flag(a, 'include_hidden') }),

  holdings: async (auth, a) => readHoldings(auth.ctx, { includeHidden: flag(a, 'include_hidden') }),
};

export const OPERATIONS: readonly Operation[] = OPERATION_SPECS.map((spec) => {
  const run = RUNS[spec.name];
  if (!run) throw new Error(`The API operation ${spec.name} has nothing to run`);
  return { ...spec, run };
});

/** An operation by its path. */
export function operation(name: string): Operation {
  const found = OPERATIONS.find((o) => o.name === name);
  if (!found) throw new Error(`No API operation is called ${name}`);
  return found;
}
