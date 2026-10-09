// lib/mcp.ts
//
// Nya's MCP server: the Model Context Protocol, read only, on the same tokens
// as the API (lib/api-tokens.ts). It lets a person's own AI assistant answer
// questions about their money, on their own AI subscription, so it costs Nya
// no inference. Served at /api/mcp (app/api/mcp/route.ts).
//
// Written by hand from the spec, without an SDK: JSON-RPC 2.0 messages over
// the streamable HTTP transport, protocol versions 2025-11-25, 2025-06-18 and
// 2025-03-26 (the subset used here is the same in each). Every request here
// has exactly one answer, so each is sent as plain JSON, which the transport
// allows; there is no SSE stream, and no session (the server keeps no state
// between requests, so it hands out no Mcp-Session-Id).
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
import { TOOL_SPECS, DATA_NOT_INSTRUCTIONS, PROTOCOL_VERSIONS, type ToolSpec } from './api-spec';
import { readNetWorth, readBalanceHistory, type Interval } from './api-read';
import { StoredDataUnreadableError } from './repo';
import { loggable } from './log-safe';

export { PROTOCOL_VERSIONS };
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

export const SERVER_INFO = { name: 'nya', title: 'Nya', version: '1.0.0' };

export const INSTRUCTIONS = [
  'Read-only access to one person’s finances in Nya: their accounts and balances, net worth and its history, transactions, spending by category, budgets, recurring bills and investment holdings.',
  'Everything is what Nya has stored, never fetched live: each result says what it is as of. Amounts use Plaid’s sign: a transaction’s positive amount is money out, and what a credit card or a loan owes is a positive balance.',
  'Totals are in one currency each, and say what they left out; nothing is converted between currencies. Hidden accounts are left out unless include_hidden is true.',
  DATA_NOT_INSTRUCTIONS,
].join(' ');

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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n: number, currency: string | null) => `${n.toFixed(2)}${currency ? ` ${currency}` : ''}`;

/** Net worth now, and its history unless include_history is false: the two
 *  reads its two endpoints make (net-worth, balance-history). */
async function netWorthTool(auth: Authenticated, a: Args): Promise<unknown> {
  if (typeof a.from === 'string' && typeof a.to === 'string' && a.from > a.to) throw new BadRequest('from is after to.');
  const includeHidden = a.include_hidden === true;
  const now = await readNetWorth(auth.ctx, { includeHidden });
  if (a.include_history === false) return { now };
  const history = await readBalanceHistory(auth.ctx, {
    from: a.from as string | undefined,
    to: a.to as string | undefined,
    includeEstimated: a.include_estimated === true,
    includeHidden,
    interval: (a.interval as Interval | undefined) ?? 'month',
  });
  return { now, history };
}

const SUMMARIES: Record<string, Tool['summary']> = {
  list_accounts: (r) => `${plural(r.accounts.length, 'account')}.${r.notes.length ? ` ${plural(r.notes.length, 'note')} on what couldn’t be read.` : ''}`,
  get_net_worth: (r) =>
    r.now.totals.length
      ? `Net worth ${r.now.totals.map((t: any) => money(t.net_worth, t.currency)).join(', ')}, from balances dated ${r.now.balances_from} to ${r.now.balances_to}.${r.history ? ` ${plural(r.history.points.length, 'history point')}.` : ''}`
      : 'No balances are recorded yet.',
  get_balance_history: (r) => `${plural(r.points.length, 'point')}${r.points.length ? `, ${r.points[0].date} to ${r.points[r.points.length - 1].date}` : ''}.`,
  search_transactions: (r) => `${plural(r.transactions.length, 'transaction')} from ${r.from} to ${r.to}${r.has_more ? ', and more: pass next_cursor as cursor' : ''}.`,
  spending_by_category: (r) => `From ${r.from} to ${r.to}: money out ${money(r.money_out, r.currency)}, money in ${money(r.money_in, r.currency)}, over ${plural(r.counted, 'transaction')}.`,
  get_budgets: (r) => `${plural(r.budgets.length, 'budget')} for ${r.month}: ${money(r.total.spent, r.currency)} spent of ${money(r.total.budget, r.currency)}.`,
  list_recurring_bills: (r) => `${plural(r.bills.length, 'recurring bill')}, about ${money(r.monthly_total.amount, r.monthly_total.currency)} a month.`,
  list_categories: (r) => `${plural(r.categories.length, 'category', 'categories')}.`,
  get_holdings: (r) => `${plural(r.accounts.length, 'investment account')}.`,
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

/** tools/list's answer. */
export function listTools(): { tools: unknown[] } {
  return {
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: inputSchema(t.args), annotations: { title: t.title, ...ANNOTATIONS } })),
  };
}

/** A tool's error, for the model to read: what was wrong, never internals. */
const toolError = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true });

/** tools/call's answer: a sentence, the result as JSON text, and the same as
 *  structured content; or a tool error. */
export async function callTool(auth: Authenticated, name: string, raw: unknown): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name)!;
  let args: Args;
  try {
    args = argsFromJson(tool, raw);
  } catch (err) {
    if (err instanceof BadRequest) return toolError(err.message);
    throw err;
  }
  try {
    const result = await tool.run(auth, args);
    return {
      content: [
        { type: 'text', text: tool.summary(result) },
        { type: 'text', text: JSON.stringify(result) },
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

const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

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
  if (!isId(id)) return rpcError(null, RPC.invalidRequest, 'id is a string or a number.');
  const params = m.params;
  if (params !== undefined && (typeof params !== 'object' || params === null)) return rpcError(id, RPC.invalidParams, 'params is an object.');
  const p = (params ?? {}) as Record<string, unknown>;

  switch (m.method) {
    case 'initialize': {
      const asked = p.protocolVersion;
      const protocolVersion = typeof asked === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL;
      return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, listTools());
    case 'tools/call': {
      if (typeof p.name !== 'string') return rpcError(id, RPC.invalidParams, 'tools/call needs the tool’s name.');
      if (!TOOLS.some((t) => t.name === p.name)) return rpcError(id, RPC.invalidParams, `Unknown tool: ${p.name.slice(0, 60)}`);
      return rpcResult(id, await callTool(auth, p.name, p.arguments));
    }
    default:
      return rpcError(id, RPC.methodNotFound, `Method not found: ${m.method.slice(0, 60)}`);
  }
}
