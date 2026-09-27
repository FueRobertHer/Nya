import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth';
import { ContainerError } from '@/lib/containers';
import { revokeAllSessions, revokeLegacySessions, sessionContainer } from '@/lib/sessions';

// Log out. With {"everywhere": true}, also end every other session for this
// container (every device), by bumping its session epoch (lib/sessions.ts).

export async function POST(req: NextRequest) {
  let everywhere = false;
  try {
    const body = await req.json();
    everywhere = body?.everywhere === true;
  } catch {
    // No body: an ordinary logout.
  }

  if (everywhere) {
    const session = await verifySessionToken(req.cookies.get(SESSION_COOKIE_NAME)?.value);
    let container;
    try {
      container = session ? await sessionContainer(session) : null;
    } catch (err) {
      // A damaged registry is not an outage: say what it is.
      if (err instanceof ContainerError) {
        console.error('Sign out everywhere refused:', err.message);
        return NextResponse.json({ error: `Nothing was signed out: ${err.message}` }, { status: 409 });
      }
      console.error('Sign out everywhere could not check the session:', err instanceof Error ? err.name : err);
      return NextResponse.json({ error: 'The database is unavailable, so nothing was signed out. Try again shortly.' }, { status: 503 });
    }
    // With no container yet, old-format sessions are the only kind, and they
    // can still be ended everywhere.
    if (!container && !session?.legacy) {
      return NextResponse.json({ error: 'This session names no container, so there is nothing to sign out of.' }, { status: 409 });
    }
    try {
      if (container) await revokeAllSessions(container);
      else await revokeLegacySessions();
    } catch (err) {
      console.error('Sign out everywhere failed:', err instanceof Error ? err.name : err);
      return NextResponse.json({ error: 'Could not sign out other devices. Try again.' }, { status: 500 });
    }
  }

  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', { maxAge: 0, path: '/' });
  return res;
}
