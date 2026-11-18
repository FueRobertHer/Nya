import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { clerkEnabled } from '@/lib/auth-mode';
import { describeInvite, OWN_LINK, UNUSABLE } from '@/lib/sharing';
import { AcceptInvite, InviteNote } from '@/components/AcceptInvite';
import { Brand } from '@/components/Brand';

// Where an invite link lands (lib/sharing.ts). Signed-in and allowed people
// only (proxy.ts). Opening it uses nothing up: accepting does. A link that
// can't be used says so the same way whatever the reason, so it reveals
// nothing about who sent it or whether they still use the app.
//
// Only Nya's own failure says something else: when reading the link fails
// (storage out of reach), before anything about it is known. Those words are
// the same whatever the token, so they tell nothing about the link either.
const UNCHECKED = 'Nya couldn’t check this invite link just now. Try again in a few minutes.';

export default async function ConnectPage({ params }: { params: Promise<{ token: string }> }) {
  if (!clerkEnabled()) redirect('/login');
  const { token } = await params;
  const { userId } = await auth();
  if (!userId) redirect(`/sign-in?redirect_url=${encodeURIComponent(`/connect/${token}`)}`);
  const invite = await describeInvite(userId, token).catch((err: unknown) => {
    console.error('Reading an invite link failed', err instanceof Error ? err.name : err);
    return 'unchecked' as const;
  });
  return (
    <main className="auth-wrap">
      <Brand />
      <div className="card connect-card">
        <div className="card-header">
          <h2>Connect</h2>
        </div>
        <div className="stack">
          {invite === 'unchecked' ? (
            <InviteNote level="caution">{UNCHECKED}</InviteNote>
          ) : !invite ? (
            <InviteNote level="caution">{UNUSABLE}</InviteNote>
          ) : invite.own ? (
            <InviteNote level="info">{OWN_LINK}</InviteNote>
          ) : (
            <AcceptInvite token={token} fromName={invite.from_name} />
          )}
          <div className="btn-row">
            <a className="btn ghost" href="/">
              Back to Nya
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
