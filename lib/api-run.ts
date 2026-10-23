// lib/api-run.ts
//
// The one gate every API operation passes, whichever way it came: a REST read
// (lib/api-http.ts serve), a REST read of one resource or a write
// (serveResource), or an MCP tool call (lib/mcp.ts callTool). Nothing runs an
// operation another way, so a tool the MCP server didn't list is refused when
// it is called by name, exactly as its endpoint would refuse the same token.
// In order:
//
//   1. ACCESS. The operation's `allows` (lib/api-spec.ts) must name the
//      token's access (lib/api-limits.ts ACCESS): a balances token reaches
//      /me, /accounts and the balance write, a read token every read, a write
//      token every read and WRITE_V1. Refused: 403 insufficient_scope.
//   2. THE SWITCH, for anything beyond reading: off (lib/api-writes-enabled.ts),
//      403 writes_off.
//   3. THE MINUTE, for a write: WRITES_PER_MINUTE per token, every write sent,
//      valid or not, so garbage is bounded too. 429 rate_limited.
//
// Then the operation reads its input (a REST body, an MCP call's arguments)
// and runs. The day's limits are the write's own: all three are checked
// before a change is made (checkDay: the token's changes, all of the person's
// tokens' changes, and for a create the token's creates), and counted only
// once it is made (countDay). So a change refused for any reason (a limit, a
// stale version, a name already taken), a balance sent that changes nothing,
// and a create sent again count against no day, and one token past its own
// limit can't use up the person's. Writes landing at the same moment can
// each pass the check, so a day can end a few changes past its limit, never
// more than the minute's limit lets through at once.
//
// The gate's answer is a Gated (gate below), the only way to get one, which
// the resource runner (lib/api-writes.ts runResource) requires: nothing can
// run an operation without passing the gate first.

import type { Authenticated } from './api-tokens';
import { apiWriteCount, apiWriteDays } from './api-token-store';
import { ApiFailure, allowsOf } from './api-spec';
import { apiWritesEnabled } from './api-writes-enabled';
import { UnreadableEntriesError, type CounterMapStore } from './repo';
import { CHANGES_PER_DAY, CREATES_PER_DAY, PERSON_CHANGES_PER_DAY, WRITES_PER_MINUTE, type Access } from './api-limits';

/** What the token may do, in words, for a refusal. */
const CAN: Record<Access, string> = {
  read: 'This token can only read.',
  balances: 'This token can only read your accounts and update manual accounts’ balances.',
  write: 'This token can read, and make the changes it was made for.',
};

/** Whether a token may run something that allows these. */
export const mayRun = (auth: Pick<Authenticated, 'access'>, spec: { allows?: readonly Access[] }): boolean => allowsOf(spec).includes(auth.access);

/** Whether something needs more than reading: the switch decides it. */
export const writesNeeded = (spec: { allows?: readonly Access[]; write?: boolean }): boolean => spec.write === true || !allowsOf(spec).includes('read');

/** Step 1 and 2: may this token run it, here and now? Throws ApiFailure. */
export function checkAccess(auth: Pick<Authenticated, 'access'>, spec: { allows?: readonly Access[]; write?: boolean }): void {
  if (!mayRun(auth, spec)) {
    throw new ApiFailure(403, 'insufficient_scope', `${CAN[auth.access]} Make a token that may do this under API tokens.`, {
      'WWW-Authenticate': 'Bearer realm="Nya", error="insufficient_scope"',
    });
  }
  if (writesNeeded(spec) && !apiWritesEnabled()) {
    throw new ApiFailure(403, 'writes_off', 'This copy of Nya doesn’t let tokens make changes.');
  }
}

/** A counter's take, or a 503 for one that can't be read (cleared, as a
 *  token's request count is: bookkeeping, nothing of the person's lost). */
async function takeOf(store: CounterMapStore, auth: Authenticated, id: string, now: number) {
  try {
    return await store.take(auth.ctx, id, now);
  } catch (err) {
    if (!(err instanceof UnreadableEntriesError)) throw err;
    await store.remove(auth.ctx, id).catch(() => {});
    throw new ApiFailure(503, 'unavailable', 'The write limit could not be checked just now. Try again.');
  }
}

/** Step 3: counts one write for the token, and answers its window as
 *  headers; past the limit, ApiFailure 429. */
export async function takeWrite(auth: Authenticated, now: number = Date.now()): Promise<Record<string, string>> {
  const w = await takeOf(apiWriteCount, auth, auth.id, now);
  const headers = {
    'Write-RateLimit-Limit': String(WRITES_PER_MINUTE),
    'Write-RateLimit-Remaining': String(Math.max(0, WRITES_PER_MINUTE - w.count)),
    'Write-RateLimit-Reset': String(w.secondsLeft),
  };
  if (w.count > WRITES_PER_MINUTE) {
    throw new ApiFailure(429, 'rate_limited', `This token has sent ${WRITES_PER_MINUTE} changes this minute. Try again in ${w.secondsLeft} seconds.`, {
      ...headers,
      'Retry-After': String(w.secondsLeft),
    });
  }
  return headers;
}

const GATED: unique symbol = Symbol('gated');

/** What passing the gate gives: the headers a write's answer carries, for the
 *  operation it was passed for. Only gate() makes one. */
export type Gated = { readonly [GATED]: string; readonly headers: Record<string, string> };

/** Whether `gated` came from the gate, for the operation named. */
export const passedGate = (gated: Gated | undefined, name: string): boolean => !!gated && gated[GATED] === name;

/** The whole gate (steps 1 to 3) for an operation. */
export async function gate(auth: Authenticated, spec: { name: string; allows?: readonly Access[]; write?: boolean }, now: number = Date.now()): Promise<Gated> {
  checkAccess(auth, spec);
  const headers = spec.write ? await takeWrite(auth, now) : {};
  return { [GATED]: spec.name, headers };
}

/** The ids a change counts against: the token's, the person's, and for a
 *  create, the token's creates. */
const dayIds = (auth: Authenticated, create: boolean) => [auth.id, 'person', ...(create ? [`${auth.id}.creates`] : [])];

const dayHeaders = (mine: { count: number; secondsLeft: number }) => ({
  'Write-Day-Limit': String(CHANGES_PER_DAY),
  'Write-Day-Remaining': String(Math.max(0, CHANGES_PER_DAY - mine.count)),
  'Write-Day-Reset': String(mine.secondsLeft),
});

/**
 * Checks, counting nothing, that one more change fits every day's limit: the
 * token's, all of the person's tokens' together, and, for a create, the
 * token's creates. Past any, ApiFailure 429, and nothing is changed or
 * counted. A count that can't be read is cleared (bookkeeping) and refused
 * for now, as the minute's is.
 */
export async function checkDay(auth: Authenticated, opts: { create: boolean }, now: number = Date.now()): Promise<void> {
  const ids = dayIds(auth, opts.create);
  let windows;
  try {
    windows = await apiWriteDays.peek(auth.ctx, ids, now);
  } catch (err) {
    if (!(err instanceof UnreadableEntriesError)) throw err;
    await apiWriteDays.remove(auth.ctx, ...err.unreadable).catch(() => {});
    throw new ApiFailure(503, 'unavailable', 'The write limit could not be checked just now. Try again.');
  }
  const [mine, all, made] = windows;
  const headers = dayHeaders(mine);
  const over = (w: { secondsLeft: number }, why: string) =>
    new ApiFailure(429, 'rate_limited', `${why} Try again in ${Math.ceil(w.secondsLeft / 3600)} hours.`, { ...headers, 'Retry-After': String(w.secondsLeft) });
  if (mine.count >= CHANGES_PER_DAY) throw over(mine, `This token has made ${CHANGES_PER_DAY} changes today.`);
  if (all.count >= PERSON_CHANGES_PER_DAY) throw over(all, `Your tokens have made ${PERSON_CHANGES_PER_DAY} changes today.`);
  if (made && made.count >= CREATES_PER_DAY) throw over(made, `This token has made ${CREATES_PER_DAY} new things today.`);
}

/**
 * Counts one change that was made against the day's limits checked by
 * checkDay, and answers the token's day window as headers. Never throws: the
 * change is made, and its answer stands; a count that can't be taken is
 * logged, and the day is the shorter by it.
 */
export async function countDay(auth: Authenticated, opts: { create: boolean }, now: number = Date.now()): Promise<Record<string, string>> {
  try {
    const [mine] = await Promise.all(dayIds(auth, opts.create).map((id) => apiWriteDays.take(auth.ctx, id, now)));
    return dayHeaders(mine);
  } catch (err) {
    console.error('API: a change could not be counted against the day', err instanceof Error ? err.name : typeof err);
    return {};
  }
}
