import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type FakeElement } from './mini-dom';

// One account's sheet (rollout phase 3), which replaced the row that expanded
// in place and the buttons inside it: what it shows for each kind of account,
// which actions each kind gets (the ones the expanded row and the manual
// row's buttons had, behind the same gates), and that each action closes the
// sheet before opening its own. Rendered and used as a person would
// (react-dom/client over test/mini-dom.ts).

const dom = installDom();
const realFetch = globalThis.fetch;
// The sparkline and the investment views load their own data; here they wait.
globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: AccountSheet } = await import('@/components/AccountSheet');
type Props = import('@/components/AccountSheet').AccountSheetProps;
type Account = import('@/components/accounts-format').Account;
type Institution = import('@/components/accounts-format').Institution;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const account = (over: Partial<Account> = {}): Account => ({
  account_id: 'acc_checking',
  name: 'Total Checking',
  official_name: null,
  mask: '4421',
  type: 'depository',
  subtype: 'checking',
  balance: 1200,
  limit: null,
  currency: 'USD',
  ...over,
});
const plaid = (a: Account, over: Partial<Institution> = {}): Institution => ({
  institution_name: 'Chase',
  item_id: 'item_chase',
  accounts: [a],
  holdings: [],
  error: null,
  needs_reauth: false,
  ...over,
});
const typed = (a: Account): Institution => plaid(a, { institution_name: 'Wallet', item_id: 'manual:wallet', manual: true });
const fed = (a: Account): Institution => plaid(a, { institution_name: 'Alpine CU', item_id: 'connector:c1:alpine', manual: true, connector: 'simplefin' });

const props = (a: Account, inst: Institution, over: Partial<Props> = {}): Props => ({
  open: true,
  account: a,
  inst,
  shownCurrency: 'USD',
  saving: false,
  hiding: false,
  lifecycleBusy: false,
  onDismiss: noop,
  onHide: noop,
  onEnd: noop,
  onUpdate: noop,
  onAddTransaction: noop,
  onImport: noop,
  onImportHistory: noop,
  onDelete: noop,
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const footerOf = (html: string) => {
  const at = html.indexOf('<div class="sheet-footer">');
  return at < 0 ? '' : html.slice(at);
};
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((b) => b.trim() !== '');

/** Mounts the sheet, opens its ⋯ when it has one, and returns the item labels. */
function menuItems(p: Props): string[] {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(<AccountSheet {...p} />));
  const all = (dom.document.body as unknown as FakeElement).findAll(() => true);
  const trigger = all.find((e) => e.getAttribute('aria-haspopup') === 'menu');
  let labels: string[] = [];
  if (trigger) {
    act(() => click(trigger));
    labels = (dom.document.body as unknown as FakeElement).findAll((e) => e.getAttribute('role') === 'menuitem').map((e) => e.textContent);
  }
  act(() => root.unmount());
  host.parentNode?.removeChild(host);
  return labels;
}

describe('the account sheet', () => {
  test('a linked account: its balance and source, Hide and Close… in the footer, history import in its ⋯', () => {
    const a = account();
    const html = renderToStaticMarkup(<AccountSheet {...props(a, plaid(a))} />);
    expect(html).toContain('aria-label="Total Checking ••4421"');
    expect(text(html)).toContain('$1,200.00 Chase · checking');
    expect(buttons(footerOf(html))).toEqual(['Hide', 'Close…']);
    expect(footerOf(html)).toContain('aria-label="Total Checking: closed, no longer yours, or stop following"');
    expect(menuItems(props(a, plaid(a)))).toEqual(['Import history from a file']);
  });

  test('a typed account: Update balance and Add transaction too, and Import and Delete in its ⋯', () => {
    const a = account({ account_id: 'acc_cash', name: 'Cash', mask: null, currency: 'EUR', updated_at: '2026-10-08T15:05:00.000Z' });
    const html = renderToStaticMarkup(<AccountSheet {...props(a, typed(a))} />);
    expect(buttons(footerOf(html))).toEqual(['Hide', 'Close…', 'Add transaction', 'Update balance']);
    expect(text(html)).toMatch(/Wallet · checking · in EUR · Updated Oct 8, \d+:05 [AP]M/);
    expect(menuItems(props(a, typed(a)))).toEqual(['Import a file', 'Delete…']);
    // A hidden one isn't imported into.
    expect(menuItems(props({ ...a, hidden: true }, typed({ ...a, hidden: true })))).toEqual(['Delete…']);
  });

  test('an account SimpleFIN feeds: nothing typed-only, no history import, and no ⋯ with nothing in it', () => {
    const a = account({ updated_at: new Date('2026-10-08T12:00:00').toISOString() });
    const html = renderToStaticMarkup(<AccountSheet {...props(a, fed(a))} />);
    expect(buttons(footerOf(html))).toEqual(['Hide', 'Close…']);
    expect(text(html)).toContain('Balance as of Oct 8');
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  test('an account held for an answer says so in amber and offers no Hide', () => {
    const a = account({ held: { as_of: '2026-09-12' } });
    const html = renderToStaticMarkup(<AccountSheet {...props(a, plaid(a))} />);
    expect(html).toContain('<span class="badge warn">Last known balance, from Sep 12</span>');
    expect(buttons(footerOf(html))).toEqual(['Close…']);
  });

  test('a card: its payment line with Overdue in red, its limit used, and its terms', () => {
    const a = account({
      account_id: 'acc_card',
      name: 'Sapphire',
      mask: '9012',
      type: 'credit',
      subtype: 'credit card',
      balance: 1400,
      limit: 5000,
      liability: { kind: 'credit', apr: 24.99, apr_label: 'Purchase APR', minimum_payment: 35, next_due_date: '2026-10-24', last_statement_balance: 1288.4, last_payment_amount: 900, last_payment_date: '2026-09-25', is_overdue: true },
    });
    const html = renderToStaticMarkup(<AccountSheet {...props(a, plaid(a))} />);
    expect(html).toContain('<span class="badge neg">Overdue</span>');
    expect(text(html)).toContain('Overdue · 24.99% APR · min $35.00 · due Oct 24');
    expect(text(html)).toContain('28% of $5,000.00 limit');
    expect(text(html)).toContain('Statement balance $1,288.40');
    expect(text(html)).toContain('Last payment $900.00 on Sep 25');
  });

  test('a brokerage: its own positions with gain or loss, and its cash with its share', () => {
    const a = account({ account_id: 'acc_ind', name: 'Individual', type: 'investment', subtype: 'brokerage', balance: 10000 });
    const other = account({ account_id: 'acc_roth', name: 'Roth IRA', type: 'investment', subtype: 'ira', balance: 5000 });
    const inst = plaid(a, {
      institution_name: 'Fidelity',
      accounts: [a, other],
      holdings: [
        { account_id: 'acc_ind', name: 'Fidelity Government Money Market', quantity: 4200, value: 4200, cost_basis: 4200, is_cash_equivalent: true, security_type: 'cash' },
        { account_id: 'acc_ind', name: 'Total Market Index', quantity: 50, value: 5800, cost_basis: 5000, security_type: 'mutual fund' },
        { account_id: 'acc_roth', name: 'Target Date 2050', quantity: 10, value: 5000, cost_basis: 4000, security_type: 'mutual fund' },
      ],
    });
    const html = renderToStaticMarkup(<AccountSheet {...props(a, inst)} />);
    expect(text(html)).toContain('Total Market Index');
    expect(text(html)).not.toContain('Target Date 2050');
    expect(text(html)).toContain('+$800.00 · 16.0%');
    expect(text(html)).toMatch(/\$4,200\.00 (uninvested|in cash) · cash is \d+(\.\d)?% of holdings/);
  });

  test('each action closes the sheet first, then opens its own', () => {
    const a = account({ account_id: 'acc_cash', name: 'Cash', mask: null });
    const events: string[] = [];
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    act(() =>
      root.render(
        <AccountSheet
          {...props(a, typed(a), {
            onDismiss: () => events.push('dismiss'),
            onHide: (id) => events.push(`hide ${id}`),
            onEnd: (t) => events.push(`end ${t.account_id} ${t.institution}`),
            onAddTransaction: (id) => events.push(`add ${id}`),
            onUpdate: (m) => events.push(`update ${m.account_id} ${m.balance}`),
            onImport: (id) => events.push(`import ${id}`),
            onDelete: (m) => events.push(`delete ${m.account_id}`),
          })}
        />
      )
    );
    const body = dom.document.body as unknown as FakeElement;
    const press = (label: string) => {
      const [el] = body.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label);
      act(() => click(el));
    };
    for (const label of ['Hide', 'Close…', 'Add transaction', 'Update balance']) press(label);
    const [more] = body.findAll((e) => e.getAttribute('aria-haspopup') === 'menu');
    act(() => click(more));
    press('Import a file');
    act(() => click(more));
    press('Delete…');
    expect(events).toEqual([
      'dismiss', 'hide acc_cash',
      'dismiss', 'end acc_cash Wallet',
      'dismiss', 'add acc_cash',
      'dismiss', 'update acc_cash 1200',
      'dismiss', 'import acc_cash',
      'dismiss', 'delete acc_cash',
    ]);
    act(() => root.unmount());
  });

  test('nothing while the account is gone', () => {
    expect(renderToStaticMarkup(<AccountSheet {...props(account(), plaid(account()), { account: null })} />)).toBe('');
  });
});
