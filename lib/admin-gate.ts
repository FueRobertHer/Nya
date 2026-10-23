// lib/admin-gate.ts
//
// Whether a signed-in account is the admin, for proxy.ts, which refuses the
// admin's pages (app/admin/) to anyone else before they render: as a path
// that does not exist, so the document they get is the one any missing path
// gets, with nothing of the page in it. Decided as lib/admin-items.ts
// isAdmin decides (the deployment's own container is the signed-in
// account's), reading only: ownedContainer, never ownerContainer, which can
// make a container on a first sign-in. Kept apart from lib/admin-items.ts so
// the proxy loads none of what that module brings (the Plaid client).
// test/admin-storage.test.ts holds the two to the same answers.

import { deploymentContainer } from './sessions';
import { ownedContainer } from './owners';
import { clerkEnabled } from './auth-mode';

/** Whether this sign-in is the admin's: its Clerk account's, or with the
 *  shared password (userId null), the one person's, whenever the deployment
 *  has a container. Any doubt (no container yet, an unreadable registry)
 *  is no. */
export async function isAdminSignIn(userId: string | null): Promise<boolean> {
  try {
    const dep = await deploymentContainer();
    if (dep.kind !== 'container') return false;
    if (userId === null) return !clerkEnabled();
    return (await ownedContainer(userId)) === dep.container;
  } catch {
    return false;
  }
}
