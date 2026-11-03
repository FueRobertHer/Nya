// lib/same-site.ts
//
// Whether a request that changes something was sent by this site's own page,
// as the demo's reset checks it (app/api/demo/seed/route.ts): no other origin
// named, no other site's fetch, and JSON, which a form on another site can't
// send. For the feature switches' routes (app/api/dev/flags,
// app/api/admin/flags).
//
// `requireOrigin` also refuses a request that names no origin at all. Every
// browser sends one with a PUT, so only a caller outside a browser loses, and
// a session cookie alone can't drive the route: the admin's route asks for it.

import { appUrl } from './app-url';

export function sameSite(req: Request, { requireOrigin = false }: { requireOrigin?: boolean } = {}): boolean {
  const own = [new URL(req.url).origin, ...(appUrl() ? [new URL(appUrl()!).origin] : [])];
  const origin = req.headers.get('origin');
  if (origin === null ? requireOrigin : !own.includes(origin)) return false;
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  return (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}
