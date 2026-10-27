import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, FakeElement } from './mini-dom';

// Shared with me is read only once it is on screen (components/Sharing.tsx
// SharedWithMe: each read counts as a showing in the sharer's record). Until
// that read answers, its place is held with a skeleton, but only on a device
// whose last good read had something shared: nobody else sees it come and go.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { SharedWithMe, rememberShares } = await import('@/components/Sharing');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as { fetch: typeof fetch };
const realFetch = g.fetch;
afterAll(() => {
  g.fetch = realFetch;
});

/** Mounts it for `viewer`, its read held until `answer` is called. */
async function mount(viewer: string) {
  let answer: (body: unknown) => void = () => {};
  g.fetch = (() => new Promise<Response>((resolve) => (answer = (body) => resolve(new Response(JSON.stringify(body), { status: 200 }))))) as unknown as typeof fetch;
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(<SharedWithMe viewer={viewer} refreshKey="k" />));
  const el = host as unknown as FakeElement;
  const statuses = () => el.findAll((e) => e.getAttribute('role') === 'status').map((e) => e.textContent);
  return {
    statuses,
    busy: () => el.findAll((e) => e.getAttribute('aria-busy') === 'true').length,
    text: () => el.textContent,
    answer: async (body: unknown) => {
      await act(async () => {
        answer(body);
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe('Shared with me while it is read', () => {
  test('on a device whose last read had shares: its place held, said once, until the cards come', async () => {
    rememberShares('user_seen', true);
    const v = await mount('user_seen');
    expect(v.busy()).toBe(1);
    expect(v.statuses()).toEqual(['Loading what is shared with you']);
    await v.answer({ shared: [{ connection: 'c1', label: 'Sam', accounts: [], expires_at: null }] });
    expect(v.busy()).toBe(0);
    expect(v.text()).toContain('Shared by Sam');
    v.unmount();
  });

  test('on a device that never saw any: nothing held, and nothing drawn when nothing is shared', async () => {
    const v = await mount('user_new');
    expect(v.busy()).toBe(0);
    expect(v.text()).toBe('');
    await v.answer({ shared: [] });
    expect(v.text()).toBe('');
    v.unmount();
  });

  test('held, and then nothing shared after all: the place goes', async () => {
    rememberShares('user_ended', true);
    const v = await mount('user_ended');
    expect(v.busy()).toBe(1);
    await v.answer({ shared: [] });
    expect(v.busy()).toBe(0);
    expect(v.text()).toBe('');
    v.unmount();
  });
});
