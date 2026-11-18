import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, type FakeElement } from './mini-dom';
import { mockForFile } from './scoped-mock';

// Settings > Account (components/AccountSettings.tsx, look and feel step 2c),
// used as a person would (react-dom/client over test/mini-dom.ts). With
// Clerk on, Manage account opens Clerk's account window with Nya's Data &
// privacy page (components/ProfileWindow.tsx); Clerk is stubbed, and what its
// window does with the page (draw it into an element, take it away) is played
// back here. The avatar menu's window carries the same page
// (test/clerk-account-view.test.tsx). A shared demo account shows no email
// and no Manage account, as the server says (app/api/demo/me, stubbed here).

type Page = { label: string; url: string; mount: (el: HTMLDivElement) => void; unmount: () => void; mountIcon: (el: HTMLDivElement) => void; unmountIcon: () => void };
const opened: { customPages: Page[] }[] = [];
// Who Clerk says is signed in, as its useUser() answers: set per test.
type User = { id: string; fullName: string | null; username: string | null; imageUrl: string; primaryEmailAddress: { emailAddress: string } | null };
const FUE: User = { id: 'user_fue', fullName: 'Fue', username: 'fue', imageUrl: 'https://img.clerk.test/fue.png', primaryEmailAddress: { emailAddress: 'fue@example.com' } };
let signedIn: { isLoaded: boolean; user: User | null } = { isLoaded: true, user: FUE };
await mockForFile('@clerk/nextjs', () => ({
  useClerk: () => ({ openUserProfile: (p: { customPages: Page[] }) => opened.push(p), signOut: async () => {}, addListener: () => () => {} }),
  useUser: () => signedIn,
  UserButton: Object.assign(({ children }: { children: unknown }) => children, {
    MenuItems: () => null,
    Action: () => null,
    UserProfilePage: () => null,
  }),
}));

const dom = installDom();
// DeleteAccount asks whether this account can be deleted: unless a test
// answers, it never hears. Whether the account is a demo (app/api/demo/me)
// is answered for whoever is signed in, from `demos`, unless a test says
// otherwise.
const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Promise<Response> = () => new Promise(() => {});
let demos = new Set<string>();
const demoServer = async () => {
  const user = signedIn.user?.id;
  return user ? Response.json({ user, demo: demos.has(user) }) : Response.json({ error: 'Not signed in.' }, { status: 401 });
};
let demoAnswer: () => Promise<Response> = demoServer;
globalThis.fetch = ((url: string, init?: RequestInit) => (url === '/api/demo/me' ? demoAnswer() : answer(url, init))) as typeof fetch;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: AccountSettings, ACCOUNT_UNSURE, DEMO_ACCOUNT_LINE } = await import('@/components/AccountSettings');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  signedIn = { isLoaded: true, user: FUE };
  demos = new Set();
  demoAnswer = demoServer;
});

function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  return {
    host,
    button: (label: string) => host.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label)[0],
    unmount: () => act(() => root.unmount()),
  };
}

describe('Settings > Account', () => {
  test('with Clerk, Manage account opens Clerk’s window with the Data & privacy page, drawn where Clerk puts it', async () => {
    opened.length = 0;
    const v = mount(<AccountSettings clerk clearDevice={() => {}} onSignOut={() => {}} onSignOutEverywhere={() => {}} />);
    await settle();
    // Sign out is the account menu's alone: the card says where.
    expect(v.button('Sign out')).toBeUndefined();
    expect(v.host.textContent).toContain('Sign out is in the account menu');
    act(() => click(v.button('Manage account')));
    expect(opened).toHaveLength(1);
    const [page] = opened[0].customPages;
    expect({ label: page.label, url: page.url }).toEqual({ label: 'Data & privacy', url: 'data' });
    // Clerk shows the page: it is drawn into Clerk's element, icon and all.
    const el = dom.document.createElement('div');
    const icon = dom.document.createElement('div');
    act(() => page.mount(el as unknown as HTMLDivElement));
    act(() => page.mountIcon(icon as unknown as HTMLDivElement));
    // While it reads whether the account can be deleted: the page's skeleton (components/LoadingSkeletons.tsx), said once.
    expect(el.findAll((e: FakeElement) => e.getAttribute('role') === 'status').map((e: FakeElement) => e.textContent)).toEqual(['Loading']);
    expect(el.findAll((e: FakeElement) => e.getAttribute('aria-busy') === 'true')).toHaveLength(1);
    expect(icon.findAll((e: FakeElement) => e.tagName === 'svg' || e.tagName === 'SVG')).toHaveLength(1);
    // And gone again when Clerk takes it away.
    act(() => page.unmount());
    act(() => page.unmountIcon());
    expect(el.findAll(() => true)).toHaveLength(0);
    expect(icon.findAll(() => true)).toHaveLength(0);
    v.unmount();
  });

  test('deleting the account from there clears what this device keeps first, as from the menu', async () => {
    opened.length = 0;
    const asked: string[] = [];
    answer = async (url, init) => {
      asked.push(`${init?.method ?? 'GET'} ${url}`);
      return Response.json(init?.method === 'DELETE' ? {} : { enabled: true, can_delete: true });
    };
    const cleared: string[] = [];
    const v = mount(<AccountSettings clerk clearDevice={() => cleared.push('device')} onSignOut={() => {}} onSignOutEverywhere={() => {}} />);
    await settle();
    act(() => click(v.button('Manage account')));
    const el = dom.document.createElement('div');
    act(() => opened[0].customPages[0].mount(el as unknown as HTMLDivElement));
    await settle();
    act(() => type(el.findAll((e: FakeElement) => e.getAttribute('aria-label') === 'Type DELETE to confirm')[0], 'DELETE'));
    act(() => click(el.findAll((e: FakeElement) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'danger-outline')[0]));
    await settle();
    expect(asked).toEqual(['GET /api/account', 'DELETE /api/account']);
    expect(cleared).toEqual(['device']);
    answer = () => new Promise(() => {});
    v.unmount();
  });

  // The card as it is drawn for a user, once the server has answered.
  const card = async (u: User | null, isLoaded = true) => {
    signedIn = { isLoaded, user: u };
    const v = mount(<AccountSettings clerk clearDevice={() => {}} onSignOut={() => {}} onSignOutEverywhere={() => {}} />);
    await settle();
    const list = v.host.findAll((e: FakeElement) => e.tagName === 'UL' && e.getAttribute('aria-label') === 'Signed in as')[0];
    const out = {
      list: !!list,
      title: list?.findAll((e: FakeElement) => e.getAttribute('class') === 'list-row-title')[0]?.textContent ?? null,
      sub: list?.findAll((e: FakeElement) => e.getAttribute('class') === 'list-row-sub')[0]?.textContent ?? null,
      img: list?.findAll((e: FakeElement) => e.tagName === 'IMG')[0]?.getAttribute('src') ?? null,
      skeleton: v.host.findAll((e: FakeElement) => (e.getAttribute('class') ?? '').split(' ').includes('skeleton')).length,
      // It comes before Manage account, inside the one card.
      first: (v.host.findAll((e: FakeElement) => e.getAttribute('class') === 'card stack')[0]?.childNodes[0] as FakeElement | undefined)?.tagName ?? null,
      manage: !!v.button('Manage account'),
      text: v.host.textContent,
      notices: v.host.findAll((e: FakeElement) => (e.getAttribute('class') ?? '').startsWith('notice ')).map((e: FakeElement) => e.getAttribute('class') ?? ''),
    };
    v.unmount();
    return out;
  };
  const ALEX: User = { id: 'user_rivera', fullName: 'Alex Rivera', username: 'alex', imageUrl: 'https://img.clerk.test/alex.png', primaryEmailAddress: { emailAddress: 'alex@example.com' } };

  test('who is signed in, in place above Manage account: picture, name, and the email when it isn’t the name', async () => {
    expect(await card(ALEX)).toMatchObject({ list: true, title: 'Alex Rivera', sub: 'alex@example.com', img: 'https://img.clerk.test/alex.png', skeleton: 0, first: 'UL', manage: true, notices: [] });
    expect((await card(ALEX)).text).not.toContain(DEMO_ACCOUNT_LINE);
    // No full name: the username; neither: the email, said once.
    expect(await card({ ...ALEX, fullName: null })).toMatchObject({ title: 'alex', sub: 'alex@example.com' });
    expect(await card({ ...ALEX, fullName: null, username: null })).toMatchObject({ title: 'alex@example.com', sub: null });
    // While Clerk loads: one row of placeholders where it will be, and no
    // Manage account until the server has said it isn't a demo account;
    // nothing without a user.
    expect(await card(null, false)).toMatchObject({ list: false, skeleton: 3, manage: false });
    expect(await card(null)).toMatchObject({ list: false, skeleton: 0, first: 'P', manage: false });
  });

  test('a demo account: its picture and name, never its email, no Manage account, and that it’s a demo that can’t be deleted', async () => {
    demos = new Set([ALEX.id]);
    expect(await card(ALEX)).toMatchObject({ list: true, title: 'Alex Rivera', sub: null, img: 'https://img.clerk.test/alex.png', skeleton: 0, manage: false, notices: [] });
    expect((await card(ALEX)).text).toContain(DEMO_ACCOUNT_LINE);
    // With no name, no row at all, rather than the email in its place.
    const nameless = await card({ ...ALEX, fullName: null, username: null });
    expect(nameless).toMatchObject({ list: false, manage: false });
    for (const u of [ALEX, { ...ALEX, fullName: null, username: null }]) expect((await card(u)).text).not.toContain('alex@example.com');
  });

  test('until the server answers, placeholders and no Manage account, so a demo account never shows either first', async () => {
    demos = new Set([ALEX.id]);
    demoAnswer = () => new Promise(() => {});
    expect(await card(ALEX)).toMatchObject({ list: false, skeleton: 3, manage: false });
    expect((await card(ALEX)).text).not.toContain('alex@example.com');
  });

  test('when the server can’t say, or answers for another account: no email and no Manage account, and the card says to load the page again', async () => {
    const failures: [string, () => Promise<Response>][] = [
      ['an error', async () => Response.json({ error: 'Something went wrong.' }, { status: 500 })],
      ['no network', async () => Promise.reject(new Error('offline'))],
      ['another account', async () => Response.json({ user: 'user_someone_else', demo: false })],
    ];
    for (const [why, fails] of failures) {
      demoAnswer = fails;
      const out = await card(ALEX);
      expect({ why, sub: out.sub as string | null, manage: out.manage, notices: out.notices, demo: out.text.includes(DEMO_ACCOUNT_LINE) }).toEqual({ why, sub: null, manage: false, notices: ['notice caution'], demo: false });
      expect(out.text).toContain(ACCOUNT_UNSURE);
      expect(out.text).not.toContain('alex@example.com');
    }
  });

  test('in password mode, Sign out and Sign out everywhere, and no Manage account', () => {
    const calls: string[] = [];
    const v = mount(<AccountSettings clerk={false} clearDevice={() => {}} onSignOut={() => calls.push('out')} onSignOutEverywhere={() => calls.push('everywhere')} />);
    expect(v.button('Manage account')).toBeUndefined();
    act(() => click(v.button('Sign out')));
    act(() => click(v.button('Sign out everywhere')));
    expect(calls).toEqual(['out', 'everywhere']);
    v.unmount();
  });
});
