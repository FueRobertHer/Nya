import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';
import { demoUsers } from '@/lib/demo';
import { Brand } from '@/components/Brand';
import { ForgetDevice } from '@/components/ForgetDevice';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import DeletionReceiptNotice from '@/components/DeletionReceipt';
import { SignInSkeleton } from '@/components/LoadingSkeletons';
import { SignInFlow } from '@/components/SignInFlow';
import { goesHome } from '@/components/sign-in-view';

// Clerk's sign-in (lib/auth-mode.ts). Without Clerk keys the app signs in with
// the shared password instead. Off production, the one-click demo accounts,
// Alex and Sam, above it (lib/demo.ts). A deletion of an account ends here, so its receipt is shown
// here too, above everything (components/DeletionReceipt.tsx).
//
// Clerk's form loads after the page, so a placeholder of its size holds its
// place (components/LoadingSkeletons.tsx). From a demo button's press, and
// once signed in, the page hands over to the app loading
// (components/SignInFlow.tsx).
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!clerkEnabled()) redirect('/login');
  const demos = demoUsers();
  const params = await searchParams;
  const unavailable = params.demo === 'unavailable';
  // A demo button's ticket (app/api/demo/sign-in), which Clerk signs in with
  // as soon as it loads: the app loading shows from the start. Only the
  // demo's: a Clerk invitation's ticket may still ask for a password.
  const demoTicket = demos.length > 0 && params.demo === 'ticket' && typeof params.__clerk_ticket === 'string';
  return (
    <SignInFlow demoTicket={demoTicket} home={goesHome(params.redirect_url)}>
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
              <form key={u.id} method="post" action="/api/demo/sign-in" data-demo-sign-in>
                <input type="hidden" name="user" value={u.id} />
                <button type="submit">{u.label}</button>
              </form>
            ))}
          </div>
          {unavailable && <p className="error">The demo couldn’t sign in just now. Try again.</p>}
        </div>
      )}
      <SignIn fallback={<SignInSkeleton />} />
      <CoverageNote />
      <TrustLinks />
    </SignInFlow>
  );
}
