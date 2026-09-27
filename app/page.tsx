import Dashboard from '@/components/Dashboard';
import { clerkEnabled } from '@/lib/auth-mode';

export default function Home() {
  return <Dashboard clerk={clerkEnabled()} />;
}
