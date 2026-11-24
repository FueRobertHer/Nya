import { afterAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDom, trackRoots, click, type FakeElement } from './mini-dom';

// Plaid Link's launcher (components/PlaidLinkHandler.tsx): opened once its
// token is ready, the dashboard told when Link says it opened, and when
// Plaid's window can't open (its script failed to load, or Link never said
// OPEN within PLAID_OPEN_TIMEOUT_MS) told once, so the button that started
// it doesn't seem to do nothing. Until one or the other, that button keeps
// saying "Starting…" (useLinkStarting). Plaid's hook is stood in for: what
// it reports is set by each test.

const dom = installDom();
afterAll(() => dom.uninstall());

type Config = { token: string | null; onEvent: (name: string, meta: unknown) => void; onExit: (err: null, meta: unknown) => void };
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
const { default: PlaidLinkHandler, PLAID_OPEN_TIMEOUT_MS, useLinkStarting } = await import('@/components/PlaidLinkHandler');
const { default: ConnectButtons } = await import('@/components/ConnectButtons');

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
          onOpen={(opened) => said.push(`open ${opened}`)}
          onUnavailable={() => said.push(`unavailable ${token}`)}
          exitRef={{ current: () => {} }}
          openRef={{ current: false }}
        />
      )
    );
  return { said, render, unmount: () => act(() => root.unmount()) };
}

describe('Plaid’s window', () => {
  test('opens once ready, says when Link has opened, and nothing more after', () => {
    hook.ready = true;
    hook.error = null;
    hook.opened = 0;
    const v = mount();
    v.render('link-1');
    expect(hook.opened).toBe(1);
    // Link's other events are not its opening.
    act(() => hook.config!.onEvent('TRANSITION_VIEW', {}));
    expect(v.said).toEqual([]);
    act(() => hook.config!.onEvent('OPEN', {}));
    expect(v.said).toEqual(['open link-1']);
    v.unmount();
    expect(v.said).toEqual(['open link-1']);
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

/** The dashboard's wiring, small (components/Dashboard.tsx): a press fetches
 *  a token (`connecting` meanwhile), Link is given it, and the buttons get
 *  useLinkStarting's busy state. `api` stands in for the token's arrival. */
function Wired({ api }: { api: { tokenIn?: (token: string) => void } }) {
  const [connecting, setConnecting] = React.useState(false);
  const [token, setToken] = React.useState<string | null>(null);
  const { starting, onOpen } = useLinkStarting(connecting, token);
  api.tokenIn = (t) => {
    setToken(t);
    setConnecting(false);
  };
  return (
    <>
      <PlaidLinkHandler
        token={token}
        onSuccess={() => {}}
        onEvent={() => {}}
        onExit={() => setToken(null)}
        onOpen={onOpen}
        onUnavailable={() => setToken(null)}
        exitRef={{ current: () => {} }}
        openRef={{ current: false }}
      />
      <ConnectButtons connecting={starting} onConnect={() => setConnecting(true)} brokerage={false} />
    </>
  );
}

function mountWired() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const api: { tokenIn?: (token: string) => void } = {};
  act(() => root.render(<Wired api={api} />));
  const button = () => (host as unknown as FakeElement).findAll((e) => e.tagName === 'BUTTON')[0];
  const shown = () => ({ label: button().textContent, held: button().getAttribute('disabled') !== null });
  return {
    shown,
    press: () => act(() => click(button())),
    tokenIn: (token: string) => act(() => api.tokenIn!(token)),
    unmount: () => act(() => root.unmount()),
  };
}

describe('the button that started it', () => {
  const free = { label: 'Connect a bank or card', held: false };
  const busy = { label: 'Starting…', held: true };

  test('keeps saying Starting… after the token is in, until Link says it opened', () => {
    hook.ready = true;
    hook.error = null;
    hook.opened = 0;
    const v = mountWired();
    expect(v.shown()).toEqual(free);
    v.press();
    expect(v.shown()).toEqual(busy);
    v.tokenIn('link-4');
    expect(hook.opened).toBe(1);
    expect(v.shown()).toEqual(busy);
    act(() => hook.config!.onEvent('OPEN', {}));
    expect(v.shown()).toEqual(free);
    // Link closed, and a second connection started: its own token starts
    // unopened, and holds the button again until its own OPEN.
    act(() => hook.config!.onExit(null, {}));
    v.press();
    v.tokenIn('link-5');
    expect(v.shown()).toEqual(busy);
    act(() => hook.config!.onEvent('OPEN', {}));
    expect(v.shown()).toEqual(free);
    v.unmount();
  });

  test('comes back when Link is given up on, or exits before it opened', () => {
    hook.ready = true;
    hook.error = null;
    const real = globalThis.setTimeout;
    const waits: { fn: () => void; ms: number }[] = [];
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      waits.push({ fn, ms });
      return waits.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    try {
      const v = mountWired();
      v.press();
      v.tokenIn('link-6');
      expect(v.shown()).toEqual(busy);
      act(() => waits.findLast((w) => w.ms === PLAID_OPEN_TIMEOUT_MS)!.fn());
      expect(v.shown()).toEqual(free);
      v.press();
      v.tokenIn('link-7');
      expect(v.shown()).toEqual(busy);
      act(() => hook.config!.onExit(null, {}));
      expect(v.shown()).toEqual(free);
      v.unmount();
    } finally {
      globalThis.setTimeout = real;
    }
  });

  // Read from the source, as test/connect-buttons-view.test.tsx does: the
  // dashboard needs Clerk and Plaid Link to render.
  test('every Plaid button on the dashboard is given the held state, and Link its onOpen', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain('const { starting: linkStarting, onOpen: onLinkOpen } = useLinkStarting(connecting, linkToken);');
    expect(dashboard).toContain('onOpen={onLinkOpen}');
    // The connect buttons, the Add account sheet, Reconnect and the account
    // pickers on each connection, and the duplicate redirect's choices.
    expect(dashboard.match(/connecting=\{linkStarting\}/g)?.length).toBe(5);
    expect(dashboard).not.toContain('connecting={connecting}');
  });
});
