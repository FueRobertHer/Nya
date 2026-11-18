import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, fakeClock, type FakeElement } from './mini-dom';

// The sheet that ends or reopens an account (components/AccountLifecycle.tsx
// useAccountLifecycle), used as a person would (react-dom/client over
// test/mini-dom.ts), for what it shows after Save and Reopen it
// (docs/design/guidelines.md#after-save): a done level saying what moved and
// where it is taken back, focus on its line, and no Undo, since the way back
// doesn't restore the stored record exactly. The connection's removal, once
// its last open account has ended, is offered there rather than opened over
// it. A refusal stays on the form, beside its buttons.

const dom = installDom();
let answer: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({}) });
const sent: unknown[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
  sent.push(init?.body ? JSON.parse(init.body) : null);
  return answer();
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { useAccountLifecycle } = await import('@/components/AccountLifecycle');
type LifecycleTarget = import('@/components/AccountLifecycle').LifecycleTarget;
type EndedConnection = import('@/components/AccountLifecycle').EndedConnection;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
const SAVINGS: LifecycleTarget = { account_id: 'acc_sav', name: 'Ally Savings', mask: '1234', institution: 'Ally' };

async function mount(target: LifecycleTarget) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const said: string[] = [];
  let api: ReturnType<typeof useAccountLifecycle> | null = null;
  function Harness() {
    const l = useAccountLifecycle({ onChanged: () => said.push('changed'), onRemoveConnection: (c: EndedConnection) => said.push(`remove ${c.item_id}`) });
    api = l;
    return l.sheet;
  }
  act(() => root.render(<Harness />));
  act(() => api!.open(target));
  await pass(5);
  const body = dom.document.body as unknown as FakeElement;
  const dialog = () => body.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  const footer = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0] ?? null;
  const doneLine = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'notice done')[0] ?? null;
  return { said, dialog, button, footer, doneLine, api: () => api!, unmount: () => act(() => root.unmount()) };
}

describe('after Save and Reopen it', () => {
  test('an end: said on a done level with focus on its line, where it is taken back, and no Undo', async () => {
    answer = ok({ account_id: 'acc_sav', lifecycle: { state: 'closed', on: '2026-11-18' } });
    const v = await mount(SAVINGS);
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(v.said).toEqual(['changed']);
    const line = v.doneLine()!;
    expect(line.getAttribute('role')).toBe('status');
    // Focusable by script only, which a browser needs to take the focus.
    expect(line.getAttribute('tabindex')).toBe('-1');
    expect(line.textContent).toContain('Ally Savings ••1234: Closed today. Every day before stays as it was; from then on it isn’t counted.');
    expect(dom.document.activeElement).toBe(line);
    expect(v.dialog()!.textContent).toContain('It’s under Accounts that ended, on the Accounts tab, where you can change or reopen it.');
    expect(v.footer()!.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent)).toEqual(['Done']);
    expect(v.button('Undo')).toBeNull();
    act(() => click(v.button('Done')!));
    await pass(400);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('the last open account at its connection: the removal is offered on the done level, not opened over it', async () => {
    answer = ok({ account_id: 'acc_sav', lifecycle: { state: 'closed', on: '2026-11-18' }, remove_connection: { item_id: 'item_ally', institution_name: 'Ally' } });
    const v = await mount(SAVINGS);
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(v.said).toEqual(['changed']);
    expect(v.dialog()!.textContent).toContain('Every account at Ally has ended, but the connection is still open, and Plaid charges for it until it is removed.');
    expect(v.footer()!.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent)).toEqual(['Disconnect Ally…', 'Done']);
    // The offer is described by what the connection still costs.
    const cost = v.dialog()!.findAll((e) => e.getAttribute('id') === v.button('Disconnect Ally…')!.getAttribute('aria-describedby'))[0]!;
    expect(cost.textContent).toContain('Plaid charges for it until it is removed.');
    act(() => click(v.button('Disconnect Ally…')!));
    await pass(400);
    expect(v.said).toEqual(['changed', 'remove item_ally']);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('reopened: said, and held at its last balance when its bank no longer returns it', async () => {
    answer = ok({ account_id: 'acc_sav', lifecycle: { state: 'active' }, reopened: true, held: true });
    const v = await mount({ ...SAVINGS, state: 'left', day: '2026-03-13', ended: true });
    act(() => click(v.button('Reopen it')!));
    await pass(5);
    expect(sent.at(-1)).toEqual({ account_id: 'acc_sav', state: 'active' });
    const line = v.doneLine()!;
    expect(line.textContent).toContain('Ally Savings ••1234 counts again, on every day.');
    expect(dom.document.activeElement).toBe(line);
    expect(v.dialog()!.textContent).toContain('Its bank no longer returns it, so it is held at its last known balance');
    expect(v.dialog()!.textContent).toContain('To end it again, open it and choose Mark as closed….');
    expect(v.button('Undo')).toBeNull();
    v.unmount();
  });

  test('refused: the form stays, the error beside its buttons; opened again, the form is back', async () => {
    answer = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Failed to save that account’s change' }) });
    const v = await mount(SAVINGS);
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(v.doneLine()).toBeNull();
    const note = v.footer()!.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0]!;
    expect(note.findAll((e) => e.getAttribute('role') === 'alert')[0]!.textContent).toContain('Failed to save that account’s change');
    expect(v.button('Save')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    // Saved, closed and opened on another account: its form, not the last done level.
    answer = ok({ account_id: 'acc_sav', lifecycle: { state: 'closed', on: '2026-11-18' } });
    act(() => click(v.button('Save')!));
    await pass(5);
    expect(v.doneLine()).not.toBeNull();
    act(() => click(v.button('Done')!));
    await pass(400);
    act(() => v.api().open({ account_id: 'acc_chk', name: 'Checking', mask: null, institution: 'Ally' }));
    await pass(5);
    expect(v.doneLine()).toBeNull();
    expect(v.button('Save')).not.toBeNull();
    v.unmount();
  });
});
