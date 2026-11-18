import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, type FakeElement } from './mini-dom';

// The sheets that add, update and delete a manual account
// (components/ManualAccountSheet.tsx), used as a person would (react-dom/client
// over test/mini-dom.ts). Their buttons sit in the footer, a refusal beside
// them in the sheet that is still open; a save closes on the Accounts list,
// which shows it, and a move of the account's typed transactions is said in
// the same sheet (docs/design/guidelines.md#after-save).

const dom = installDom();
// The write as each test answers it; the count of what a move would take, at once.
let answer: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
const sent: { method: string; body: Record<string, unknown> | null }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
  if (url.startsWith('/api/manual-accounts?')) return { ok: true, status: 200, json: async () => ({ relabel: { moved: 2, kept: 1 } }) };
  sent.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
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
const { useManualAccountSheets } = await import('@/components/ManualAccountSheet');
const { OWED_FLIP_REASON } = await import('@/components/OwedFlipNote');
type ManualAccount = import('@/components/accounts-format').ManualAccount;
type Sheets = ReturnType<typeof useManualAccountSheets>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const WALLET: ManualAccount = { account_id: 'manual_1', name: 'Wallet', institution_name: 'Home', type: 'depository', subtype: null, balance: 40, currency: 'USD' };
const CARD: ManualAccount = { account_id: 'manual_2', name: 'Store card', institution_name: 'Store', type: 'credit', subtype: null, balance: 120, currency: 'USD' };

beforeEach(() => {
  sent.length = 0;
  answer = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
});

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const said: string[] = [];
  // What the screen behind reads again after a save, held until the test lets it go.
  let release: () => void = () => {};
  let hold = false;
  const onSaved = () => {
    said.push('saved');
    return hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  };
  let sheets: Sheets | null = null;
  function Harness() {
    sheets = useManualAccountSheets({
      currencies: ['USD', 'EUR'],
      onSaved,
      onEnd: (a) => said.push(`end ${a.account_id}`),
      onHide: (id) => said.push(`hide ${id}`),
      hiding: false,
    });
    return sheets.sheets;
  }
  act(() => root.render(<Harness />));
  const doc = dom.document.body as unknown as FakeElement;
  const dialog = () => doc.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  const fields = () => dialog()?.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') !== 'checkbox') ?? [];
  const selects = () => dialog()?.findAll((e) => e.tagName === 'SELECT') ?? [];
  const footer = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0] ?? null;
  const footButtons = () => footer()?.findAll((e) => e.tagName === 'BUTTON').map((e) => e.textContent) ?? [];
  const footNote = () => footer()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0] ?? null;
  const open = async (start: (s: Sheets) => void) => {
    act(() => start(sheets!));
    // The frame it takes to slide in.
    await pass(5);
  };
  return {
    said,
    sheets: () => sheets!,
    holdSaved: () => (hold = true),
    releaseSaved: () => act(() => release()),
    open,
    dialog,
    button,
    fields,
    selects,
    footer,
    footButtons,
    footNote,
  };
}
type View = Awaited<ReturnType<typeof mount>>;

/** Types a new account's name, institution and balance. */
function fill(v: View, name: string, institution: string, balance: string) {
  const [n, i, b] = v.fields();
  act(() => {
    type(n, name);
    type(i, institution);
    type(b, balance);
  });
}

const refused = (error: string) => async () => ({ ok: false, status: 400, json: async () => ({ error }) });

describe('adding a manual account', () => {
  test('its buttons in the footer; a save closes on the list, which reads it again', async () => {
    const v = await mount();
    await v.open((s) => s.startAdd('USD'));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Add a manual account');
    expect(v.footButtons()).toEqual(['Cancel', 'Add account']);
    expect(v.button('Add account')!.getAttribute('class')).toBe('btn');
    expect(v.button('Add account')!.getAttribute('disabled')).not.toBeNull();
    // No button left in the body.
    const body = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && !v.footer()!.contains(e));
    expect(body.filter((e) => e.textContent === 'Cancel' || e.textContent === 'Add account')).toEqual([]);
    fill(v, 'Credit Union', 'CU', '250.5');
    expect(v.button('Add account')!.getAttribute('disabled')).toBeNull();
    act(() => click(v.button('Add account')!));
    await pass(20);
    expect(sent).toEqual([
      { method: 'POST', body: { name: 'Credit Union', institution_name: 'CU', type: 'depository', subtype: null, balance: 250.5, currency: 'USD' } },
    ]);
    expect(v.said).toEqual(['saved']);
    expect(v.dialog()).toBeNull();
  });

  test('a refused add stays open, said beside its buttons, and Add account points at it', async () => {
    answer = refused('Name is too long');
    const v = await mount();
    await v.open((s) => s.startAdd('USD'));
    fill(v, 'Credit Union', 'CU', '10');
    act(() => click(v.button('Add account')!));
    await pass(20);
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Add a manual account');
    const note = v.footNote()!;
    expect(note.textContent).toBe('Critical: Name is too long');
    expect(note.findAll((e) => e.getAttribute('role') === 'alert').length).toBe(1);
    // First in the footer, before the buttons.
    expect(v.footer()!.firstChild).toBe(note);
    expect(v.button('Add account')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    expect(v.said).toEqual([]);
    // What was typed is kept, to try again.
    expect(v.fields().map((f) => (f as unknown as { value: string }).value)).toEqual(['Credit Union', 'CU', '10']);
  });

  test('adding again after a save, or after Cancel, starts empty', async () => {
    const v = await mount();
    await v.open((s) => s.startAdd('USD'));
    fill(v, 'Credit Union', 'CU', '10');
    act(() => click(v.button('Add account')!));
    await pass(20);
    await v.open((s) => s.startAdd('USD'));
    expect(v.fields().map((f) => (f as unknown as { value: string }).value)).toEqual(['', '', '']);
    expect(v.footNote()).toBeNull();
    fill(v, 'Brokerage', 'Broker', '5');
    act(() => click(v.button('Cancel')!));
    await pass(5);
    expect(v.dialog()).toBeNull();
    await v.open((s) => s.startAdd('USD'));
    expect(v.fields().map((f) => (f as unknown as { value: string }).value)).toEqual(['', '', '']);
  });

  test('saving holds until the list behind has read the save, after the sheet has closed', async () => {
    const v = await mount();
    v.holdSaved();
    await v.open((s) => s.startAdd('USD'));
    fill(v, 'Credit Union', 'CU', '10');
    act(() => click(v.button('Add account')!));
    await pass(20);
    expect(v.dialog()).toBeNull();
    expect(v.sheets().saving).toBe(true);
    v.releaseSaved();
    await pass(5);
    expect(v.sheets().saving).toBe(false);
  });
});

describe('updating a manual account', () => {
  test('Save in the footer, and a save closes on the list', async () => {
    const v = await mount();
    await v.open((s) => s.startEdit(WALLET));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Update account');
    expect(v.footButtons()).toEqual(['Cancel', 'Save']);
    act(() => type(v.fields()[2], '55'));
    act(() => click(v.button('Save')!));
    await pass(20);
    expect(sent.map((s) => [s.method, s.body?.account_id, s.body?.balance])).toEqual([['PATCH', 'manual_1', 55]]);
    expect(sent[0].body!.relabel_from).toBeUndefined();
    expect(v.dialog()).toBeNull();
    expect(v.said).toEqual(['saved']);
  });

  test('a currency moved with its typed transactions says what moved, until Done', async () => {
    answer = async () => ({ ok: true, status: 200, json: async () => ({ success: true, relabelled: { moved: 2, kept: 1 } }) });
    const v = await mount();
    await v.open((s) => s.startEdit(WALLET));
    act(() => type(v.selects()[1], 'EUR'));
    await pass(20);
    const box = v.dialog()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox')[0];
    act(() => {
      (box as unknown as { checked: boolean }).checked = true;
      click(box);
    });
    act(() => click(v.button('Save')!));
    await pass(20);
    expect(sent.map((s) => [s.method, s.body?.currency, s.body?.relabel_from])).toEqual([['PATCH', 'EUR', 'USD']]);
    // The same sheet, saying what moved; the form's buttons gone.
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Saved');
    const text = v.dialog()!.textContent;
    expect(text).toContain('2 transactions you entered on it moved to EUR.');
    expect(text).toContain('1 stays in USD');
    expect(v.button('Save')).toBeNull();
    expect(v.button('Cancel')).toBeNull();
    act(() => click(v.button('Done')!));
    await pass(5);
    expect(v.dialog()).toBeNull();
  });

  test('a type across money held and owed is refused, and Save says why', async () => {
    const v = await mount();
    await v.open((s) => s.startEdit(CARD));
    act(() => type(v.selects()[0], 'depository'));
    const save = v.button('Save')!;
    expect(save.getAttribute('disabled')).not.toBeNull();
    expect(save.getAttribute('aria-describedby')).toBe(OWED_FLIP_REASON);
  });

  test('a refused update is said beside Save, which points at it', async () => {
    answer = refused('Could not save. Please try again.');
    const v = await mount();
    await v.open((s) => s.startEdit(WALLET));
    act(() => click(v.button('Save')!));
    await pass(20);
    const note = v.footNote()!;
    expect(note.textContent).toBe('Critical: Could not save. Please try again.');
    expect(v.button('Save')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Update account');
  });
});

describe('deleting a manual account', () => {
  test('Delete in the footer; a refusal stays beside it, then a delete closes on the list', async () => {
    answer = refused('Could not save. Please try again.');
    const v = await mount();
    await v.open((s) => s.startDelete(WALLET));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Delete Wallet?');
    expect(v.footButtons()).toEqual(['Cancel', 'Delete']);
    expect(v.button('Delete')!.getAttribute('class')).toBe('btn danger');
    expect(v.dialog()!.textContent).toContain('not recoverable');
    expect(v.button('Delete')!.getAttribute('aria-describedby')).toBeNull();
    act(() => click(v.button('Delete')!));
    await pass(20);
    const note = v.footNote()!;
    expect(note.textContent).toBe('Critical: Could not save. Please try again.');
    expect(v.button('Delete')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    expect(v.said).toEqual([]);
    answer = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
    act(() => click(v.button('Delete')!));
    await pass(20);
    expect(sent).toEqual([
      { method: 'DELETE', body: { account_id: 'manual_1' } },
      { method: 'DELETE', body: { account_id: 'manual_1' } },
    ]);
    expect(v.dialog()).toBeNull();
    expect(v.said).toEqual(['saved']);
  });

  test('a refusal on one account is gone when the next opens', async () => {
    answer = refused('Could not save. Please try again.');
    const v = await mount();
    await v.open((s) => s.startDelete(WALLET));
    act(() => click(v.button('Delete')!));
    await pass(20);
    act(() => click(v.button('Cancel')!));
    await pass(5);
    await v.open((s) => s.startEdit(CARD));
    expect(v.footNote()).toBeNull();
  });
});
