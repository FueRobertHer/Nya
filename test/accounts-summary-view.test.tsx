import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import AccountsSummary from '@/components/AccountsSummary';
import type { Account, Institution } from '@/components/accounts-format';
import { MASK, setAmountsHidden } from '@/lib/format';

// The Accounts tab's totals by type (rollout phase 3c), a stat strip in a
// card since the screen review: its figures, masked under hide amounts, and
// the words for what it can't count, under the figures in the same card.

const account = (over: Partial<Account> = {}): Account => ({
  account_id: 'acc',
  name: 'Account',
  official_name: null,
  mask: null,
  type: 'depository',
  subtype: 'checking',
  balance: 1200,
  limit: null,
  currency: 'USD',
  ...over,
});

const institution = (over: Partial<Institution> = {}): Institution => ({
  institution_name: 'Chase',
  item_id: 'item_chase',
  accounts: [account(), account({ type: 'credit', balance: 300 })],
  holdings: [],
  error: null,
  needs_reauth: false,
  ...over,
});

const render = (institutions: Institution[]) => renderToStaticMarkup(<AccountsSummary institutions={institutions} fx={null} main="USD" />);

/** One kind's cell in the strip: its label over its figure, then any badge. */
const cell = (label: string, figure: string, badge = '') =>
  `<li class="stat"><span class="stat-label">${label}</span><span class="stat-value money">${figure}</span>${badge}</li>`;

/** As in a browser's page: only there can amounts be hidden. */
function hidden<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const none = g.window === undefined;
  if (none) g.window = {};
  try {
    setAmountsHidden(true);
    return fn();
  } finally {
    setAmountsHidden(false);
    if (none) delete g.window;
  }
}

afterEach(() => setAmountsHidden(false));

describe('the line', () => {
  test('each kind with its figure, debts with a minus', () => {
    const html = render([institution()]);
    expect(html).toStartWith('<div class="card stack"><ul class="stat-strip" role="list" aria-label="Totals by kind">');
    expect(html).toContain(cell('Cash', '$1,200.00'));
    expect(html).toContain(cell('Credit', '−$300.00'));
    expect(html).not.toContain('notice');
  });

  test('all five kinds, each a cell of the one strip, in the tab’s order', () => {
    const html = render([
      institution({
        accounts: [
          account(),
          account({ type: 'credit', balance: 300 }),
          account({ type: 'investment', balance: 1234567.89 }),
          account({ type: 'loan', balance: 9000 }),
          account({ type: 'other', balance: 50 }),
        ],
      }),
    ]);
    const labels = [...html.matchAll(/<span class="stat-label">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Cash', 'Credit', 'Investments', 'Loans', 'Other']);
    expect(html).toContain(cell('Investments', '$1,234,567.89'));
  });

  test('one kind only would repeat the card: nothing', () => {
    expect(render([institution({ accounts: [account()] })])).toBe('');
  });

  test('hide amounts masks every figure', () => {
    const html = hidden(() => render([institution()]));
    expect(html).not.toContain('1,200');
    expect(html).not.toContain('300.00');
    expect(html).toContain(MASK);
  });
});

describe('what it can’t count', () => {
  test('a kind missing an account is marked, and the institution named in red', () => {
    const html = render([institution({ accounts: [account(), account({ type: 'credit', balance: null, held: { as_of: null } })] })]);
    expect(html).toContain('role="list"');
    expect(html).toContain(cell('Credit', '--', '<span class="badge neg">Incomplete</span>'));
    // On the figures: in the same card, under the strip.
    expect(html.indexOf('<div class="notice critical">')).toBeGreaterThan(html.indexOf('</ul>'));
    expect(html).toEndWith('</div></div>');
    expect(html).toContain('These totals leave out accounts at Chase; its card says more.');
  });

  test('of a kind it can’t tell: any total may be short, every institution named', () => {
    const html = render([
      institution({ error: 'Needs reconnecting', stale_as_of: '2026-10-21', stale_missing: 1, accounts: [account({ stale: true }), account({ type: 'credit', balance: 1, stale: true })] }),
      institution({ institution_name: 'Ally', item_id: 'a', error: 'Down', accounts: [] }),
    ]);
    expect(html).not.toContain('Incomplete');
    expect(html).toContain('These totals leave out accounts at Chase and Ally, and any total may be short; their cards say more.');
  });

  test('last known balances: one amber line naming the institutions', () => {
    const html = render([institution({ error: 'Down', stale_as_of: '2026-10-21', accounts: [account({ stale: true }), account({ type: 'credit', balance: 5, stale: true })] })]);
    expect(html).toContain('<div class="notice caution">');
    expect(html).toContain('Some figures at Chase aren’t current or complete yet; its card says what.');
    expect(html).not.toContain('notice critical');
  });

  test('mixed currencies with nothing to convert: a mixed kind says so instead of a figure', () => {
    const html = render([institution({ accounts: [account(), account({ currency: 'EUR' }), account({ type: 'credit', balance: 300 })] })]);
    expect(html).toContain(cell('Cash', 'Mixed'));
    expect(html).toContain('<p class="helper">Mixed currencies; totals aren’t converted.</p>');
  });
});
