import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import AccountsSummary from '@/components/AccountsSummary';
import type { Account, Institution } from '@/components/accounts-format';
import { MASK, setAmountsHidden } from '@/lib/format';

// The Accounts tab's line by type (rollout phase 3c): its figures, masked
// under hide amounts, and the words for what it can't count.

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
    expect(html).toContain('<li>Cash <span class="money">$1,200.00</span></li>');
    expect(html).toContain('<li>Credit <span class="money">-$300.00</span></li>');
    expect(html).not.toContain('notice');
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
    expect(html).toContain('Credit <span class="money">$0.00</span><span class="badge neg">Incomplete</span>');
    expect(html).toContain('<div class="notice critical">');
    expect(html).toContain('These totals leave out accounts at Chase; its card says which.');
  });

  test('of a kind it can’t tell: any total may be short, every institution named', () => {
    const html = render([
      institution({ error: 'Needs reconnecting', stale_as_of: '2026-10-21', stale_missing: 1, accounts: [account({ stale: true }), account({ type: 'credit', balance: 1, stale: true })] }),
      institution({ institution_name: 'Ally', item_id: 'a', error: 'Down', accounts: [] }),
    ]);
    expect(html).not.toContain('Incomplete');
    expect(html).toContain('These totals leave out accounts at Chase and Ally, and any of them may be short; their cards say which.');
  });

  test('last known balances: one amber line naming the institutions', () => {
    const html = render([institution({ error: 'Down', stale_as_of: '2026-10-21', accounts: [account({ stale: true }), account({ type: 'credit', balance: 5, stale: true })] })]);
    expect(html).toContain('<div class="notice caution">');
    expect(html).toContain('Some figures at Chase aren’t current or complete yet; its card says what.');
    expect(html).not.toContain('notice critical');
  });

  test('mixed currencies with nothing to convert: a mixed kind says so instead of a figure', () => {
    const html = render([institution({ accounts: [account(), account({ currency: 'EUR' }), account({ type: 'credit', balance: 300 })] })]);
    expect(html).toContain('<li>Cash <span class="money">Mixed</span></li>');
    expect(html).toContain('<p class="helper">Mixed currencies; totals aren’t converted.</p>');
  });
});
