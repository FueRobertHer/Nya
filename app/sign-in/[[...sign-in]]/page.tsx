import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';
import { Brand } from '@/components/Brand';
import { ForgetDevice } from '@/components/ForgetDevice';

// Clerk's sign-in (lib/auth-mode.ts). Without Clerk keys the app signs in with
// the shared password instead.
export default function SignInPage() {
  if (!clerkEnabled()) redirect('/login');
  return (
    <main className="auth-wrap">
      <ForgetDevice />
      <Brand />
      <SignIn />
    </main>
  );
}
