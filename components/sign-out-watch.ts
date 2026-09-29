// components/sign-out-watch.ts
//
// Wraps fetch so the dashboard notices its session has ended: an /api/ call
// (other than login) answering 401 calls onSignedOut once it is sure.
//
// With Clerk (lib/auth-mode.ts) a 401 can also mean the session cookie, which
// lasts about a minute and is renewed in the background, ran out while the
// app slept. So Clerk's session is renewed and the call tried once more first;
// only a second 401 counts. A Request's body can't be sent twice, so a call
// made with one isn't retried.

type ClerkSession = { getToken(): Promise<string | null> };
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function clerkSession(): ClerkSession | undefined {
  return (globalThis as { Clerk?: { session?: ClerkSession | null } }).Clerk?.session ?? undefined;
}

export function watchSignOut(call: Fetch, opts: { clerk: boolean; onSignedOut: () => void }): Fetch {
  return async (input, init) => {
    let res = await call(input, init);
    if (res.status !== 401) return res;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') || url.pathname === '/api/login') return res;
    const session = opts.clerk ? clerkSession() : undefined;
    if (session && !(input instanceof Request)) {
      try {
        if (await session.getToken()) res = await call(input, init);
      } catch {
        // Still signed out, then.
      }
    }
    if (res.status === 401) opts.onSignedOut();
    return res;
  };
}
