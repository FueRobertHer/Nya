import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, fakeClock, type FakeElement } from './mini-dom';

// Repairing an investment account's holdings history (components/
// HoldingsRecorded.tsx), used as a person would (react-dom/client over
// test/mini-dom.ts), for what it shows after Rebuild it
// (docs/design/guidelines.md#after-save): done, the sheet closes on the line
// read again, which says what came of it; refused, the sheet stays open with
// the server's words beside its buttons.

const dom = installDom();
// What the line reads, in turn, and what the repair answers.
let summaries: { status: number; body: unknown }[] = [];
let repair: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({ repaired: true, months: 3 }) });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { method?: string }) => {
  if (url === '/api/holdings-history' && init?.method === 'POST') return repair();
  const next = summaries.length > 1 ? summaries.shift()! : summaries[0];
  return { ok: next.status === 200, status: next.status, json: async () => next.body };
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: HoldingsRecorded } = await import('@/components/HoldingsRecorded');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const DAMAGED = { status: 409, body: { unreadable: true, repairable: true } };
const today = new Date().toISOString().slice(0, 10);
const RECORDED = { status: 200, body: { first_recorded: '2026-09-12', last_recorded: today } };

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(<HoldingsRecorded accountId="acc_ira" />));
  await pass(5);
  const body = dom.document.body as unknown as FakeElement;
  const dialog = () => body.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const button = (label: string, within: FakeElement = body) => within.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  const footer = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0] ?? null;
  return { host, dialog, button, footer, unmount: () => act(() => root.unmount()) };
}

describe('rebuilding holdings history', () => {
  test('done: the sheet closes on the line read again', async () => {
    summaries = [DAMAGED, RECORDED];
    repair = async () => ({ ok: true, status: 200, json: async () => ({ repaired: true, months: 3 }) });
    const v = await mount();
    expect(v.host.textContent).toContain('Holdings history can’t be read, so it isn’t being recorded.'.replaceAll('’', "'"));
    act(() => click(v.button('Repair it')!));
    await pass(5);
    // Its buttons in the footer, none in the body.
    expect(v.footer()!.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent)).toEqual(['Cancel', 'Rebuild it']);
    act(() => click(v.button('Rebuild it', v.dialog()!)!));
    await pass(400);
    expect(v.dialog()).toBeNull();
    expect(v.host.textContent).toContain('Holdings recorded since Sep 12');
    v.unmount();
  });

  test('done, with months too damaged to read: the line says so', async () => {
    summaries = [DAMAGED, RECORDED];
    repair = async () => ({ ok: true, status: 200, json: async () => ({ repaired: true, months: 3, damaged_months: 2 }) });
    const v = await mount();
    act(() => click(v.button('Repair it')!));
    await pass(5);
    act(() => click(v.button('Rebuild it', v.dialog()!)!));
    await pass(400);
    expect(v.dialog()).toBeNull();
    expect(v.host.textContent).toContain("2 months of holdings history are damaged and can't be read, so they were left as they were.");
    v.unmount();
  });

  test('refused: it stays open, the server’s words beside its buttons', async () => {
    summaries = [DAMAGED];
    repair = async () => ({ ok: false, status: 500, json: async () => ({ error: 'The store couldn’t be reached just now.' }) });
    const v = await mount();
    act(() => click(v.button('Repair it')!));
    await pass(5);
    act(() => click(v.button('Rebuild it', v.dialog()!)!));
    await pass(5);
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Repair holdings history');
    const note = v.footer()!.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0]!;
    const alert = note.findAll((e) => e.getAttribute('role') === 'alert')[0]!;
    expect(alert.getAttribute('class')).toBe('notice critical');
    expect(alert.textContent).toContain('The store couldn’t be reached just now.');
    expect(v.button('Rebuild it', v.dialog()!)!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    expect(v.button('Rebuild it', v.dialog()!)!.getAttribute('disabled')).toBeNull();
    v.unmount();
  });
});
