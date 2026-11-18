import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, fakeClock, type FakeElement } from './mini-dom';

// Hide, in one account's sheet (components/AccountSheet.tsx), used as a person
// would (react-dom/client over test/mini-dom.ts). The account leaves the list
// behind and Unhide is far away under Hidden, so the sheet stays open on a
// done notice that says what moved, with focus on its line and an Undo that
// unhides it (docs/design/guidelines.md#after-save). The screen behind is
// played here as Dashboard does it: the sheet is open while its account is on
// the list, and drawn from the last one it showed.

const dom = installDom();
const realFetch = globalThis.fetch;
// The sparkline and the investment views load their own data; here they wait.
globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act, useEffect, useRef, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: AccountSheet, focusAfterHide } = await import('@/components/AccountSheet');
type Account = import('@/components/accounts-format').Account;
type Institution = import('@/components/accounts-format').Institution;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pass = fakeClock();
const noop = () => {};
const CHECKING: Account = {
  account_id: 'acc_checking',
  name: 'Total Checking',
  official_name: null,
  mask: '4421',
  type: 'depository',
  subtype: 'checking',
  balance: 1200,
  limit: null,
  currency: 'USD',
};
const chase = (accounts: Account[]): Institution => ({ institution_name: 'Chase', item_id: 'item_chase', accounts, holdings: [], error: null, needs_reauth: false });

type Answer = () => Promise<string | null>;

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const said: string[] = [];
  // Each write's answer, as the test gives it: the words of a refusal, or null.
  const answers: { hide: Answer; unhide: Answer } = { hide: async () => null, unhide: async () => null };
  let openAgain: () => void = noop;
  let listed: () => string[] = () => [];
  function Screen() {
    const [list, setList] = useState<Account[]>([CHECKING]);
    const [openId, setOpenId] = useState<string | null>(CHECKING.account_id);
    const opened = list.find((a) => a.account_id === openId) ?? null;
    // Dashboard: drawn from the last account shown, and closed once its
    // account has left the list.
    const last = useRef(opened);
    if (opened) last.current = opened;
    useEffect(() => {
      if (openId && !opened) setOpenId(null);
    }, [openId, opened]);
    openAgain = () => setOpenId(CHECKING.account_id);
    listed = () => list.map((a) => a.account_id);
    const a = last.current!;
    // The list behind, as Dashboard draws it: a row for each account
    // (InstitutionCard), opening its sheet, and Hidden's toggle once one is hidden.
    const toggle = useRef<HTMLButtonElement>(null);
    return (
      <>
        <ul>
          {list.map((x) => (
            <li key={x.account_id}>
              <button
                className="list-row"
                data-account-row={x.account_id}
                onClick={() => {
                  focusAfterHide(document.activeElement, x.account_id, () => toggle.current);
                  setOpenId(x.account_id);
                }}
              >
                {x.name}
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 && (
          <button type="button" className="section-toggle" ref={toggle}>
            Hidden
          </button>
        )}
      <AccountSheet
        open={!!opened}
        account={a}
        inst={chase(list.length ? list : [a])}
        shownCurrency="USD"
        saving={false}
        hiding={false}
        lifecycleBusy={false}
        onDismiss={() => {
          said.push('dismiss');
          setOpenId(null);
        }}
        // As Dashboard's writeHidden: the accounts are read again before it answers.
        onHide={async (id) => {
          said.push(`hide ${id}`);
          const refused = await answers.hide();
          if (!refused) setList((l) => l.filter((x) => x.account_id !== id));
          return refused;
        }}
        onUnhide={async (id) => {
          said.push(`unhide ${id}`);
          const refused = await answers.unhide();
          if (!refused) setList((l) => (l.some((x) => x.account_id === id) ? l : [...l, CHECKING]));
          return refused;
        }}
        onEnd={(t) => said.push(`end ${t.account_id}`)}
        onUpdate={noop}
        onAddTransaction={noop}
        onImport={noop}
        onImportHistory={noop}
        onMoneyInOut={noop}
        onDelete={noop}
      />
      </>
    );
  }
  act(() => root.render(<Screen />));
  // The frame it takes to slide in.
  await pass(5);
  const doc = dom.document.body as unknown as FakeElement;
  const dialog = () => doc.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const button = (label: string) => dialog()?.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0] ?? null;
  const footer = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer')[0] ?? null;
  // Its words: the ⋯ (an icon, its name in a label) left out.
  const footButtons = () => footer()?.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-haspopup') !== 'menu').map((e) => e.textContent) ?? [];
  const footNote = () => footer()?.findAll((e) => (e.getAttribute('class') ?? '') === 'sheet-footer-note')[0] ?? null;
  const doneLine = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '') === 'notice done')[0] ?? null;
  const press = async (label: string) => {
    act(() => click(button(label)!));
    await pass(20);
  };
  /** Outside the sheet: the account's row, and Hidden's toggle. */
  const row = () => doc.findAll((e) => e.getAttribute('data-account-row') === CHECKING.account_id)[0] ?? null;
  const hiddenToggle = () => doc.findAll((e) => (e.getAttribute('class') ?? '') === 'section-toggle')[0] ?? null;
  /** Closed, then opened from its row, as a person does. */
  const openFromRow = async () => {
    const close = dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Close')[0]!;
    act(() => click(close));
    await pass(400);
    const r = row()!;
    r.focus();
    act(() => click(r));
    await pass(5);
  };
  return {
    said,
    answers,
    listed: () => listed(),
    openAgain: async () => {
      act(() => openAgain());
      await pass(5);
    },
    dialog,
    button,
    footer,
    footButtons,
    footNote,
    doneLine,
    press,
    row,
    hiddenToggle,
    openFromRow,
    unmount: () => act(() => root.unmount()),
  };
}

const HIDDEN = 'Total Checking ••4421 is hidden. It’s out of every total, past days included, and its transactions are out of Activity.';

describe('hiding an account from its sheet', () => {
  test('stays open on what moved, with focus on its line, though the account has left the list', async () => {
    const v = await mount();
    await v.press('Hide');
    expect(v.said).toEqual(['hide acc_checking']);
    expect(v.listed()).toEqual([]);
    const line = v.doneLine()!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.getAttribute('tabindex')).toBe('-1');
    expect(line.textContent).toContain(HIDDEN);
    expect(dom.document.activeElement).toBe(line);
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Total Checking ••4421');
    expect(v.dialog()!.textContent).toContain('It’s under Hidden at the bottom of Accounts, where Unhide brings it back.');
    expect(v.footButtons()).toEqual(['Done']);
    // Undo in a row of its own, not stretched by the stack.
    const undo = v.button('Undo')!;
    expect(undo.getAttribute('class')).toBe('btn ghost');
    expect((undo.parentNode as FakeElement).getAttribute('class')).toBeNull();
    v.unmount();
  });

  test('Undo unhides it, says so, and Done closes', async () => {
    const v = await mount();
    await v.press('Hide');
    await v.press('Undo');
    expect(v.said).toEqual(['hide acc_checking', 'unhide acc_checking']);
    expect(v.listed()).toEqual(['acc_checking']);
    const line = v.doneLine()!;
    expect(line.textContent).toContain('Undone: Total Checking ••4421 is back in every total, past days included.');
    expect(dom.document.activeElement).toBe(line);
    expect(v.button('Undo')).toBeNull();
    expect(v.dialog()!.textContent).not.toContain('Unhide brings it back');
    await v.press('Done');
    expect(v.dialog()).toBeNull();
    expect(v.said.at(-1)).toBe('dismiss');
    v.unmount();
  });

  test('a refused Hide stays on the account, said beside its buttons, and Hide points at it', async () => {
    const v = await mount();
    v.answers.hide = async () => 'That account is not currently available to hide';
    await v.press('Hide');
    expect(v.doneLine()).toBeNull();
    expect(v.listed()).toEqual(['acc_checking']);
    const note = v.footNote()!;
    expect(note.textContent).toBe('Critical: That account is not currently available to hide');
    expect(v.footer()!.firstChild).toBe(note);
    expect(v.button('Hide')!.getAttribute('aria-describedby')).toBe(note.getAttribute('id'));
    expect(v.footButtons()).toEqual(['Hide', 'Mark as closed…']);
    v.unmount();
  });

  test('closed after a refused Hide and opened again: nothing said from before', async () => {
    const v = await mount();
    v.answers.hide = async () => 'That account is not currently available to hide';
    await v.press('Hide');
    expect(v.footNote()).not.toBeNull();
    const close = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Close')[0]!;
    act(() => click(close));
    await pass(20);
    expect(v.dialog()).toBeNull();
    await v.openAgain();
    expect(v.footNote()).toBeNull();
    expect(v.button('Hide')!.getAttribute('aria-describedby')).toBeNull();
    v.unmount();
  });

  test('a refused Undo keeps it hidden and Undo to try again, which points at the words', async () => {
    const v = await mount();
    await v.press('Hide');
    v.answers.unhide = async () => 'This account is being forgotten. Finish forgetting it under Earlier accounts.';
    await v.press('Undo');
    expect(v.doneLine()!.textContent).toContain(HIDDEN);
    const undo = v.button('Undo')!;
    const said = v.dialog()!.findAll((e) => e.getAttribute('id') === undo.getAttribute('aria-describedby'))[0]!;
    expect(said.findAll((e) => e.getAttribute('role') === 'alert')[0]!.textContent).toContain('This account is being forgotten.');
    v.unmount();
  });

  test('while it hides: Hiding…, and nothing else acts or closes it', async () => {
    const v = await mount();
    let answer: (refused: string | null) => void = noop;
    v.answers.hide = () => new Promise((resolve) => (answer = resolve));
    await v.press('Hide');
    expect(v.button('Hiding…')).not.toBeNull();
    await v.press('Mark as closed…');
    const close = v.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Close')[0]!;
    act(() => click(close));
    await pass(20);
    expect(v.said).toEqual(['hide acc_checking']);
    expect(v.dialog()).not.toBeNull();
    act(() => answer(null));
    await pass(20);
    expect(v.doneLine()!.textContent).toContain(HIDDEN);
    v.unmount();
  });

  // The follow-up to the sheets review: focus fell to the page once Done
  // closed the sheet, its row gone with the account.
  test('Done: focus goes to Hidden at the bottom of Accounts, where the account went', async () => {
    const v = await mount();
    await v.openFromRow();
    await v.press('Hide');
    expect(v.row()).toBeNull();
    await v.press('Done');
    await pass(400);
    expect(v.dialog()).toBeNull();
    expect(dom.document.activeElement).toBe(v.hiddenToggle()!);
    v.unmount();
  });

  test('Done after Undo: focus goes to the account’s row, back on the list', async () => {
    const v = await mount();
    await v.openFromRow();
    const before = v.row();
    await v.press('Hide');
    await v.press('Undo');
    await v.press('Done');
    await pass(400);
    // A row drawn anew, not the one that opened the sheet.
    expect(v.row()).not.toBe(before);
    expect(dom.document.activeElement).toBe(v.row()!);
    v.unmount();
  });

  test('opened again after Done: the account, with nothing said from before', async () => {
    const v = await mount();
    await v.press('Hide');
    await v.press('Undo');
    await v.press('Done');
    expect(v.dialog()).toBeNull();
    await v.openAgain();
    expect(v.doneLine()).toBeNull();
    expect(v.footNote()).toBeNull();
    expect(v.footButtons()).toEqual(['Hide', 'Mark as closed…']);
    v.unmount();
  });
});
