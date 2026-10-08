// lib/notice-recipients.ts
//
// Who is emailed about a container's bank connections (#51): whoever owns the
// data, and nobody else.
//
//   With Clerk on (lib/auth-mode.ts): the primary email address of each
//   account that owns the container (lib/owners.ts), when Clerk has verified
//   it. An unverified address could be anyone's, so it gets nothing. Preview's
//   demo accounts get nothing either: their data is a sandbox.
//
//   With the shared password: NOTIFY_EMAIL, and only for the deployment's own
//   container (lib/sessions.ts deploymentContainer), the one the password
//   opens. Any other container in the registry is somebody else's data. With
//   Clerk on, NOTIFY_EMAIL is ignored, so one address can never receive every
//   account's notices.
//
// An empty answer means nobody to tell: the caller sends nothing and says so.

import type { Ctx } from './containers';
import { clerkEnabled } from './auth-mode';
import { isDemoUser } from './demo';
import { ownersOf } from './owners';
import { deploymentContainer } from './sessions';
import { isEmailAddress } from './mail';

/** At most this many addresses: a container has one owner, unless its mapping
 *  was edited by hand. */
const MAX_RECIPIENTS = 5;

/** A Clerk user, as far as this reads one. */
export type ClerkUserEmails = {
  primaryEmailAddressId: string | null;
  emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[];
};

/** The user's primary address, if Clerk has verified it; otherwise null. */
export function primaryVerifiedOf(user: ClerkUserEmails): string | null {
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  return primary && primary.verification?.status === 'verified' && isEmailAddress(primary.emailAddress) ? primary.emailAddress : null;
}

async function clerkPrimaryEmail(userId: string): Promise<string | null> {
  const { clerkClient } = await import('@clerk/nextjs/server');
  return primaryVerifiedOf(await (await clerkClient()).users.getUser(userId));
}

/** NOTIFY_EMAIL's addresses: one, or a few separated by commas. */
export function notifyEmails(): string[] {
  return (process.env.NOTIFY_EMAIL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(isEmailAddress)
    .slice(0, MAX_RECIPIENTS);
}

export type RecipientDeps = {
  owners?: (container: Ctx['container']) => Promise<string[]>;
  primaryEmail?: (userId: string) => Promise<string | null>;
  deployment?: typeof deploymentContainer;
};

/**
 * The addresses to email about this container's connections (see the header).
 * Throws if the owners or Clerk can't be read: the caller sends nothing, and
 * tries again on its next run. The dependencies are for tests.
 */
export async function noticeRecipients(ctx: Ctx, deps: RecipientDeps = {}): Promise<string[]> {
  if (clerkEnabled()) {
    const owners = (await (deps.owners ?? ownersOf)(ctx.container)).filter((id) => !isDemoUser(id));
    const emails = await Promise.all(owners.map((id) => (deps.primaryEmail ?? clerkPrimaryEmail)(id)));
    return [...new Set(emails.filter((e): e is string => e !== null))].slice(0, MAX_RECIPIENTS);
  }
  const dep = await (deps.deployment ?? deploymentContainer)();
  if (dep.kind !== 'container' || dep.container !== ctx.container) return [];
  return notifyEmails();
}
