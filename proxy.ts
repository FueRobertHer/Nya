import { NextRequest, NextResponse, type NextFetchEvent, type NextMiddleware } from 'next/server';
import { clerkMiddleware } from '@clerk/nextjs/server';
import { clerkEnabled, clerkUserAllowed } from '@/lib/auth-mode';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';
import { sessionCurrent } from '@/lib/sessions';
import { buildCsp, cspHeaderName, cspMode, newNonce } from '@/lib/security-headers';
import { isAdminSignIn } from '@/lib/admin-gate';

// Everything is protected EXCEPT: the login API; the public pages (PUBLIC_PAGES
// below); static PWA assets (they must be publicly fetchable for install/offline
// to work); and routes that authenticate themselves:
//   - the cron endpoints (the snapshot and its catch-up, the nightly backup, the
//     ECB rates' fetch, the unused-Item check), via CRON_SECRET;
//   - the manual-balance ingest, via INGEST_SECRET;
//   - the API (each /api/v1 endpoint, listed one by one) and the MCP server
//     (/api/mcp), via a personal API token (lib/api-tokens.ts). They read no
//     cookie, so a session alone reaches none of them. Any other path under
//     /api/v1 is answered 404 here (proxy below), so a new endpoint isn't
//     reached until it is added. An endpoint with a resource's id in its path
//     takes one segment of the characters an id has (and a colon written as
//     %3A, as encodeURIComponent writes it), never starting with a dot, so
//     no "..", no "/" however written, and nothing else reaches past here;
//   - Plaid's webhook, by verifying Plaid's signature (lib/plaid-webhook.ts);
//   - the ops routes (export, rotate-master, reencrypt, containers,
//     container-keys), via
//     OPS_SECRET, and off entirely unless OPS_ENABLED=1 (lib/ops.ts);
//   - the demo sign-in (Preview only, and only ever as a listed demo account;
//     lib/demo.ts);
//   - the link that turns a weekly summary off (api/weekly-summary/
//     unsubscribe), via the signed, expiring token in its own address
//     (lib/weekly-summary/unsubscribe.ts). It must work from an email, signed
//     out, and from a mail app's own one-click unsubscribe, which sends no
//     cookie; it can only ever turn that summary off. Only that path: the rest
//     of api/weekly-summary is gated as usual.
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
    '/((?!api/login$|api/demo/sign-in$|api/snapshot$|api/snapshot/catchup$|api/backup$|api/fx/fetch$|api/ingest/balance$|api/v1/me$|api/v1/accounts$|api/v1/net-worth$|api/v1/balance-history$|api/v1/transactions$|api/v1/categories$|api/v1/tags$|api/v1/rules$|api/v1/budgets$|api/v1/spending$|api/v1/cash-flow$|api/v1/recurring$|api/v1/goals$|api/v1/holdings$|api/v1/runway$|api/v1/year-over-year$|api/v1/transactions/(?:[A-Za-z0-9_:-]|%3[Aa])(?:[A-Za-z0-9_.:-]|%3[Aa])*$|api/v1/manual-accounts$|api/v1/manual-accounts/(?:[A-Za-z0-9_:-]|%3[Aa])(?:[A-Za-z0-9_.:-]|%3[Aa])*$|api/v1/manual-accounts/(?:[A-Za-z0-9_:-]|%3[Aa])(?:[A-Za-z0-9_.:-]|%3[Aa])*/balance$|api/v1/categories/(?:[A-Za-z0-9_:-]|%3[Aa])(?:[A-Za-z0-9_.:-]|%3[Aa])*$|api/v1/category-groups$|api/v1/category-groups/(?:[A-Za-z0-9_:-]|%3[Aa])(?:[A-Za-z0-9_.:-]|%3[Aa])*$|api/v1/tags/(?:[A-Za-z0-9_:-]|%3[Aa])(?:[A-Za-z0-9_.:-]|%3[Aa])*$|api/v1/changes$|api/v1/changes/(?:[A-Za-z0-9_:-]|%3[Aa])(?:[A-Za-z0-9_.:-]|%3[Aa])*/undo$|api/mcp$|api/plaid/webhook$|api/plaid/check-items$|api/ops/export$|api/ops/rotate-master$|api/ops/reencrypt$|api/ops/containers$|api/weekly-summary/unsubscribe$|api/ops/container-keys$|_next/static/|_next/image/|favicon.ico$|icon.svg$|apple-icon.png$|manifest.json$|icons/|service-worker.js$).*)',
  ],
};

// Pages anyone may open, signed in or not: the password login, the pages that
// say how Nya protects data and who can read it (app/security, app/privacy),
// which people read before deciding to sign up, the developer page
// (app/developers), which documents the API for whoever writes a program
// against it, the page that opens a protected download in the browser
// (app/open-download), which must work after the account it came from is
// gone, and the page a weekly summary's link opens (app/unsubscribe), which
// asks before it turns the summary off, signed out, by posting the link's
// token to the route above. Exact paths.
// None of them reads stored data or has a server action of its own (Clerk's,
// on every page, only clears a cache cookie); a page that does must never be
// listed here.
const PUBLIC_PAGES: ReadonlySet<string> = new Set(['/login', '/security', '/privacy', '/developers', '/open-download', '/unsubscribe']);

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
// `to`, when given, is a path to render in the request's place (a rewrite):
// an admin page sent where it lives, or to MISSING (ADMIN_PAGES), gets the
// policy as every page does.
function pass(req: NextRequest, to?: string): NextResponse {
  const go = (init?: { request: { headers: Headers } }) => (to ? NextResponse.rewrite(new URL(to, req.url), init) : NextResponse.next(init));
  const document = !req.nextUrl.pathname.startsWith('/api/') || (req.headers.get('accept') ?? '').includes('text/html');
  if (!document) return go();
  const headers = new Headers(req.headers);
  for (const name of NONCE_CARRIERS) headers.delete(name);
  const mode = cspMode();
  if (mode === 'off') return go({ request: { headers } });
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
  const res = go({ request: { headers } });
  res.headers.set(header, policy);
  return res;
}

// The admin's pages are linked at /admin/... but live at /admin-view/...
// (app/admin-view), and no route answers /admin/... itself. The admin
// (lib/admin-gate.ts) is shown them by a rewrite to where they live; anyone
// else's request goes on untouched, to no route, so the 404 they get is the
// one any missing path gets, header for header: not a rewrite, and none of the
// page's title, description or segments. Asked for where they live, by
// anyone but the admin, they are rewritten to a path no route matches
// (MISSING). The pages and their routes check again for themselves.
const ADMIN_PAGES = /^\/admin(\/.*)?$/;
const ADMIN_VIEW = /^\/admin-view(\/|$)/;
const MISSING = '/__nya-no-such-page__';

/** Where an admin page request goes: the page where it lives for the admin,
 *  nowhere for anyone else (see above). */
async function adminPage(req: NextRequest, userId: string | null): Promise<NextResponse | null> {
  const path = req.nextUrl.pathname;
  const asked = ADMIN_PAGES.exec(path);
  if (asked) return (await isAdminSignIn(userId)) ? pass(req, `/admin-view${asked[1] ?? ''}${req.nextUrl.search}`) : pass(req);
  if (ADMIN_VIEW.test(path) && !(await isAdminSignIn(userId))) return pass(req, MISSING);
  return null;
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
  return (await adminPage(req, userId)) ?? pass(req);
});

// The read-only API's endpoints skip this proxy (the matcher above), so a path
// under /api/v1 that reaches it is no endpoint at all: a typo, or a trailing
// slash. It is answered in the API's own error shape (lib/api-http.ts), a 404,
// whoever asks, so a program never reads it as a token that doesn't work.
const API_V1 = /^\/api\/v1(\/|$)/;

// Next always passes the event; tests of the password path need not.
export async function proxy(req: NextRequest, event?: NextFetchEvent) {
  if (API_V1.test(req.nextUrl.pathname)) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'There is no such endpoint. The endpoints are listed at /developers.' } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }
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

  return (await adminPage(req, null)) ?? pass(req);
}
