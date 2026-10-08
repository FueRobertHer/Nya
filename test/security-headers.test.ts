import { describe, expect, test } from 'bun:test';
import { parsePublishableKey } from '@clerk/shared/keys';
import nextConfig from '@/next.config.js';
import {
  buildCsp,
  clerkFrontendApi,
  cspDirectives,
  cspHeaderName,
  cspMode,
  newNonce,
  plaidApiHost,
  type CspOptions,
} from '@/lib/security-headers';

// What a key looks like: "pk_test_" or "pk_live_", then the host and a "$",
// base64 without padding (as Clerk issues them).
const keyFor = (host: string, live = false) => `pk_${live ? 'live' : 'test'}_${btoa(`${host}$`).replace(/=+$/, '')}`;
const DEV_KEY = keyFor('fine-heron-12.clerk.accounts.dev');
const LIVE_KEY = keyFor('clerk.nya.example.com', true);

const base: CspOptions = { nonce: 'bm9uY2Vub25jZW5vbmNlMQ==', mode: 'enforce', dev: false, plaidEnv: 'production' };
const directives = (opts: Partial<CspOptions> = {}) => cspDirectives({ ...base, ...opts });

describe('CSP_MODE', () => {
  test('report-only unless it says enforce or off', () => {
    expect(cspMode(undefined)).toBe('report-only');
    expect(cspMode('')).toBe('report-only');
    expect(cspMode('report-only')).toBe('report-only');
    expect(cspMode('enforce')).toBe('enforce');
    expect(cspMode('off')).toBe('off');
    expect(cspMode('  Enforce ')).toBe('enforce');
    expect(cspMode('OFF')).toBe('off');
  });

  test('a typo is report-only, never enforce, and is logged once', () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect(cspMode('enforced')).toBe('report-only');
      expect(cspMode('enforced')).toBe('report-only');
      expect(cspMode('true')).toBe('report-only');
    } finally {
      console.warn = warn;
    }
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"enforced"');
  });

  test('each mode sends its own header', () => {
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(cspHeaderName('report-only')).toBe('Content-Security-Policy-Report-Only');
  });
});

describe('the nonce', () => {
  test('is 128 random bits, base64, new every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const nonce = newNonce();
      expect(atob(nonce)).toHaveLength(16);
      // The form Next.js accepts (get-script-nonce-from-header).
      expect(nonce).toMatch(/^[A-Za-z0-9+/_-]+={0,2}$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(200);
  });
});

describe("Clerk's host, from the publishable key", () => {
  test('development and production keys', () => {
    expect(clerkFrontendApi(DEV_KEY)).toEqual({ host: 'fine-heron-12.clerk.accounts.dev', development: true });
    expect(clerkFrontendApi(LIVE_KEY)).toEqual({ host: 'clerk.nya.example.com', development: false });
    // Padded, or with stray whitespace from a pasted variable, reads the same.
    expect(clerkFrontendApi(`pk_live_${btoa('clerk.nya.example.com$')}`)?.host).toBe('clerk.nya.example.com');
    expect(clerkFrontendApi(` ${DEV_KEY}\n`)?.host).toBe('fine-heron-12.clerk.accounts.dev');
  });

  test("reads every key the way Clerk's own parser does", () => {
    for (const key of [DEV_KEY, LIVE_KEY, keyFor('clerk.example.co.uk', true), keyFor('a-b-1.clerk.accounts.dev')]) {
      expect(clerkFrontendApi(key)?.host).toBe(parsePublishableKey(key)!.frontendApi);
    }
  });

  test('anything else names no host', () => {
    for (const key of [
      undefined,
      '',
      'pk_test_',
      'sk_test_' + btoa('clerk.example.com$'),
      'pk_prod_' + btoa('clerk.example.com$'),
      'pk_test_' + btoa('clerk.example.com'), // no "$"
      'pk_test_' + btoa('localhost$'), // no dot
      'pk_test_!!!',
    ]) {
      expect(clerkFrontendApi(key)).toBeNull();
    }
  });

  test('a key cannot write into the policy', () => {
    for (const host of ["evil.com; script-src 'unsafe-inline'", 'evil.com *', "evil.com 'unsafe-eval'", 'a.com$', 'evil.com\nx: y']) {
      expect(clerkFrontendApi(keyFor(host))).toBeNull();
    }
    const policy = buildCsp({ ...base, clerkPublishableKey: keyFor("evil.com; script-src 'unsafe-inline'") });
    expect(policy).not.toContain('evil.com');
    const scripts = policy.split('; ').filter((d) => d.startsWith('script-src'));
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toContain("'unsafe-inline'");
  });
});

describe('the policy', () => {
  test('scripts need the nonce; nothing inline runs without it', () => {
    const d = directives();
    expect(d['script-src']).toContain(`'nonce-${base.nonce}'`);
    expect(d['script-src']).toContain("'strict-dynamic'");
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['form-action']).toEqual(["'self'"]);
  });

  test("frame-ancestors only when enforced: report-only ignores it, and Chrome logs an error for it", () => {
    expect(buildCsp(base)).toContain("frame-ancestors 'none'");
    const reportOnly = buildCsp({ ...base, mode: 'report-only' });
    expect(reportOnly).not.toContain('frame-ancestors');
    // Everything else is the same policy, so report-only shows what enforce would block.
    expect(reportOnly).toBe(buildCsp(base).replace("; frame-ancestors 'none'", ''));
  });

  test("no 'unsafe-eval' outside next dev", () => {
    expect(buildCsp(base)).not.toContain('unsafe-eval');
    expect(buildCsp({ ...base, clerkPublishableKey: DEV_KEY })).not.toContain('unsafe-eval');
    expect(directives({ dev: true })['script-src']).toContain("'unsafe-eval'");
  });

  test('Plaid Link: its script, its frame, and the API host for PLAID_ENV', () => {
    const d = directives();
    expect(d['script-src']).toContain('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
    expect(d['frame-src']).toContain('https://cdn.plaid.com');
    expect(d['connect-src']).toContain('https://production.plaid.com');
    expect(d['connect-src']).not.toContain('https://sandbox.plaid.com');
    expect(directives({ plaidEnv: 'sandbox' })['connect-src']).toContain('https://sandbox.plaid.com');
    // Unset is sandbox, as lib/plaid.ts reads it.
    expect(plaidApiHost(undefined)).toBe('https://sandbox.plaid.com');
    expect(plaidApiHost('production')).toBe('https://production.plaid.com');
  });

  test("Plaid's merchant logos and category icons, and the app's own images", () => {
    const img = directives()['img-src'];
    for (const src of [
      "'self'",
      'data:',
      'https://plaid-merchant-logos.plaid.com',
      'https://plaid-counterparty-logos.plaid.com',
      'https://plaid-category-icons.plaid.com',
    ]) {
      expect(img).toContain(src);
    }
  });

  test('the service worker and the manifest are this origin', () => {
    const d = directives();
    expect(d['worker-src']).toContain("'self'");
    expect(d['default-src']).toEqual(["'self'"]); // covers manifest-src
  });

  test('without Clerk, none of its hosts', () => {
    const policy = buildCsp(base);
    for (const host of ['clerk', 'challenges.cloudflare.com']) expect(policy).not.toContain(host);
  });

  test('with Clerk: its Frontend API, images, bot check and workers', () => {
    const d = directives({ clerkPublishableKey: LIVE_KEY });
    expect(d['script-src']).toContain('https://clerk.nya.example.com');
    expect(d['connect-src']).toContain('https://clerk.nya.example.com');
    expect(d['img-src']).toContain('https://img.clerk.com');
    expect(d['script-src']).toContain('https://challenges.cloudflare.com');
    expect(d['frame-src']).toContain('https://challenges.cloudflare.com');
    expect(d['worker-src']).toContain('blob:');
    expect(d['style-src']).toContain("'unsafe-inline'");
    // The demo sign-in's form post may be redirected through Clerk.
    expect(d['form-action']).toEqual(["'self'", 'https://clerk.nya.example.com']);
    expect(directives()['form-action']).toEqual(["'self'"]);
  });

  test("Clerk's telemetry host only for a development instance, the only kind that sends it", () => {
    expect(directives({ clerkPublishableKey: DEV_KEY })['connect-src']).toContain('https://clerk-telemetry.com');
    expect(directives({ clerkPublishableKey: LIVE_KEY })['connect-src']).not.toContain('https://clerk-telemetry.com');
  });

  test('is one header line of well-formed directives', () => {
    const policy = buildCsp({ ...base, clerkPublishableKey: DEV_KEY });
    expect(policy).not.toMatch(/[\r\n]/);
    const names = policy.split('; ').map((d) => d.split(' ')[0]);
    expect(new Set(names).size).toBe(names.length);
    for (const d of policy.split('; ')) expect(d.split(' ').length).toBeGreaterThan(1);
  });
});

describe('the headers on every response (next.config.js)', () => {
  test('apply to every path', async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('/:path*');
  });

  test('HSTS, nosniff, a strict referrer, framing off, and the rest', async () => {
    const [rule] = await nextConfig.headers!();
    const h = Object.fromEntries(rule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
    expect(h['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(h['strict-transport-security']).not.toContain('preload');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['x-frame-options']).toBe('DENY');
    // The page policy from the proxy is the only Content-Security-Policy: two
    // would both be enforced, and how Vercel combines them is not documented.
    expect(h['content-security-policy']).toBeUndefined();
    expect(h['content-security-policy-report-only']).toBeUndefined();
    // Not same-origin: that would cut a bank's sign-in pop-up off from Plaid Link.
    expect(h['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'browsing-topics']) {
      expect(h['permissions-policy']).toContain(`${feature}=()`);
    }
    // Clerk's passkeys and copy buttons still work.
    expect(h['permissions-policy']).not.toContain('publickey-credentials');
    expect(h['permissions-policy']).not.toContain('clipboard');
  });
});
