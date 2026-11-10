import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, fakeClock, FakeElement, type FakeNode } from './mini-dom';
import { holdDay, HELD_DAY } from './held-day';

holdDay();

// Accounts > Summary's Investment growth card (components/InvestmentGrowth.tsx)
// as a person sees it (react-dom/client over test/mini-dom.ts), on mocked
// history and activity: its figures for each currency, Since you started and
// what stands in for it, what it can't count, and how it loads.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: InvestmentGrowth } = await import('@/components/InvestmentGrowth');
const { moneyInOutSaved } = await import('@/components/InvestmentActivity');
const { Sheet } = await import('@/components/Sheet');
const { ACTIVITY_STILL_LOADING } = await import('@/lib/growth-summary');
type Institution = import('@/components/accounts-format').Institution;
type Target = import('@/components/MoneyInOutFigures').MoneyInOutTarget;
type Point = import('@/lib/growth').BalancePoint;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const pass = fakeClock({ now: HELD_DAY });

// Today is Nov 6, 2026; each account's last recorded day is Nov 5.
//   Individual: $5,000 in on Mar 1, 100,000 to 120,000 this year: +$15,000 growth.
//   Roth IRA: $2,000 in on Apr 15, 41,000 to 45,500: +$2,500.
//   401(k): recorded from Jul 12; $1,500 in, $500 out, 50,000 to 56,000: +$5,000.
//   TFSA (CAD): CA$6,500 in, 10,000 to 17,000: +CA$500.
type Fixture = { points: Point[]; flows: { date: string; amount: number }[]; flows_from: string; totals?: { in: number; out: number; as_of: string } | null };
const FIXTURES: Record<string, Fixture> = {
  ind: {
    points: [{ date: '2025-12-01', value: 95_000 }, { date: '2026-01-01', value: 100_000 }, { date: '2026-06-01', value: 110_000 }, { date: '2026-11-05', value: 120_000 }],
    flows: [{ date: '2026-03-01', amount: 5000 }],
    flows_from: '2025-06-01',
    totals: { in: 80_000, out: 0, as_of: '2026-06-30' },
  },
  roth: {
    points: [{ date: '2025-12-01', value: 40_000 }, { date: '2026-01-02', value: 41_000 }, { date: '2026-11-05', value: 45_500 }],
    flows: [{ date: '2026-04-15', amount: 2000 }],
    flows_from: '2025-06-01',
    totals: null,
  },
  k401: {
    points: [{ date: '2026-07-12', value: 50_000 }, { date: '2026-11-05', value: 56_000 }],
    flows: [{ date: '2026-08-01', amount: 1500 }, { date: '2026-09-01', amount: -500 }],
    flows_from: '2026-07-01',
    totals: { in: 30_000, out: 2000, as_of: '2026-10-01' },
  },
  tfsa: {
    points: [{ date: '2025-12-01', value: 10_000 }, { date: '2026-01-01', value: 10_000 }, { date: '2026-11-05', value: 17_000 }],
    flows: [{ date: '2026-02-01', amount: 6500 }],
    flows_from: '2025-01-01',
    totals: null,
  },
};

// Each test's accounts get their own ids: the activity is cached by account
// for a minute (components/InvestmentActivity.tsx), across tests too.
let run = 0;
type Answer = { status?: number; note?: string | null; unreadable?: boolean; totals?: Fixture['totals']; noActivity?: boolean };

function setup(
  opts: { answers?: Record<string, Answer>; currencies?: Record<string, string>; manual?: boolean; history?: number; only?: string[]; balances?: Record<string, number | null> } = {}
) {
  run++;
  const id = (k: string) => `${k}_${run}`;
  const acct = (k: string, name: string, mask: string, balance: number) => ({
    account_id: id(k),
    name,
    official_name: null,
    mask,
    type: 'investment',
    subtype: null,
    balance: opts.balances && k in opts.balances ? opts.balances[k] : balance,
    limit: null,
    currency: opts.currencies?.[k] ?? 'USD',
  });
  const inst = (item: string, name: string, accounts: ReturnType<typeof acct>[], more: Partial<Institution> = {}): Institution => ({
    institution_name: name,
    item_id: id(item),
    accounts,
    holdings: [],
    error: null,
    needs_reauth: false,
    ...more,
  });
  const only = (k: string) => !opts.only || opts.only.includes(k);
  const institutions: Institution[] = [
    inst('vg', 'Vanguard', [...(only('ind') ? [acct('ind', 'Individual', '4421', 120_500)] : []), ...(only('roth') ? [acct('roth', 'Roth IRA', '3302', 45_600)] : [])]),
    inst('fid', 'Fidelity', only('k401') ? [acct('k401', '401(k)', '8810', 56_200)] : []),
    ...(opts.currencies?.tfsa ? [inst('q', 'Questrade', [acct('tfsa', 'TFSA', '5506', 17_000)])] : []),
    ...(opts.manual
      ? [
          inst('manual', 'Manual', [acct('rh', 'Robinhood', '1290', 9000)], { manual: true }),
          inst('sf', 'Wealthfront', [acct('wf', 'Wealthfront', '7781', 3000)], { manual: true, connector: 'simplefin' }),
        ]
      : []),
  ].filter((i) => i.accounts.length > 0);

  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/account-history') {
      calls.push('history');
      if (opts.history) return Response.json({ error: 'Failed' }, { status: opts.history });
      const ids = u.searchParams.get('ids')!.split(',');
      return Response.json({ histories: Object.fromEntries(ids.map((i) => [i, FIXTURES[i.replace(/_\d+$/, '')]?.points ?? []])) });
    }
    const key = u.searchParams.get('id')!.replace(/_\d+$/, '');
    calls.push(key);
    const a = opts.answers?.[key] ?? {};
    if (a.status) return Response.json({ error: 'Failed' }, { status: a.status });
    const f = FIXTURES[key];
    const none = a.noActivity || a.note;
    return Response.json({
      txns: none ? [] : [{ date: '2026-03-01' }],
      ytd_contributions: 0,
      ytd_rollovers: 0,
      flows: none ? null : f.flows,
      flows_from: none ? null : f.flows_from,
      flows_to: none ? null : '2026-11-05',
      note: a.note ?? null,
      money_in_out: a.unreadable ? null : 'totals' in a ? a.totals ? { ...a.totals, currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' } : null : f.totals ? { ...f.totals, currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' } : null,
      money_in_out_unreadable: !!a.unreadable,
    });
  }) as unknown as typeof fetch;

  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const opened: string[] = [];
  const forms: Target[] = [];
  // The money sheet the tab opens from a Set button, as a sheet with nothing
  // in it: what a test of focus needs.
  let closeSheet = () => {};
  function Tab({ refreshKey }: { refreshKey: string | null }) {
    const [target, setTarget] = React.useState<Target | null>(null);
    closeSheet = () => setTarget(null);
    return (
      <>
        <InvestmentGrowth
          institutions={institutions}
          main="USD"
          refreshKey={refreshKey}
          onOpenAccount={(item, account) => opened.push(`${item}:${account}`)}
          onMoneyInOut={(t) => {
            forms.push(t);
            setTarget(t);
          }}
        />
        <Sheet open={!!target} title="Money in and out" onClose={() => setTarget(null)}>
          <p>The form</p>
        </Sheet>
      </>
    );
  }
  let refreshes = 0;
  const draw = (refreshKey: string | null) => act(() => root.render(<Tab refreshKey={refreshKey} />));
  draw(null);
  return { host, root, calls, opened, forms, id, refresh: () => draw(`refresh ${++refreshes}`), close: () => act(() => closeSheet()) };
}

/** An element's words, its parts spaced apart. */
const words = (n: FakeNode): string =>
  (n instanceof FakeElement ? n.childNodes.map(words).join(' ') : n.textContent).replace(/\s+/g, ' ').trim();
const byClass = (host: FakeElement, cls: string) => host.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes(cls));
const rows = (host: FakeElement) => byClass(host, 'list-row').map(words);

describe('the card', () => {
  test('loading: a placeholder for the figures, and rows waiting on their activity', () => {
    const { host, root } = setup();
    try {
      expect(host.findAll((e) => e.getAttribute('aria-label') === 'Loading investment activity').length).toBe(1);
      expect(rows(host)).toEqual(['Individual ••4421 Vanguard · Loading its activity', 'Roth IRA ••3302 Vanguard · Loading its activity', '401(k) ••8810 Fidelity · Loading its activity']);
    } finally {
      act(() => root.unmount());
    }
  });

  test('one total missing: the range for each account and together, and what would show growth so far', async () => {
    const { host, root, forms, id } = setup();
    try {
      await pass(50);
      const text = words(host);
      expect(text).toContain('Year to date Money in $8,500.00 Money out $500.00 Net $8,000.00 Growth +$22,500.00');
      expect(text).toContain('401(k) ••8810 counts from Jul 12, its first recorded day.');
      expect(text).not.toContain('Since you started Money in');
      expect(text).toContain('Set money in and out for Roth IRA ••3302 to see your growth so far across these accounts.');
      expect(rows(host)).toEqual([
        'Individual ••4421 Vanguard · $5,000.00 in Net $80,000.00 · +$40,500.00 growth so far +$15,000.00 growth',
        'Roth IRA ••3302 Vanguard · $2,000.00 in No money in and out set yet +$2,500.00 growth',
        '401(k) ••8810 Fidelity · $1,500.00 in, $500.00 out, from Jul 12 Net $28,000.00 · +$28,200.00 growth so far +$5,000.00 growth',
      ]);
      // Its one button opens the form on that account.
      const set = host.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Set money in and out for Roth IRA ••3302');
      act(() => click(set[0]));
      expect(forms.map((f) => [f.account_id, f.label, f.flows_from])).toEqual([[id('roth'), 'Roth IRA ••3302 · Vanguard', '2025-06-01']]);
    } finally {
      act(() => root.unmount());
    }
  });

  test('every total set: Since you started across the accounts', async () => {
    const { host, root } = setup({ answers: { roth: { totals: { in: 20_000, out: 0, as_of: '2026-05-01' } } } });
    try {
      await pass(50);
      expect(words(host)).toContain('Since you started Money in $130,000.00 Money out $2,000.00 Net $128,000.00 Growth so far +$94,300.00');
      expect(words(host)).not.toContain('Set money in and out');
    } finally {
      act(() => root.unmount());
    }
  });

  test('a row opens its account', async () => {
    const { host, root, opened, id } = setup();
    try {
      await pass(50);
      act(() => click(byClass(host, 'list-row')[1]));
      expect(opened).toEqual([`${id('vg')}:${id('roth')}`]);
    } finally {
      act(() => root.unmount());
    }
  });

  test('two currencies: each added up on its own, named', async () => {
    const { host, root } = setup({ currencies: { tfsa: 'CAD' } });
    try {
      await pass(50);
      const text = words(host);
      expect(text).toContain('US dollars, year to date Money in $8,500.00');
      expect(text).toContain('Canadian dollars, year to date Money in CA$6,500.00 Money out CA$0.00 Net CA$6,500.00 Growth +CA$500.00');
      expect(text).toContain('Each currency is added up on its own: nothing here is converted.');
    } finally {
      act(() => root.unmount());
    }
  });

  test('not counted: manual and SimpleFIN accounts, said once', async () => {
    const { host, root } = setup({ manual: true });
    try {
      await pass(50);
      expect(byClass(host, 'notice').filter((n) => (n.getAttribute('class') ?? '').includes('info')).map(words)).toEqual([
        'Note: Not counted: Robinhood ••1290 (manual) and Wealthfront ••7781 (through SimpleFIN). Nya has no investment activity for them.',
      ]);
      expect(rows(host)).toHaveLength(3);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('what the figures are short of', () => {
  test('activity that fails to load: a critical notice under the figures, and on its row', async () => {
    const { host, root } = setup({ answers: { roth: { status: 500 } } });
    try {
      await pass(50);
      const critical = byClass(host, 'critical').map(words);
      expect(critical).toEqual(['Critical: These figures leave out Roth IRA ••3302: its activity couldn’t be loaded just now.']);
      expect(words(host)).toContain('Money in $6,500.00 Money out $500.00 Net $6,000.00 Growth +$20,000.00');
      expect(rows(host)[1]).toBe('Roth IRA ••3302 Vanguard · Its activity couldn’t be loaded');
      // Short of an account, so no Since you started, and no button to set its totals.
      expect(words(host)).not.toContain('Since you started Money in');
      expect(words(host)).not.toContain('Set money in and out for Roth IRA');
    } finally {
      act(() => root.unmount());
    }
  });

  test('activity still loading on another request: said as such', async () => {
    const { host, root } = setup({ answers: { roth: { note: ACTIVITY_STILL_LOADING } } });
    try {
      await pass(50);
      expect(byClass(host, 'critical').map(words)).toEqual([
        'Critical: These figures leave out Roth IRA ••3302: its activity is still loading, so refresh in a moment.',
      ]);
      expect(rows(host)[1]).toBe('Roth IRA ••3302 Vanguard · Its activity is still loading');
    } finally {
      act(() => root.unmount());
    }
  });

  // The activity is kept for a minute (components/InvestmentActivity.tsx),
  // but not that answer: the refresh the notice asks for asks again.
  test('a refresh asks again for activity that was still loading, and only that', async () => {
    const { root, calls, refresh } = setup({ answers: { roth: { note: ACTIVITY_STILL_LOADING } } });
    try {
      await pass(50);
      expect(calls.filter((c) => c === 'roth')).toHaveLength(1);
      refresh();
      await pass(50);
      expect(calls.filter((c) => c === 'roth')).toHaveLength(2);
      expect(calls.filter((c) => c === 'ind')).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });

  test('no investment activity at all: its row says so, and nothing is short', async () => {
    const { host, root } = setup({ answers: { roth: { noActivity: true } } });
    try {
      await pass(50);
      expect(byClass(host, 'critical')).toHaveLength(0);
      expect(rows(host)[1]).toBe('Roth IRA ••3302 Vanguard · No investment activity yet');
      // The two left have their totals: Since you started across them.
      expect(words(host)).toContain('Since you started Money in $110,000.00 Money out $2,000.00 Net $108,000.00 Growth so far +$68,700.00');
    } finally {
      act(() => root.unmount());
    }
  });

  test('history that fails to load: said once, critical', async () => {
    const { host, root } = setup({ history: 500 });
    try {
      await pass(50);
      expect(byClass(host, 'critical').map(words)).toEqual([
        'Critical: The accounts’ balance history couldn’t be loaded just now, so their growth over a range can’t be worked out. Refresh to try again.',
      ]);
      expect(words(host)).not.toContain('Year to date');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('totals', () => {
  test('that can’t be read: a caution, and never a button', async () => {
    const { host, root } = setup({ answers: { roth: { unreadable: true } } });
    try {
      await pass(50);
      expect(byClass(host, 'caution').map(words)).toEqual([
        'Caution: Money in and out for Roth IRA ••3302 can’t be read just now, so growth so far across these accounts isn’t shown.',
      ]);
      expect(rows(host)[1]).toBe('Roth IRA ••3302 Vanguard · $2,000.00 in Money in and out can’t be read just now +$2,500.00 growth');
      expect(host.findAll((e) => e.tagName === 'BUTTON' && words(e).startsWith('Set money'))).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });

  test('set for a day before the activity Nya has: change them', async () => {
    const { host, root } = setup({ answers: { roth: { totals: { in: 1, out: 0, as_of: '2025-01-01' } } } });
    try {
      await pass(50);
      expect(words(host)).toContain(
        'Change money in and out for Roth IRA ••3302 to see your growth so far across these accounts: its totals are for a day before the activity Nya now has.'
      );
      expect(host.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Change money in and out for Roth IRA ••3302')).toHaveLength(1);
      expect(rows(host)[1]).toContain('Money in and out need changing');
    } finally {
      act(() => root.unmount());
    }
  });

  test('set, with no balance to measure growth so far by: said, not left out', async () => {
    const { host, root } = setup({ answers: { roth: { totals: { in: 20_000, out: 0, as_of: '2026-05-01' } } }, balances: { ind: null } });
    try {
      await pass(50);
      expect(words(host)).toContain('Nya has no balance for Individual ••4421 just now, so growth so far across these accounts isn’t shown.');
      expect(words(host)).not.toContain('Since you started Money in');
      expect(rows(host)[0]).toBe('Individual ••4421 Vanguard · $5,000.00 in Net $80,000.00 +$15,000.00 growth');
    } finally {
      act(() => root.unmount());
    }
  });

  test('several missing: named, with no button', async () => {
    const { host, root } = setup({ answers: { ind: { totals: null } } });
    try {
      await pass(50);
      expect(words(host)).toContain('Set money in and out for Individual ••4421 and Roth IRA ••3302 to see your growth so far across these accounts.');
      expect(host.findAll((e) => e.tagName === 'BUTTON' && words(e).startsWith('Set money'))).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });

  test('a save loads that account again', async () => {
    const { host, root, id } = setup();
    try {
      await pass(50);
      const totals = { in: 20_000, out: 0, as_of: '2026-05-01', currency: 'USD', set_at: '2026-11-06T00:00:00.000Z' };
      act(() => moneyInOutSaved(id('roth'), id('vg'), totals));
      await pass(50);
      expect(rows(host)[1]).toBe('Roth IRA ••3302 Vanguard · $2,000.00 in Net $20,000.00 · +$25,600.00 growth so far +$2,500.00 growth');
      expect(words(host)).toContain('Since you started Money in $130,000.00');
    } finally {
      act(() => root.unmount());
    }
  });

  // The save takes the button away (Since you started takes its place), and
  // the sheet closes after: focus goes to that heading, not to nothing.
  test('a save from its button: focus goes to Since you started', async () => {
    const { host, root, id, close } = setup();
    try {
      await pass(50);
      const set = host.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Set money in and out for Roth IRA ••3302')[0];
      act(() => {
        set.focus();
        click(set);
      });
      await pass(50);
      expect(dom.document.activeElement.getAttribute('role')).toBe('dialog');
      const totals = { in: 20_000, out: 0, as_of: '2026-05-01', currency: 'USD', set_at: '2026-11-06T00:00:00.000Z' };
      act(() => moneyInOutSaved(id('roth'), id('vg'), totals));
      await pass(50);
      expect(set.isConnected).toBe(false);
      close();
      await pass(50);
      expect(words(dom.document.activeElement)).toBe('Since you started');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('loading', () => {
  // The activity route syncs a connection's whole store: a second account's
  // request while the first holds it would only hear "still loading".
  test('one account per connection first, then the rest; the history in one read', async () => {
    const { root, calls } = setup();
    try {
      await pass(50);
      expect(calls.filter((c) => c === 'history')).toHaveLength(1);
      const activity = calls.filter((c) => c !== 'history');
      expect(activity.slice(0, 2).sort()).toEqual(['ind', 'k401']);
      expect(activity[2]).toBe('roth');
    } finally {
      act(() => root.unmount());
    }
  });

  test('the range switch changes what is counted', async () => {
    const { host, root } = setup();
    try {
      await pass(50);
      const all = host.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'All');
      act(() => click(all[0]));
      // From Dec 1: Individual 95,000 to 120,000 with $5,000 in, +$20,000;
      // Roth IRA 40,000 to 45,500 with $2,000 in, +$3,500; the 401(k) as before.
      expect(words(host)).toContain('Since Dec 1, 2025 Money in $8,500.00 Money out $500.00 Net $8,000.00 Growth +$28,500.00');
    } finally {
      act(() => root.unmount());
    }
  });

  test('no linked investment accounts: what will be here', async () => {
    const { host, root } = setup({ only: [], manual: true });
    try {
      await pass(50);
      expect(words(host)).toContain('Linked investment accounts show their growth here.');
      expect(words(host)).toContain('Not counted: Robinhood ••1290 (manual) and Wealthfront ••7781 (through SimpleFIN).');
    } finally {
      act(() => root.unmount());
    }
  });
});
