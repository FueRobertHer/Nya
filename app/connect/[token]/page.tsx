import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { clerkEnabled } from '@/lib/auth-mode';
import { describeInvite } from '@/lib/sharing';
import { AcceptInvite } from '@/components/AcceptInvite';
import { Brand } from '@/components/Brand';

// Where an invite link lands (lib/sharing.ts). Signed-in and allowed people
// only (proxy.ts). Opening it uses nothing up: accepting does. A link that
// can't be used says so the same way whatever the reason, so it reveals
// nothing about who sent it or whether they still use the app.
export default async function ConnectPage({ params }: { params: Promise<{ token: string }> }) {
  if (!clerkEnabled()) redirect('/login');
  const { token } = await params;
  const { userId } = await auth();
  if (!userId) redirect(`/sign-in?redirect_url=${encodeURIComponent(`/connect/${token}`)}`);
  const invite = await describeInvite(userId, token).catch(() => null);
  return (
    <main className="auth-wrap">
      <Brand />
      <div className="card" style={{ width: '100%', maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>Connect</h2>
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
