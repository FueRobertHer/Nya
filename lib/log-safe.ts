// lib/log-safe.ts
//
// What is safe to put in a log about an error.
//
// A failed Plaid call throws the SDK's axios error, and that error carries the
// request it failed on: `config.headers` holds PLAID-CLIENT-ID and
// PLAID-SECRET, `config.data` is the JSON body, which for most calls holds the
// Item's access token, and `request` is the raw client request. Printing the
// error copies all of it into the deployment's logs. Before this module,
// several routes did exactly that: `console.error(err)` on a failed Plaid call,
// and `console.error(err?.response?.data || err)` whenever Plaid gave no answer
// (a timeout, a reset connection), so a disconnect of an already-revoked Item
// or a slow institution logged the secret and a token.
//
// The Plaid client strips the request from its errors itself
// (lib/plaid-scrub.ts). loggable() is the second line, for anything that
// reaches a log some other way: it keeps what diagnoses a failure (what kind it
// was, the endpoint and method, Plaid's error code, reason and request id, the
// HTTP status, the stack) and drops the request. Anything that
// is not an axios error is returned as it is, so ordinary errors still log
// with their stack, except that a cause chain is walked: an error that wraps a
// Plaid failure must not print the request either.

/** The fields of Plaid's error body worth keeping. None of them is a secret;
 *  `display_message` is text meant for the person. */
const PLAID_FIELDS = ['error_type', 'error_code', 'error_code_reason', 'error_message', 'display_message', 'request_id'] as const;

const MAX_CAUSES = 5;

type AxiosLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  stack?: unknown;
  config?: { url?: unknown; method?: unknown };
  response?: { status?: unknown; data?: unknown };
};

function isAxiosLike(err: unknown): err is AxiosLike {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  // The SDK's errors say so; anything else carrying a request config is
  // treated the same way, since the config is what holds the secret.
  return e.isAxiosError === true || ('config' in e && ('request' in e || 'response' in e));
}

function plaidBody(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const f of PLAID_FIELDS) {
    const v = (data as Record<string, unknown>)[f];
    if (typeof v === 'string' || typeof v === 'number' || v === null) out[f] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The path of a request URL, without its query (Plaid sends everything in the
 *  body, but a query is where a secret would go if anything ever put one in a URL). */
function endpointOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0];
  }
}

function summarizeAxios(e: AxiosLike): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: typeof e.name === 'string' ? e.name : 'Error',
    message: typeof e.message === 'string' ? e.message : String(e.message ?? ''),
  };
  if (typeof e.code === 'string') out.code = e.code;
  // Which call it was: the endpoint and method are not secret, and without
  // them a timeout says only how long it waited.
  const method = typeof e.config?.method === 'string' ? e.config.method.toUpperCase() : null;
  const url = typeof e.config?.url === 'string' ? endpointOf(e.config.url) : null;
  if (url) out.endpoint = method ? `${method} ${url}` : url;
  if (e.response && typeof e.response.status === 'number') out.status = e.response.status;
  const plaid = plaidBody(e.response?.data);
  if (plaid) out.plaid = plaid;
  if (typeof e.stack === 'string') out.stack = e.stack;
  return out;
}

/** A value to pass to console.error/warn in place of `err`. */
export function loggable(err: unknown, depth = 0): unknown {
  if (isAxiosLike(err)) return summarizeAxios(err);
  if (err instanceof Error && err.cause !== undefined && depth < MAX_CAUSES) {
    const cause = loggable(err.cause, depth + 1);
    // Only rebuilt when the chain held something unsafe, so an ordinary
    // error keeps logging exactly as it did, stack and all.
    if (cause !== err.cause) return { name: err.name, message: err.message, stack: err.stack, cause };
  }
  return err;
}
