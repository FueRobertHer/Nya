import { Suspense } from 'react';
import Dashboard from '@/components/Dashboard';
import { AppLoading } from '@/components/LoadingSkeletons';
import { clerkEnabled } from '@/lib/auth-mode';
import { brokerageLinkEnabled } from '@/lib/item-products';
import { lunchFlowEnabled } from '@/lib/connectors/switch';
import { parseSettings, parseTab, type SettingsView, type Tab } from '@/lib/dashboard-tab';

export default async function Home({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  // The tab the address asks for (lib/dashboard-tab.ts), so a reload draws
  // that tab's loading view first and comes back to it; and Settings, open
  // over it, the same way (Sharing only with Clerk, else its list).
  const params = await searchParams;
  const tab = parseTab(params);
  const settings = parseSettings(params, { sharing: clerkEnabled() });
  // Without Clerk there is one person, who is the admin (lib/admin-items.ts), so
  // nothing more is read.
  // Whether to offer connecting a brokerage or retirement account, which is off
  // unless the deployment turns it on (lib/item-products.ts), and Lunch Flow,
  // likewise (lib/connectors/switch.ts).
  const brokerageLink = brokerageLinkEnabled();
  const lunchFlow = lunchFlowEnabled();
  if (!clerkEnabled()) return <Dashboard clerk={false} admin brokerageLink={brokerageLink} lunchFlow={lunchFlow} initialTab={tab} initialSettings={settings} />;
  // Who is signed in, and whether they are the admin, are read before the
  // dashboard is sent. Meanwhile the page streams the app loading
  // (components/LoadingSkeletons.tsx), the header and Net worth card the
  // dashboard draws while it loads: so once Clerk signs someone in and moves
  // here, that shows at once, where the sign-in page stayed before.
  return (
    <Suspense fallback={<AppLoading account="clerk" tab={tab} settings={settings} />}>
      <SignedInHome brokerageLink={brokerageLink} lunchFlow={lunchFlow} tab={tab} settings={settings} />
    </Suspense>
  );
}

async function SignedInHome({ brokerageLink, lunchFlow, tab, settings }: { brokerageLink: boolean; lunchFlow: boolean; tab: Tab; settings: SettingsView | null }) {
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
  return <Dashboard clerk viewer={userId ?? undefined} admin={admin} brokerageLink={brokerageLink} lunchFlow={lunchFlow} initialTab={tab} initialSettings={settings} />;
}
