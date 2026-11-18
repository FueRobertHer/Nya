import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, FakeEvent, type FakeElement } from './mini-dom';
import { mockForFile } from './scoped-mock';

// The account menu with Clerk on (components/ClerkAccount.tsx), used as a
// person would (react-dom/client over test/mini-dom.ts). A real account gets
// Clerk's button, with its account window and Nya's Data & privacy page. A
// shared demo account never does: Clerk's menu shows the email and its
// window every visitor's device with its address. It gets Nya's own menu
// (Settings, Sharing, Sign out), and so does an account the server couldn't
// answer for. Clerk is stubbed, and so is the server's answer
// (app/api/demo/me).

// What Clerk was asked to draw: its button, and the pages added to its window.
const drawn: { userButton: number; pages: { label: string; url: string }[] } = { userButton: 0, pages: [] };
const calls: string[] = [];
type User = { id: string; fullName: string | null; imageUrl: string; primaryEmailAddress: { emailAddress: string } | null };
let signedIn: { isLoaded: boolean; user: User | null } = { isLoaded: true, user: null };
await mockForFile('@clerk/nextjs', () => ({
  useClerk: () => ({
    addListener: () => () => {},
    signOut: async () => {
      calls.push('signOut');
    },
    openUserProfile: () => calls.push('openUserProfile'),
  }),
  useUser: () => signedIn,
  UserButton: Object.assign(
    ({ children }: { children: unknown }) => {
      drawn.userButton++;
      return children;
    },
    {
      MenuItems: () => null,
      Action: () => null,
      UserProfilePage: ({ label, url }: { label: string; url: string }) => {
        drawn.pages.push({ label, url });
        return null;
      },
    }
  ),
}));

const dom = installDom();
// The server's answer to app/api/demo/me: set per test. Each ask is kept,
// with a way to answer it later.
const realFetch = globalThis.fetch;
type Ask = { url: string; answer: (res: Response | Error) => void };
let asks: Ask[] = [];
let respond: ((url: string) => Response | Error) | null = null;
globalThis.fetch = ((url: string) =>
  new Promise<Response>((resolve, reject) => {
    const answer = (res: Response | Error) => (res instanceof Error ? reject(res) : resolve(res));
    asks.push({ url, answer });
    if (respond) answer(respond(url));
  })) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: ClerkAccount } = await import('@/components/ClerkAccount');
const { DATA_PAGE } = await import('@/components/ProfileWindow');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALEX: User = { id: 'user_alex', fullName: 'Alex Rivera', imageUrl: 'https://img.clerk.test/alex.png', primaryEmailAddress: { emailAddress: 'alex.demo@example.com' } };
const FUE: User = { id: 'user_fue', fullName: 'Fue', imageUrl: 'https://img.clerk.test/fue.png', primaryEmailAddress: { emailAddress: 'fue@example.com' } };
const isDemo = (id: string) => id === ALEX.id;
/** The server's answer, for whoever is signed in now. */
const server = () => {
  const user = signedIn.user?.id;
  return user ? Response.json({ user, demo: isDemo(user) }) : Response.json({ error: 'Not signed in.' }, { status: 401 });
};
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));

beforeEach(() => {
  drawn.userButton = 0;
  drawn.pages = [];
  calls.length = 0;
  asks = [];
  respond = server;
  signedIn = { isLoaded: true, user: null };
});

function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const props = {
    clearDevice: () => calls.push('clearDevice'),
    onOpenSettings: () => calls.push('settings'),
    onOpenSharing: () => calls.push('sharing'),
  };
  const render = () => act(() => root.render(<ClerkAccount {...props} />));
  render();
  const find = (test: (e: FakeElement) => boolean) => host.findAll(test);
  const trigger = () => find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-haspopup') === 'menu')[0];
  return {
    host,
    rerender: render,
    trigger,
    items: () => find((e) => e.getAttribute('role') === 'menuitem'),
    skeleton: () => find((e) => (e.getAttribute('class') ?? '').split(' ').includes('user-button-skeleton')).length,
    unmount: () => act(() => root.unmount()),
  };
}

const key = (el: FakeElement, k: string) => {
  const e = new FakeEvent('keydown');
  e.key = k;
  act(() => {
    el.dispatchEvent(e);
  });
};

describe('the account menu', () => {
  test('a real account gets Clerk’s button, its window carrying the Data & privacy page, once the server has said it isn’t a demo', async () => {
    signedIn = { isLoaded: true, user: FUE };
    const v = mount();
    await settle();
    expect(asks.map((a) => a.url)).toEqual(['/api/demo/me']);
    expect(drawn.userButton).toBeGreaterThan(0);
    expect(drawn.pages).toContainEqual({ ...DATA_PAGE });
    expect(v.trigger()).toBeUndefined();
    v.unmount();
  });

  test('a demo account never gets Clerk’s button: Nya’s menu, under its picture, with Settings, Sharing and Sign out, and no email', async () => {
    signedIn = { isLoaded: true, user: ALEX };
    const v = mount();
    await settle();
    expect(drawn).toEqual({ userButton: 0, pages: [] });
    const trigger = v.trigger();
    expect(trigger.getAttribute('aria-label')).toBe('Account');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // Its picture, as Clerk's button draws it; a 44px target (.icon-btn).
    expect(trigger.getAttribute('class')).toBe('icon-btn account-menu-btn');
    expect(trigger.findAll((e) => e.tagName === 'IMG').map((e) => [e.getAttribute('src'), e.getAttribute('alt')])).toEqual([[ALEX.imageUrl, '']]);
    // The first button in the slot, where Dashboard gives focus back to (avatarButton).
    expect(v.host.findAll((e) => e.tagName === 'BUTTON')[0]).toBe(trigger);
    act(() => click(trigger));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(v.items().map((e) => e.textContent)).toEqual(['Settings', 'Sharing', 'Sign out']);
    // Nothing of the sign-in: no email, no Manage account, no way to Clerk's window.
    expect(v.host.textContent).not.toContain(ALEX.primaryEmailAddress!.emailAddress);
    expect(v.host.textContent).not.toContain('Manage account');
    expect(v.host.textContent).not.toContain('Alex Rivera');
    act(() => click(v.items()[0]));
    expect(v.items()).toHaveLength(0);
    act(() => click(trigger));
    act(() => click(v.items()[1]));
    expect(calls).toEqual(['settings', 'sharing']);
    expect(calls).not.toContain('openUserProfile');
    v.unmount();
  });

  test('its Sign out clears what this device keeps, then signs out through Clerk', async () => {
    signedIn = { isLoaded: true, user: ALEX };
    const v = mount();
    await settle();
    act(() => click(v.trigger()));
    act(() => click(v.items()[2]));
    await settle();
    expect(calls).toEqual(['clearDevice', 'signOut']);
    v.unmount();
  });

  test('used from the keys: opens on its first item, moves with the arrows, and Escape gives focus back to the button', async () => {
    signedIn = { isLoaded: true, user: ALEX };
    const v = mount();
    await settle();
    const trigger = v.trigger();
    key(trigger, 'ArrowDown');
    const [settings, sharing, signOut] = v.items();
    expect(dom.document.activeElement).toBe(settings);
    key(settings, 'ArrowDown');
    expect(dom.document.activeElement).toBe(sharing);
    key(sharing, 'End');
    expect(dom.document.activeElement).toBe(signOut);
    key(signOut, 'ArrowDown');
    expect(dom.document.activeElement).toBe(settings);
    key(settings, 'Escape');
    expect(v.items()).toHaveLength(0);
    expect(dom.document.activeElement).toBe(trigger);
    v.unmount();
  });

  test('until the server answers, the circle the app loading drew, and neither menu', async () => {
    respond = null;
    signedIn = { isLoaded: true, user: ALEX };
    const v = mount();
    await settle();
    expect(v.skeleton()).toBe(1);
    expect(drawn.userButton).toBe(0);
    expect(v.trigger()).toBeUndefined();
    // And while Clerk loads, without asking.
    signedIn = { isLoaded: false, user: null };
    asks = [];
    const w = mount();
    await settle();
    expect(w.skeleton()).toBe(1);
    expect(asks).toEqual([]);
    v.unmount();
    w.unmount();
  });

  test('when the server can’t answer, or answers for another account, Nya’s menu: never Clerk’s for want of an answer', async () => {
    const failures: [string, () => Response | Error][] = [
      ['an error', () => Response.json({ error: 'Something went wrong.' }, { status: 500 })],
      ['no network', () => new Error('offline')],
      ['not JSON', () => new Response('<html>', { status: 200 })],
      ['another account', () => Response.json({ user: 'user_someone_else', demo: false })],
      ['no answer at all', () => Response.json({})],
    ];
    for (const [why, answer] of failures) {
      drawn.userButton = 0;
      respond = answer;
      signedIn = { isLoaded: true, user: FUE };
      const v = mount();
      await settle();
      expect({ why, userButton: drawn.userButton, menu: !!v.trigger() }).toEqual({ why, userButton: 0, menu: true });
      v.unmount();
    }
  });

  test('a change of account in place asks again, and an answer for the one before is never used', async () => {
    respond = null;
    signedIn = { isLoaded: true, user: FUE };
    const v = mount();
    // Fue's answer is still on its way when Alex, the demo, signs in in place.
    signedIn = { isLoaded: true, user: ALEX };
    v.rerender();
    expect(asks.map((a) => a.url)).toEqual(['/api/demo/me', '/api/demo/me']);
    // The late answer, for Fue, doesn't give Alex Clerk's button.
    act(() => asks[0].answer(Response.json({ user: FUE.id, demo: false })));
    await settle();
    expect(drawn.userButton).toBe(0);
    expect(v.skeleton()).toBe(1);
    act(() => asks[1].answer(Response.json({ user: ALEX.id, demo: true })));
    await settle();
    expect(drawn.userButton).toBe(0);
    expect(v.trigger()).toBeDefined();
    // And back to a real account: asked again, the circle meanwhile, then Clerk's.
    signedIn = { isLoaded: true, user: FUE };
    v.rerender();
    expect(v.skeleton()).toBe(1);
    expect(v.trigger()).toBeUndefined();
    act(() => asks[2].answer(Response.json({ user: FUE.id, demo: false })));
    await settle();
    expect(drawn.userButton).toBeGreaterThan(0);
    expect(v.trigger()).toBeUndefined();
    v.unmount();
  });
});
