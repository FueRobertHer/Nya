// lib/admin-items.ts
//
// The admin's view of connections that cost money and do nothing, across every
// account on the deployment (lib/item-usage.ts flags them per container).
//
// WHO IS THE ADMIN: whoever the deployment's own container belongs to
// (lib/sessions.ts deploymentContainer): normally the primary container, so the
// account that signed in first with Clerk, or the password holder without it;
// CONTAINER_ID, if set, names a different one. Nobody else
// gets to list other accounts' connections, let alone remove one.
//
// Removal is the only thing here that changes anything, and it is fenced:
//   - only an Item the admin was shown as flagged can be named;
//   - the check is run again first, and the Item must be confirmed unused by
//     THAT run's own read (`confirmed_run`), so a connection its owner reconnected
//     or unhid since the last daily check is left alone, and so is one whose
//     read merely failed;
//   - the container must be active (not being restored or archived);
//   - the admin types the institution's name in the app, as for any disconnect.
// It then does exactly what the Disconnect button does (lib/disconnect-item.ts).

import { NextResponse } from 'next/server';
import { dataCtx } from './data-ctx';
import { deploymentContainer } from './sessions';
import { clerkEnabled } from './auth-mode';
import { kEnv, getItems, redis } from './storage';
import { listContainers, isContainerId, type Ctx, type ContainerId } from './containers';
import { checkItemUsage, readFlagged, type FlagKind } from './item-usage';
import { disconnectItem } from './disconnect-item';

/** Whether this container is the deployment's own, i.e. its owner is the admin. */
export async function isAdmin(ctx: Ctx): Promise<boolean> {
  const dep = await deploymentContainer();
  return dep.kind === 'container' && dep.container === ctx.container;
}

/** The signed-in admin's container, or null for anyone else. */
export async function adminCtx(): Promise<Ctx | null> {
  const ctx = await dataCtx();
  return (await isAdmin(ctx)) ? ctx : null;
}

/** The response for a request from someone who is not the admin. A 404, as if
 *  the route did not exist: it should not announce itself to other accounts. */
export function notAdmin(): Response {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export type AdminRow = {
  container: string;
  /** Who it belongs to: "You", an email address, or "Account from <date it was
   *  created>" (stable, unlike a number). */
  owner: string;
  item_id: string;
  institution_name: string;
  kind: FlagKind;
  since: string;
};

/** Container id -> a Clerk address for its owner, where one can be found. */
async function ownerAddresses(containers: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (containers.length === 0 || !clerkEnabled()) return out;
  try {
    const owners = ((await redis().hgetall(kEnv('owners'))) ?? {}) as Record<string, unknown>;
    const { emailAddresses } = await import('./clerk-emails');
    for (const [userId, container] of Object.entries(owners)) {
      if (typeof container !== 'string' || !containers.includes(container)) continue;
      try {
        const verified = (await emailAddresses(userId)).find((e) => e.verified);
        if (verified) out.set(container, verified.address);
      } catch {
        // labelled "Account N" instead
      }
    }
  } catch {
    // ditto
  }
  return out;
}

/** Every active container's flagged connections, as the last check left them.
 *  Reads stored records only; calls no one. */
export async function listFlagged(admin: Ctx): Promise<AdminRow[]> {
  const registry = (await listContainers()).filter((c) => c.status === 'active');
  const perContainer = await Promise.all(
    registry.map(async (c) => {
      try {
        return { id: c.id as string, made: c.created_at.slice(0, 10), items: await readFlagged({ container: c.id }) };
      } catch {
        console.error('Admin items: one account could not be read.');
        return { id: c.id as string, made: c.created_at.slice(0, 10), items: [] };
      }
    })
  );
  const flaggedContainers = perContainer.filter((p) => p.items.length > 0).map((p) => p.id);
  const addresses = await ownerAddresses(flaggedContainers.filter((id) => id !== admin.container));
  const rows: AdminRow[] = [];
  for (const p of perContainer) {
    const owner = p.id === admin.container ? 'You' : addresses.get(p.id) ?? `Account from ${p.made}`;
    for (const f of p.items) {
      rows.push({ container: p.id, owner, item_id: f.item_id, institution_name: f.institution_name, kind: f.kind, since: f.since });
    }
  }
  return rows;
}

/** Runs the check on every active account now. Removes nothing. */
export async function checkAll(): Promise<void> {
  for (const c of (await listContainers()).filter((c) => c.status === 'active')) {
    try {
      await checkItemUsage({ container: c.id });
    } catch {
      console.error('Admin items: one account could not be checked.');
    }
  }
}

export type RemoveResult = { ok: true } | { ok: false; status: number; error: string };

/** Disconnects one flagged Item, after checking again that it still is one. */
export async function removeFlagged(container: unknown, item_id: unknown): Promise<RemoveResult> {
  if (!isContainerId(container) || typeof item_id !== 'string') return { ok: false, status: 400, error: 'Bad request' };
  const rec = (await listContainers()).find((c) => c.id === container);
  if (!rec || rec.status !== 'active') return { ok: false, status: 409, error: 'That account is not available right now.' };
  const ctx: Ctx = { container: container as ContainerId };

  // Named only if the admin could have been shown it.
  if (!(await readFlagged(ctx)).some((f) => f.item_id === item_id)) {
    return { ok: false, status: 409, error: 'That connection is not flagged any more.' };
  }

  // Confirmed again, by a read made now.
  const runId = crypto.randomUUID();
  await checkItemUsage(ctx, { runId, onlyItemId: item_id });
  const still = (await readFlagged(ctx)).find((f) => f.item_id === item_id);
  if (!still || still.confirmed_run !== runId) {
    return {
      ok: false,
      status: 409,
      error: 'It could not be confirmed as unused just now (it may have been reconnected, or Plaid did not answer). Nothing was removed.',
    };
  }

  const item = (await getItems(ctx)).find((i) => i.item_id === item_id);
  if (!item) return { ok: false, status: 409, error: 'That connection is already gone.' };
  await disconnectItem(ctx, item_id, item);
  return { ok: true };
}
