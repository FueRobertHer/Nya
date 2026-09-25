import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth';
import { revokeAllSessions, sessionContainer } from '@/lib/sessions';

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
    const container = session ? sessionContainer(session) : null;
    if (!container) {
      return NextResponse.json({ error: 'This session names no container, so there is nothing to sign out of.' }, { status: 409 });
    }
    try {
      await revokeAllSessions(container);
    } catch (err) {
      console.error('Sign out everywhere failed:', err instanceof Error ? err.name : err);
      return NextResponse.json({ error: 'Could not sign out other devices. Try again.' }, { status: 500 });
    }
  }

  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', { maxAge: 0, path: '/' });
  return res;
}
