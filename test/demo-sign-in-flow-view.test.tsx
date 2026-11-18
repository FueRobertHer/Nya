import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, fakeClock, FakeEvent, type FakeElement } from './mini-dom';
import { mockForFile } from './scoped-mock';

// The sign-in page's demo card in its frame (components/DemoSignIn.tsx in
// components/SignInFlow.tsx), used as a person would (react-dom/client over
// test/mini-dom.ts): a press hides the page under the app loading, and when
// the page comes back with nothing signed in, the card says why and focus
// goes to what it says, since the button pressed was hidden with the page.

// Clerk, loaded, whose sign-in with the route's ticket fails as a test says.
let signIn: () => Promise<{ status: string | null; createdSessionId: string | null }> = () => Promise.reject(new Error('ticket refused'));
await mockForFile('@clerk/nextjs', () => ({
  useClerk: () => ({ loaded: true, client: { signIn: { create: () => signIn() } }, setActive: async () => {} }),
}));

const dom = installDom();
const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ ticket: 'tkt_1' }), { status: 200 }))) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { SignInFlow } = await import('@/components/SignInFlow');
const { default: DemoSignIn } = await import('@/components/DemoSignIn');
const { DEMO_UNAVAILABLE } = await import('@/lib/demo');
const { DEMO_WAIT_MS } = await import('@/components/sign-in-view');

const pass = fakeClock();
const words = (e: FakeElement) => e.textContent.replace(/\s+/g, ' ').trim();
const demos = [
  { id: 'user_alex', label: 'Alex' },
  { id: 'user_sam', label: 'Sam' },
];

function mount(demoTicket = false, unavailable = false) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() =>
    root.render(
      <SignInFlow demoTicket={demoTicket}>
        <DemoSignIn demos={demos} unavailable={unavailable} />
      </SignInFlow>
    )
  );
  return {
    page: () => host.findAll((e) => e.tagName === 'MAIN' && e.getAttribute('class') === 'auth-wrap')[0],
    notice: () => host.findAll((e) => e.getAttribute('role') === 'alert')[0],
    button: (name: string) => host.findAll((e) => e.tagName === 'BUTTON').find((b) => words(b) === name)!,
    press: async (name: string) => {
      const form = host.findAll((e) => e.tagName === 'FORM').find((f) => words(f) === name)!;
      await act(async () => {
        form.dispatchEvent(new FakeEvent('submit'));
      });
    },
  };
}

describe('a demo sign-in that doesn’t open the app', () => {
  test('one that failed: the page again, the card saying why, and focus on what it says', async () => {
    const view = mount();
    await view.press('Alex');
    await pass(50);
    expect(view.page().hasAttribute('hidden')).toBe(false);
    const notice = view.notice();
    expect(words(notice)).toBe(`Critical: ${DEMO_UNAVAILABLE}`);
    expect(notice.getAttribute('tabindex')).toBe('-1');
    expect(dom.document.activeElement).toBe(notice);
  });

  test('one still on its way when the wait runs out: the page again, saying the app didn’t open, with focus there', async () => {
    signIn = () => new Promise(() => {});
    const view = mount();
    await view.press('Sam');
    await pass(50);
    expect(view.page().getAttribute('hidden')).toBe('');
    expect(view.notice()).toBeUndefined();
    await pass(DEMO_WAIT_MS);
    expect(view.page().hasAttribute('hidden')).toBe(false);
    expect(words(view.notice())).toBe('Critical: Nya didn’t open. Try again, or reload the page.');
    expect(dom.document.activeElement).toBe(view.notice());
    // A press again takes it away while it tries.
    await view.press('Sam');
    expect(view.notice()).toBeUndefined();
  });

  test('a demo ticket’s page that never signs in says the same after its wait', async () => {
    const view = mount(true);
    expect(view.page().getAttribute('hidden')).toBe('');
    await pass(DEMO_WAIT_MS);
    expect(words(view.notice())).toBe('Critical: Nya didn’t open. Try again, or reload the page.');
    expect(dom.document.activeElement).toBe(view.notice());
  });

  test('a failure said once the page is back is read in place: focus stays where the person put it', async () => {
    let fail: (e: Error) => void = () => {};
    signIn = () => new Promise((_, reject) => (fail = reject));
    const view = mount();
    await view.press('Alex');
    await pass(DEMO_WAIT_MS);
    expect(dom.document.activeElement).toBe(view.notice());
    act(() => view.button('Sam').focus());
    await act(async () => fail(new Error('ticket refused')));
    await pass(50);
    expect(words(view.notice())).toBe(`Critical: ${DEMO_UNAVAILABLE}`);
    expect(dom.document.activeElement).toBe(view.button('Sam'));
  });
});

describe('a demo card that says something as the page loads', () => {
  test('the demo unavailable (?demo=unavailable): said, and focus left alone, since nothing was hidden', async () => {
    const before = dom.document.activeElement;
    const view = mount(false, true);
    await pass(50);
    expect(words(view.notice())).toBe(`Critical: ${DEMO_UNAVAILABLE}`);
    expect(dom.document.activeElement).toBe(before);
  });
});
