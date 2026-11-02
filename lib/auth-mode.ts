// lib/auth-mode.ts
//
// Which sign-in the app uses. Clerk (managed accounts, the start of #44) when
// both of its keys are set; otherwise the shared password (lib/auth.ts),
// unchanged. Turning Clerk on or off is a change of environment, not of code.
//
// Who may sign in is the `sign-in` feature switch (lib/flags.ts). While
// CLERK_ALLOWED_USER_IDS is set, only people on it get in, as always. It is
// comma-separated, and each entry is a Clerk user id (user_...) or an email
// address. An email matches an account that has it as a verified address, in
// any case: Clerk has proved the person holds that inbox, so typing someone
// else's address into an account gets nobody in. An account matching more than
// one entry (its id and its email) is simply allowed; to turn someone away,
// remove every entry that matches them. Set to nothing but commas and blanks,
// it lets nobody in. Unset or empty, the deployment's owners (the accounts that
// own its container, lib/owners.ts) get in, and so does anyone on the stored
// list (set on the admin page from F2), which holds the same ids and emails;
// until the flags have been read once here, nobody else can be told apart, and
// the answer is 'unknown'. A signed-in stranger never reaches the data. Which
// data an allowed account reaches is lib/owners.ts: the first to sign in owns
// what is already here, each other its own.
//
// Ids are checked first and need nothing else. Emails need the account's
// addresses from Clerk: looked up only when an email entry exists and the id
// isn't listed, reused for a minute per instance (the proxy asks on every
// request), and shared by requests that ask at the same time. If Clerk can't
// answer, an answer up to ten minutes old is used, so a short Clerk outage
// doesn't lock anyone out; with none, the person is turned away. List the owner
// by id: ids never depend on Clerk answering.

import { isDemoUser } from './demo';
import { signInVariable } from './flags';
import { signInFromStore } from './flag-read';

export function clerkEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && !!process.env.CLERK_SECRET_KEY;
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
  return (await clerkUserAccess(userId, now)) === 'allowed';
}

/**
 * Whether an account may sign in, as clerkUserAllowed decides it, but saying
 * when it couldn't be told: 'unknown' when only its emails could let it in
 * and Clerk couldn't give them (with no answer recent enough to use). For a
 * caller that must not take an outage for a refusal: an API token
 * (lib/api-tokens.ts) is answered "try again later" then, not "revoked".
 */
export async function clerkUserAccess(userId: string, now: number = Date.now()): Promise<'allowed' | 'denied' | 'unknown'> {
  if (!userId) return 'denied';
  const listed = signInVariable();
  if (listed !== undefined) {
    if (listed.ids.includes(userId)) return 'allowed';
    // Preview's demo accounts (lib/demo.ts), wherever demos are on.
    if (isDemoUser(userId)) return 'allowed';
    return byEmail(userId, listed.emails, now);
  }
  if (isDemoUser(userId)) return 'allowed';
  const { owners, list } = await signInFromStore();
  if (owners?.includes(userId) || list?.ids.includes(userId)) return 'allowed';
  const answer = list ? await byEmail(userId, list.emails, now) : 'denied';
  if (answer === 'allowed') return 'allowed';
  // Not read yet here: whether this account may come in can't be told.
  if (owners === null || list === null) return 'unknown';
  return answer;
}

/** Whether one of an account's verified emails is among these. */
async function byEmail(userId: string, emails: readonly string[], now: number): Promise<'allowed' | 'denied' | 'unknown'> {
  if (emails.length === 0) return 'denied';
  try {
    return (await emailsOf(userId, now)).some((e) => emails.includes(e)) ? 'allowed' : 'denied';
  } catch (err) {
    console.error('Allowlist: the account’s emails could not be read from Clerk', err instanceof Error ? err.name : err);
    return 'unknown';
  }
}
