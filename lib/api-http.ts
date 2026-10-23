// lib/api-http.ts
//
// How every /api/v1 route answers (app/api/v1/*): the token checked
// (lib/api-tokens.ts), the request counted against the token's limit, what the
// token may do checked by the one gate every operation passes (lib/api-run.ts),
// its query or body checked strictly, the operation run (lib/api-read.ts for
// the reads, lib/api-writes.ts for one resource and the writes), and JSON
// back, with one stable shape for every error:
//
//   { "error": { "code": "<code>", "message": "<for a person>" } }
//
//   400 invalid_request   a parameter that isn't one, or isn't valid
//   401 unauthorized      no token, or one that doesn't work (every way alike)
//   403 insufficient_scope  the token may not do this (lib/api-run.ts)
//   403 forbidden         what is named is never changed through the API
//   403 writes_off        this copy of Nya doesn't let tokens make changes
//   404 not_found         what was asked for isn't there (or is hidden)
//   409 unreadable        stored data that can't be read: nothing is guessed
//   409 conflict          the app's own rules refuse the change just now
//   409 in_progress       a create with this Idempotency-Key is being made
//   412 version_mismatch  it changed since the version If-Match names
//   413 too_large         the body, or what it would store, is too large
//   415 unsupported_media_type  a write's body isn't JSON
//   422 idempotency_key_reused  the key was sent with another request
//   428 version_required  a change to something that exists names no version
//   429 rate_limited      over the token's limit, or too many tokens that
//                         don't work from this address; Retry-After says when
//   500 internal          anything else; the log has it, the answer doesn't
//   503 unavailable       the data can't be reached just now (the token is
//                         good: its data is being restored, say, by the
//                         operator or from a download)
//
// A token that isn't in a token's form is a 401 before anything is read; one
// in the right form that doesn't work is counted against its address
// (lib/rate-limit.ts). Past a flood's worth, the address is turned away for
// the rest of the window before the token's own reads: each request then
// costs one read, the count's, which every request with a token in the right
// form makes. When the token was last used is written down at most once a
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
import { StoredDataUnreadableError, StoreRefusedError } from './repo';
import { loggable } from './log-safe';
import { argsFromQuery, BadRequest, NotFound, type Operation } from './api-ops';
import { restoreUnfinished } from './user-restore/restored';
import { ApiFailure, bodyFromJson, idFromPath, OPERATION_SPECS, RESOURCE_SPECS, type Args, type ResourceSpec } from './api-spec';
import { checkAccess, gate, writesNeeded } from './api-run';
import { apiWritesEnabled } from './api-writes-enabled';
import { runResource } from './api-writes';
import { readIfMatch } from './api-versions';
import { WRITE_BODY_MAX } from './api-limits';

export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'unreadable'
  | 'rate_limited'
  | 'internal'
  | 'unavailable'
  | 'method_not_allowed'
  | 'insufficient_scope'
  | 'forbidden'
  | 'writes_off'
  | 'conflict'
  | 'in_progress'
  | 'version_mismatch'
  | 'too_large'
  | 'unsupported_media_type'
  | 'idempotency_key_reused'
  | 'version_required';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function apiError(status: number, code: ApiErrorCode, message: string, headers: Readonly<Record<string, string>> = {}): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { ...NO_STORE, ...headers } });
}

export const unauthorized = (presented: boolean) =>
  apiError(401, 'unauthorized', 'A valid API token is needed, sent as Authorization: Bearer <token>.', {
    'WWW-Authenticate': presented ? 'Bearer realm="Nya", error="invalid_token"' : 'Bearer realm="Nya"',
  });

/** The answer for a read that threw: never its internals. */
export function failed(err: unknown, what: string): NextResponse {
  if (err instanceof ApiFailure) return apiError(err.status, err.code as ApiErrorCode, err.message, err.headers);
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
  // What the seam refused to write (seam rule 5): a change that kept losing
  // its compare-and-set, or one too large to store. Nothing was written.
  if (err instanceof StoreRefusedError) return apiError(err.status, err.status === 413 ? 'too_large' : 'conflict', err.message);
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
  // A restore still being written or undone here (lib/user-restore/
  // restored.ts): a program can't be shown the app's banner, so it is told
  // to wait, never answered from part of the data.
  try {
    if (await restoreUnfinished(auth.ctx)) {
      return apiError(503, 'unavailable', 'Your data is being brought back from a download, or that is being undone. Try again once it has finished.', limits);
    }
  } catch (err) {
    return failed(err, 'checking for a restore');
  }
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
    // The gate every operation passes: a balances token reads /me and
    // /accounts alone.
    checkAccess(admitted.auth, op);
    const args = argsFromQuery(op, new URL(req.url).searchParams);
    const body = await op.run(admitted.auth, args);
    return NextResponse.json(body, { headers: { ...NO_STORE, ...admitted.limits } });
  } catch (err) {
    const res = failed(err, op.name);
    for (const [k, v] of Object.entries(admitted.limits)) res.headers.set(k, v);
    return res;
  }
}

/** The key of a JSON object given twice, anywhere in a valid JSON text, or
 *  null: JSON.parse keeps the last, and a body like {"amount": 1, "amount":
 *  1000} must not mean one thing to one reader and another to the next. */
export function repeatedKey(text: string): string | null {
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (ch === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === '[') {
      stack.push(null);
      expectKey = false;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      expectKey = false;
    } else if (ch === ',') {
      expectKey = stack[stack.length - 1] instanceof Set;
    }
  }
  return null;
}

/** A write's body, strictly (see the header's 413, 415 and 400). */
async function readBody(req: Request, spec: ResourceSpec): Promise<Args> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const text = await req.text();
  if (spec.method === 'DELETE' || (spec.method === 'POST' && Object.keys(spec.args).length === 0)) {
    // Nothing to send: an empty body, or an empty object.
    if (text.trim() !== '' && text.trim() !== '{}') throw new BadRequest('This endpoint takes no body.');
    return {};
  }
  if (type !== 'application/json') throw new ApiFailure(415, 'unsupported_media_type', 'Send the body as JSON, with Content-Type: application/json.');
  if (text.length > WRITE_BODY_MAX) throw new ApiFailure(413, 'too_large', `A body is at most ${WRITE_BODY_MAX} characters.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequest('The body is not JSON.');
  }
  const twice = repeatedKey(text);
  if (twice !== null) throw new BadRequest(`Give ${twice.slice(0, 40)} once.`);
  return bodyFromJson(spec, raw);
}

/**
 * Serves one operation on one resource (lib/api-spec.ts RESOURCE_SPECS): the
 * token admitted, the gate passed (what it may do, the switch and, for a
 * write, the minute's limit: lib/api-run.ts), the id in the path (decoded
 * once, by the router) and the query or body read strictly, If-Match and
 * Idempotency-Key as the operation takes them, and the operation run
 * (lib/api-writes.ts). Its answer carries the token's limits, and a write's
 * its write limits.
 */
export async function serveResource(req: Request, spec: ResourceSpec, rawId?: string): Promise<NextResponse> {
  // While this copy doesn't let tokens make changes, the API answers as it
  // did before writing existed: a write to a path that reads is a 405, and a
  // path only a write has is no endpoint at all.
  if (writesNeeded(spec) && !apiWritesEnabled()) return notTaken(spec.path);
  const admitted = await admit(req);
  if (admitted instanceof NextResponse) return admitted;
  const headers: Record<string, string> = { ...admitted.limits };
  try {
    Object.assign(headers, await gate(admitted.auth, spec));
    const id = spec.id ? idFromPath(spec.id, rawId) : undefined;
    const args = spec.method === 'GET' ? argsFromQuery(spec, new URL(req.url).searchParams) : await readBody(req, spec);
    const answer = await runResource(admitted.auth, spec, {
      id,
      args,
      version: spec.versioned ? readIfMatch(req.headers.get('if-match')) : undefined,
      key: req.headers.get('idempotency-key'),
      via: 'api',
    });
    return NextResponse.json(answer.body, { status: answer.status, headers: { ...NO_STORE, ...headers, ...answer.headers } });
  } catch (err) {
    const res = failed(err, spec.name);
    for (const [k, v] of Object.entries(headers)) if (!res.headers.has(k)) res.headers.set(k, v);
    return res;
  }
}

/** The answer for a method a path doesn't take, as this copy is set up: the
 *  methods its operations take (its writes only while tokens may make
 *  changes), or no endpoint at all where none is left. */
export function notTaken(path: string): NextResponse {
  const methods = new Set<string>();
  if (OPERATION_SPECS.some((o) => o.name === path)) methods.add('GET');
  for (const r of RESOURCE_SPECS) if (r.path === path && (!writesNeeded(r) || apiWritesEnabled())) methods.add(r.method);
  const allow = ['GET', 'POST', 'PATCH', 'DELETE'].filter((m) => methods.has(m)).join(', ');
  return allow ? methodNotAllowed(allow) : apiError(404, 'not_found', 'There is no such endpoint. The endpoints are listed at /developers.');
}

/** The answer for a method an endpoint doesn't take. */
export const methodNotAllowed = (allow: string) => apiError(405, 'method_not_allowed', `This endpoint takes ${allow} only.`, { Allow: allow });
