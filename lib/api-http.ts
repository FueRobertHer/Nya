// lib/api-http.ts
//
// How every /api/v1 route answers (app/api/v1/*): the token checked
// (lib/api-tokens.ts), the request counted against the token's limit, its
// query checked strictly, the read run (lib/api-read.ts), and JSON back, with
// one stable shape for every error:
//
//   { "error": { "code": "<code>", "message": "<for a person>" } }
//
//   400 invalid_request   a parameter that isn't one, or isn't valid
//   401 unauthorized      no token, or one that doesn't work (every way alike)
//   404 not_found         what was asked for isn't there (or is hidden)
//   409 unreadable        stored data that can't be read: nothing is guessed
//   429 rate_limited      over the token's limit, or too many tokens that
//                         don't work from this address; Retry-After says when
//   500 internal          anything else; the log has it, the answer doesn't
//   503 unavailable       the data can't be reached just now (the token is
//                         good: its data is being restored, say)
//
// A token that isn't in a token's form is a 401 before anything is read; one
// in the right form that doesn't work is counted against its address
// (lib/rate-limit.ts), which is turned away for a while past the limit, before
// any read. When the token was last used is written down at most once a
// minute per token; requests that start together write it once
// (lib/api-tokens.ts noteUse).
//
// No answer carries an internal detail: an error's own message goes to the
// log (through loggable, lib/log-safe.ts), never to the caller, apart from the
// seam's messages about stored data, which are written for the person.
//
// The routes authenticate themselves, so proxy.ts lets them past the session
// gate; a session cookie alone reaches nothing here. Every answer says not to
// cache it, and none sends CORS headers: the API is for programs, not for
// pages on other sites.

import { NextResponse } from 'next/server';
import { bearerToken, checkToken, noteUse, parseToken, takeRequest, RateCountUnreadableError, type Authenticated } from './api-tokens';
import { tokenFailuresExhausted, countTokenFailure, API_AUTH_WINDOW_SECONDS } from './rate-limit';
import { ContainerError } from './containers';
import { StoredDataUnreadableError } from './repo';
import { loggable } from './log-safe';
import { argsFromQuery, BadRequest, NotFound, type Operation } from './api-ops';

export type ApiErrorCode = 'invalid_request' | 'unauthorized' | 'not_found' | 'unreadable' | 'rate_limited' | 'internal' | 'unavailable' | 'method_not_allowed';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function apiError(status: number, code: ApiErrorCode, message: string, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { ...NO_STORE, ...headers } });
}

export const unauthorized = (presented: boolean) =>
  apiError(401, 'unauthorized', 'A valid API token is needed, sent as Authorization: Bearer <token>.', {
    'WWW-Authenticate': presented ? 'Bearer realm="Nya", error="invalid_token"' : 'Bearer realm="Nya"',
  });

/** The answer for a read that threw: never its internals. */
export function failed(err: unknown, what: string): NextResponse {
  if (err instanceof BadRequest) return apiError(400, 'invalid_request', err.message);
  if (err instanceof NotFound) return apiError(404, 'not_found', err.message);
  if (err instanceof ContainerError) {
    console.error(`API: ${what} refused: ${err.message}`);
    return apiError(503, 'unavailable', 'Your data can’t be reached just now. Try again later.');
  }
  if (err instanceof RateCountUnreadableError) return apiError(503, 'unavailable', err.message);
  if (err instanceof StoredDataUnreadableError) {
    console.error(`API: ${what}: stored data unreadable`, err.name);
    return apiError(409, 'unreadable', err.message);
  }
  console.error(`API: ${what} failed`, loggable(err));
  return apiError(500, 'internal', 'Something went wrong reading your data.');
}

/** A checked token, counted, or the answer to send instead. Shared with the
 *  MCP route, which answers its own way around the same steps. */
export async function admit(req: Request, now: number = Date.now()): Promise<{ auth: Authenticated; limits: Record<string, string> } | NextResponse> {
  const header = req.headers.get('authorization');
  // Not even in a token's form: refused before anything is read or counted.
  if (!parseToken(bearerToken(header))) return unauthorized(header !== null);
  // An address that has sent too many tokens that don't work is turned away
  // before any of the reads a token costs.
  if (await tokenFailuresExhausted(req)) {
    return apiError(429, 'rate_limited', 'Too many requests with tokens that don’t work have come from this address. Try again later.', {
      'Retry-After': String(API_AUTH_WINDOW_SECONDS),
    });
  }
  let check: Awaited<ReturnType<typeof checkToken>>;
  try {
    check = await checkToken(header, now);
  } catch (err) {
    console.error('API: a token could not be checked', loggable(err));
    return apiError(503, 'unavailable', 'Tokens can’t be checked just now. Try again later.');
  }
  if (check.kind === 'malformed') return unauthorized(header !== null);
  if (check.kind === 'refused') {
    await countTokenFailure(req);
    return unauthorized(true);
  }
  if (check.kind === 'unavailable') return apiError(503, 'unavailable', `${check.why} Try again later.`);
  const { auth } = check;
  let allowance;
  try {
    allowance = await takeRequest(auth, now);
  } catch (err) {
    return failed(err, 'counting a request');
  }
  const limits = {
    'RateLimit-Limit': String(allowance.limit),
    'RateLimit-Remaining': String(allowance.remaining),
    'RateLimit-Reset': String(allowance.resetSeconds),
  };
  if (!allowance.ok) {
    return apiError(429, 'rate_limited', `This token has made ${allowance.limit} requests this minute. Try again in ${allowance.resetSeconds} seconds.`, {
      ...limits,
      'Retry-After': String(allowance.resetSeconds),
    });
  }
  await noteUse(auth, now);
  return { auth, limits };
}

/**
 * Serves one GET of an operation (lib/api-ops.ts): the token admitted, the
 * query read strictly against the operation's arguments (each at most once,
 * and none it doesn't take: a misspelled include_hidden must not quietly show
 * nothing hidden), the operation run, and its answer sent as JSON with the
 * token's limit in the headers.
 */
export async function serve(req: Request, op: Operation): Promise<NextResponse> {
  const admitted = await admit(req);
  if (admitted instanceof NextResponse) return admitted;
  try {
    const args = argsFromQuery(op, new URL(req.url).searchParams);
    const body = await op.run(admitted.auth, args);
    return NextResponse.json(body, { headers: { ...NO_STORE, ...admitted.limits } });
  } catch (err) {
    const res = failed(err, op.name);
    for (const [k, v] of Object.entries(admitted.limits)) res.headers.set(k, v);
    return res;
  }
}

/** The answer for a method an endpoint doesn't take. */
export const methodNotAllowed = (allow: string) => apiError(405, 'method_not_allowed', `This endpoint takes ${allow} only.`, { Allow: allow });
