import { Suspense } from 'react';
import Dashboard from '@/components/Dashboard';
import { AppLoading } from '@/components/LoadingSkeletons';
import { clerkEnabled } from '@/lib/auth-mode';
import { brokerageLinkEnabled } from '@/lib/item-products';
import { lunchFlowEnabled } from '@/lib/connectors/switch';

export default function Home() {
  // Without Clerk there is one person, who is the admin (lib/admin-items.ts), so
  // nothing is read: this page stays as static as it was.
  // Whether to offer connecting a brokerage or retirement account, which is off
  // unless the deployment turns it on (lib/item-products.ts), and Lunch Flow,
  // likewise (lib/connectors/switch.ts).
  const brokerageLink = brokerageLinkEnabled();
  const lunchFlow = lunchFlowEnabled();
  if (!clerkEnabled()) return <Dashboard clerk={false} admin brokerageLink={brokerageLink} lunchFlow={lunchFlow} />;
  // Who is signed in, and whether they are the admin, are read before the
  // dashboard is sent. Meanwhile the page streams the app loading
  // (components/LoadingSkeletons.tsx), the header and Net worth card the
  // dashboard draws while it loads: so once Clerk signs someone in and moves
  // here, that shows at once, where the sign-in page stayed before.
  return (
    <Suspense fallback={<AppLoading account="clerk" />}>
      <SignedInHome brokerageLink={brokerageLink} lunchFlow={lunchFlow} />
    </Suspense>
  );
}

async function SignedInHome({ brokerageLink, lunchFlow }: { brokerageLink: boolean; lunchFlow: boolean }) {
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
  return <Dashboard clerk viewer={userId ?? undefined} admin={admin} brokerageLink={brokerageLink} lunchFlow={lunchFlow} />;
}
