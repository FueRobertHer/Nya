import { redirect } from 'next/navigation';
import { clerkEnabled } from '@/lib/auth-mode';

// With Clerk on, the shared password is off: its page sends people to Clerk's.
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  if (clerkEnabled()) redirect('/sign-in');
  return children;
}
