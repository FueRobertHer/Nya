// Sent with every response: pages, API routes, static files, and the routes
// proxy.ts never sees. A page's Content-Security-Policy is added per request by
// proxy.ts (lib/security-headers.ts), since it carries a nonce.
//
// - X-Frame-Options: DENY forbids framing everywhere, whatever CSP_MODE says.
//   No Content-Security-Policy is sent from here: two headers of that name
//   would both be enforced, and how Vercel combines one from here with the
//   proxy's is not documented, so the page policy is the only one. Once it is
//   enforced it says frame-ancestors 'none' too.
// - HSTS: browsers use HTTPS only, for two years after a visit. Subdomains of
//   the app's host included; not submitted for preloading.
// - Referrer-Policy: other sites see at most this origin, never a path (an
//   invite link is a path).
// - Permissions-Policy: device features Nya never uses, off for every frame
//   too. Passkeys (publickey-credentials-*) and the clipboard stay available:
//   Clerk's sign-in and account window may use them.
// - Cross-Origin-Opener-Policy: same-origin-allow-popups, not same-origin, so a
//   bank's sign-in pop-up opened from Plaid Link (or a Clerk pop-up) keeps its
//   link back to the page that opened it, while other sites that open Nya get
//   no handle on its window.
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'accelerometer=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=()',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Next's default TypeScript integration loads the legacy JS Compiler API
    // (lib/typescript.js), which the native TypeScript 7 package no longer
    // ships. This flag makes `next build`/`next dev` shell out to the local
    // `tsc` CLI instead, so the native TS7 compiler works. See
    // https://github.com/vercel/next.js/pull/95639
    useTypeScriptCli: true,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
