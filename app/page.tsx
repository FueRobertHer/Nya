import Dashboard from '@/components/Dashboard';
import { clerkEnabled } from '@/lib/auth-mode';

export default async function Home() {
  if (!clerkEnabled()) return <Dashboard clerk={false} />;
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  return <Dashboard clerk viewer={userId ?? undefined} />;
}
