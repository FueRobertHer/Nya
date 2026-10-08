import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import SecurityPage from '@/app/security/page';
import PrivacyPage from '@/app/privacy/page';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import nextConfig from '@/next.config.js';
import { DEFAULT_KEEP_DAYS, MIN_KEPT } from '@/lib/backup';
import { SESSION_MAX_AGE_SECONDS } from '@/lib/auth';
import { SHORT_TTL_SECONDS, WEBHOOK_TTL_SECONDS } from '@/lib/cache';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS } from '@/lib/rate-limit';

// The public pages make promises about the code. These tests hold them to it:
// every figure they state comes from the code, and none of them makes a claim
// the plan's "What not to promise" list rules out.

// lib/sharing.ts brings the Plaid client, which warns at import when no
// credentials are set. Nothing here calls Plaid, so placeholders, for the
// import alone, keep the output clean.
const { INVITE_HOURS, SHARED_TXN_DAYS } = await (async () => {
  const before = { ...process.env };
  process.env.PLAID_CLIENT_ID ||= 'placeholder';
  process.env.PLAID_SECRET ||= 'placeholder';
  try {
    return await import('@/lib/sharing');
  } finally {
    process.env = before;
  }
})();

// Route files may export only their handlers, so the limits that live in
// routes are read from their source. One that can't be found reads NaN, which
// the first test below reports by name instead of failing the whole file.
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const routeFigure = (path: string, pattern: RegExp) => Number(pattern.exec(source(path))?.[1]);
const LOGIN_WINDOW_MINUTES = LOGIN_WINDOW_SECONDS / 60;
const DEMO_WINDOW_MINUTES = routeFigure('app/api/demo/sign-in/route.ts', /const WINDOW_SECONDS = (\d+) \* 60;/);

/** The page as text: tags dropped, the entities React writes decoded, spaces collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const securityHtml = () => renderToStaticMarkup(<SecurityPage />);
const privacyHtml = () => renderToStaticMarkup(<PrivacyPage />);
const security = () => text(securityHtml());
const privacy = () => text(privacyHtml());

const DAYS = SESSION_MAX_AGE_SECONDS / 86400;
/** A usable master key: 32 bytes, base64. */
const MASTER = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

test('finds the limits it checks in their routes', () => {
  for (const [name, value] of Object.entries({ DEMO_WINDOW_MINUTES })) {
    expect({ [name]: Number.isFinite(value) }).toEqual({ [name]: true });
  }
});

describe('never promised', () => {
  // The plan's "What not to promise", overclaims about what is encrypted, and
  // marketing words besides.
  const RULED_OUT: RegExp[] = [
    /can(?:not|'t|’t) read your data/i,
    /never see(?:s)? your data/i,
    /end-to-end encrypted/i,
    /exposes none/i,
    /deleted everywhere/i,
    /\binstant(?:ly)?\b/i,
    /everything\b[^.]{0,30}\bencrypted/i,
    /\ball (?:of )?your (?:financial )?data\b[^.]{0,30}\bencrypted/i,
    /your (?:financial )?data (?:is|are) encrypted/i,
    /(?:holds|stores|keeps) your (?:financial )?data encrypted/i,
    /encrypted like everything/i,
    /fully encrypted/i,
    /military|bank-(?:level|grade)|unhackable|100% secure|bulletproof/i,
  ];

  test('the guard catches the phrasings it is there for', () => {
    for (const claim of [
      'Everything financial is encrypted with AES-256-GCM.',
      'Everything is encrypted.',
      'All your data is encrypted at rest.',
      'Holds your data encrypted.',
      'Encrypted like everything else.',
    ]) {
      expect(RULED_OUT.some((r) => r.test(claim))).toBe(true);
    }
  });

  test('neither page makes a claim the plan rules out, with a master key or without', () => {
    for (const master of [undefined, MASTER]) {
      if (master) process.env.MASTER_KEY = master;
      else delete process.env.MASTER_KEY;
      for (const page of [security(), privacy()]) {
        for (const claim of RULED_OUT) expect(page).not.toMatch(claim);
      }
    }
  });

  test('says plainly that whoever runs Nya can read the data', () => {
    expect(security()).toContain('Nya is not encrypted end to end. Whoever runs Nya holds the keys, so they can read your data.');
    expect(security()).toMatch(/The operator, who runs this copy of Nya Everything, in practice\./);
  });

  test('no dashes of the kinds the house style rules out', () => {
    for (const page of [security(), privacy()]) expect(page).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('the security page', () => {
  test('lists what is encrypted, not "everything"', () => {
    expect(security()).toContain('These values are encrypted with AES-256-GCM before they are written to the database: the tokens');
    expect(security()).toContain('Some details around them are not; they are listed below.');
  });

  test('describes envelope encryption only where a master key is set', () => {
    delete process.env.MASTER_KEY;
    let page = security();
    expect(page).toContain('This copy of Nya encrypts them with one key');
    expect(page).toContain('is built in but not turned on here');
    expect(page).not.toContain('uses envelope encryption');
    expect(page).not.toContain('data keys in their locked form');
    expect(page).toContain('which holds both the key and the database password');

    process.env.MASTER_KEY = MASTER;
    page = security();
    expect(page).toContain('This copy of Nya uses envelope encryption.');
    for (const fact of ['data keys', 'master key', 'leaves the data itself untouched', 'the server’s log says so', 'data keys in their locked form']) {
      expect(page).toContain(fact);
    }
    expect(page).not.toContain('not turned on here');
    expect(page).toContain('which holds both the master key and the database password');

    // A value that can't be a key is no master key: writes use the original key.
    process.env.MASTER_KEY = 'not-a-key';
    expect(security()).toContain('is built in but not turned on here');
  });

  test('lists what is stored as plain text, as docs/operations.md does', () => {
    const page = security();
    for (const item of ['dates and times', 'ids: of your accounts, transactions and bank connections', 'the names of the banks you linked', 'the merchant names you renamed', 'for sharing: the names']) {
      expect(page).toContain(item);
    }
    // IP addresses, in the rate limiters' keys, which exports leave out.
    expect(page).toContain(`the IP address of a device that typed a wrong password, for up to ${LOGIN_WINDOW_MINUTES} minutes`);
    expect(page).toContain(`for up to ${DEMO_WINDOW_MINUTES} minutes. These never go into backups.`);
  });

  test('names everyone who can read anything, and what', () => {
    const page = security();
    for (const who of ['The operator', 'Upstash', 'Vercel', 'Plaid', 'Clerk', 'People you share with', 'Your device']) {
      expect(page).toContain(who);
    }
    expect(page).toContain(`last ${SHARED_TXN_DAYS} days of transactions`);
    expect(page).toContain('your name and picture if you sign in with Google or another account');
    expect(page).toContain('Cloudflare (Turnstile), which sees your IP address and browser');
    // The device keeps more than balances (components/Dashboard.tsx saves the whole snapshot).
    expect(page).toContain('Your accounts, their balances and your net-worth history, as the app last showed them');
  });

  test('backups, deletion, sessions and the login limit, with the figures the code uses', () => {
    const page = security();
    expect(page).toContain(`Copies are kept for ${DEFAULT_KEEP_DAYS} days. The newest ${MIN_KEPT} are always kept`);
    expect(page).toContain('Delete my account');
    expect(page).toContain(`Invite links you made that nobody has used: each holds your sign-in id and the name you gave, and expires on its own within ${INVITE_HOURS} hours.`);
    expect(page).toContain(`good for ${DAYS} days`);
    expect(page).toContain('Sign out everywhere');
    expect(page).toContain(`${LOGIN_MAX_FAILURES} wrong passwords per ${LOGIN_WINDOW_MINUTES} minutes`);
    expect(securityHtml()).toContain('href="https://my.plaid.com"');
  });

  test('describes every header the app sends (next.config.js)', async () => {
    const page = security();
    const [rule] = await nextConfig.headers!();
    for (const { key } of rule.headers) expect(page).toContain(key);
    expect(page).toContain('X-Frame-Options: DENY : no other site can show Nya inside a frame.');
  });

  test('says how this copy sends its Content-Security-Policy, in words that fit the mode', () => {
    delete process.env.CSP_MODE;
    const reportOnly = security();
    expect(reportOnly).toContain('which this copy of Nya is still checking against live Plaid and Clerk sign-ins');
    expect(reportOnly).toContain('block nothing yet. Once it is enforced, it may only run scripts');

    process.env.CSP_MODE = 'enforce';
    expect(security()).toContain('which this copy of Nya enforces: it may only run scripts');

    process.env.CSP_MODE = 'off';
    const off = security();
    expect(off).toContain('This copy of Nya has it switched off.');
    expect(off).not.toContain('Every page also carries');
  });

  test('says where bank connections work, and that manual accounts are in US dollars', () => {
    const page = security();
    expect(page).toContain('work for US institutions only');
    expect(page).toContain('you enter the balance in US dollars');
  });
});

describe('the privacy page', () => {
  test('says first that it is a plain-language summary, not a legal policy, and nothing of internal plans', () => {
    const page = privacy();
    expect(page.indexOf('This page is a plain-language summary, not a legal privacy policy.')).toBeGreaterThan(-1);
    expect(page.indexOf('not a legal privacy policy')).toBeLessThan(page.indexOf('Our commitments'));
    expect(page).not.toContain('legal entity');
    expect(page).not.toContain('lawyer');
  });

  test('makes the seven commitments, each with what is true today and what is not', () => {
    const html = privacyHtml();
    const promises = [
      'We never sell or share your financial data.',
      'You can download everything stored about you, in open formats, whenever you like.',
      'You can delete everything, and it reaches backups and connected services.',
      'You decide what anyone else sees, and you can see what they see about you.',
      'You can see who can read what, including us.',
      'AI features are opt-in and act only on what you point them at.',
      'You can leave.',
    ];
    for (const promise of promises) expect(text(html)).toContain(promise);
    expect(html.match(/<dt>True today<\/dt>/g)).toHaveLength(promises.length);
    // "Being built" only where work is under way: the download.
    expect(html.match(/<dt>Being built<\/dt>/g)).toHaveLength(1);
    expect(text(html)).toMatch(/Being built Download my data, under Manage accounts/);
  });

  test('names the processors, and the kinds not used yet', () => {
    const page = privacy();
    for (const name of ['Vercel', 'Upstash', 'Plaid', 'Clerk']) expect(page).toContain(name);
    expect(page).toContain('the values that hold money encrypted, and the details listed on the Security page in plain text');
    expect(page).toContain('your name and picture if you sign in with Google or another account');
    expect(page).toContain('Cloudflare (Turnstile)');
    expect(page).toContain('no billing provider');
    expect(page).toContain('no email provider');
  });

  test('states retention with the figures the code uses', () => {
    const page = privacy();
    expect(page).toContain(`Nightly backups ${DEFAULT_KEEP_DAYS} days. The newest ${MIN_KEPT} are always kept`);
    expect(page).toContain(`Invite links ${INVITE_HOURS} hours, or until used.`);
    expect(page).toContain(`used for ${SHORT_TTL_SECONDS / 60} minutes, or up to ${WEBHOOK_TTL_SECONDS / 3600} hours`);
    expect(page).toContain(`Sessions with the shared password ${DAYS} days`);
    expect(page).toContain(`counted by IP address ${LOGIN_WINDOW_MINUTES} minutes.`);
    expect(page).toContain('What your device keeps Your accounts, their balances and your net-worth history, as the app last showed them');
  });

  test('says what outlives a deletion or a disconnection', () => {
    const page = privacy();
    expect(page).toContain(`apart from invite links you made that nobody used (your sign-in id and the name you gave), which expire within ${INVITE_HOURS} hours`);
    expect(page).toContain(`Invite links you made that nobody has used hold your sign-in id and the name you gave, and expire on their own within ${INVITE_HOURS} hours.`);
    expect(page).toContain('for each one you recategorized, its date, amount and bank description are kept, encrypted');
    expect(page).toContain('Plaid keeps what it collected under its own policy.');
  });

  test('says how to download and delete, and points to the Plaid Portal', () => {
    const page = privacy();
    expect(page).toContain('It will appear under Manage accounts as Download my data');
    expect(page).toContain('Delete my account');
    expect(privacyHtml()).toContain('href="https://my.plaid.com"');
  });
});

describe('getting to them', () => {
  test('each page links to the other, and back into the app', () => {
    for (const html of [securityHtml(), privacyHtml()]) {
      expect(html).toContain('href="/security"');
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/"');
    }
    expect(securityHtml()).toMatch(/href="\/security" aria-current="page"/);
    expect(privacyHtml()).toMatch(/href="\/privacy" aria-current="page"/);
  });

  test('the links and the coverage statement shown on the sign-in pages and beside Connect an account', () => {
    const links = renderToStaticMarkup(<TrustLinks />);
    expect(links).toContain('href="/security"');
    expect(links).toContain('href="/privacy"');
    expect(links).not.toContain('aria-current');
    expect(text(renderToStaticMarkup(<CoverageNote />))).toContain(
      'Bank connections work for US institutions only, through Plaid. Anything else can be tracked as a manual account, with a balance you enter in US dollars.'
    );
  });

  test('which matches what the link-token routes ask Plaid for', () => {
    for (const route of ['create-link-token', 'create-update-link-token']) {
      expect(source(`app/api/${route}/route.ts`)).toContain('country_codes: [CountryCode.Us]');
    }
  });

  // Read from the source: rendering these needs Clerk and the router, which
  // other test files mock process-wide in their own ways.
  test('the login and sign-in pages show both, and every Connect an account button the coverage statement', () => {
    for (const page of ['app/login/page.tsx', 'app/sign-in/[[...sign-in]]/page.tsx']) {
      expect(source(page)).toContain('<CoverageNote />');
      expect(source(page)).toContain('<TrustLinks />');
    }
    const dashboard = source('components/Dashboard.tsx');
    const buttons = dashboard.split("{connecting ? 'Starting…' : 'Connect an account'}").slice(1);
    expect(buttons.length).toBeGreaterThan(0);
    for (const after of buttons) expect(after.slice(0, 200)).toMatch(/^\s*<\/button>\s*<CoverageNote \/>/);
    expect(dashboard).toContain('<TrustLinks />');
  });
});
