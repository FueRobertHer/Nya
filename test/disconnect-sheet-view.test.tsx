import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, type FakeElement } from './mini-dom';

// The sheet that disconnects a connection (components/DisconnectSheet.tsx),
// used as a person would (react-dom/client over test/mini-dom.ts): the name
// typed to confirm, then the write. A failure is said beside its buttons, in
// the sheet that is still open, never only on the screen behind it
// (docs/design/guidelines.md#after-save); once it is done the sheet hands
// back to the screen behind, whose card goes.

const dom = installDom();
// The write as each test answers it; what the splits note asks, at once.
let answer: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
const sent: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  sent.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  if (url === '/api/disconnect') return answer();
  return { ok: true, status: 200, json: async () => ({ split: 0, grouped: 0 }) };
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: DisconnectSheet, DISCONNECT_FAILED } = await import('@/components/DisconnectSheet');
type Props = import('@/components/DisconnectSheet').DisconnectSheetProps;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const CHASE = { item_id: 'item_chase', institution_name: 'Chase' };
const ALLY = { item_id: 'item_ally', institution_name: 'Ally Bank' };

async function mount(over: Partial<Props> = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const said: string[] = [];
  let props: Props = {
    open: true,
    target: CHASE,
    ended: false,
    onClose: () => said.push('close'),
    onDisconnected: (id) => said.push(`disconnected ${id}`),
    ...over,
  };
  const render = (p: Partial<Props> = {}) => {
    props = { ...props, ...p };
    act(() => root.render(<DisconnectSheet {...props} />));
  };
  render();
  // The frame it takes to slide in.
  await pass(5);
  const doc = dom.document.body as unknown as FakeElement;
  const dialog = () => doc.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  const field = () => dialog()?.findAll((e) => e.tagName === 'INPUT')[0] ?? null;
  const footer = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0] ?? null;
  const footNote = () => footer()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0] ?? null;
  return { said, render, dialog, button, field, footer, footNote, unmount: () => act(() => root.unmount()) };
}

const refused = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed to disconnect' }) });

describe('disconnecting a connection', () => {
  test('its buttons in the footer; Disconnect only once the name is typed, in any case', async () => {
    const v = await mount();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Disconnect Chase?');
    const foot = v.footer()!;
    expect(foot.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent)).toEqual(['Cancel', 'Disconnect']);
    expect(v.button('Disconnect')!.getAttribute('class')).toBe('btn danger');
    expect(v.button('Disconnect')!.getAttribute('disabled')).not.toBeNull();
    act(() => type(v.field()!, ' chase '));
    expect(v.button('Disconnect')!.getAttribute('disabled')).toBeNull();
    // No button left in the body.
    const body = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && !foot.findAll((f) => f === e).length && e.getAttribute('aria-label') !== 'Close');
    expect(body).toHaveLength(0);
    v.unmount();
  });

  test('done: it hands back to the screen behind, with nothing more', async () => {
    answer = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
    const v = await mount();
    act(() => type(v.field()!, 'Chase'));
    act(() => click(v.button('Disconnect')!));
    await pass(5);
    expect(sent.filter((s) => s.url === '/api/disconnect').at(-1)!.body).toEqual({ item_id: 'item_chase' });
    expect(v.said).toEqual(['disconnected item_chase']);
    expect(v.footNote()).toBeNull();
    v.unmount();
  });

  for (const [why, refuse] of [
    ['refused', refused],
    [
      'never reached',
      async () => {
        throw new Error('offline');
      },
    ],
  ] as const) {
    test(`${why}: said beside its buttons in the open sheet, the name typed kept`, async () => {
      answer = refuse;
      const v = await mount();
      act(() => type(v.field()!, 'Chase'));
      act(() => click(v.button('Disconnect')!));
      await pass(5);
      expect(v.said).toEqual([]);
      expect(v.dialog()!.getAttribute('aria-label')).toBe('Disconnect Chase?');
      const note = v.footNote()!;
      const alert = note.findAll((e) => e.getAttribute('role') === 'alert')[0]!;
      expect(alert.getAttribute('class')).toBe('notice critical');
      expect(alert.textContent).toContain(DISCONNECT_FAILED);
      expect(v.button('Disconnect')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
      expect(v.field()!.value).toBe('Chase');
      expect(v.button('Disconnect')!.getAttribute('disabled')).toBeNull();
      v.unmount();
    });
  }

  test('tried again: the error goes while it waits, and it is done', async () => {
    answer = refused;
    const v = await mount();
    act(() => type(v.field()!, 'Chase'));
    act(() => click(v.button('Disconnect')!));
    await pass(5);
    expect(v.footNote()).not.toBeNull();
    let settle: (r: unknown) => void = () => {};
    answer = () => new Promise((resolve) => (settle = resolve));
    act(() => click(v.button('Disconnect')!));
    expect(v.footNote()).toBeNull();
    expect(v.button('Disconnecting…')!.getAttribute('disabled')).not.toBeNull();
    expect(v.button('Cancel')!.getAttribute('disabled')).not.toBeNull();
    settle({ ok: true, status: 200, json: async () => ({ success: true }) });
    await pass(5);
    expect(v.said).toEqual(['disconnected item_chase']);
    v.unmount();
  });

  test('opened again, or on another connection: nothing typed and no error from before', async () => {
    answer = refused;
    const v = await mount();
    act(() => type(v.field()!, 'Chase'));
    act(() => click(v.button('Disconnect')!));
    await pass(5);
    expect(v.footNote()).not.toBeNull();
    v.render({ open: false });
    await pass(400);
    v.render({ open: true, target: ALLY });
    await pass(5);
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Disconnect Ally Bank?');
    expect(v.footNote()).toBeNull();
    expect(v.field()!.value).toBe('');
    v.render({ open: false });
    await pass(400);
    v.render({ open: true, target: CHASE });
    await pass(5);
    expect(v.footNote()).toBeNull();
    expect(v.field()!.value).toBe('');
    v.unmount();
  });

  test('a store that can’t be reached says why, in its words', async () => {
    answer = async () => ({ ok: false, status: 503, json: async () => ({ error: 'Your data is being moved. Try again in a minute.' }) });
    const v = await mount();
    act(() => type(v.field()!, 'Chase'));
    act(() => click(v.button('Disconnect')!));
    await pass(5);
    expect(v.footNote()!.textContent).toContain('Your data is being moved. Try again in a minute.');
    expect(v.footNote()!.textContent).not.toContain(DISCONNECT_FAILED);
    v.unmount();
  });

  test('every account ended: the offer to remove it, without the note on marking one closed', async () => {
    sent.length = 0;
    const v = await mount({ ended: true });
    const text = v.dialog()!.textContent;
    expect(text).toContain('Every account at Chase has ended, but the connection is still open, and Plaid charges for it until it is removed.');
    expect(text).not.toContain('Disconnecting doesn');
    v.render({ ended: false });
    expect(v.dialog()!.textContent).toContain('Disconnecting doesn’t say an account closed.'.replace('’', "'"));
    // What adding it back doesn't bring back is asked of this connection.
    expect(sent.some((s) => s.url === '/api/transaction-splits?item_id=item_chase')).toBe(true);
    v.unmount();
  });
});
