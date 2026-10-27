import { Suspense } from 'react';
import Dashboard from '@/components/Dashboard';
import { AppLoading } from '@/components/LoadingSkeletons';
import { clerkEnabled } from '@/lib/auth-mode';
import { brokerageLinkEnabled } from '@/lib/item-products';
import { lunchFlowEnabled } from '@/lib/connectors/switch';
import { parseTab, type Tab } from '@/lib/dashboard-tab';

export default async function Home({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  // The tab the address asks for (lib/dashboard-tab.ts), so a reload draws
  // that tab's loading view first and comes back to it.
  const tab = parseTab(await searchParams);
  // Without Clerk there is one person, who is the admin (lib/admin-items.ts), so
  // nothing more is read.
  // Whether to offer connecting a brokerage or retirement account, which is off
  // unless the deployment turns it on (lib/item-products.ts), and Lunch Flow,
  // likewise (lib/connectors/switch.ts).
  const brokerageLink = brokerageLinkEnabled();
  const lunchFlow = lunchFlowEnabled();
  if (!clerkEnabled()) return <Dashboard clerk={false} admin brokerageLink={brokerageLink} lunchFlow={lunchFlow} initialTab={tab} />;
  // Who is signed in, and whether they are the admin, are read before the
  // dashboard is sent. Meanwhile the page streams the app loading
  // (components/LoadingSkeletons.tsx), the header and Net worth card the
  // dashboard draws while it loads: so once Clerk signs someone in and moves
  // here, that shows at once, where the sign-in page stayed before.
  return (
    <Suspense fallback={<AppLoading account="clerk" tab={tab} />}>
      <SignedInHome brokerageLink={brokerageLink} lunchFlow={lunchFlow} tab={tab} />
    </Suspense>
  );
}

async function SignedInHome({ brokerageLink, lunchFlow, tab }: { brokerageLink: boolean; lunchFlow: boolean; tab: Tab }) {
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  // Decided here, on the server, so nobody else is ever sent the admin's panel
  // or makes a request for it. Any doubt (no container yet, unreadable
  // registry) means not the admin.
  let admin = false;
  if (userId) {
    try {
      const [{ dataCtx }, { isAdmin }] = await Promise.all([import('@/lib/data-ctx'), import('@/lib/admin-items')]);
      admin = await isAdmin(await dataCtx());
    } catch {
      admin = false;
    }
  }
  return <Dashboard clerk viewer={userId ?? undefined} admin={admin} brokerageLink={brokerageLink} lunchFlow={lunchFlow} initialTab={tab} />;
}
