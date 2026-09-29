import Dashboard from '@/components/Dashboard';
import { clerkEnabled } from '@/lib/auth-mode';

export default async function Home() {
  // Without Clerk there is one person, who is the admin (lib/admin-items.ts), so
  // nothing is read: this page stays as static as it was.
  if (!clerkEnabled()) return <Dashboard clerk={false} admin />;
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
  return <Dashboard clerk viewer={userId ?? undefined} admin={admin} />;
}
