import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';
import { clerkEnabled } from '@/lib/auth-mode';
import { demoUsers } from '@/lib/demo';
import { loadedScenarios } from '@/lib/demo-seed/loaded';
import { Brand } from '@/components/Brand';
import { ForgetDevice } from '@/components/ForgetDevice';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import DeletionReceiptNotice from '@/components/DeletionReceipt';
import { SignInFlow, SignInPlaceholder } from '@/components/SignInFlow';
import DemoSignIn from '@/components/DemoSignIn';
import { Why } from '@/components/Why';
import { TAGLINE } from '@/lib/tagline';

// Clerk's sign-in (lib/auth-mode.ts). Without Clerk keys the app signs in with
// the shared password instead. First the name and one line on what Nya is
// (lib/tagline.ts). A deletion of an account ends here, so its receipt is
// shown next, above the rest (components/DeletionReceipt.tsx). Off
// production, the one-click demo accounts, Alex and Sam (lib/demo.ts), each
// with the scenario it was last reset to under its name, read here
// (lib/demo-seed/loaded.ts): anyone may reset either to any scenario, so the
// line says what was loaded, which stays true after visitors change the
// data, and nothing while a reset runs. They sit above Clerk's
// form: the form changes height from step to step, so nothing under it holds
// a button. Clerk's own Continue is the one filled button; the demo's are
// tonal. Which banks connect is folded away under the form.
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
  // What each demo account was last reset to, for the line under its button:
  // never an error, and never long (lib/demo-seed/loaded.ts). Not for a
  // demo's ticket, whose page shows the app loading from the start.
  const loaded = demoTicket ? {} : await loadedScenarios(demos);
  return (
    <SignInFlow demoTicket={demoTicket}>
      <ForgetDevice />
      <Brand />
      <p className="auth-tagline">{TAGLINE}</p>
      <DeletionReceiptNotice />
      {demos.length > 0 && <DemoSignIn demos={demos} loaded={loaded} unavailable={unavailable} />}
      <SignIn fallback={<SignInPlaceholder />} />
      <Why label="Which banks work?">
        <CoverageNote />
      </Why>
      <TrustLinks />
    </SignInFlow>
  );
}
