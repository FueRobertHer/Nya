import { NextRequest, NextResponse, type NextFetchEvent, type NextMiddleware } from 'next/server';
import { clerkMiddleware } from '@clerk/nextjs/server';
import { clerkEnabled, clerkUserAllowed } from '@/lib/auth-mode';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { sessionCurrent } from '@/lib/sessions';
import { buildCsp, cspHeaderName, cspMode, newNonce } from '@/lib/security-headers';

// Everything is protected EXCEPT: the login API; the public pages (PUBLIC_PAGES
// below); static PWA assets (they must be publicly fetchable for install/offline
// to work); and routes that authenticate themselves:
//   - the cron endpoints (the snapshot and its catch-up, the nightly backup, the
//     unused-Item check), via CRON_SECRET;
//   - the manual-balance ingest, via INGEST_SECRET;
//   - the read-only API (each /api/v1 endpoint, listed one by one), via a
//     personal API token (lib/api-tokens.ts). It reads no cookie, so a session
//     alone reaches none of it; a new endpoint is gated until it is added here;
//   - Plaid's webhook, by verifying Plaid's signature (lib/plaid-webhook.ts);
//   - the ops routes (export, rotate-master, reencrypt, containers), via
//     OPS_SECRET, and off entirely unless OPS_ENABLED=1 (lib/ops.ts);
//   - the demo sign-in (Preview only, and only ever as a listed demo account;
//     lib/demo.ts).
//
// Note the `$` anchors on the API entries: they exclude exactly those paths. A
// bare prefix like `api/ingest/` would un-gate every future route under it.
//
// Every page runs through here, the public ones included, because this is where
// a page gets its Content-Security-Policy. The headers that are the same on
// every response are set in next.config.js, so they reach the paths excluded
// here too.
export const config = {
  matcher: [
    '/((?!api/login$|api/demo/sign-in$|api/snapshot$|api/snapshot/catchup$|api/backup$|api/ingest/balance$|api/v1/me$|api/v1/accounts$|api/v1/net-worth$|api/v1/balance-history$|api/v1/transactions$|api/v1/categories$|api/v1/budgets$|api/v1/spending$|api/v1/recurring$|api/v1/holdings$|api/plaid/webhook$|api/plaid/check-items$|api/ops/export$|api/ops/rotate-master$|api/ops/reencrypt$|api/ops/containers$|_next/static/|_next/image/|favicon.ico$|icon.svg$|apple-icon.png$|manifest.json$|icons/|service-worker.js$).*)',
  ],
};

// Pages anyone may open, signed in or not: the password login, and the pages
// that say how Nya protects data and who can read it (app/security,
// app/privacy), which people read before deciding to sign up. Exact paths.
// None of them reads stored data or has a server action of its own (Clerk's,
// on every page, only clears a cache cookie); a page that does must never be
// listed here.
const PUBLIC_PAGES: ReadonlySet<string> = new Set(['/login', '/security', '/privacy']);

// Request headers a nonce could be read from (by Next.js, and by Clerk for its
// script tags). Only this proxy sets them: whatever a request brings is dropped.
const NONCE_CARRIERS = ['x-nonce', 'content-security-policy', 'content-security-policy-report-only'];

// Where to come back to after signing in with Clerk: this path and its query,
// so the link in a notice email (/?view=connections, lib/connection-notices.ts)
// still opens the Connection health card for someone signed out. Only a path
// on this site: one starting "//" or with a backslash could be read as another
// host.
function returnPath(req: NextRequest): string | null {
  const { pathname, search } = req.nextUrl;
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\')) return null;
  const path = `${pathname}${search}`;
  return path === '/' ? null : path;
}

// The one place the password login sends someone back to, besides Home: the
// Connection health card, from a notice email's link. Only a flag is passed,
// never a path, so the login page can't be made to redirect anywhere else.
const forConnections = (req: NextRequest) => req.nextUrl.pathname === '/' && req.nextUrl.searchParams.get('view') === 'connections';

// Lets a request through. A page also gets its Content-Security-Policy
// (lib/security-headers.ts), in the mode CSP_MODE sets, with a nonce made for
// this request alone and passed on in the request headers as well: Next.js
// reads it there to put it on its own scripts, and Clerk on its. An API call
// is answered with JSON, not a document, so it gets none; but a browser that
// navigates to an /api/ path that does not exist is shown the HTML 404 page,
// so a request that asks for HTML gets the policy wherever it goes.
function pass(req: NextRequest): NextResponse {
  const document = !req.nextUrl.pathname.startsWith('/api/') || (req.headers.get('accept') ?? '').includes('text/html');
  if (!document) return NextResponse.next();
  const headers = new Headers(req.headers);
  for (const name of NONCE_CARRIERS) headers.delete(name);
  const mode = cspMode();
  if (mode === 'off') return NextResponse.next({ request: { headers } });
  const nonce = newNonce();
  const policy = buildCsp({
    nonce,
    mode,
    dev: process.env.NODE_ENV === 'development',
    plaidEnv: process.env.PLAID_ENV,
    clerkPublishableKey: clerkEnabled() ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY : undefined,
  });
  const header = cspHeaderName(mode);
  headers.set('x-nonce', nonce);
  headers.set(header, policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set(header, policy);
  return res;
}

// With Clerk keys set (lib/auth-mode.ts), sign-in is Clerk's: the request needs
// a Clerk session whose user is on the allowlist. /sign-in and /not-allowed
// stay reachable, so someone can sign in, or see why they were turned away, and
// so do the public pages.
// Built on first use, so a deployment without Clerk never sets it up.
let clerkProxy: NextMiddleware | null = null;
const makeClerkProxy = (): NextMiddleware => clerkMiddleware(async (auth, req) => {
  const path = req.nextUrl.pathname;
  if (path.startsWith('/sign-in') || path === '/not-allowed' || PUBLIC_PAGES.has(path)) return pass(req);
  const { userId } = await auth();
  if (!userId) {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Back to where they were going once signed in (an invite link, or the
    // Connection health card from a notice email), query and all.
    const signIn = new URL('/sign-in', req.url);
    const back = returnPath(req);
    if (back) signIn.searchParams.set('redirect_url', back);
    return NextResponse.redirect(signIn);
  }
  if (!(await clerkUserAllowed(userId))) {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'This account is not allowed here yet.' }, { status: 403 });
    return NextResponse.redirect(new URL('/not-allowed', req.url));
  }
  return pass(req);
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
  if (PUBLIC_PAGES.has(req.nextUrl.pathname)) return pass(req);

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);
  const valid = session !== null && (await sessionCurrent(session));

  if (!valid) {
    if (req.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // The login page goes Home once signed in, or to the Connection health
    // card when that is where this request was going: nothing else is passed.
    const login = new URL('/login', req.url);
    if (forConnections(req)) login.searchParams.set('view', 'connections');
    return NextResponse.redirect(login);
  }

  return pass(req);
}
