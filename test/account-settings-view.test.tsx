import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, type FakeElement } from './mini-dom';
import { mockForFile } from './scoped-mock';

// Settings > Account (components/AccountSettings.tsx, look and feel step 2c),
// used as a person would (react-dom/client over test/mini-dom.ts). With
// Clerk on, Manage account opens Clerk's account window with Nya's Data &
// privacy page (components/ProfileWindow.tsx); Clerk is stubbed, and what its
// window does with the page (draw it into an element, take it away) is played
// back here. The avatar menu's window carries the same page.

type Page = { label: string; url: string; mount: (el: HTMLDivElement) => void; unmount: () => void; mountIcon: (el: HTMLDivElement) => void; unmountIcon: () => void };
const opened: { customPages: Page[] }[] = [];
const menuPages: { label: string; url: string }[] = [];
await mockForFile('@clerk/nextjs', () => ({
  useClerk: () => ({ openUserProfile: (p: { customPages: Page[] }) => opened.push(p), signOut: async () => {}, addListener: () => () => {} }),
  UserButton: Object.assign(({ children }: { children: unknown }) => children, {
    MenuItems: () => null,
    Action: () => null,
    UserProfilePage: ({ label, url }: { label: string; url: string }) => {
      menuPages.push({ label, url });
      return null;
    },
  }),
}));

const dom = installDom();
// DeleteAccount asks whether this account can be deleted: unless a test
// answers, it never hears.
const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Promise<Response> = () => new Promise(() => {});
globalThis.fetch = ((url: string, init?: RequestInit) => answer(url, init)) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: AccountSettings } = await import('@/components/AccountSettings');
const { default: ClerkAccount } = await import('@/components/ClerkAccount');
const { DATA_PAGE } = await import('@/components/ProfileWindow');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  test('with Clerk, Manage account opens Clerk’s window with the Data & privacy page, drawn where Clerk puts it', () => {
    opened.length = 0;
    const v = mount(<AccountSettings clerk clearDevice={() => {}} onSignOut={() => {}} onSignOutEverywhere={() => {}} />);
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
    expect(el.findAll((e: FakeElement) => e.getAttribute('role') === 'status' && e.getAttribute('aria-label') === 'Loading')).toHaveLength(1);
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
    act(() => click(v.button('Manage account')));
    const el = dom.document.createElement('div');
    const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));
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

  test('the avatar menu’s window carries the same page', () => {
    menuPages.length = 0;
    const v = mount(<ClerkAccount clearDevice={() => {}} onOpenSettings={() => {}} onOpenSharing={() => {}} />);
    expect(menuPages).toEqual([{ ...DATA_PAGE }]);
    v.unmount();
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
