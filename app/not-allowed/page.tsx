import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { SignOutButton } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';
import { Brand } from '@/components/Brand';

// A signed-in Clerk account that isn't on CLERK_ALLOWED_USER_IDS. Its own id
// is shown so the owner can add it (or its email); nothing else is. Laid out
// as the sign-in page is, from the top: the name, then one card as wide as
// the sign-in form, its words at the body size.
export default async function NotAllowedPage() {
  if (!clerkEnabled()) redirect('/login');
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  return (
    <main className="auth-wrap">
      <Brand />
      <div className="card not-allowed-card">
        <div className="card-header">
          <h2>Not allowed yet</h2>
        </div>
        <div className="stack">
          <p>You're signed in, but this account can't open Nya yet. Ask to be added by your email, or by this account's id:</p>
          <p>
            <code>{userId}</code>
          </p>
          <div className="btn-row">
            <SignOutButton redirectUrl="/sign-in">
              <button type="button" className="btn secondary">
                Sign out
              </button>
            </SignOutButton>
          </div>
        </div>
      </div>
    </main>
  );
}
