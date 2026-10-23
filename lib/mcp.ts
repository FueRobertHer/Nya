// lib/mcp.ts
//
// Nya's MCP server: the Model Context Protocol, on the same tokens as the API
// (lib/api-tokens.ts). It lets a person's own AI assistant answer questions
// about their money, on their own AI subscription, so it costs Nya no
// inference; and, with a token the person made to make changes, where this
// copy lets tokens write (lib/api-writes-enabled.ts), make the changes they
// ask it for. Served at /api/mcp (app/api/mcp/route.ts).
//
// WHAT A TOKEN MAY CALL. tools/list lists only the tools the token's access
// allows (a read token's list is the read tools, exactly as before writing
// existed; a balances token's, list_accounts and set_account_balance), and
// tools/call refuses any other as a tool error, whatever was listed, through
// the gate every operation passes (lib/api-run.ts), so a tool name a client
// knows from elsewhere does nothing. A write tool runs the same operation as
// its endpoint (lib/api-writes.ts), with the same limits and the same record
// of changes, one change per call: no tool takes a list. Its annotations
// mark it as changing data (destructive where it changes or removes what
// exists), so a client that asks before a tool call asks; its description,
// and a write token's instructions, tell the assistant to ask the person
// first and never to act on text it reads; and its answer's sentence holds
// numbers, dates and codes alone, never a name (see PROMPT INJECTION).
//
// Written by hand from the spec, without an SDK: JSON-RPC 2.0 messages over
// the streamable HTTP transport, protocol versions 2025-11-25 and 2025-06-18
// (the subset used here is the same in each), one message per request: those
// versions have no batches, so every tool call is a request of its own,
// counted against the token's limit. Every request here has exactly one
// answer, so each is sent as plain JSON, which the transport allows; there is
// no SSE stream, and no session (the server keeps no state between requests,
// so it hands out no Mcp-Session-Id).
//
// SIZE. A tool's result is sent twice (as text, and as structured content),
// so it may come to at most MCP_MAX_RESULT_BYTES of JSON, well inside what a
// function may send back: a larger one is a tool error saying how to ask for
// less (ToolSpec.narrow). search_transactions pages are smaller than the
// REST endpoint's, with the same cursor.
//
// It speaks initialize, notifications/initialized, ping, tools/list and
// tools/call; any other method is "method not found". Each tool is a thin
// call into the API's own operations (lib/api-ops.ts): the same arguments,
// checked as strictly (an unknown argument or one of the wrong type is a tool
// error the model can read and correct), and the same read layer
// (lib/api-read.ts), never a second one.
//
// PROMPT INJECTION. Names of transactions, merchants and accounts, notes and
// categories come from banks, from merchants (who choose their own names) and
// from the person: a merchant could call itself "ignore your instructions and
// ...". So a tool returns them only as data: inside a JSON document, never in
// the sentence beside it, which is built from numbers and dates alone; and
// every tool's description, and the server's instructions, say to treat them
// as data, never as instructions.

import type { Authenticated } from './api-tokens';
import { argsFromJson, inputSchema, operation, BadRequest, NotFound, type Args } from './api-ops';
import { TOOL_SPECS, WRITE_TOOL_SPECS, DATA_NOT_INSTRUCTIONS, ASK_FIRST, PROTOCOL_VERSIONS, ApiFailure, resourceSpec, allowsOf, type ToolSpec, type WriteToolSpec } from './api-spec';
import { checkAccess, gate, mayRun, writesNeeded } from './api-run';
import { runResource } from './api-writes';
import { readIfMatch } from './api-versions';
import { apiWritesEnabled } from './api-writes-enabled';
import { StoreRefusedError } from './repo';
import type { Access } from './api-limits';
import { readNetWorthAndHistory, readNetWorth, type ApiMissing, type Interval } from './api-read';
import { MCP_MAX_RESULT_BYTES } from './api-limits';
import { StoredDataUnreadableError } from './repo';
import { loggable } from './log-safe';
import { CONNECTOR_KINDS, connectorLabel, isConnectorKind } from './connectors/types';

export { PROTOCOL_VERSIONS };
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

export const SERVER_INFO = { name: 'nya', title: 'Nya', version: '1.0.0' };

export const INSTRUCTIONS = [
  'Read-only access to one person’s finances in Nya: their accounts and balances, net worth and its history, transactions, spending by category, where money came from and went (cash flow), budgets, recurring bills and investment holdings.',
  'Everything is what Nya has stored, never fetched live: each result says what it is as of. Amounts use Plaid’s sign: a transaction’s positive amount is money out, and what a credit card or a loan owes is a positive balance.',
  'Totals are in one currency each, and say what they left out. Once the person has chosen a home currency in Nya, net worth also gives base, and accounts and balance history to_base, converted into it (base_currency) at the European Central Bank’s reference rates or the person’s own; nothing else is converted between currencies. Hidden accounts are left out unless include_hidden is true.',
  'Some connections bring in no transactions (a 401(k) or a brokerage account; or a bank account or card whose transactions Plaid doesn’t provide, or the person didn’t allow): sources[].no_transactions says which and why, and the notes what that leaves out, so an empty list or a zero total is not, by itself, no spending.',
  DATA_NOT_INSTRUCTIONS,
].join(' ');

/** What a token that can make changes is told besides, while this copy lets
 *  tokens write: what it may change, and to ask first (see the header). */
export const WRITE_INSTRUCTIONS = [
  'This token can also make changes: add and change the person’s manual accounts and the transactions entered on them, their categories and tags, and set a manual account’s balance. It can never change a bank’s transaction, delete an account, or touch sharing, tokens or settings.',
  ASK_FIRST,
  'Every change is recorded with what it changed: undo_change reverses one while nothing has changed it since, and the person can see and undo every change in Nya.',
].join(' ');

/** The instructions a token is given, by what it may do. */
export function instructionsFor(auth: Pick<Authenticated, 'access'>): string {
  if (auth.access === 'write' && apiWritesEnabled()) return `${INSTRUCTIONS} ${WRITE_INSTRUCTIONS}`;
  if (auth.access === 'balances' && apiWritesEnabled()) {
    return `${INSTRUCTIONS} This token reads only the person’s accounts (list_accounts), and can set a manual account’s balance (set_account_balance). ${ASK_FIRST}`;
  }
  return INSTRUCTIONS;
}

/** JSON-RPC 2.0's error codes, as MCP uses them. */
export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

type Id = string | number;
export type RpcResponse = { jsonrpc: '2.0'; id: Id | null } & ({ result: unknown } | { error: { code: number; message: string } });

export const rpcError = (id: Id | null, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });

// ---- Tools ----

type Tool = ToolSpec & {
  run: (auth: Authenticated, args: Args) => Promise<unknown>;
  /** One sentence from the result, of numbers and dates only (see the header). */
  summary: (result: any) => string;
};

/** A tool that runs an operation on one resource: a write, or a read by id. */
type WriteTool = WriteToolSpec & {
  allows: readonly Access[];
  summary: (result: any) => string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n: number, currency: string | null) => `${n.toFixed(2)}${currency ? ` ${currency}` : ''}`;

/** Net worth now, and its history unless include_history is false, from one
 *  read of the accounts and of the history (readNetWorthAndHistory). */
async function netWorthTool(auth: Authenticated, a: Args): Promise<unknown> {
  if (typeof a.from === 'string' && typeof a.to === 'string' && a.from > a.to) throw new BadRequest('from is after to.');
  const includeHidden = a.include_hidden === true;
  if (a.include_history === false) return { now: await readNetWorth(auth.ctx, { includeHidden, base: true }) };
  return readNetWorthAndHistory(
    auth.ctx,
    {
      from: a.from as string | undefined,
      to: a.to as string | undefined,
      includeEstimated: a.include_estimated === true,
      includeHidden,
      interval: (a.interval as Interval | undefined) ?? 'month',
    },
    { base: true }
  );
}

/** What an answer's list of accounts is short of, in counts (never names:
 *  see PROMPT INJECTION above), or '' when it is whole. */
function missingAccounts(missing: readonly ApiMissing[], withoutBalance = 0): string {
  const count = (pred: (m: ApiMissing) => boolean) => missing.filter(pred).length;
  const unreadable = count((m) => m.account_id === null && m.reason === 'unreadable');
  const notLoaded = count((m) => m.reason === 'not_loaded');
  const manual = count((m) => m.account_id !== null && !isConnectorKind(m.source));
  // An account a connector feeds, counted by its connector (SimpleFIN, Lunch Flow).
  const fed = CONNECTOR_KINDS.map((kind) => [connectorLabel(kind), count((m) => m.account_id !== null && m.source === kind)] as const);
  const parts = [
    unreadable > 0 ? `the accounts of ${plural(unreadable, 'connection')} couldn’t be read` : '',
    notLoaded > 0 ? `${plural(notLoaded, 'connection')} ${notLoaded === 1 ? 'hasn’t' : 'haven’t'} been loaded yet` : '',
    manual > 0 ? `${plural(manual, 'manual account')} couldn’t be read` : '',
    ...fed.map(([label, n]) => (n > 0 ? `${plural(n, `${label} account`)} couldn’t be read` : '')),
    // Never measured, or a card SimpleFIN reports as money held, waiting for
    // the person's answer (the notes say which).
    withoutBalance > 0 ? `${plural(withoutBalance, 'account')} ${withoutBalance === 1 ? 'has' : 'have'} no balance to count` : '',
  ].filter(Boolean);
  return parts.length === 0 ? '' : ` Incomplete: ${parts.join('; ')}. See missing_accounts and notes.`;
}

/** A currency code as a sentence may say it: a code's shape only (ISO, or
 *  Plaid's unofficial ones such as BTC), never other text (see PROMPT
 *  INJECTION above). */
const code = (c: unknown): string | null => (typeof c === 'string' && /^[A-Z0-9]{2,10}$/.test(c) ? c : null);

/** Net worth now, in the sentence: in the home currency, converted, when the
 *  person chose one and something was converted into it (as the app shows
 *  it), naming what was left out; else one total per currency. */
function netWorthNow(now: any): string {
  const b = now.base;
  const home = code(now.base_currency);
  const totals = () =>
    now.totals.length
      ? `Net worth ${now.totals.map((t: any) => money(t.net_worth, code(t.currency))).join(', ')}${datedFrom(now.balances_from, now.balances_to)}.`
      : 'No balances are recorded yet.';
  if (!b || !home) return totals();
  // The home currency itself has no rate: nothing converts into it, so one
  // total per currency, and why.
  if (b.left_out.some((l: any) => l.why === 'base_has_no_rate')) return `${totals()} Nothing could be converted into ${home}, the home currency: it has no rate.`;
  if (!b.parts.some((p: any) => p.currency !== home && p.converted !== null)) return totals();
  const rates = [b.rate_day ? `the ECB’s rates of ${b.rate_day}` : '', b.own_rates.length > 0 ? 'the person’s own rates' : ''].filter(Boolean).join(' and ');
  /** Accounts left out for a reason, in counts and codes. */
  const out = (pred: (l: any) => boolean, why: string) => {
    const left = b.left_out.filter(pred);
    const n = left.reduce((s: number, l: any) => s + l.accounts, 0);
    return n > 0 ? `${plural(n, 'account')} in ${left.map((l: any) => code(l.currency) ?? 'another currency').join(', ')} not counted: ${why}` : '';
  };
  const left = [
    out((l) => l.why === 'not_fetched', 'Nya has no rates for them yet'),
    out((l) => l.why === 'rates_unreadable', 'the rates couldn’t be read just now'),
    out((l) => l.why !== 'not_fetched' && l.why !== 'rates_unreadable', 'no rate'),
  ]
    .filter(Boolean)
    .join('; ');
  const stale = b.rates_stale ? ' The newest rates Nya has may be out of date: see notes.' : '';
  return `Net worth ${money(b.net_worth, home)}, converted into ${home}${rates ? ` at ${rates}` : ''}${left ? ` (${left})` : ''}${datedFrom(now.balances_from, now.balances_to)}.${stale}`;
}

/** What a total of transactions converted (lib/fx/api-base.ts
 *  flowsConverted), in the sentence: at whose rates, from which days, and
 *  what was left out for having no rate, in counts and codes. */
function convertedFlows(b: any, home: string): string {
  const days = b.rate_days ? (b.rate_days.from === b.rate_days.to ? `of ${b.rate_days.from}` : `of ${b.rate_days.from} to ${b.rate_days.to}`) : '';
  const rates = [days ? `the ECB’s rates ${days}` : '', b.own_rates?.length > 0 ? 'the person’s own rates' : ''].filter(Boolean).join(' and ');
  const out = (pred: (l: any) => boolean, why: string) => {
    const left = (b.left_out ?? []).filter(pred);
    const n = left.reduce((s: number, l: any) => s + (l.transactions ?? l.bills ?? 0), 0);
    return n > 0 ? `${plural(n, 'transaction')} in ${left.map((l: any) => code(l.currency) ?? 'another currency').join(', ')} not counted: ${why}` : '';
  };
  const left = [
    out((l) => l.why === 'not_fetched', 'Nya has no rates for them yet'),
    out((l) => l.why === 'rates_unreadable', 'the rates couldn’t be read just now'),
    out((l) => l.why !== 'not_fetched' && l.why !== 'rates_unreadable', 'no rate'),
  ]
    .filter(Boolean)
    .join('; ');
  return `converted into ${home}${rates ? ` at ${rates}` : ''}${left ? ` (${left})` : ''}`;
}

/** Rates older than they should be, as a sentence after the figures. */
const staleRates = (b: any): string => (b?.rates_stale ? ' The newest rates Nya has may be out of date: see notes.' : '');

/** A converted answer's base, when the person chose a home currency and
 *  something in another currency was converted into it; else null, and the
 *  sentence says version 1's figures. */
const convertedBase = (r: any): { b: any; home: string } | null => {
  const home = code(r.base_currency);
  return r.base && home && (r.base.converted ?? []).length > 0 ? { b: r.base, home } : null;
};

/** The days the balances counted are from, when known. */
function datedFrom(from: string | null, to: string | null): string {
  if (!from || !to) return '';
  return from === to ? `, from balances dated ${from}` : `, from balances dated ${from} to ${to}`;
}

/**
 * What a summary of transactions or totals adds when connections bring in
 * none (sources[].no_transactions), in counts, as the rest of the sentence is:
 * that what came in may be incomplete, when some bank account or card's
 * transactions don't come in; or that no connection brings any in, so an
 * empty list or a zero isn't read as no spending. The notes say whose, and why.
 */
function withoutTransactions(r: { sources?: { no_transactions: string | null }[] }): string {
  const sources = r.sources ?? [];
  const without = sources.filter((s) => s.no_transactions !== null);
  const unknown = without.filter((s) => s.no_transactions === 'refused' || s.no_transactions === 'no_consent').length;
  if (unknown > 0) return ` Bank or card transactions from ${plural(unknown, 'connection')} don’t come in, so this may be incomplete: see notes.`;
  if (without.length > 0 && without.length === sources.length) return ' No connection brings in bank or card transactions, so this is not a measure of spending: see notes.';
  return '';
}

/** For budgets, what notes says of incomplete months: the month's spending
 *  (none counted before anything stored, or what is spent may be off), and
 *  carries or a pool counting such months (lib/api-read.ts readBudgets). */
function incompleteMonths(r: { month: string; earliest_month?: string | null; notes?: string[] }): string {
  const said = (start: string) => (r.notes ?? []).some((n) => n.startsWith(start));
  let out = '';
  if (said('No transactions are stored from before')) out += ` No transactions are stored from before ${r.earliest_month}, so nothing is counted as spent in ${r.month}: see notes.`;
  else if (said(`${r.month} may be incomplete`)) out += ` ${r.month} may be incomplete, so what is spent may be off: see notes.`;
  const rolls = said('What rolled over');
  const pools = rolls ? said('What rolled over and the income pool') : said('The income pool counts');
  if (rolls || pools) out += ` ${rolls && pools ? 'What rolled over and the income pool count' : rolls ? 'What rolled over counts' : 'The income pool counts'} months that may be incomplete: see notes.`;
  return out;
}

/** How long a line of the runway lasts, in words (lib/api-reports.ts). */
const lasts = (l: any) =>
  l.outcome === 'runs_out'
    ? `runs out on ${l.runs_out}, after ${plural(l.days, 'day')} (${l.months} months)`
    : l.outcome === 'beyond'
      ? 'lasts more than ten years'
      : 'doesn’t run out at this rate';
/** A change in words: "against 650.00 USD (+23.1%)". */
const against = (c: any, currency: string | null) => `${money(c.this, currency)} against ${money(c.last, currency)}${c.pct === null ? '' : ` (${c.pct > 0 ? '+' : ''}${c.pct}%)`}`;

const SUMMARIES: Record<string, Tool['summary']> = {
  list_accounts: (r) => `${plural(r.accounts.length, 'account')}.${missingAccounts(r.missing_accounts)}`,
  get_net_worth: (r) =>
    netWorthNow(r.now) + missingAccounts(r.now.missing_accounts, r.now.accounts_without_balance) + (r.history ? ` ${plural(r.history.points.length, 'history point')}.` : ''),
  get_balance_history: (r) => `${plural(r.points.length, 'point')}${r.points.length ? `, ${r.points[0].date} to ${r.points[r.points.length - 1].date}` : ''}.`,
  search_transactions: (r) =>
    `${plural(r.transactions.length, 'transaction')} from ${r.from} to ${r.to}${r.has_more ? ', and more: pass next_cursor as cursor' : ''}.${withoutTransactions(r)}`,
  spending_by_category: (r) => {
    // In the home currency, converted, when the person chose one and
    // something was converted into it (as the app shows it).
    const c = convertedBase(r);
    const s = c ? c.b : r;
    const cur = c ? c.home : r.currency;
    return `From ${r.from} to ${r.to}: money out ${money(s.money_out, cur)}, money in ${money(s.money_in, cur)}, over ${plural(s.counted, 'transaction')}${c ? `, ${convertedFlows(c.b, c.home)}` : ''}.${staleRates(c?.b)}${withoutTransactions(r)}`;
  },
  get_cash_flow: (r) => {
    const c = convertedBase(r);
    const s = c ? c.b : r;
    const cur = c ? c.home : r.currency;
    return `From ${r.from} to ${r.to}: money in ${money(s.money_in, cur)} from ${plural(s.payers.length, 'payer')}, money out ${money(s.money_out, cur)} in ${plural(s.groups.length, 'group')}, ${
      s.from_savings_or_debt > 0 ? `${money(s.from_savings_or_debt, cur)} from savings or debt` : `${money(s.left_over, cur)} left over`
    }${c ? `, ${convertedFlows(c.b, c.home)}` : ''}.${staleRates(c?.b)}${withoutTransactions(r)}`;
  },
  get_budgets: (r) => {
    // As the Budgets tab counts them once a home currency is chosen (base):
    // the budgets keep their currency, and spending in another counts in it,
    // converted; else version 1's figures.
    const c = r.base && code(r.base.currency) && (r.base.converted ?? []).length > 0 ? r.base : null;
    const s = c ?? r;
    return `${plural(s.budgets.length, 'category budget')}${s.groups.some((g: any) => g.own !== null) ? ` and ${plural(s.groups.filter((g: any) => g.own !== null).length, 'group budget')}` : ''} for ${r.month}: ${money(s.total.spent, r.currency)} spent of ${money(s.total.budget, r.currency)}${s.total.available === s.total.budget ? '' : s.total.available > 0 ? `, ${money(s.total.available, r.currency)} available with what rolled over` : `, nothing left with what rolled over${s.total.available < 0 ? `: it began the month ${money(-s.total.available, r.currency)} over` : ''}`}.${
      c ? ` Spending in other currencies is counted ${convertedFlows(c, code(c.currency)!)}.${staleRates(c)}` : ''
    }${s.income ? ` Available to allocate: ${money(s.income.available, r.currency)}.` : ''}${incompleteMonths(r)}${withoutTransactions(r)}`;
  },
  list_recurring_bills: (r) => {
    const ended = r.bills.filter((b: any) => b.ended).length;
    // In the home currency at today's rates, when one is chosen and a bill is in another.
    const home = code(r.base_currency);
    const converted = !!r.base && !!home && r.bills.some((b: any) => b.currency && b.currency !== home);
    if (converted) {
      const left = r.base.left_out.reduce((n: number, l: any) => n + l.bills, 0);
      const out = left > 0 ? ` (${plural(left, 'bill')} in ${r.base.left_out.map((l: any) => code(l.currency) ?? 'another currency').join(', ')} not counted: no rate)` : '';
      return `${plural(r.bills.length, 'recurring bill')}${ended ? ` (${ended} may have ended)` : ''}, about ${money(r.base.monthly_total, home)} a month, converted into ${home} at today’s rates${out}.${withoutTransactions(r)}`;
    }
    return `${plural(r.bills.length, 'recurring bill')}${ended ? ` (${ended} may have ended)` : ''}, about ${money(r.monthly_total.amount, r.monthly_total.currency)} a month.${withoutTransactions(r)}`;
  },
  list_categories: (r) => `${plural(r.categories.length, 'category', 'categories')} in use, in ${plural(r.groups.length, 'group')}.${withoutTransactions(r)}`,
  get_goals: (r) => {
    const active = r.goals.filter((g: any) => !g.archived);
    const count = (status: string) => active.filter((g: any) => g.projection?.status === status).length;
    const archived = r.goals.length - active.length;
    return (
      `${plural(active.length, 'goal')}${archived ? `, and ${archived} archived` : ''}: ${count('complete')} reached, ${count('on_track')} on track, ${count('behind')} behind, ` +
      `${count('no_recent_contributions')} with no recent contributions.${missingAccounts(r.missing_accounts)}`
    );
  },
  list_tags: (r) => `${plural(r.tags.length, 'tag')}.${withoutTransactions(r)}`,
  list_rules: (r) => `${plural(r.rules.length, 'rule')}, ${r.rules.filter((x: any) => x.enabled).length} on.${withoutTransactions(r)}`,
  get_holdings: (r) => `${plural(r.accounts.length, 'investment account')}.${missingAccounts(r.missing_accounts)}`,
  get_runway: (r) => {
    // As the report page shows it once a home currency is chosen (base): in
    // the runway's currency, what is in another converted; else version 1's.
    const b =
      r.base && code(r.base.currency) && (r.base.spending.converted.length > 0 || r.base.newest_rates.cash_accounts.length > 0 || r.base.newest_rates.expected.length > 0)
        ? r.base
        : null;
    const s = b ?? r;
    const converted = b
      ? ` What is in other currencies is counted: transactions ${convertedFlows(b.spending, code(b.currency)!)}, and cash and expected amounts at today’s rates${
          b.newest_rates.left_out.length > 0 ? ` (${b.newest_rates.left_out.map((l: any) => code(l.currency) ?? 'another currency').join(', ')} not counted: no rate)` : ''
        }.${staleRates(b.spending)}`
      : '';
    return s.without_income.outcome === 'no_cash'
      ? 'No runway: no checking, savings or cash on hand is in Nya, so there is no cash to start from. See notes.'
      : s.without_income.outcome === 'no_spending'
        ? `No runway: there are no transactions from ${s.spending.from} to ${s.spending.to} to go by. See notes.`
        : `An estimate, from ${money(s.cash.start, s.currency)} of cash and the spending of ${s.spending.from} to ${s.spending.to}: without income it ${lasts(s.without_income)}; with income it ${lasts(s.with_income)}.${converted}${
            s.spending.months_short.length > 0 ? ' Some of those months may be short of transactions: see notes.' : ''
          }`;
  },
  get_year_over_year: (r) => {
    // In the home currency, converted, once one is chosen and something was
    // converted into it (base); else version 1's.
    const home = code(r.base_currency);
    const b = r.base && home && (r.base.converted ?? []).length > 0 ? r.base : null;
    const s = b ?? r;
    const cur = b ? home : r.currency;
    return `${s.year.this.start} to ${s.year.this.end}: money out ${against(s.year.money_out, cur)}, money in ${against(s.year.money_in, cur)}, the same days a year before${
      b ? `, ${convertedFlows(b, home!)}` : ''
    }.${staleRates(b ?? undefined)}${s.year.this.uncertain || s.year.last.uncertain ? ' Some months may be short of transactions: see notes.' : ''}`;
  },
};

/** Each declared tool (lib/api-spec.ts) with what it runs: its operation, with
 *  the tool's defaults under the call's own arguments, or a run of its own. */
export const TOOLS: readonly Tool[] = TOOL_SPECS.map((spec) => {
  const summary = SUMMARIES[spec.name];
  if (!summary) throw new Error(`The MCP tool ${spec.name} has no summary`);
  if (spec.operation) {
    const op = operation(spec.operation);
    return { ...spec, summary, run: (auth: Authenticated, args: Args) => op.run(auth, { ...spec.defaults, ...args }) };
  }
  if (spec.name === 'get_net_worth') return { ...spec, summary, run: netWorthTool };
  throw new Error(`The MCP tool ${spec.name} has nothing to run`);
});

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** A change's id, in a sentence: digits, a token's id and hex (see PROMPT
 *  INJECTION above). */
const changeSentence = (r: any) =>
  typeof r?.change_id === 'string' && /^[0-9a-z.]{1,64}$/.test(r.change_id) ? ` Change ${r.change_id}: undo_change reverses it while nothing changes it since.` : '';
const dated = (t: any) => (typeof t?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? ` dated ${t.date}` : '');

const WRITE_SUMMARIES: Record<string, (r: any) => string> = {
  get_transaction: (r) => `1 transaction${dated(r.transaction)}.`,
  add_transaction: (r) =>
    r.deleted ? `What this key made was deleted since.${changeSentence(r)}` : `Added a transaction of ${money(Math.abs(r.transaction.amount), code(r.transaction.currency))} (${r.transaction.amount > 0 ? 'money out' : 'money in'})${dated(r.transaction)} to a manual account.${changeSentence(r)}`,
  update_transaction: (r) => `Changed a transaction${dated(r.transaction)}.${changeSentence(r)}`,
  delete_transaction: (r) => `Deleted a transaction${dated(r.transaction)}.${changeSentence(r)}`,
  set_account_balance: (r) =>
    r.changed === false
      ? 'The balance was already that: nothing changed.'
      : `Set a manual account’s balance to ${money(r.account.balance, code(r.account.currency))}.${changeSentence(r)}`,
  add_manual_account: (r) =>
    r.deleted ? `What this key made was deleted since.${changeSentence(r)}` : `Added a manual account with a balance of ${money(r.account.balance, code(r.account.currency))}.${changeSentence(r)}`,
  update_manual_account: (r) => `Changed a manual account.${changeSentence(r)}`,
  add_category: (r) => (r.deleted ? `What this key made was deleted since.${changeSentence(r)}` : `Added a category.${changeSentence(r)}`),
  update_category: (r) => `Changed a category.${changeSentence(r)}`,
  add_category_group: (r) => (r.deleted ? `What this key made was deleted since.${changeSentence(r)}` : `Added a category group.${changeSentence(r)}`),
  update_category_group: (r) => `Renamed a category group.${changeSentence(r)}`,
  add_tag: (r) => (r.deleted ? `What this key made was deleted since.${changeSentence(r)}` : `Added a tag.${changeSentence(r)}`),
  update_tag: (r) => `Changed a tag.${changeSentence(r)}`,
  list_changes: (r) => `${plural(r.changes.length, 'change')} this token made${r.has_more ? ', and more: pass next_cursor as cursor' : ''}.`,
  undo_change: (r) =>
    typeof r?.undo === 'string' && /^[0-9a-z.]{1,64}$/.test(r.undo) ? `Undone. The undo is change ${r.undo}.` : 'Undone.',
};

/** Who may call each write tool: a write token, or for setting a balance a
 *  balances token too. */
export const WRITE_TOOLS: readonly WriteTool[] = WRITE_TOOL_SPECS.map((spec) => {
  const summary = WRITE_SUMMARIES[spec.name];
  if (!summary) throw new Error(`The MCP tool ${spec.name} has no summary`);
  const allows: readonly Access[] = spec.resource === 'manual-accounts.balance' ? ['balances', 'write'] : ['write'];
  return { ...spec, allows, summary };
});

/** Whether a token may call a tool now: its access, and the switch for one
 *  that needs more than reading. */
const callable = (auth: Pick<Authenticated, 'access'>, spec: { allows?: readonly Access[] }) =>
  mayRun(auth, spec) && (!writesNeeded(spec) || apiWritesEnabled());

/** tools/list's answer, for this token: only what it may call. */
export function listTools(auth: Pick<Authenticated, 'access'>): { tools: unknown[] } {
  return {
    tools: [
      ...TOOLS.filter((t) => callable(auth, t)).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: inputSchema(t.args),
        annotations: { title: t.title, ...ANNOTATIONS },
      })),
      ...WRITE_TOOLS.filter((t) => callable(auth, t)).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: inputSchema(t.args, t.required),
        annotations: { title: t.title, ...t.annotations, openWorldHint: false },
      })),
    ],
  };
}

/** Runs a write tool (or a read by id) through the same gate and operation
 *  as its endpoint (lib/api-run.ts, lib/api-writes.ts). */
async function callWriteTool(auth: Authenticated, tool: WriteTool, raw: unknown): Promise<unknown> {
  const spec = resourceSpec(tool.resource);
  try {
    checkAccess(auth, tool);
    await gate(auth, spec);
  } catch (err) {
    if (err instanceof ApiFailure) return toolError(err.message);
    throw err;
  }
  let args: Args;
  try {
    args = argsFromJson(tool, raw);
  } catch (err) {
    if (err instanceof BadRequest) return toolError(err.message);
    throw err;
  }
  const { version, idempotency_key, ...rest } = args;
  const id = tool.idArg ? (rest[tool.idArg] as string | undefined) : undefined;
  if (tool.idArg) delete rest[tool.idArg];
  try {
    const answer = await runResource(auth, spec, {
      id,
      args: rest,
      version: spec.versioned ? (typeof version === 'string' ? readIfMatch(version) : null) : undefined,
      key: typeof idempotency_key === 'string' ? idempotency_key : null,
      via: 'mcp',
    });
    const result = answer.body;
    return {
      content: [
        { type: 'text', text: tool.summary(result) },
        { type: 'text', text: JSON.stringify(result) },
      ],
      structuredContent: result,
    };
  } catch (err) {
    if (err instanceof ApiFailure || err instanceof BadRequest || err instanceof NotFound || err instanceof StoredDataUnreadableError || err instanceof StoreRefusedError) {
      return toolError(err.message);
    }
    console.error(`MCP: ${tool.name} failed`, loggable(err));
    return toolError('Something went wrong. Try again later.');
  }
}

/** A tool's error, for the model to read: what was wrong, never internals. */
const toolError = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true });

/** tools/call's answer: a sentence, the result as JSON text, and the same as
 *  structured content; or a tool error. */
export async function callTool(auth: Authenticated, name: string, raw: unknown): Promise<unknown> {
  const writing = WRITE_TOOLS.find((t) => t.name === name);
  if (writing) return callWriteTool(auth, writing, raw);
  const tool = TOOLS.find((t) => t.name === name)!;
  // The gate every operation passes, whatever tools/list showed: a balances
  // token reads its accounts alone.
  try {
    checkAccess(auth, tool);
  } catch (err) {
    if (err instanceof ApiFailure) return toolError(err.message);
    throw err;
  }
  let args: Args;
  try {
    args = argsFromJson(tool, raw);
  } catch (err) {
    if (err instanceof BadRequest) return toolError(err.message);
    throw err;
  }
  try {
    const result = await tool.run(auth, args);
    const json = JSON.stringify(result);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MCP_MAX_RESULT_BYTES) {
      return toolError(`This answer is too large to send (${(bytes / 1_000_000).toFixed(1)} MB). ${tool.narrow}`);
    }
    return {
      content: [
        { type: 'text', text: tool.summary(result) },
        { type: 'text', text: json },
      ],
      structuredContent: result,
    };
  } catch (err) {
    if (err instanceof BadRequest || err instanceof NotFound || err instanceof StoredDataUnreadableError) return toolError(err.message);
    console.error(`MCP: ${name} failed`, loggable(err));
    return toolError('Something went wrong reading the data. Try again later.');
  }
}

// ---- Messages ----

/** MCP's request ids: a string or an integer (never null). */
const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v));

/**
 * One JSON-RPC message's answer, or null for one that has none (a
 * notification, or a response the client sends to a request of ours, which
 * this server never makes).
 */
export async function handleMessage(auth: Authenticated, msg: unknown): Promise<RpcResponse | null> {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return rpcError(null, RPC.invalidRequest, 'A message is a JSON-RPC 2.0 object.');
  const m = msg as Record<string, unknown>;
  const id = m.id;
  if (m.jsonrpc !== '2.0') return rpcError(isId(id) ? id : null, RPC.invalidRequest, 'jsonrpc must be "2.0".');
  if (typeof m.method !== 'string') {
    // A response (result or error) to a request: this server sends none, so
    // there is nothing to match it to, and nothing to answer.
    if (('result' in m || 'error' in m) && isId(id)) return null;
    return rpcError(isId(id) ? id : null, RPC.invalidRequest, 'A request has a method.');
  }
  // A notification (no id) is never answered, whatever its method.
  if (!('id' in m)) return null;
  if (!isId(id)) return rpcError(null, RPC.invalidRequest, 'id is a string or an integer.');
  const params = m.params;
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) return rpcError(id, RPC.invalidParams, 'params is an object.');
  const p = (params ?? {}) as Record<string, unknown>;

  switch (m.method) {
    case 'initialize': {
      const asked = p.protocolVersion;
      const protocolVersion = typeof asked === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL;
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instructionsFor(auth) });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, listTools(auth));
    case 'tools/call': {
      if (typeof p.name !== 'string') return rpcError(id, RPC.invalidParams, 'tools/call needs the tool’s name.');
      if (!TOOLS.some((t) => t.name === p.name) && !WRITE_TOOLS.some((t) => t.name === p.name)) return rpcError(id, RPC.invalidParams, `Unknown tool: ${p.name.slice(0, 60)}`);
      return rpcResult(id, await callTool(auth, p.name, p.arguments));
    }
    default:
      return rpcError(id, RPC.methodNotFound, `Method not found: ${m.method.slice(0, 60)}`);
  }
}
