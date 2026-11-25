import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mockForFile } from './scoped-mock';
// What the demo card takes from Clerk's client, for this file only
// (test/scoped-mock.ts): a Clerk that hasn't loaded, so a press would post
// the form as forms do.
await mockForFile('@clerk/nextjs', () => ({
  useClerk: () => ({ loaded: false, client: null }),
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: DemoSignIn } = await import('@/components/DemoSignIn');
const { DEMO_UNAVAILABLE } = await import('@/lib/demo');
const { TAGLINE } = await import('@/lib/tagline');

// The sign-in page's first screen (app/sign-in, components/DemoSignIn.tsx):
// one line on what Nya is, then the demo accounts as tonal buttons with
// their names, so Clerk's Continue is the one filled button, each with the
// scenario it was last reset to under it when the page could read it
// (lib/demo-seed/loaded.ts, test/demo-seed-loaded.test.ts).
// The flow itself (a form per account, posted, or signed in in place) is
// test/demo-sign-in.test.ts's and test/sign-in-flow-view.test.tsx's.

const demos = [
  { id: 'user_alex', label: 'Alex' },
  { id: 'user_sam', label: 'Sam' },
];
const html = (unavailable = false, loaded?: Record<string, string>) => renderToStaticMarkup(<DemoSignIn demos={demos} loaded={loaded} unavailable={unavailable} />);
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the demo card', () => {
  test('a form per account, in order, posting its id as before', () => {
    const forms = [...html().matchAll(/<form class="stack tight" action="\/api\/demo\/sign-in" method="post"><input type="hidden" name="user" value="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(forms).toEqual(['user_alex', 'user_sam']);
  });

  test('the accounts side by side, in one button row', () => {
    expect(html()).toMatch(/<div class="btn-row demo-accounts">(<form [^>]*>[\s\S]*?<\/form>){2}<\/div>/);
    expect(html(false, { user_alex: 'Single renter', user_sam: 'Two-income household' })).toMatch(
      /<div class="btn-row demo-accounts">(<form [^>]*>[\s\S]*?<\/form>){2}<\/div>/
    );
  });

  test('each button tonal, never filled, named for its account alone', () => {
    for (const loaded of [undefined, { user_alex: 'Single renter', user_sam: 'Two-income household' }]) {
      const buttons = [...html(false, loaded).matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
      expect(buttons).toHaveLength(2);
      for (const [, attrs] of buttons) expect(attrs).toContain('class="btn secondary btn-block"');
      expect(buttons.map((b) => b[2])).toEqual(['Alex', 'Sam']);
    }
  });

  test('under each button, the scenario it was last reset to, which describes the button', () => {
    const page = html(false, { user_alex: 'Single renter', user_sam: 'Two-income household' });
    const forms = [...page.matchAll(/<form [^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]);
    expect(forms[0]).toContain(
      '<button type="submit" class="btn secondary btn-block" aria-describedby="demo-loaded-user_alex">Alex</button><p class="helper" id="demo-loaded-user_alex">Single renter</p>'
    );
    expect(forms[1]).toContain(
      '<button type="submit" class="btn secondary btn-block" aria-describedby="demo-loaded-user_sam">Sam</button><p class="helper" id="demo-loaded-user_sam">Two-income household</p>'
    );
  });

  test('no line for an account the page couldn’t say, and none at all without them', () => {
    const one = html(false, { user_sam: 'Early retiree' });
    expect(one).toContain('<button type="submit" class="btn secondary btn-block">Alex</button></form>');
    expect(one).toContain('aria-describedby="demo-loaded-user_sam">Sam</button><p class="helper" id="demo-loaded-user_sam">Early retiree</p>');
    for (const page of [html(), html(false, {})]) {
      expect(page).not.toContain('aria-describedby');
      expect(page).not.toContain('demo-loaded-');
      expect(page).toContain('<button type="submit" class="btn secondary btn-block">Alex</button></form>');
    }
  });

  test('keeps its warning that the accounts are shared, word for word, and notes how to switch scenarios', () => {
    expect(html()).toContain(
      'Sign in as a demo account, with pretend banks from Plaid&#x27;s sandbox. Everyone who tries it shares these\n          accounts, so anything you add is visible to others.'.replace(/\s+/g, ' ')
    );
    expect(html()).toContain('You can switch among sample scenarios anytime in Settings, Your data and privacy.');
  });

  test('a demo that couldn’t sign in says so, as an alert that can take focus (test/demo-sign-in-flow-view.test.tsx)', () => {
    expect(html()).not.toContain('role="alert"');
    expect(html(true)).toContain('<div class="notice critical" role="alert" tabindex="-1">');
    expect(html(true)).toContain(`<span class="visually-hidden">Critical: </span>${DEMO_UNAVAILABLE}</div></div>`);
  });
});

describe('the pages someone meets first', () => {
  test('one line on what Nya is, short enough for one line on a phone', () => {
    expect(TAGLINE.length).toBeLessThanOrEqual(60);
    expect(TAGLINE).not.toMatch(/[\u2013\u2014]/);
  });

  test('the sign-in page: the name, the line, then the receipt, the demo, Clerk’s form and which banks work', () => {
    const page = source('app/sign-in/[[...sign-in]]/page.tsx');
    const order = ['<Brand />', '<p className="auth-tagline">{TAGLINE}</p>', '<DeletionReceiptNotice />', '<DemoSignIn ', '<SignIn ', '<Why label="Which banks work?">', '<TrustLinks />'];
    const at = order.map((s) => page.indexOf(s));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test('the sign-in page reads what each demo account was reset to, on the server, and hands it to the card', () => {
    const page = source('app/sign-in/[[...sign-in]]/page.tsx');
    expect(page).toContain("import { loadedScenarios } from '@/lib/demo-seed/loaded';");
    expect(page).toContain('await loadedScenarios(demos)');
    expect(page).toContain('<DemoSignIn demos={demos} loaded={loaded} ');
  });

  test('the password login says the same line', () => {
    expect(source('app/login/page.tsx')).toContain('{TAGLINE} Enter your password to continue.');
  });
});
