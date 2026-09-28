import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { clerkEnabled } from '@/lib/auth-mode';
import { describeInvite } from '@/lib/sharing';
import { AcceptInvite } from '@/components/AcceptInvite';

// Where an invite link lands (lib/sharing.ts). Signed-in and allowed people
// only (proxy.ts). Opening it uses nothing up: accepting does. A link that
// can't be used says so the same way whatever the reason, so it reveals
// nothing about who sent it or whether they still use the app.
export default async function ConnectPage({ params }: { params: Promise<{ token: string }> }) {
  if (!clerkEnabled()) redirect('/login');
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  const { token } = await params;
  const invite = await describeInvite(userId, token).catch(() => null);
  return (
    <main className="wrap">
      <div className="card">
        <h1>Connect on Nya</h1>
        {!invite ? (
          <p>This invite link can’t be used. Ask for a new one.</p>
        ) : invite.own ? (
          <p>This is your own invite link. Send it to the person you want to connect with.</p>
        ) : (
          <AcceptInvite token={token} fromName={invite.from_name} />
        )}
        <p>
          <a href="/">Back to Nya</a>
        </p>
      </div>
    </main>
  );
}
