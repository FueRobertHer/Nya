import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';

// Everything is protected EXCEPT the login page, the login API, static PWA
// assets (which must be publicly fetchable for install/offline to work), the
// cron snapshot endpoint (which authenticates itself via CRON_SECRET -- see
// app/api/snapshot/route.ts), and the manual-balance ingest endpoint (which
// authenticates itself via INGEST_SECRET -- see app/api/ingest/balance/route.ts).
//
// Note the `$` anchors on the API entries: they exclude exactly those paths.
// A bare prefix like `api/ingest/` would un-gate every future route under it.
export const config = {
  matcher: [
    '/((?!api/login$|api/snapshot$|api/ingest/balance$|login$|_next/static/|_next/image/|favicon.ico$|icon.svg$|apple-icon.png$|manifest.json$|icons/|service-worker.js$).*)',
  ],
};

export async function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const valid = await verifySessionToken(token);

  if (!valid) {
    if (req.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}
