import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, type, fakeClock, FakeEvent, type FakeElement } from './mini-dom';
import { mockForFile } from './scoped-mock';

// The shared password's sign-in page (app/login/page.tsx), used as a person
// would (react-dom/client over test/mini-dom.ts): a field with its label, a
// wrong password said under it, anything else that stops a sign-in in a
// notice, and no try left on "Checking…" when the server can't be reached.

const pushed: string[] = [];
const navigation = { ...(await import('next/navigation')) };
await mockForFile('next/navigation', () => ({ ...navigation, useRouter: () => ({ push: (to: string) => pushed.push(to), refresh: () => {} }) }));

const dom = installDom();
const realFetch = globalThis.fetch;
// What /api/login answers, per test: a response, or a fetch that fails.
let answer: () => Promise<Response> = () => new Promise(() => {});
const sent: unknown[] = [];
globalThis.fetch = ((_url: string, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body)));
  return answer();
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: LoginPage } = await import('@/app/login/page');

const pass = fakeClock();
const words = (e: FakeElement) => e.textContent.replace(/\s+/g, ' ').trim();

function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(<LoginPage />));
  const all = (tag: string) => host.findAll((e) => e.tagName === tag);
  return {
    host,
    field: () => all('INPUT')[0],
    button: () => all('BUTTON').find((b) => b.getAttribute('type') === 'submit'),
    errorUnder: () => host.findAll((e) => e.getAttribute('class') === 'field-error')[0],
    notice: () => host.findAll((e) => (e.getAttribute('class') ?? '').startsWith('notice'))[0],
    // Where a click leaves focus: on the button, not in the field (autoFocus puts it there).
    clickFocus: () => act(() => host.findAll((e) => e.tagName === 'BUTTON')[0].focus()),
    type: (value: string) => act(() => type(all('INPUT')[0], value)),
    submit: async () => {
      await act(async () => {
        all('FORM')[0].dispatchEvent(new FakeEvent('submit'));
      });
      await pass(20);
    },
  };
}

const respond = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('the password login', () => {
  test('its field has a visible label, and its one button says Sign in, as the rest of Nya does', () => {
    const page = mount();
    const label = page.field().parentNode as FakeElement;
    expect(label.tagName).toBe('LABEL');
    expect(label.getAttribute('class')).toBe('field');
    expect(words(label)).toBe('Password');
    expect(page.field().getAttribute('type')).toBe('password');
    expect(page.field().getAttribute('autoComplete')).toBe('current-password');
    expect(page.field().hasAttribute('placeholder')).toBe(false);
    expect(page.button()!.getAttribute('class')).toBe('btn btn-block');
    expect(words(page.button()!)).toBe('Sign in');
    expect(page.host.textContent).not.toContain('Log In');
  });

  test('a wrong password is said under the field, with what to do, as an alert, and focus goes back to it', async () => {
    const page = mount();
    answer = respond(401, { error: 'Incorrect password' });
    page.type('hunter2');
    page.clickFocus();
    expect(dom.document.activeElement).toBe(page.button());
    await page.submit();
    const error = page.errorUnder();
    expect(words(error)).toBe('That password isn’t right. Check it and try again.');
    expect((error.parentNode as FakeElement).getAttribute('role')).toBe('alert');
    expect(page.field().getAttribute('aria-invalid')).toBe('true');
    expect(page.field().getAttribute('aria-describedby')).toBe(error.getAttribute('id'));
    expect(page.notice()).toBeUndefined();
    expect(dom.document.activeElement).toBe(page.field());
    expect(words(page.button()!)).toBe('Sign in');
    // Typing again takes it away.
    page.type('hunter3');
    expect(page.errorUnder()).toBeUndefined();
    expect(page.field().hasAttribute('aria-invalid')).toBe(false);
  });

  test('too many tries, or a server that fails, in a critical notice with the server’s words, the field left as it is', async () => {
    const page = mount();
    answer = respond(429, { error: 'Too many attempts. Try again in a few minutes.' });
    page.type('hunter2');
    await page.submit();
    expect(page.notice().getAttribute('class')).toBe('notice critical');
    expect(page.notice().getAttribute('role')).toBe('alert');
    expect(words(page.notice())).toBe('Critical: Too many attempts. Try again in a few minutes.');
    expect(page.errorUnder()).toBeUndefined();
    expect(page.field().hasAttribute('aria-invalid')).toBe(false);
  });

  test('a server that fails with no words of its own: the notice says what to do', async () => {
    const page = mount();
    answer = () => Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 }));
    page.type('hunter2');
    await page.submit();
    expect(words(page.notice())).toBe('Critical: Nya couldn’t sign you in just now. Try again.');
    expect(page.errorUnder()).toBeUndefined();
  });

  test('no connection: said so, and the button is back, not left on Checking…', async () => {
    const page = mount();
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    page.type('hunter2');
    page.clickFocus();
    await page.submit();
    expect(words(page.notice())).toBe('Critical: Nya couldn’t be reached. Check your connection and try again.');
    expect(words(page.button()!)).toBe('Sign in');
    expect(page.button()!.disabled).toBe(false);
    expect(dom.document.activeElement).toBe(page.field());
  });

  test('accepted: Home, with the app loading in its place; if it never opens, the form again, saying so', async () => {
    pushed.length = 0;
    sent.length = 0;
    const page = mount();
    answer = respond(200, { success: true });
    page.type('hunter2');
    await page.submit();
    expect(sent).toEqual([{ password: 'hunter2' }]);
    expect(pushed).toEqual(['/']);
    expect(page.field()).toBeUndefined();
    expect(page.host.findAll((e) => e.getAttribute('aria-busy') === 'true').length).toBeGreaterThan(0);
    await pass(12_000);
    expect(words(page.notice())).toBe('Critical: Nya didn’t open. Try again, or reload the page.');
    expect(page.field()).toBeDefined();
  });
});
