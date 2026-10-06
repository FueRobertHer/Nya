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

// The public pages make promises about the code. These tests hold them to it:
// every figure they state comes from the code, and none of them makes a claim
// the plan's "What not to promise" list rules out.

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

// Read from the source: the login limit lives in its route, which may export
// only handlers, and lib/sharing.ts would bring the Plaid client with it. Either
// way the page can't drift from them.
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const figure = (path: string, pattern: RegExp) => Number(pattern.exec(source(path))![1]);
const MAX_FAILURES = figure('app/api/login/route.ts', /const MAX_FAILURES = (\d+);/);
const WINDOW_MINUTES = figure('app/api/login/route.ts', /const WINDOW_SECONDS = (\d+) \* 60;/);
const INVITE_HOURS = figure('lib/sharing.ts', /export const INVITE_HOURS = (\d+);/);
const SHARED_TXN_DAYS = figure('lib/sharing.ts', /export const SHARED_TXN_DAYS = (\d+);/);

const DAYS = SESSION_MAX_AGE_SECONDS / 86400;

describe('never promised', () => {
  // The plan's "What not to promise", and marketing words besides.
  const RULED_OUT: RegExp[] = [
    /can(?:not|'t|’t) read your data/i,
    /never see(?:s)? your data/i,
    /end-to-end encrypted/i,
    /exposes none/i,
    /deleted everywhere/i,
    /\binstant(?:ly)?\b/i,
    /everything (?:is )?encrypted/i,
    /fully encrypted/i,
    /military|bank-(?:level|grade)|unhackable|100% secure|bulletproof/i,
  ];

  test('neither page makes a claim the plan rules out', () => {
    for (const page of [security(), privacy()]) {
      for (const claim of RULED_OUT) expect(page).not.toMatch(claim);
    }
  });

  test('both say plainly that whoever runs Nya can read the data', () => {
    expect(security()).toContain('Nya is not encrypted end to end. Whoever runs Nya holds the keys, so they can read your data.');
    expect(security()).toMatch(/The operator, who runs this copy of Nya Everything, in practice\./);
  });

  test('no dashes of the kinds the house style rules out', () => {
    for (const page of [security(), privacy()]) expect(page).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('the security page', () => {
  test('explains the envelope encryption', () => {
    const page = security();
    for (const fact of ['AES-256-GCM', 'envelope encryption', 'data keys', 'master key', 'leaves the data itself untouched']) {
      expect(page).toContain(fact);
    }
  });

  test('lists what is stored as plain text, as docs/operations.md does', () => {
    const page = security();
    for (const item of ['dates and times', 'ids: of your accounts, transactions and bank connections', 'the names of the banks you linked', 'the merchant names you renamed', 'for sharing: the names']) {
      expect(page).toContain(item);
    }
  });

  test('names everyone who can read anything', () => {
    const page = security();
    for (const who of ['The operator', 'Upstash', 'Vercel', 'Plaid', 'Clerk', 'People you share with', 'Your device']) {
      expect(page).toContain(who);
    }
    expect(page).toContain(`last ${SHARED_TXN_DAYS} days of transactions`);
  });

  test('backups, deletion, sessions and the login limit, with the figures the code uses', () => {
    const page = security();
    expect(page).toContain(`Copies are kept for ${DEFAULT_KEEP_DAYS} days. The newest ${MIN_KEPT} are always kept`);
    expect(page).toContain(`within ${DEFAULT_KEEP_DAYS} days`);
    expect(page).toContain('Delete my account');
    expect(page).toContain(`good for ${DAYS} days`);
    expect(page).toContain('Sign out everywhere');
    expect(page).toContain(`${MAX_FAILURES} wrong passwords per ${WINDOW_MINUTES} minutes`);
    expect(securityHtml()).toContain('href="https://my.plaid.com"');
  });

  test('describes every header the app sends (next.config.js)', async () => {
    const page = security();
    const [rule] = await nextConfig.headers!();
    for (const { key } of rule.headers) expect(page).toContain(key);
  });

  test('says how this copy sends its Content-Security-Policy', () => {
    delete process.env.CSP_MODE;
    expect(security()).toContain('still checking it against live Plaid and Clerk sign-ins');
    process.env.CSP_MODE = 'enforce';
    expect(security()).toContain('This copy of Nya enforces it.');
    process.env.CSP_MODE = 'off';
    expect(security()).toContain('This copy of Nya has it switched off.');
  });

  test('says where bank connections work', () => {
    expect(security()).toContain('work for US institutions only');
    expect(security()).toContain('manual account');
  });
});

describe('the privacy page', () => {
  test('says first that it is not a legal policy', () => {
    const page = privacy();
    expect(page.indexOf('not a legal privacy policy')).toBeGreaterThan(-1);
    expect(page.indexOf('not a legal privacy policy')).toBeLessThan(page.indexOf('Our commitments'));
    expect(page).toContain('legal entity');
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
    expect(page).toContain('no billing provider');
    expect(page).toContain('no email provider');
  });

  test('states retention with the figures the code uses', () => {
    const page = privacy();
    expect(page).toContain(`Nightly backups ${DEFAULT_KEEP_DAYS} days. The newest ${MIN_KEPT} are always kept`);
    expect(page).toContain(`Invite links ${INVITE_HOURS} hours, or until used.`);
    expect(page).toContain(`used for ${SHORT_TTL_SECONDS / 60} minutes, or up to ${WEBHOOK_TTL_SECONDS / 3600} hours`);
    expect(page).toContain(`Sessions with the shared password ${DAYS} days`);
    expect(page).toContain(`counted by IP address ${WINDOW_MINUTES} minutes.`);
    expect(page).toContain(`within ${DEFAULT_KEEP_DAYS} days`);
    expect(page).toContain('What your device keeps');
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
      'Bank connections work for US institutions only, through Plaid. Anything else can be tracked as a manual account'
    );
  });

  test('which matches what the link-token routes ask Plaid for', () => {
    for (const route of ['create-link-token', 'create-update-link-token']) {
      expect(source(`app/api/${route}/route.ts`)).toContain('country_codes: [CountryCode.Us]');
    }
  });
});
