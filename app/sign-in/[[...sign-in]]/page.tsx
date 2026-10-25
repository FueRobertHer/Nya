import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';
import { demoUsers } from '@/lib/demo';
import { Brand } from '@/components/Brand';
import { ForgetDevice } from '@/components/ForgetDevice';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import DeletionReceiptNotice from '@/components/DeletionReceipt';
import { SignInFlow, SignInPlaceholder } from '@/components/SignInFlow';
import DemoSignIn from '@/components/DemoSignIn';

// Clerk's sign-in (lib/auth-mode.ts). Without Clerk keys the app signs in with
// the shared password instead. Off production, the one-click demo accounts,
// Alex and Sam, above it (lib/demo.ts). A deletion of an account ends here, so its receipt is shown
// here too, above everything (components/DeletionReceipt.tsx).
//
// Clerk's form loads after the page, so a placeholder of its size holds its
// place, and from a demo button's press, which signs in on this page
// (components/DemoSignIn.tsx), it hands over to the app loading
// (components/SignInFlow.tsx). Once Clerk signs in, Home streams the same
// while it loads (app/page.tsx).
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!clerkEnabled()) redirect('/login');
  const demos = demoUsers();
  const params = await searchParams;
  const unavailable = params.demo === 'unavailable';
  // A demo form's ticket (app/api/demo/sign-in), when it posted before Clerk
  // had loaded, which Clerk signs in with as soon as it loads: the app
  // loading shows from the start. Only the demo's: a Clerk invitation's
  // ticket may still ask for a password.
  const demoTicket = demos.length > 0 && params.demo === 'ticket' && typeof params.__clerk_ticket === 'string';
  return (
    <SignInFlow demoTicket={demoTicket}>
      <ForgetDevice />
      <Brand />
      <DeletionReceiptNotice />
      {demos.length > 0 && <DemoSignIn demos={demos} unavailable={unavailable} />}
      <SignIn fallback={<SignInPlaceholder />} />
      <CoverageNote />
      <TrustLinks />
    </SignInFlow>
  );
}
