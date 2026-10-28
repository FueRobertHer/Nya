// lib/admin-gate.ts
//
// Who the admin is, decided here once (isAdminContainer) for both gates:
// lib/admin-items.ts isAdmin, which the admin's routes and pages and Home's
// admin panel ask, and isAdminSignIn below, which proxy.ts asks before it
// shows the admin's pages (app/admin/) to anyone: anyone else gets them as a
// path that does not exist, so the document they get is the one any missing
// path gets, with nothing of the page in it. The admin is the owner of the
// deployment's own container, never a demo account (lib/demo.ts): while one
// owns that container, nobody is the admin, since everyone who presses its
// button on the sign-in page would be. isAdminSignIn reads only:
// ownedContainer, never ownerContainer, which can make a container on a
// first sign-in. Kept apart from lib/admin-items.ts so the proxy loads none
// of what that module brings (the Plaid client).
// test/admin-storage.test.ts holds the two gates to the same answers.

import { deploymentContainer } from './sessions';
import { ownedContainer, ownersOf } from './owners';
import { clerkEnabled } from './auth-mode';
import { demoUsers } from './demo';
import type { ContainerId } from './containers';

/**
 * Whether this container is the admin's: the deployment's own, unless a demo
 * account owns it. Where there are no demo accounts (Production, self-hosted)
 * nothing is read beyond the registry deploymentContainer keeps. Where there
 * are, the container's owners are read, and it is the admin's only when that
 * list holds someone and no demo account: an empty list, for a container that
 * someone is signed in to, can only be a read that does not match the
 * mapping.
 *
 * Two failures, answered differently on purpose. A registry that can't be
 * read throws, as it did before demo accounts mattered here: the admin's
 * routes then answer it as the error it is (a 500), Home and the proxy as
 * not the admin. Owners that can't be read answer false (not the admin, so
 * the routes' usual 404): the doubt is about whether a demo owns the
 * container, and that doubt must never make anyone the admin. Don't turn
 * either into a true.
 */
export async function isAdminContainer(container: ContainerId): Promise<boolean> {
  const dep = await deploymentContainer();
  if (dep.kind !== 'container' || dep.container !== container) return false;
  const demos = demoUsers();
  if (demos.length === 0) return true;
  let owners: string[];
  try {
    owners = await ownersOf(container);
  } catch {
    console.error('Admin: who owns the deployment’s container could not be read, so nobody is the admin just now.');
    return false;
  }
  return owners.length > 0 && !owners.some((id) => demos.some((d) => d.id === id));
}

/** Whether this sign-in is the admin's: its Clerk account's, or with the
 *  shared password (userId null), the one person's, whenever the deployment
 *  has a container. Decided by isAdminContainer, over the container the
 *  account owns. Any doubt (no container yet, an unreadable registry or
 *  mapping) is no. */
export async function isAdminSignIn(userId: string | null): Promise<boolean> {
  try {
    if (userId === null) {
      if (clerkEnabled()) return false;
      const dep = await deploymentContainer();
      return dep.kind === 'container' && (await isAdminContainer(dep.container));
    }
    const owned = await ownedContainer(userId);
    return owned !== null && (await isAdminContainer(owned));
  } catch {
    return false;
  }
}
