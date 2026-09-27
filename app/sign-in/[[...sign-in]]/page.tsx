import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';

// Clerk's sign-in (lib/auth-mode.ts). Without Clerk keys the app signs in with
// the shared password instead.
export default function SignInPage() {
  if (!clerkEnabled()) redirect('/login');
  return (
    <main className="wrap">
      <SignIn />
    </main>
  );
}
