// lib/log-safe.ts
//
// What is safe to put in a log about an error.
//
// A failed Plaid call throws the SDK's axios error, and that error carries the
// request it failed on: `config.headers` holds PLAID-CLIENT-ID and
// PLAID-SECRET, and `config.data` is the JSON body, which for most calls holds
// the Item's access token. When Plaid answers, the old habit of logging
// `err.response.data` printed only Plaid's error body, which is fine. When
// Plaid gives no answer (a timeout, a reset connection) there is no response,
// and `console.error(err)` printed the whole error, secret and token included,
// into the deployment's logs.
//
// loggable() keeps what diagnoses a failure (what kind it was, Plaid's error
// code and request id, the HTTP status) and drops the request. Anything that
// is not an axios error is returned as it is, so ordinary errors still log
// with their stack, except that a cause chain is walked: an error that wraps a
// Plaid failure must not print the request either.

/** The fields of Plaid's error body worth keeping. None of them is a secret;
 *  `display_message` is text meant for the person. */
const PLAID_FIELDS = ['error_type', 'error_code', 'error_message', 'display_message', 'request_id'] as const;

const MAX_CAUSES = 5;

type AxiosLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
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

function summarizeAxios(e: AxiosLike): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: typeof e.name === 'string' ? e.name : 'Error',
    message: typeof e.message === 'string' ? e.message : String(e.message ?? ''),
  };
  if (typeof e.code === 'string') out.code = e.code;
  if (e.response && typeof e.response.status === 'number') out.status = e.response.status;
  const plaid = plaidBody(e.response?.data);
  if (plaid) out.plaid = plaid;
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
