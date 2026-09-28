// lib/auth-mode.ts
//
// Which sign-in the app uses. Clerk (managed accounts, the start of #44) when
// both of its keys are set; otherwise the shared password (lib/auth.ts),
// unchanged. So a deployment without Clerk keys behaves exactly as before,
// and turning Clerk on or off is a change of environment, not of code.
//
// Only people on CLERK_ALLOWED_USER_IDS get in. It is comma-separated, and
// each entry is a Clerk user id (user_...) or an email address. An email
// matches an account that has it as a verified address, in any case: Clerk
// has proved the person holds that inbox, so typing someone else's address
// into an account gets nobody in. An
// account matching more than one entry (its id and its email) is simply
// allowed; to turn someone away, remove every entry that matches them.
// Unset or empty lets nobody in: a signed-in stranger must never reach the
// data. Which data an allowed account reaches is lib/owners.ts: the first to
// sign in owns what is already here, each other its own.
//
// Ids are checked first and need nothing else. Emails need the account's
// addresses from Clerk: looked up only when an email entry exists and the id
// isn't listed, reused for a minute per instance (the proxy asks on every
// request), and shared by requests that ask at the same time. If Clerk can't
// answer, an answer up to ten minutes old is used instead, so a short Clerk
// outage doesn't lock anyone out; with none, the person is turned away. List
// the owner by id: ids never depend on Clerk answering.

export function clerkEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && !!process.env.CLERK_SECRET_KEY;
}

function allowlist(): { ids: Set<string>; emails: Set<string> } {
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const raw of (process.env.CLERK_ALLOWED_USER_IDS ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.includes('@')) emails.add(entry.toLowerCase());
    else ids.add(entry);
  }
  return { ids, emails };
}

export const EMAILS_REUSE_MS = 60_000;
export const EMAILS_STALE_MS = 10 * 60_000;
const MAX_CACHED = 1000;
const emailCache = new Map<string, { emails: string[]; at: number }>();
const inFlight = new Map<string, Promise<string[]>>();

async function lookup(userId: string, now: number): Promise<string[]> {
  const { emailAddresses } = await import('./clerk-emails');
  const emails = (await emailAddresses(userId)).filter((e) => e.verified).map((e) => e.address.toLowerCase());
  if (emailCache.size >= MAX_CACHED) emailCache.clear(); // strangers signing in can't grow it forever
  emailCache.set(userId, { emails, at: now });
  return emails;
}

async function emailsOf(userId: string, now: number): Promise<string[]> {
  const hit = emailCache.get(userId);
  if (hit && now - hit.at < EMAILS_REUSE_MS) return hit.emails;
  let pending = inFlight.get(userId);
  if (!pending) {
    pending = lookup(userId, now).finally(() => inFlight.delete(userId));
    inFlight.set(userId, pending);
  }
  try {
    return await pending;
  } catch (err) {
    if (hit && now - hit.at < EMAILS_STALE_MS) return hit.emails;
    throw err;
  }
}

/** For tests. */
export function forgetEmails(): void {
  emailCache.clear();
  inFlight.clear();
}

export async function clerkUserAllowed(userId: string, now: number = Date.now()): Promise<boolean> {
  if (!userId) return false;
  const { ids, emails } = allowlist();
  if (ids.has(userId)) return true;
  if (emails.size === 0) return false;
  try {
    return (await emailsOf(userId, now)).some((e) => emails.has(e));
  } catch (err) {
    console.error('Allowlist: the account’s emails could not be read from Clerk', err instanceof Error ? err.name : err);
    return false;
  }
}
