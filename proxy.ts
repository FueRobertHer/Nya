import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/auth';

// Everything is protected EXCEPT the login page, the login API, static PWA
// assets (which must be publicly fetchable for install/offline to work), and
// the cron snapshot endpoint (which authenticates itself via CRON_SECRET --
// see app/api/snapshot/route.ts).
export const config = {
  matcher: [
    '/((?!api/login$|api/snapshot$|login$|_next/static/|_next/image/|favicon.ico$|manifest.json$|icons/|service-worker.js$).*)',
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
