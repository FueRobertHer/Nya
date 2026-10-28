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
const { DEFAULT_SCENARIO, SCENARIOS, demoHolds } = await import('@/lib/demo-seed/scenarios');
const { TAGLINE } = await import('@/lib/tagline');

// The sign-in page's first screen (app/sign-in, components/DemoSignIn.tsx):
// one line on what Nya is, then the demo accounts as tonal buttons that say
// what each is set up to hold, so Clerk's Continue is the one filled button.
// The flow itself (a form per account, posted, or signed in in place) is
// test/demo-sign-in.test.ts's and test/sign-in-flow-view.test.tsx's.

const demos = [
  { id: 'user_alex', label: 'Alex', holds: demoHolds('Alex') },
  { id: 'user_sam', label: 'Sam', holds: demoHolds('Sam') },
];
const html = (unavailable = false) => renderToStaticMarkup(<DemoSignIn demos={demos} unavailable={unavailable} />);
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the demo card', () => {
  test('a form per account, in order, posting its id as before', () => {
    const forms = [...html().matchAll(/<form action="\/api\/demo\/sign-in" method="post"><input type="hidden" name="user" value="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(forms).toEqual(['user_alex', 'user_sam']);
  });

  test('each button tonal, never filled, saying its name and then what it holds, apart when spoken', () => {
    const buttons = [...html().matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
    expect(buttons).toHaveLength(2);
    for (const [, attrs] of buttons) expect(attrs).toContain('class="btn secondary btn-block demo-account"');
    expect(buttons[0][2]).toBe(
      `<span class="list-row-text"><span class="list-row-title">Alex</span><span class="list-row-sub"><span class="visually-hidden">, </span>${demos[0].holds}</span></span>`
    );
    expect(buttons[1][2]).toContain(`<span class="list-row-title">Sam</span>`);
  });

  test('what each holds is its default scenario’s, a few words without dashes', () => {
    for (const name of ['Alex', 'Sam'] as const) {
      const scenario = SCENARIOS.find((s) => s.id === DEFAULT_SCENARIO[name])!;
      expect(demoHolds(name)).toBe(scenario.holds);
      expect(scenario.holds.length).toBeGreaterThan(0);
      // One line under the name on a 320px phone (measured there).
      expect(scenario.holds.length).toBeLessThanOrEqual(34);
      expect(scenario.holds).not.toMatch(/[\u2013\u2014]/);
    }
    expect(demoHolds('Someone else')).toBe('');
  });

  test('keeps its warning that the accounts are shared, word for word', () => {
    expect(html()).toContain(
      'Sign in as a demo account, with pretend banks from Plaid&#x27;s sandbox. Everyone who tries it shares these\n          accounts, so anything you add is visible to others.'.replace(/\s+/g, ' ')
    );
  });

  test('a demo that couldn’t sign in says so, as an alert', () => {
    expect(html()).not.toContain('role="alert"');
    expect(html(true)).toContain(`<p class="error" role="alert">${DEMO_UNAVAILABLE}</p>`);
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

  test('the password login says the same line', () => {
    expect(source('app/login/page.tsx')).toContain('{TAGLINE} Enter your password to continue.');
  });
});
