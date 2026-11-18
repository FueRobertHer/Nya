import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, type FakeElement } from './mini-dom';

// The sheet that chooses a home currency (components/CurrencyChoiceSheet.tsx),
// used as a person would (react-dom/client over test/mini-dom.ts), for what it
// shows after Save (docs/design/guidelines.md#after-save): with a manual
// account's typed transactions moved, a done notice saying what moved, with
// focus on it and no Undo (a move has none, as its offer says); with nothing
// moved, it closes on the totals that show the choice. Its buttons, and a
// refusal, in the sheet's footer.

const dom = installDom();
type Sent = { url: string; method: string; body: unknown };
const sent: Sent[] = [];
const VIEW = {
  home: 'EUR',
  own: [],
  problem: null,
  removable: false,
  ecb: { date: '2026-11-17', rates: { USD: '1.1551', GBP: '0.85598' }, stale: false, fetch_ok: true },
};
let patch: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({ relabelled: { moved: 3, kept: 1 } }) });
let put: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({}) });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? 'GET';
  sent.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
  if (url === '/api/currency' && method === 'GET') return { ok: true, status: 200, json: async () => VIEW };
  if (url === '/api/currency' && method === 'PUT') return put();
  if (url.startsWith('/api/manual-accounts?')) return { ok: true, status: 200, json: async () => ({ relabel: { moved: 3, kept: 1 } }) };
  if (url === '/api/manual-accounts' && method === 'PATCH') return patch();
  return { ok: false, status: 404, json: async () => ({}) };
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: CurrencyChoiceSheet } = await import('@/components/CurrencyChoiceSheet');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const ABROAD = { account_id: 'manual_abroad', name: 'Abroad', currency: 'USD' };

async function mount(initial = 'EUR') {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const said: string[] = [];
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return (
      <CurrencyChoiceSheet
        open={open}
        onClose={() => {
          said.push('closed');
          setOpen(false);
        }}
        initial={initial}
        first={['USD', 'EUR']}
        manual={[ABROAD]}
        onSaved={(home) => said.push(`saved ${home}`)}
      />
    );
  }
  act(() => root.render(<Harness />));
  await pass(5);
  const body = dom.document.body as unknown as FakeElement;
  const dialog = () => body.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  const footer = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0] ?? null;
  const footerButtons = () => footer()!.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent);
  const accountSelect = () => dialog()!.findAll((e) => e.tagName === 'LABEL' && (e.textContent ?? '').startsWith('Abroad'))[0]!.findAll((e) => e.tagName === 'SELECT')[0]!;
  const moveBox = () => dialog()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox')[0] ?? null;
  const doneLine = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'notice done')[0] ?? null;
  return { said, dialog, button, footer, footerButtons, accountSelect, moveBox, doneLine, unmount: () => act(() => root.unmount()) };
}

describe('after Save', () => {
  test('a correction whose typed transactions moved: a done notice says what moved, with focus on it and no Undo', async () => {
    patch = async () => ({ ok: true, status: 200, json: async () => ({ relabelled: { moved: 3, kept: 1 } }) });
    const v = await mount();
    act(() => type(v.accountSelect(), 'GBP'));
    await pass(5);
    act(() => {
      const box = v.moveBox()!;
      box.checked = true;
      click(box);
    });
    expect(v.footerButtons()).toEqual(['Not now', 'Save the currencies']);
    act(() => click(v.button('Save the currencies')!));
    await pass(5);
    expect(sent.filter((s) => s.method === 'PATCH').at(-1)!.body).toEqual({ account_id: 'manual_abroad', currency: 'GBP', relabel_from: 'USD' });
    const line = v.doneLine()!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toContain('Saved.');
    expect(line.textContent).toContain('3 transactions you entered on it moved to GBP. 1 stays in USD: split, in a group, or more precise than GBP allows.');
    expect(dom.document.activeElement).toBe(line);
    expect(v.footerButtons()).toEqual(['Done']);
    expect(v.button('Undo')).toBeNull();
    expect(v.said).toEqual(['saved EUR']);
    act(() => click(v.button('Done')!));
    await pass(400);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('nothing moved: it closes, the totals behind showing the choice', async () => {
    const v = await mount('USD');
    expect(v.footerButtons()).toEqual(['Not now', 'Show my net worth in USD']);
    act(() => click(v.button('Show my net worth in USD')!));
    await pass(400);
    expect(sent.filter((s) => s.method === 'PUT').at(-1)!.body).toEqual({ home: 'USD' });
    expect(v.said).toEqual(['saved USD', 'closed']);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('refused: it stays open, the words beside its buttons', async () => {
    put = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed to save the currency' }) });
    const v = await mount('USD');
    act(() => click(v.button('Show my net worth in USD')!));
    await pass(5);
    expect(v.said).toEqual([]);
    const note = v.footer()!.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0]!;
    expect(note.findAll((e) => e.getAttribute('role') === 'alert')[0]!.textContent).toContain('Failed to save the currency');
    expect(v.button('Show my net worth in USD')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    v.unmount();
  });
});
