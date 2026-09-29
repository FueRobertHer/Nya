import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { SignOutButton } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';
import { Brand } from '@/components/Brand';

// A signed-in Clerk account that isn't on CLERK_ALLOWED_USER_IDS. Its own id
// is shown so the owner can add it (or its email); nothing else is.
export default async function NotAllowedPage() {
  if (!clerkEnabled()) redirect('/login');
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  return (
    <main className="auth-wrap">
      <Brand />
      <div className="card" style={{ width: '100%', maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>Not allowed yet</h2>
        <p>You're signed in, but this account can't open Nya yet. Ask to be added by your email, or by this account's id:</p>
        <p>
          <code>{userId}</code>
        </p>
        <SignOutButton redirectUrl="/sign-in">
          <button className="secondary">Sign out</button>
        </SignOutButton>
      </div>
    </main>
  );
}
