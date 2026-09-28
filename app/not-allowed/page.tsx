import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { SignOutButton } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';

// A signed-in Clerk account that isn't on CLERK_ALLOWED_USER_IDS. Its own id
// is shown so the owner can add it (or its email); nothing else is.
export default async function NotAllowedPage() {
  if (!clerkEnabled()) redirect('/login');
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  return (
    <main className="wrap">
      <div className="card">
        <h1>Not allowed yet</h1>
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
