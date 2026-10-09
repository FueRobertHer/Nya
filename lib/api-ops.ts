// lib/api-ops.ts
//
// The read-only API's operations, each with its arguments declared once: what
// a REST endpoint (app/api/v1, through lib/api-http.ts) and an MCP tool
// (lib/mcp.ts) both run. From the one declaration come the REST query's
// parsing (strings), an MCP tool's input schema and its validation (JSON), so
// the two take the same arguments the same way, and each operation is a thin
// call into the read layer (lib/api-read.ts), which does all the reading.
//
// Validation is strict on both sides: an argument an operation doesn't take
// is refused, as is one given twice or out of its range, never ignored or
// guessed at.

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
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './api-limits';

/** An argument refused: 400 with its message (REST), or a tool's error (MCP). */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

/** What was asked for isn't there: 404. */
export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
  }
}

/** The kinds of argument the API takes. */
export type Arg = { description: string } & (
  | { kind: 'day' }
  | { kind: 'month' }
  | { kind: 'flag' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'amount' }
  | { kind: 'text'; max: number }
  | { kind: 'choice'; values: readonly string[] }
  /** Account ids: a comma-separated list in a query, a list (or one) in JSON. */
  | { kind: 'ids'; max: number }
  | { kind: 'id' }
  | { kind: 'currency' }
  | { kind: 'cursor' }
);

export type Operation = {
  /** Its path under /api/v1. */
  name: string;
  /** What it answers, in a line. */
  summary: string;
  args: Readonly<Record<string, Arg>>;
  run: (auth: Authenticated, args: Args) => Promise<unknown>;
};

/** Arguments as checked: each of its declared type, absent when not given. */
export type Args = Record<string, string | number | boolean | string[] | undefined>;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
/** An ISO code, or Plaid's unofficial one (a cryptocurrency's). */
const CURRENCY = /^[A-Z0-9]{2,10}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,600}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_AMOUNT = 1e13;

const fail = (name: string, arg: Arg): never => {
  const what: Record<Arg['kind'], string> = {
    day: 'a date, YYYY-MM-DD',
    month: 'a month, YYYY-MM',
    flag: 'true or false',
    int: arg.kind === 'int' ? `a whole number from ${arg.min} to ${arg.max}` : '',
    amount: 'an amount, like 25 or -12.5',
    text: arg.kind === 'text' ? `text of 1 to ${arg.max} characters` : '',
    choice: arg.kind === 'choice' ? `one of: ${arg.values.join(', ')}` : '',
    ids: arg.kind === 'ids' ? `up to ${arg.max} account ids` : '',
    id: 'an account id',
    currency: 'a currency code, like USD',
    cursor: 'a cursor from the page before',
  };
  throw new BadRequest(`${name} is ${what[arg.kind]}.`);
};

const textOk = (s: string, max: number) => s.length > 0 && s.length <= max && !CONTROL.test(s);

/** One query parameter, from its text. */
function fromText(name: string, arg: Arg, raw: string): Args[string] {
  switch (arg.kind) {
    case 'day':
      return isCalendarDay(raw) ? raw : fail(name, arg);
    case 'month':
      return MONTH.test(raw) ? raw : fail(name, arg);
    case 'flag':
      return raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : fail(name, arg);
    case 'int':
      return /^\d{1,9}$/.test(raw) && Number(raw) >= arg.min && Number(raw) <= arg.max ? Number(raw) : fail(name, arg);
    case 'amount':
      return /^-?\d{1,13}(\.\d{1,8})?$/.test(raw) ? Number(raw) : fail(name, arg);
    case 'text': {
      const t = raw.trim();
      return textOk(t, arg.max) ? t : fail(name, arg);
    }
    case 'choice':
      return arg.values.includes(raw) ? raw : fail(name, arg);
    case 'ids': {
      const ids = raw.split(',').map((s) => s.trim());
      return ids.length <= arg.max && ids.every((id) => ID.test(id)) ? ids : fail(name, arg);
    }
    case 'id':
      return ID.test(raw) ? raw : fail(name, arg);
    case 'currency':
      return CURRENCY.test(raw) ? raw : fail(name, arg);
    case 'cursor':
      return CURSOR.test(raw) ? raw : fail(name, arg);
  }
}

/** One JSON argument (an MCP tool's). */
function fromJson(name: string, arg: Arg, v: unknown): Args[string] {
  switch (arg.kind) {
    case 'flag':
      return typeof v === 'boolean' ? v : fail(name, arg);
    case 'int':
      return typeof v === 'number' && Number.isInteger(v) && v >= arg.min && v <= arg.max ? v : fail(name, arg);
    case 'amount':
      return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_AMOUNT ? v : fail(name, arg);
    case 'ids': {
      const ids = typeof v === 'string' ? [v] : v;
      return Array.isArray(ids) && ids.length > 0 && ids.length <= arg.max && ids.every((id) => typeof id === 'string' && ID.test(id)) ? (ids as string[]) : fail(name, arg);
    }
    default:
      return typeof v === 'string' ? fromText(name, arg, v) : fail(name, arg);
  }
}

/** An operation's arguments from a REST query: each at most once, and none
 *  the operation doesn't take. */
export function argsFromQuery(op: Operation, params: URLSearchParams): Args {
  const out: Args = {};
  for (const name of new Set(params.keys())) {
    const arg = op.args[name];
    if (!arg) throw new BadRequest(`Unknown parameter: ${name.slice(0, 40)}. This endpoint takes ${Object.keys(op.args).join(', ') || 'none'}.`);
    const values = params.getAll(name);
    if (values.length > 1) throw new BadRequest(`Give ${name} once.`);
    out[name] = fromText(name, arg, values[0]);
  }
  return out;
}

/** An operation's arguments from JSON (an MCP tool call): an object, holding
 *  only arguments the operation takes; null counts as not given. */
export function argsFromJson(op: Pick<Operation, 'args'>, raw: unknown): Args {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('The arguments are an object.');
  const out: Args = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const arg = Object.hasOwn(op.args, name) ? op.args[name] : undefined;
    if (!arg) throw new BadRequest(`Unknown argument: ${name.slice(0, 40)}. This tool takes ${Object.keys(op.args).join(', ') || 'none'}.`);
    if (v === null) continue;
    out[name] = fromJson(name, arg, v);
  }
  return out;
}

/** An operation's arguments as a JSON Schema object (an MCP tool's
 *  inputSchema), refusing any other. */
export function inputSchema(args: Readonly<Record<string, Arg>>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, arg] of Object.entries(args)) {
    const base = { description: arg.description };
    switch (arg.kind) {
      case 'day':
        properties[name] = { ...base, type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
        break;
      case 'month':
        properties[name] = { ...base, type: 'string', pattern: MONTH.source };
        break;
      case 'flag':
        properties[name] = { ...base, type: 'boolean' };
        break;
      case 'int':
        properties[name] = { ...base, type: 'integer', minimum: arg.min, maximum: arg.max };
        break;
      case 'amount':
        properties[name] = { ...base, type: 'number' };
        break;
      case 'text':
        properties[name] = { ...base, type: 'string', minLength: 1, maxLength: arg.max };
        break;
      case 'choice':
        properties[name] = { ...base, type: 'string', enum: [...arg.values] };
        break;
      case 'ids':
        properties[name] = { ...base, type: 'array', items: { type: 'string', pattern: ID.source }, minItems: 1, maxItems: arg.max };
        break;
      case 'id':
        properties[name] = { ...base, type: 'string', pattern: ID.source };
        break;
      case 'currency':
        properties[name] = { ...base, type: 'string', pattern: CURRENCY.source };
        break;
      case 'cursor':
        properties[name] = { ...base, type: 'string', pattern: CURSOR.source };
        break;
    }
  }
  return { type: 'object', properties, additionalProperties: false };
}

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

// ---- The operations ----

const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
const lastOfMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

const INCLUDE_HIDDEN: Arg = { kind: 'flag', description: 'Include hidden accounts, which are left out unless this is true.' };
const FROM: Arg = { kind: 'day', description: 'The first day, YYYY-MM-DD (UTC), inclusive.' };
const TO: Arg = { kind: 'day', description: 'The last day, YYYY-MM-DD (UTC), inclusive.' };

const flag = (a: Args, name: string) => a[name] === true;
const str = (a: Args, name: string) => a[name] as string | undefined;
const num = (a: Args, name: string) => a[name] as number | undefined;

function op(name: string, summary: string, args: Record<string, Arg>, run: Operation['run']): Operation {
  return { name, summary, args, run };
}

/** from and to, in order, defaulting to the `days` days up to today. */
function range(a: Args, days: number): { from: string; to: string } {
  const to = str(a, 'to') ?? today();
  const from = str(a, 'from') ?? daysBefore(to, days);
  if (from > to) throw new BadRequest('from is after to.');
  return { from, to };
}

export const transactionsArgs: Record<string, Arg> = {
  from: { kind: 'day', description: 'The first day, YYYY-MM-DD (UTC), inclusive. Defaults to 30 days before to.' },
  to: { kind: 'day', description: 'The last day, YYYY-MM-DD (UTC), inclusive. Defaults to today.' },
  account_id: { kind: 'ids', max: 50, description: 'Only these accounts (ids from accounts).' },
  q: { kind: 'text', max: 100, description: 'Text to find, in any case, in the name, the merchant behind it, the category or the note.' },
  category: { kind: 'text', max: 60, description: 'Only this category, as categories lists it ("other" for none).' },
  min_amount: { kind: 'amount', description: 'The smallest amount, inclusive, in Plaid’s sign: positive is money out.' },
  max_amount: { kind: 'amount', description: 'The largest amount, inclusive, in Plaid’s sign: positive is money out.' },
  include_hidden: INCLUDE_HIDDEN,
  limit: { kind: 'int', min: 1, max: MAX_PAGE_SIZE, description: `Transactions per page, at most ${MAX_PAGE_SIZE}. Defaults to ${DEFAULT_PAGE_SIZE}.` },
  cursor: { kind: 'cursor', description: 'next_cursor from the page before, with the same other arguments.' },
};

export const OPERATIONS: readonly Operation[] = [
  op('me', 'The token you called with, and the data it reads.', {}, async (auth) => readMe(auth)),

  op('accounts', 'Every account, linked and manual, with its newest measured balance and as of when.', { include_hidden: INCLUDE_HIDDEN }, async (auth, a) =>
    readAccounts(auth.ctx, { includeHidden: flag(a, 'include_hidden') })
  ),

  op('net-worth', 'Net worth now, per currency, from each account’s newest balance, and the newest recorded point of its history.', { include_hidden: INCLUDE_HIDDEN }, async (auth, a) =>
    readNetWorth(auth.ctx, { includeHidden: flag(a, 'include_hidden') })
  ),

  op(
    'balance-history',
    'Net worth by day, or one account’s balance by day: recorded points, and estimated ones only when asked for.',
    {
      account_id: { kind: 'id', description: 'One account’s history (ids from accounts); net worth without it.' },
      from: FROM,
      to: TO,
      include_estimated: { kind: 'flag', description: 'Include points estimated from transactions (flagged estimated), left out by default.' },
      include_hidden: INCLUDE_HIDDEN,
      interval: { kind: 'choice', values: ['day', 'week', 'month'], description: 'One point per day (the default), or the last point of each week or month.' },
    },
    async (auth, a) => {
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
    }
  ),

  op('transactions', 'Transactions, newest first, a page at a time, as the Activity tab shows them.', transactionsArgs, async (auth, a) => {
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
  }),

  op('categories', 'The categories in use, on transactions or with a budget.', { include_hidden: INCLUDE_HIDDEN }, async (auth, a) =>
    readCategories(auth.ctx, { includeHidden: flag(a, 'include_hidden') })
  ),

  op(
    'budgets',
    'Monthly budgets, with the month’s spending against each.',
    { month: { kind: 'month', description: 'The month, YYYY-MM. Defaults to this month (UTC).' }, include_hidden: INCLUDE_HIDDEN },
    async (auth, a) => readBudgets(auth.ctx, { month: str(a, 'month') ?? today().slice(0, 7), includeHidden: flag(a, 'include_hidden') })
  ),

  op(
    'spending',
    'Money in and out, and spending by category, for a month or any range, in one currency.',
    {
      month: { kind: 'month', description: 'A month, YYYY-MM, instead of from and to. Defaults to this month (UTC).' },
      from: FROM,
      to: TO,
      currency: { kind: 'currency', description: 'Total in this currency. Defaults to the one most transactions are in.' },
      include_hidden: INCLUDE_HIDDEN,
    },
    async (auth, a) => {
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
    }
  ),

  op('recurring', 'Recurring bills detected from transactions, with each one’s estimated next date.', { include_hidden: INCLUDE_HIDDEN }, async (auth, a) =>
    readRecurring(auth.ctx, { includeHidden: flag(a, 'include_hidden') })
  ),

  op('holdings', 'Each investment account’s latest recorded positions, and the day they were recorded.', { include_hidden: INCLUDE_HIDDEN }, async (auth, a) =>
    readHoldings(auth.ctx, { includeHidden: flag(a, 'include_hidden') })
  ),
];

/** An operation by its path, or null. */
export function operation(name: string): Operation {
  const found = OPERATIONS.find((o) => o.name === name);
  if (!found) throw new Error(`No API operation is called ${name}`);
  return found;
}
