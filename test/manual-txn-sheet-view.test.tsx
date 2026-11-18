import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, type FakeElement } from './mini-dom';

// The form that adds, edits and deletes a manual account's transaction
// (components/ManualTxnSheet.tsx), used as a person would (react-dom/client
// over test/mini-dom.ts), for what it shows after Save
// (docs/design/guidelines.md#after-save): added from Activity, it closes on
// the list that shows it; added from an account's sheet, it says what it
// added, with focus on the line, and an Undo that deletes it, unless the
// balance moved with it, which deleting never moves back. Its buttons in the
// sheet's footer, a refusal beside them; deleting from its actions' last row.

const dom = installDom();
type Sent = { method: string; body: Record<string, unknown> };
const sent: Sent[] = [];
let answer: (s: Sent) => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({}) });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
  if (url !== '/api/manual-transactions') return { ok: false, status: 404, json: async () => ({}) };
  const s = { method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : {} };
  sent.push(s);
  return answer(s);
}) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: ManualTxnSheet } = await import('@/components/ManualTxnSheet');
type ManualTxnTarget = import('@/components/ManualTxnSheet').ManualTxnTarget;
type Txn = import('@/components/MonthBreakdown').Txn;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const WALLET = { institution_name: 'Cash', manual: true, accounts: [{ account_id: 'acc_wallet', name: 'Wallet', type: 'depository', balance: 100, currency: 'USD' }] };
/** The server's answer to an add: the row as sent, saved. */
const addedOk =
  (more: Record<string, unknown> = {}) =>
  async (s: Sent) => ({
    ok: true,
    status: 200,
    json: async () => ({ transaction: { transaction_id: s.body.id, account_id: s.body.account_id, name: s.body.name, amount: s.body.amount, date: s.body.date }, added: true, balance_updated: false, ...more }),
  });
const ok = async () => ({ ok: true, status: 200, json: async () => ({ success: true, deleted: true }) });
const refused = (error: string) => async () => ({ ok: false, status: 400, json: async () => ({ error }) });

async function mount(start: ManualTxnTarget) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const saved: unknown[] = [];
  let closed = 0;
  function Harness() {
    const [target, setTarget] = React.useState<ManualTxnTarget | null>(start);
    return (
      <ManualTxnSheet
        target={target}
        institutions={[WALLET]}
        txns={[]}
        onClose={() => {
          closed++;
          setTarget(null);
        }}
        onSaved={(r) => saved.push(r)}
        onBalanceStale={() => {}}
      />
    );
  }
  act(() => root.render(<Harness />));
  await pass(5);
  const body = dom.document.body as unknown as FakeElement;
  const dialog = () => body.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  const field = (label: string) => dialog()!.findAll((e) => e.tagName === 'LABEL' && (e.textContent ?? '').startsWith(label))[0]!.findAll((e) => e.tagName === 'INPUT')[0]!;
  const footer = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0] ?? null;
  const footerButtons = () => footer()!.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent);
  const doneLine = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'notice done')[0] ?? null;
  const fill = () => {
    act(() => type(field('Amount'), '12.50'));
    act(() => type(field('Paid to'), 'Corner Store'));
  };
  return { saved, closed: () => closed, dialog, button, field, footer, footerButtons, doneLine, fill, unmount: () => act(() => root.unmount()) };
}

describe('after Add, from an account’s sheet', () => {
  test('said, with focus on its line, and Undo deletes it as if never added', async () => {
    answer = addedOk();
    const v = await mount({ mode: 'add', account_id: 'acc_wallet' });
    v.fill();
    expect(v.footerButtons()).toEqual(['Cancel', 'Add $12.50']);
    act(() => click(v.button('Add $12.50')!));
    await pass(5);
    const add = sent.at(-1)!;
    expect(add.method).toBe('POST');
    const line = v.doneLine()!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('tabindex')).toBe('-1');
    expect(line.textContent).toContain('Added $12.50 spent at Corner Store to Wallet.');
    expect(dom.document.activeElement).toBe(line);
    expect(v.dialog()!.textContent).toContain('It’s in Activity, where you can edit or delete it.');
    expect(v.footerButtons()).toEqual(['Done']);
    expect(v.closed()).toBe(0);
    answer = ok;
    act(() => click(v.button('Undo')!));
    await pass(5);
    expect(sent.at(-1)).toEqual({ method: 'DELETE', body: { id: add.body.id, account_id: 'acc_wallet' } });
    expect(v.saved.at(-1)).toEqual({ balanceChanged: false, removed: add.body.id });
    expect(v.doneLine()!.textContent).toContain('Undone: $12.50 spent at Corner Store is no longer on Wallet.');
    expect(dom.document.activeElement).toBe(v.doneLine());
    expect(v.button('Undo')).toBeNull();
    act(() => click(v.button('Done')!));
    await pass(400);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('the balance moved with it: said, with no Undo, and where the balance is changed', async () => {
    answer = addedOk({ balance_updated: true, balance: 87.5 });
    const v = await mount({ mode: 'add', account_id: 'acc_wallet' });
    v.fill();
    act(() => {
      const box = v.dialog()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox')[0]!;
      box.checked = true;
      click(box);
    });
    act(() => click(v.button('Add $12.50')!));
    await pass(5);
    expect(sent.at(-1)!.body.update_balance).toEqual({ from: 100, to: 87.5 });
    expect(v.doneLine()!.textContent).toContain('Added $12.50 spent at Corner Store to Wallet. Wallet’s balance moved from $100.00 to $87.50 with it.');
    expect(v.button('Undo')).toBeNull();
    expect(v.dialog()!.textContent).toContain('Deleting it leaves the balance as it is now: update that from the account.');
    v.unmount();
  });

  test('an Undo refused: said beside Undo, which stays to try again', async () => {
    answer = addedOk();
    const v = await mount({ mode: 'add', account_id: 'acc_wallet' });
    v.fill();
    act(() => click(v.button('Add $12.50')!));
    await pass(5);
    answer = refused('Failed to delete the transaction');
    act(() => click(v.button('Undo')!));
    await pass(5);
    const undo = v.button('Undo')!;
    const said = v.dialog()!.findAll((e) => e.getAttribute('id') === undo.getAttribute('aria-describedby'))[0]!;
    expect(said.findAll((e) => e.getAttribute('role') === 'alert')[0]!.textContent).toContain('Failed to delete the transaction');
    expect(v.doneLine()!.textContent).toContain('Added $12.50 spent at Corner Store to Wallet.');
    v.unmount();
  });

  test('opened again: the form, with nothing said from before', async () => {
    answer = addedOk();
    const v = await mount({ mode: 'add', account_id: 'acc_wallet' });
    v.fill();
    act(() => click(v.button('Add $12.50')!));
    await pass(5);
    expect(v.doneLine()).not.toBeNull();
    act(() => click(v.button('Done')!));
    await pass(400);
    v.unmount();
    const again = await mount({ mode: 'add', account_id: 'acc_wallet' });
    expect(again.doneLine()).toBeNull();
    expect(again.footerButtons()).toEqual(['Cancel', 'Add']);
    again.unmount();
  });
});

describe('after Add from Activity, Save and Delete', () => {
  test('added from Activity: it closes on the list, which shows it', async () => {
    answer = addedOk();
    const v = await mount({ mode: 'add', account_id: null });
    v.fill();
    act(() => click(v.button('Add $12.50')!));
    await pass(400);
    expect(v.closed()).toBe(1);
    expect(v.dialog()).toBeNull();
    expect((v.saved.at(-1) as { transaction: { name: string } }).transaction.name).toBe('Corner Store');
    v.unmount();
  });

  test('refused: it stays open, the words beside the buttons, which point at them', async () => {
    answer = refused('Wallet changed since this form opened, so nothing was saved. Check it and save again.');
    const v = await mount({ mode: 'add', account_id: 'acc_wallet' });
    v.fill();
    act(() => click(v.button('Add $12.50')!));
    await pass(5);
    const note = v.footer()!.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0]!;
    expect(note.findAll((e) => e.getAttribute('role') === 'alert')[0]!.textContent).toContain('Wallet changed since this form opened');
    expect(v.button('Add $12.50')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    expect(v.doneLine()).toBeNull();
    // No row of buttons left in the body.
    expect(v.dialog()!.findAll((e) => (e.getAttribute('class') ?? '') === 'button-pair')).toEqual([]);
    v.unmount();
  });

  test('deleted from its actions’ last row, asked first, its buttons in the footer; refused, said beside them', async () => {
    const txn = { transaction_id: 'manual_t1', account_id: 'acc_wallet', name: 'Corner Store', amount: 12.5, date: '2026-11-10', iso_currency_code: 'USD' } as unknown as Txn;
    const v = await mount({ mode: 'edit', txn });
    expect(v.footerButtons()).toEqual(['Cancel', 'Save']);
    const row = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '') === 'list-row neg')[0]!;
    expect(row.textContent).toContain('Delete transaction');
    act(() => click(row));
    await pass(5);
    expect(v.dialog()!.textContent).toContain('Delete this transaction? It can');
    expect(v.footerButtons()).toEqual(['Keep it', 'Delete']);
    answer = refused('Failed to delete the transaction');
    act(() => click(v.button('Delete')!));
    await pass(5);
    const note = v.footer()!.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0]!;
    expect(note.textContent).toContain('Failed to delete the transaction');
    expect(v.button('Delete')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    answer = ok;
    act(() => click(v.button('Delete')!));
    await pass(400);
    expect(sent.at(-1)).toEqual({ method: 'DELETE', body: { id: 'manual_t1', account_id: 'acc_wallet' } });
    expect(v.closed()).toBe(1);
    v.unmount();
  });
});
