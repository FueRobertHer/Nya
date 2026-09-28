import { NextRequest, NextResponse, type NextFetchEvent, type NextMiddleware } from 'next/server';
import { clerkMiddleware } from '@clerk/nextjs/server';
import { clerkEnabled, clerkUserAllowed } from '@/lib/auth-mode';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { sessionCurrent } from '@/lib/sessions';

// Everything is protected EXCEPT the login page, the login API, static PWA
// assets (which must be publicly fetchable for install/offline to work), the
// cron snapshot endpoints (which authenticate themselves via CRON_SECRET -- see
// app/api/snapshot/route.ts; the catch-up is the same handler), the nightly backup (CRON_SECRET too,
// app/api/backup/route.ts), and the manual-balance ingest endpoint (which
// authenticates itself via INGEST_SECRET -- see app/api/ingest/balance/route.ts),
// and the ops routes, export, rotate-master, reencrypt and containers (OPS_SECRET, and off entirely
// unless OPS_ENABLED=1 -- see lib/ops.ts).
//
// Note the `$` anchors on the API entries: they exclude exactly those paths.
// A bare prefix like `api/ingest/` would un-gate every future route under it.
export const config = {
  matcher: [
    '/((?!api/login$|api/snapshot$|api/snapshot/catchup$|api/backup$|api/ingest/balance$|api/ops/export$|api/ops/rotate-master$|api/ops/reencrypt$|api/ops/containers$|login$|_next/static/|_next/image/|favicon.ico$|icon.svg$|apple-icon.png$|manifest.json$|icons/|service-worker.js$).*)',
  ],
};

// With Clerk keys set (lib/auth-mode.ts), sign-in is Clerk's: the request needs
// a Clerk session whose user is on the allowlist. /sign-in and /not-allowed
// stay reachable, so someone can sign in, or see why they were turned away.
// Built on first use, so a deployment without Clerk never sets it up.
let clerkProxy: NextMiddleware | null = null;
const makeClerkProxy = (): NextMiddleware => clerkMiddleware(async (auth, req) => {
  const path = req.nextUrl.pathname;
  if (path.startsWith('/sign-in') || path === '/not-allowed') return NextResponse.next();
  const { userId } = await auth();
  if (!userId) {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Back to where they were going once signed in (an invite link, say).
    const signIn = new URL('/sign-in', req.url);
    if (path !== '/') signIn.searchParams.set('redirect_url', path);
    return NextResponse.redirect(signIn);
  }
  if (!(await clerkUserAllowed(userId))) {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'This account is not allowed here yet.' }, { status: 403 });
    return NextResponse.redirect(new URL('/not-allowed', req.url));
  }
  return NextResponse.next();
});

// Next always passes the event; tests of the password path need not.
export async function proxy(req: NextRequest, event?: NextFetchEvent) {
  if (clerkEnabled()) {
    const res = await (clerkProxy ??= makeClerkProxy())(req, event as NextFetchEvent);
    return res ?? NextResponse.next();
  }
  return passwordProxy(req);
}

// A session must be genuine, unexpired, issued under the current password
// (lib/auth.ts) and not revoked (lib/sessions.ts). The last needs one Redis
// read, reused for a few seconds per instance; this proxy runs on Node.
async function passwordProxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);
  const valid = session !== null && (await sessionCurrent(session));

  if (!valid) {
    if (req.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}
