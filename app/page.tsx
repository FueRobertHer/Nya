import { Suspense } from 'react';
import Dashboard from '@/components/Dashboard';
import { AppLoading } from '@/components/LoadingSkeletons';
import { clerkEnabled } from '@/lib/auth-mode';
import { clientFlags, flagsNameAccounts, flagWho, newUntil, opsOpenCached, type ClientFlags } from '@/lib/flag-read';
import type { OpsOpen } from '@/lib/flag-view';
import type { ContainerId } from '@/lib/containers';
import { parseSettings, parseTab, type Tab } from '@/lib/dashboard-tab';

export default async function Home({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  // The tab the address asks for (lib/dashboard-tab.ts), so a reload draws
  // that tab's loading view first and comes back to it; and Settings, open
  // over it, the same way (Sharing only with Clerk, else its list; Admin only
  // for the admin, who is the one person without Clerk and isn't known yet
  // with it, so SignedInHome reads it again once they are).
  const params = await searchParams;
  const tab = parseTab(params);
  const settings = parseSettings(params, { sharing: clerkEnabled(), admin: !clerkEnabled() });
  // Without Clerk there is one person, who is the admin (lib/admin-items.ts), so
  // nothing more is read about who it is. The feature switches come with the
  // page's other server values (lib/flag-read.ts clientFlags): whether to offer
  // connecting a brokerage or retirement account (lib/item-products.ts), Lunch
  // Flow (lib/connectors/switch.ts), and the rest, never their lists.
  if (!clerkEnabled()) return <Dashboard clerk={false} admin flags={await passwordFlags()} initialTab={tab} initialSettings={settings} adminOps={await adminOps()} newUntil={await newUntil('plan-items-in-fi')} childNewUntil={await newUntil('plan-child-accounts')} />;
  // Who is signed in, and whether they are the admin, are read before the
  // dashboard is sent. Meanwhile the page streams the app loading
  // (components/LoadingSkeletons.tsx), the header and Net worth card the
  // dashboard draws while it loads: so once Clerk signs someone in and moves
  // here, that shows at once, where the sign-in page stayed before.
  return (
    <Suspense fallback={<AppLoading account="clerk" tab={tab} settings={settings} />}>
      <SignedInHome tab={tab} params={params} />
    </Suspense>
  );
}

/** Whether the ops routes are open, and by what, for the admin's Needs
 *  attention on Home; never sent to anyone else. A read that fails says
 *  nothing. */
async function adminOps(): Promise<OpsOpen | null> {
  try {
    return await opsOpenCached();
  } catch {
    return null;
  }
}

/** The one person's feature switches, as the admin, who sees every audience
 *  but nobody: the deployment's container is read only when a stored audience
 *  names accounts (none known, and only those listed don't count). */
async function passwordFlags(): Promise<ClientFlags> {
  let container: ContainerId | null = null;
  if (await flagsNameAccounts()) {
    try {
      const { deploymentCtx } = await import('@/lib/data-ctx');
      container = (await deploymentCtx()).container;
    } catch {
      container = null;
    }
  }
  return clientFlags(flagWho(container, null, { admin: true }));
}

async function SignedInHome({ tab, params }: { tab: Tab; params: { [key: string]: string | string[] | undefined } }) {
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  // Decided here, on the server, so nobody else is ever sent the admin's panel
  // or makes a request for it. Any doubt (no container yet, unreadable
  // registry) means not the admin.
  let admin = false;
  let container: ContainerId | null = null;
  if (userId) {
    try {
      const [{ dataCtx }, { isAdmin }] = await Promise.all([import('@/lib/data-ctx'), import('@/lib/admin-items')]);
      const ctx = await dataCtx();
      container = ctx.container;
      admin = await isAdmin(ctx);
    } catch {
      admin = false;
    }
  }
  // Evaluated for this account here, so the browser gets booleans alone; with
  // no container known, only Everyone and the variables count.
  const flags = await clientFlags(flagWho(container, userId ?? null, { admin }));
  const settings = parseSettings(params, { sharing: true, admin });
  return <Dashboard clerk viewer={userId ?? undefined} admin={admin} flags={flags} initialTab={tab} initialSettings={settings} adminOps={admin ? await adminOps() : null} newUntil={await newUntil('plan-items-in-fi')} childNewUntil={await newUntil('plan-child-accounts')} />;
}
