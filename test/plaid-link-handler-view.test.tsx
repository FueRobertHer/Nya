import { afterAll, describe, expect, mock, test } from 'bun:test';
import { installDom, trackRoots } from './mini-dom';

// Plaid Link's launcher (components/PlaidLinkHandler.tsx): opened once its
// token is ready, and when Plaid's window can't open (its script failed to
// load, or Link never said OPEN within PLAID_OPEN_TIMEOUT_MS) the dashboard
// is told once, so the button that started it doesn't seem to do nothing.
// Plaid's hook is stood in for: what it reports is set by each test.

const dom = installDom();
afterAll(() => dom.uninstall());

type Config = { token: string | null; onEvent: (name: string, meta: unknown) => void };
const hook = { ready: false, error: null as Error | null, opened: 0, config: null as Config | null };
mock.module('react-plaid-link', () => ({
  usePlaidLink: (config: Config) => {
    hook.config = config;
    return { open: () => void (hook.opened += 1), exit: () => {}, ready: hook.ready, error: hook.error };
  },
}));

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: PlaidLinkHandler, PLAID_OPEN_TIMEOUT_MS } = await import('@/components/PlaidLinkHandler');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const said: string[] = [];
  const render = (token: string | null) =>
    act(() =>
      root.render(
        <PlaidLinkHandler
          token={token}
          onSuccess={() => {}}
          onEvent={() => {}}
          onExit={() => {}}
          onUnavailable={() => said.push(`unavailable ${token}`)}
          exitRef={{ current: () => {} }}
          openRef={{ current: false }}
        />
      )
    );
  return { said, render, unmount: () => act(() => root.unmount()) };
}

describe('Plaid’s window', () => {
  test('opens once ready, and says nothing more once Link has opened', () => {
    hook.ready = true;
    hook.error = null;
    hook.opened = 0;
    const v = mount();
    v.render('link-1');
    expect(hook.opened).toBe(1);
    act(() => hook.config!.onEvent('OPEN', {}));
    v.unmount();
    expect(v.said).toEqual([]);
  });

  test('a script that failed to load is said at once, once for its token', () => {
    hook.ready = false;
    hook.error = new Error('script failed');
    const v = mount();
    v.render('link-2');
    v.render('link-2');
    expect(v.said).toEqual(['unavailable link-2']);
    v.unmount();
  });

  test('Link that never says it opened is said after the wait, and not for a token taken back before it', () => {
    hook.ready = true;
    hook.error = null;
    const real = globalThis.setTimeout;
    const waits: { fn: () => void; ms: number }[] = [];
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      waits.push({ fn, ms });
      return waits.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    try {
      const v = mount();
      v.render('link-3');
      const wait = waits.find((w) => w.ms === PLAID_OPEN_TIMEOUT_MS)!;
      expect(wait).toBeDefined();
      act(() => wait.fn());
      expect(v.said).toEqual(['unavailable link-3']);
      // Closed before then (no token): nothing waits.
      waits.length = 0;
      v.render(null);
      expect(waits.filter((w) => w.ms === PLAID_OPEN_TIMEOUT_MS)).toEqual([]);
      v.unmount();
    } finally {
      globalThis.setTimeout = real;
    }
    expect(PLAID_OPEN_TIMEOUT_MS).toBe(30_000);
  });
});
