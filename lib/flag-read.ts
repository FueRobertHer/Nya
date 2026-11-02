// lib/flag-read.ts
//
// Reading the feature switches (lib/flags.ts) on the server, and deciding
// what each answers for a request.
//
// VARIABLE FIRST. A switch moved from the environment answers from its
// variable while that is set, and then reads nothing.
//
// FRESH AT A GATE. A route about to allow what a flag turns on (starting a
// restore, a Lunch Flow connection, a token's write, an ops route) reads the
// stored values then (readFlagsFresh), so turning a flag off holds at once. If
// that read fails, the gate answers off and refuses.
//
// CACHED EVERYWHERE ELSE. Pages, the proxy, and answers that only describe or
// come before an account is known read a copy kept in this instance's memory
// at most CACHE_MS old (lib/flag-cache.ts holds it). Callers at the same time
// share one read, and its time is noted before it is awaited, so a slow or
// failing Redis costs one read per instance per CACHE_MS; a cached read waits
// at most WAIT_MS. A failed read keeps the last value read, or, with none read
// yet, the defaults, and tries again after RETRY_MS. Every instance (and the
// proxy apart from the route handlers in one) keeps its own copy, so a change
// reaches pages, the proxy and the CSP within CACHE_MS.
//
// LENIENT PER FIELD. A stored field for a flag this release doesn't know is
// skipped, so a rollback ignores a newer flag; a known flag's value this
// release can't read takes the default and is logged, by its key alone.
//
// The deployment's owners, whom the sign-in list always lets in, are cached
// the same way beside the flags, read apart and only when the sign-in list is
// consulted, so a registry that can't be read fails only sign-in, as unknown.

import { flagsStore } from './flag-store';
import { flagCache } from './flag-cache';
import { isDemoUser } from './demo';
import {
  AUDIENCE_KEYS,
  FLAGS,
  audienceVariable,
  cspVariable,
  flagEnvironment,
  isAudienceValue,
  isFlagKey,
  isListValue,
  isModeValue,
  isSwitchValue,
  opsVariable,
  type AudienceKey,
  type AudienceValue,
  type FlagKey,
  type FlagValue,
} from './flags';
import type { ContainerId, Ctx } from './containers';
import type { CspMode } from './security-headers';

/** The stored values this release can use, by flag. */
export type StoredFlags = ReadonlyMap<FlagKey, FlagValue>;
/** Where a cached answer came from: a read within CACHE_MS, the last read
 *  kept through a failed one, or none read yet (the defaults). */
export type Source = 'read' | 'last' | 'none';

export const CACHE_MS = 30_000;
export const RETRY_MS = 2_000;
export const WAIT_MS = 2_000;

/** The stored values, now, leniently (see the header). Throws when storage
 *  can't be read. */
export async function readFlagsFresh(): Promise<StoredFlags> {
  const report = await flagsStore.getAllReport();
  const out = new Map<FlagKey, FlagValue>();
  for (const [id, value] of report.entries) if (isFlagKey(id)) out.set(id, value);
  for (const id of report.unrecognised) {
    if (isFlagKey(id)) console.error(`Flags: the stored value of ${id} can't be read, so its default applies.`);
  }
  return out;
}

function withLimit<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A cached read of one slot (see the header). */
async function cached(slot: 'flags' | 'owners', read: () => Promise<unknown>, what: string, now: number): Promise<{ value: unknown; source: Source }> {
  const held = flagCache[slot];
  if (!held.inFlight) {
    const wait = held.value === undefined ? RETRY_MS : CACHE_MS;
    if (held.triedAt === 0 || now - held.triedAt >= wait) {
      const generation = flagCache.generation;
      held.triedAt = now;
      const run = async () => {
        try {
          const value = await withLimit(read(), WAIT_MS);
          if (flagCache.generation !== generation) return;
          held.value = value;
          held.ok = true;
        } catch (err) {
          if (flagCache.generation !== generation) return;
          held.ok = false;
          const kept = held.value === undefined ? 'the defaults apply' : 'the last read is used';
          console.error(`Flags: ${what} could not be read, so ${kept}:`, err instanceof Error ? err.message : typeof err);
        }
      };
      const attempt: Promise<void> = run().finally(() => {
        if (held.inFlight === attempt) held.inFlight = null;
      });
      held.inFlight = attempt;
    }
  }
  if (held.inFlight) await held.inFlight;
  // A forget meanwhile left a slot of its own, with nothing read in it.
  const after = flagCache[slot];
  return { value: after.value, source: after.value === undefined ? 'none' : after.ok ? 'read' : 'last' };
}

/** The stored values through this instance's copy, and where they came from. */
export async function cachedFlags(now: number = Date.now()): Promise<{ flags: StoredFlags; source: Source }> {
  const { value, source } = await cached('flags', readFlagsFresh, 'the feature switches', now);
  return { flags: (value as StoredFlags | undefined) ?? new Map(), source };
}

async function readOwners(): Promise<string[]> {
  const [{ deploymentContainer }, { ownersOf }] = await Promise.all([import('./sessions'), import('./owners')]);
  const dep = await deploymentContainer();
  return dep.kind === 'container' ? ownersOf(dep.container) : [];
}

/** The deployment's owners (the accounts that own its container) through
 *  this instance's copy, or null when none has been read yet. */
export async function cachedOwners(now: number = Date.now()): Promise<string[] | null> {
  const { value } = await cached('owners', readOwners, 'the deployment’s owners', now);
  return (value as string[] | undefined) ?? null;
}

// ---- Who a request is for ----

/** What an audience is judged by: the request's container (null where none is
 *  known), whether its account is a demo account, and, asked only when an
 *  audience needs it, whether it is the admin. */
export type Who = { readonly container: ContainerId | null; readonly demo: boolean; admin(): Promise<boolean> };

export function flagWho(container: ContainerId | null, userId: string | null, opts: { admin?: boolean } = {}): Who {
  let admin: Promise<boolean> | undefined = opts.admin === undefined ? undefined : Promise.resolve(opts.admin);
  return {
    container,
    demo: userId !== null && isDemoUser(userId),
    admin() {
      // Imported here: lib/admin-gate.ts imports lib/auth-mode.ts, which
      // reads the sign-in list through this module.
      admin ??=
        container === null
          ? Promise.resolve(false)
          : import('./admin-gate').then(
              (m) => m.isAdminContainer(container),
              () => false
            );
      return admin;
    },
  };
}

/** Who a signed-in request is for: its container, and its Clerk account
 *  where Clerk is on (with the shared password there are no people). For a
 *  route that has resolved its container (lib/data-ctx.ts). */
export async function requestWho(ctx: Ctx): Promise<Who> {
  const { clerkEnabled } = await import('./auth-mode');
  if (!clerkEnabled()) return flagWho(ctx.container, null);
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  return flagWho(ctx.container, userId ?? null);
}

// ---- Evaluating ----

function audienceOf(key: AudienceKey, flags: StoredFlags): Pick<AudienceValue, 'on' | 'containers'> {
  const stored = flags.get(key);
  return stored && isAudienceValue(stored) ? stored : { on: FLAGS[key].defaults[flagEnvironment()], containers: [] };
}

async function includes(audience: Pick<AudienceValue, 'on' | 'containers'>, who: Who): Promise<boolean> {
  if (who.container !== null && audience.containers.includes(who.container)) return true;
  switch (audience.on) {
    case 'everyone':
      return true;
    case 'nobody':
      return false;
    case 'admin-and-demo':
      return who.demo || (await who.admin());
    case 'admin':
      return who.admin();
  }
}

/** Whether an audience flag is on for `who`, given the stored values: its
 *  variable while set, else the stored audience, else its default. */
export async function flagOn(key: AudienceKey, who: Who, flags: StoredFlags): Promise<boolean> {
  const variable = audienceVariable(key);
  if (variable !== undefined) return variable;
  return includes(audienceOf(key, flags), who);
}

/** flagOn through this instance's copy: for pages and answers that describe. */
export async function flagOnCached(key: AudienceKey, who: Who): Promise<boolean> {
  const variable = audienceVariable(key);
  if (variable !== undefined) return variable;
  return flagOn(key, who, (await cachedFlags()).flags);
}

/** flagOn on a fresh read: for a gate. A read that fails answers off. */
export async function flagOnFresh(key: AudienceKey, who: Who): Promise<boolean> {
  const variable = audienceVariable(key);
  if (variable !== undefined) return variable;
  let flags: StoredFlags;
  try {
    flags = await readFlagsFresh();
  } catch (err) {
    console.error(`Flags: ${key} could not be read, so it is taken as off:`, err instanceof Error ? err.name : typeof err);
    return false;
  }
  return flagOn(key, who, flags);
}

/** Whether an audience flag is on for anyone at all: for an answer given
 *  before any account is known (the API's answer to a method a path doesn't
 *  take). Through this instance's copy. */
export async function flagOnForAnyone(key: AudienceKey): Promise<boolean> {
  const variable = audienceVariable(key);
  if (variable !== undefined) return variable;
  const audience = audienceOf(key, (await cachedFlags()).flags);
  return audience.on !== 'nobody' || audience.containers.length > 0;
}

/** Every audience flag for `who`, as the browser gets them with the page's
 *  other server values: booleans only, never the accounts or the lists. */
export type ClientFlags = Record<AudienceKey, boolean>;

export async function clientFlags(who: Who): Promise<ClientFlags> {
  const read = AUDIENCE_KEYS.some((key) => audienceVariable(key) === undefined);
  const flags = read ? (await cachedFlags()).flags : new Map<FlagKey, FlagValue>();
  const pairs = await Promise.all(AUDIENCE_KEYS.map(async (key) => [key, await flagOn(key, who, flags)] as const));
  return Object.fromEntries(pairs) as ClientFlags;
}

/** The Content-Security-Policy's mode, through this instance's copy: for the
 *  proxy, on every page. */
export async function cspModeCached(): Promise<CspMode> {
  const variable = cspVariable();
  if (variable !== undefined) return variable;
  const stored = (await cachedFlags()).flags.get('csp');
  return stored && isModeValue(stored) ? stored.mode : FLAGS.csp.defaults[flagEnvironment()];
}

function opsFrom(flags: StoredFlags): boolean {
  const stored = flags.get('ops');
  return stored && isSwitchValue(stored) ? stored.on : FLAGS.ops.defaults[flagEnvironment()];
}

/** Whether the ops routes are open, through this instance's copy: their first
 *  look, so a probe of a public path reads nothing. */
export async function opsOnCached(): Promise<boolean> {
  const variable = opsVariable();
  if (variable !== undefined) return variable;
  return opsFrom((await cachedFlags()).flags);
}

/** Whether the ops routes are open, now: once a request's secret matched. A
 *  read that fails answers closed. */
export async function opsOnFresh(): Promise<boolean> {
  const variable = opsVariable();
  if (variable !== undefined) return variable;
  try {
    return opsFrom(await readFlagsFresh());
  } catch (err) {
    console.error('Flags: ops could not be read, so the ops routes stay closed:', err instanceof Error ? err.name : typeof err);
    return false;
  }
}

/** The stored sign-in list and the deployment's owners, for lib/auth-mode.ts
 *  while CLERK_ALLOWED_USER_IDS is unset: each null when none has been read
 *  yet, which the caller answers as unknown. */
export async function signInFromStore(): Promise<{ list: { ids: string[]; emails: string[] } | null; owners: string[] | null }> {
  const [{ flags, source }, owners] = await Promise.all([cachedFlags(), cachedOwners()]);
  if (source === 'none') return { list: null, owners };
  const stored = flags.get('sign-in');
  return { list: stored && isListValue(stored) ? { ids: stored.ids, emails: stored.emails } : { ids: [], emails: [] }, owners };
}
