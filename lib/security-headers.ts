// lib/security-headers.ts
//
// The Content-Security-Policy for pages: which scripts, styles, images, frames
// and connections a page of Nya may use. Built per request by proxy.ts, with a
// nonce made for that request alone. The headers that are the same on every
// response (HSTS, nosniff, Referrer-Policy, Permissions-Policy, framing,
// Cross-Origin-Opener-Policy) are in next.config.js instead, so they also reach
// the static files and the self-authenticating routes the proxy never sees.
//
// WHY A NONCE. Next.js puts the request's nonce on its own scripts when it
// finds one in the request's policy (it reads Content-Security-Policy, else
// Content-Security-Policy-Report-Only), and Clerk puts it on its script tags
// (ClerkProvider's `dynamic`, app/layout.tsx). With 'strict-dynamic', a script
// those load may load others: that is how Plaid Link's script (react-plaid-link
// inserts it), Clerk's UI and Cloudflare's bot check arrive. Nothing else runs:
// no inline script without the nonce, no script from a host merely listed.
// Every page is rendered per request already (the root layout awaits
// connection()), so the nonce costs no static rendering. The hosts listed in
// script-src only matter to browsers too old for 'strict-dynamic'.
//
// WHERE EACH HOST COMES FROM.
//   Plaid Link (Plaid's documented policy for Link on the web): its script and
//     iframe on cdn.plaid.com, and the API host for PLAID_ENV. Plaid also lists
//     cdn.plaid.com as default-src, so it is allowed for images and fonts too.
//   Plaid's images: merchant and counterparty logos and category icons, which
//     transactions carry as URLs (lib/transactions.ts, components/MonthBreakdown.tsx,
//     components/BudgetsTab.tsx). Hosts from Plaid's API reference.
//   Clerk, only when it is on (lib/auth-mode.ts): its Frontend API, whose host
//     the publishable key names (clerkFrontendApi below), for its scripts and
//     calls; img.clerk.com for avatars and sign-in icons; Cloudflare Turnstile,
//     its bot check, as a script and a frame; *.protect.clerk.com, which
//     @clerk/nextjs's own policy lists; worker-src blob:, which Clerk's docs
//     require; and, for a development instance only, clerk-telemetry.com, the
//     only kind of instance Clerk sends SDK telemetry from. On a *.vercel.app
//     production domain Clerk serves all of this from this origin (/__clerk),
//     which 'self' covers.
//   style-src 'unsafe-inline': React style attributes, Clerk's CSS-in-JS and
//     Plaid's overlay all need it. Styles cannot run code.
//   'unsafe-eval' only under `next dev`, where React uses eval for its error
//     overlay. Never in a build.
//
// A page that needs anything new shows it as a violation in the browser
// console (in report-only mode, without breaking): add the host here, with
// where it comes from. docs/deployment.md says how to check a live session.
//
// No reporting endpoint: violations go to the browser console, which is where
// the checks in docs/deployment.md read them. An endpoint would be a public,
// unauthenticated route for little gain.

/** How the policy is sent (CSP_MODE). */
export type CspMode = 'report-only' | 'enforce' | 'off';
const MODES: readonly CspMode[] = ['report-only', 'enforce', 'off'];

let warnedMode: string | undefined;

/**
 * CSP_MODE, read per request so a redeploy with a new value is all a switch
 * takes. Unset is report-only: violations are logged in the browser console
 * and nothing is blocked, until a live Plaid Link and Clerk session has been
 * checked (docs/deployment.md). A value that is not one of the three is also
 * report-only, never enforce: a typo must not break sign-in or Link. It is
 * logged once per instance, so the typo is found.
 */
export function cspMode(raw: string | undefined = process.env.CSP_MODE): CspMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'report-only';
  if ((MODES as readonly string[]).includes(value)) return value as CspMode;
  if (warnedMode !== value) {
    warnedMode = value;
    console.warn(`CSP_MODE must be report-only, enforce or off; "${value}" is treated as report-only.`);
  }
  return 'report-only';
}

/** The response header that carries the policy in this mode. */
export function cspHeaderName(mode: Exclude<CspMode, 'off'>): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' {
  return mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
}

/** A fresh nonce: 128 random bits, base64 (the form Next.js looks for). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

// A DNS name: labels of letters, digits and inner hyphens, at least two of
// them. Anything else (a space, a quote, a semicolon) could change the policy
// it is written into, so it is refused rather than escaped.
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PUBLISHABLE_KEY = /^pk_(test|live)_([A-Za-z0-9+/]+={0,2})$/;

/**
 * The Clerk Frontend API host a publishable key names, and whether it is a
 * development instance (pk_test_). The key is "pk_test_" or "pk_live_" and
 * then the host followed by one "$", base64-encoded (padding optional), the
 * same reading as Clerk's parsePublishableKey. Null for anything else.
 */
export function clerkFrontendApi(publishableKey: string | undefined): { host: string; development: boolean } | null {
  const match = PUBLISHABLE_KEY.exec((publishableKey ?? '').trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = atob(match[2]);
  } catch {
    return null;
  }
  if (!decoded.endsWith('$')) return null;
  const host = decoded.slice(0, -1).toLowerCase();
  return HOST.test(host) ? { host, development: match[1] === 'test' } : null;
}

const PLAID_CDN = 'https://cdn.plaid.com';
const PLAID_LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const PLAID_IMAGES = [
  'https://plaid-merchant-logos.plaid.com',
  'https://plaid-counterparty-logos.plaid.com',
  'https://plaid-category-icons.plaid.com',
];
const CLERK_IMAGES = 'https://img.clerk.com';
const CLERK_PROTECT = 'https://*.protect.clerk.com';
const CLERK_TELEMETRY = 'https://clerk-telemetry.com';
const TURNSTILE = 'https://challenges.cloudflare.com';

/** The Plaid API host for PLAID_ENV, as lib/plaid.ts reads it (sandbox unless
 *  it says production). */
export function plaidApiHost(plaidEnv: string | undefined): string {
  return (plaidEnv || 'sandbox') === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';
}

export type CspOptions = {
  nonce: string;
  /** Running under `next dev`. */
  dev: boolean;
  /** PLAID_ENV. */
  plaidEnv: string | undefined;
  /** NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, passed only while Clerk is on. */
  clerkPublishableKey?: string;
};

/** The policy as directives and their sources, in the order they are sent. */
export function cspDirectives(opts: CspOptions): Record<string, string[]> {
  const clerk = opts.clerkPublishableKey ? clerkFrontendApi(opts.clerkPublishableKey) : null;
  // A key that names no host leaves Clerk's own sources in: its images, bot
  // check and protection still have fixed hosts. Clerk refuses such a key
  // loudly itself.
  const clerkOn = !!opts.clerkPublishableKey;
  const fapi = clerk ? [`https://${clerk.host}`] : [];
  return {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${opts.nonce}'`,
      "'strict-dynamic'",
      ...(opts.dev ? ["'unsafe-eval'"] : []),
      PLAID_LINK_SCRIPT,
      ...(clerkOn ? [...fapi, TURNSTILE, CLERK_PROTECT] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...PLAID_IMAGES, PLAID_CDN, ...(clerkOn ? [CLERK_IMAGES] : [])],
    'font-src': ["'self'", PLAID_CDN],
    'connect-src': [
      "'self'",
      plaidApiHost(opts.plaidEnv),
      PLAID_CDN,
      ...(clerkOn ? [...fapi, CLERK_IMAGES, `${CLERK_PROTECT}:*`] : []),
      ...(clerk?.development ? [CLERK_TELEMETRY] : []),
    ],
    'frame-src': [PLAID_CDN, ...(clerkOn ? [TURNSTILE, CLERK_PROTECT] : [])],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    // The demo sign-in is a form post (app/sign-in), and browsers apply this to
    // the redirects that follow it too, which may pass through Clerk's Frontend
    // API when its middleware refreshes a session.
    'form-action': ["'self'", ...fapi],
    'frame-ancestors': ["'none'"],
  };
}

/** The policy as a header value. */
export function buildCsp(opts: CspOptions): string {
  return Object.entries(cspDirectives(opts))
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}
