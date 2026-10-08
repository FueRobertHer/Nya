import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';
import { demoUsers } from '@/lib/demo';
import { Brand } from '@/components/Brand';
import { ForgetDevice } from '@/components/ForgetDevice';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import DeletionReceiptNotice from '@/components/DeletionReceipt';

// Clerk's sign-in (lib/auth-mode.ts). Without Clerk keys the app signs in with
// the shared password instead. On Preview, one-click demo accounts above it
// (lib/demo.ts). A deletion of an account ends here, so its receipt is shown
// here too, above everything (components/DeletionReceipt.tsx).
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!clerkEnabled()) redirect('/login');
  const demos = demoUsers();
  const unavailable = (await searchParams).demo === 'unavailable';
  return (
    <main className="auth-wrap">
      <ForgetDevice />
      <Brand />
      <DeletionReceiptNotice />
      {demos.length > 0 && (
        <div className="card demo-panel">
          <h2>Try the demo</h2>
          <p className="panel-note">
            Sign in as a demo account, with pretend banks from Plaid&apos;s sandbox. Everyone who tries it shares these
            accounts, so anything you add is visible to others.
          </p>
          <div className="action-row">
            {demos.map((u) => (
              <form key={u.id} method="post" action="/api/demo/sign-in">
                <input type="hidden" name="user" value={u.id} />
                <button type="submit">{u.label}</button>
              </form>
            ))}
          </div>
          {unavailable && <p className="error">The demo couldn’t sign in just now. Try again.</p>}
        </div>
      )}
      <SignIn />
      <CoverageNote />
      <TrustLinks />
    </main>
  );
}
