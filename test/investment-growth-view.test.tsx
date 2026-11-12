import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, fakeClock, pressThrough, type, FakeElement, FakeEvent, type FakeNode } from './mini-dom';
import { holdDay, HELD_DAY } from './held-day';

holdDay();

// Accounts > Investments (components/InvestmentGrowth.tsx), as a person sees
// it (react-dom/client over test/mini-dom.ts), on mocked history and
// activity: the chooser, the hero's returns and rate, the range's card and
// its rows, when All is all time, what it can't count, how it loads, and the
// hero under a finger.

const dom = installDom();
const realFetch = globalThis.fetch;

// The chart is laid out 352px wide, from the left of the screen, so a
// pointer's clientX is its viewBox x (as test/net-worth-hero-view.test.tsx).
const LAID_OUT = 352;
const rect = FakeElement.prototype.getBoundingClientRect;
FakeElement.prototype.getBoundingClientRect = function (this: FakeElement) {
  const r = rect.call(this);
  return this.tagName.toLowerCase() === 'svg' ? { ...r, width: LAID_OUT, right: LAID_OUT } : r;
};

afterAll(() => {
  globalThis.fetch = realFetch;
  FakeElement.prototype.getBoundingClientRect = rect;
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
const { setHideAmounts } = await import('@/components/hide-amounts');
type Institution = import('@/components/accounts-format').Institution;
type Target = import('@/components/MoneyInOutFigures').MoneyInOutTarget;
type Point = import('@/lib/growth').BalancePoint;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const pass = fakeClock({ now: HELD_DAY });

// Today is Nov 6, 2026; each account's last recorded day is Nov 5.
//   Individual (brokerage): $5,000 in on Mar 1, 100,000 to 120,000 this
//     year: +$15,000 returns; totals of $80,000 in.
//   Roth IRA: $2,000 in on Apr 15, 41,000 to 45,500: +$2,500; no totals.
//   401(k): recorded from Jul 12; $1,500 in, $500 out, 50,000 to 56,000:
//     +$5,000; totals of $30,000 in and $2,000 out.
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
const SUBTYPES: Record<string, string> = { ind: 'brokerage', roth: 'roth', k401: '401k', tfsa: 'tfsa', rh: 'brokerage', wf: 'ira' };
const ROTH_SET = { roth: { totals: { in: 20_000, out: 0, as_of: '2026-05-01' } } };

// Each test's accounts get their own ids: the activity is cached by account
// for a minute (components/InvestmentActivity.tsx), across tests too.
let run = 0;
type Answer = { status?: number; note?: string | null; unreadable?: boolean; totals?: Fixture['totals']; noActivity?: boolean };

function setup(
  opts: {
    answers?: Record<string, Answer>;
    currencies?: Record<string, string>;
    manual?: boolean;
    history?: number;
    only?: string[];
    flows?: Record<string, Fixture['flows']>;
    /** The buckets the person set (Plan > Allocation), by fixture key. */
    buckets?: Record<string, string>;
    /** Names other than the fixtures', by fixture key. */
    names?: Record<string, string>;
  } = {}
) {
  run++;
  const id = (k: string) => `${k}_${run}`;
  const acct = (k: string, name: string, mask: string, balance: number) => ({
    account_id: id(k),
    name: opts.names?.[k] ?? name,
    official_name: null,
    mask,
    type: 'investment',
    subtype: SUBTYPES[k] ?? null,
    balance,
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
  let linked = opts.only;
  const only = (k: string) => !linked || linked.includes(k);
  const build = (): Institution[] => [
    inst('vg', 'Vanguard', [...(only('ind') ? [acct('ind', 'Individual', '4421', 120_500)] : []), ...(only('roth') ? [acct('roth', 'Roth IRA', '3302', 45_600)] : [])]),
    inst('fid', 'Fidelity', only('k401') ? [acct('k401', '401(k)', '8810', 56_200)] : []),
    ...(opts.currencies?.tfsa || linked?.includes('tfsa') ? [inst('q', 'Questrade', [acct('tfsa', 'TFSA', '5506', 17_000)])] : []),
    ...(opts.manual
      ? [
          inst('manual', 'Manual', [acct('rh', 'Robinhood', '1290', 9000)], { manual: true }),
          inst('sf', 'Wealthfront', [acct('wf', 'Wealthfront', '7781', 3000)], { manual: true, connector: 'simplefin' }),
        ]
      : []),
  ].filter((i) => i.accounts.length > 0);
  let institutions = build();

  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/account-history') {
      calls.push('history');
      if (opts.history) return Response.json({ error: 'Failed' }, { status: opts.history });
      const ids = u.searchParams.get('ids')!.split(',');
      return Response.json({ histories: Object.fromEntries(ids.map((i) => [i, FIXTURES[i.replace(/_\d+$/, '')]?.points ?? []])) });
    }
    if (u.pathname === '/api/allocation-settings') {
      calls.push('settings');
      const buckets = Object.entries(opts.buckets ?? {}).map(([k, bucket]) => ({ account_id: id(k), bucket }));
      return Response.json({ settings: { v: 1, buckets, funds: [], accounts: [], target: null } });
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
      flows: none ? null : (opts.flows?.[key] ?? f.flows),
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
  function Tab({ refreshKey, institutions }: { refreshKey: string | null; institutions: Institution[] }) {
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
        <Sheet open={!!target} title="Deposits and withdrawals" onClose={() => setTarget(null)}>
          <p>The form</p>
        </Sheet>
      </>
    );
  }
  let refreshes = 0;
  let drawn: string | null = null;
  const draw = (refreshKey: string | null) => {
    drawn = refreshKey;
    act(() => root.render(<Tab refreshKey={refreshKey} institutions={institutions} />));
  };
  draw(null);
  const buttons = (text: string) => host.findAll((e) => e.tagName === 'BUTTON' && words(e) === text);
  const chooser = () => host.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-haspopup') === 'dialog')[0] ?? null;
  const sheet = () => host.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('aria-label') === 'Accounts')[0] ?? null;
  const inputs = (kind: string) =>
    sheet()!
      .findAll((e) => e.tagName === 'LABEL')
      .map((label) => ({ label, input: label.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('type') === kind)[0] }))
      .filter((r) => r.input)
      .map((r) => ({ name: words(r.label), checked: !!(r.input as unknown as { checked: boolean }).checked, input: r.input }));
  const change = async (input: FakeElement, on: boolean) => {
    act(() => {
      (input as unknown as { checked: boolean }).checked = on;
      click(input);
    });
    await pass(10);
  };
  return {
    host,
    root,
    calls,
    opened,
    forms,
    id,
    refresh: () => draw(`refresh ${++refreshes}`),
    /** The tab drawn again with these accounts linked (by fixture key). */
    relink: async (keys: string[]) => {
      linked = keys;
      institutions = build();
      draw(drawn);
      await pass(50);
    },
    close: () => act(() => closeSheet()),
    buttons,
    /** The chart's range switch. */
    range: (text: string) => act(() => click(buttons(text)[0])),
    /** The Accounts chip, which opens the sheet. */
    chooser,
    /** The sheet it opens. */
    sheet,
    /** The sheet's presets, by their words, and whether each is chosen. */
    presets: () => inputs('radio'),
    /** The sheet's accounts, by their words, and whether each is checked. */
    boxes: () => inputs('checkbox'),
    /** Choosing a preset by its name. */
    choose: (name: string) => change(inputs('radio').find((r) => r.name.startsWith(name))!.input, true),
    /** Checking or unchecking an account by its name. */
    tick: (name: string, on: boolean) => change(inputs('checkbox').find((b) => b.name.startsWith(name))!.input, on),
    /** A press, and what it starts let settle (a sheet slides in a frame later). */
    press: async (el: FakeElement) => {
      act(() => click(el));
      await pass(400);
    },
  };
}

/** An element's words, its parts spaced apart. */
const words = (n: FakeNode): string =>
  (n instanceof FakeElement ? n.childNodes.map(words).join(' ') : n.textContent).replace(/\s+/g, ' ').trim();
const byClass = (host: FakeElement, cls: string) => host.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes(cls));
const rows = (host: FakeElement) => byClass(host, 'list-row').map(words);
/** The hero's figure as a screen reader hears it: the whole amount. */
const figure = (host: FakeElement) => {
  const v = byClass(host, 'total-value')[0];
  const whole = byClass(v, 'visually-hidden')[0];
  return words(whole ?? v);
};
const heroLine = (host: FakeElement) => words(byClass(host, 'hero-delta')[0]);
const hero = (host: FakeElement) => words(byClass(host, 'investments-hero')[0]);
const card = (host: FakeElement) => words(byClass(host, 'card')[0]);

describe('the screen', () => {
  test('loading: placeholders for the figures, and rows waiting on their activity', () => {
    const { host, root } = setup();
    try {
      expect(figure(host)).toBe('Loading investment returns');
      expect(host.findAll((e) => e.getAttribute('aria-label') === 'Loading investment activity').length).toBe(1);
      expect(rows(host)).toEqual(['Individual ••4421 Vanguard · Loading its activity', 'Roth IRA ••3302 Vanguard · Loading its activity', '401(k) ••8810 Fidelity · Loading its activity']);
    } finally {
      act(() => root.unmount());
    }
  });

  test('year to date: the returns and the rate, the four figures, and a row for each account', async () => {
    const { host, root } = setup();
    try {
      await pass(50);
      expect(figure(host)).toBe('+$22,500.00');
      expect(heroLine(host)).toBe('▲ +13.6% rate of return · year to date');
      expect(hero(host)).toContain('401(k) ••8810 counts from Jul 12, its first recorded day.');
      expect(card(host)).toContain(
        'Year to date Beginning balance $191,000.00 Deposits & withdrawals +$8,000.00 Investment returns +$22,500.00 Ending balance $221,500.00 Jan 1 to yesterday. 401(k) ••8810’s beginning balance is its Jul 12 balance.'
      );
      expect(rows(host)).toEqual([
        'Individual ••4421 Vanguard +$15,000.00 returns · +14.4%',
        'Roth IRA ••3302 Vanguard +$2,500.00 returns · +5.9%',
        '401(k) ••8810 Fidelity · from Jul 12 +$5,000.00 returns · +9.8%',
      ]);
      // Only All asks for totals.
      expect(card(host)).not.toContain('Set deposits and withdrawals');
    } finally {
      act(() => root.unmount());
    }
  });

  test('All, one total missing: counted from the first recorded day, and what would make it all time', async () => {
    const { host, root, forms, id, range, buttons } = setup();
    try {
      await pass(50);
      range('All');
      expect(heroLine(host)).toStartWith('▲');
      expect(heroLine(host)).toEndWith('rate of return · since Dec 1, 2025');
      expect(figure(host)).toBe('+$28,500.00');
      expect(card(host)).toContain(
        'Since Dec 1, 2025 Beginning balance $185,000.00 Deposits & withdrawals +$8,000.00 Investment returns +$28,500.00 Ending balance $221,500.00'
      );
      expect(card(host)).toContain(
        'Set deposits and withdrawals for Roth IRA ••3302 to see all time for these accounts. Until then, All counts from Dec 1, 2025, the first recorded day.'
      );
      // Its one button opens the form on that account.
      act(() => click(buttons('Set deposits and withdrawals')[0]));
      expect(forms.map((f) => [f.account_id, f.label, f.flows_from])).toEqual([[id('roth'), 'Roth IRA ••3302 · Vanguard', '2025-06-01']]);
    } finally {
      act(() => root.unmount());
    }
  });

  test('All, every total set: all time, from $0.00, with no rate', async () => {
    const { host, root, range } = setup({ answers: ROTH_SET });
    try {
      await pass(50);
      range('All');
      expect(heroLine(host)).toBe('All time, since each account opened');
      expect(figure(host)).toBe('+$93,500.00');
      expect(card(host)).toContain(
        'All time Beginning balance $0.00 Deposits & withdrawals +$128,000.00 Investment returns +$93,500.00 Ending balance $221,500.00 Since each account opened, from the deposits and withdrawals you set for it.'
      );
      expect(rows(host)).toEqual(['Individual ••4421 Vanguard +$40,000.00 returns', 'Roth IRA ••3302 Vanguard +$25,500.00 returns', '401(k) ••8810 Fidelity +$28,000.00 returns']);
      expect(words(host)).not.toContain('Set deposits and withdrawals');
      // For all time each account counts from when it opened: no late start said.
      expect(hero(host)).not.toContain('counts from');
      // The rate's absence, said in the chart's info.
      expect(words(host)).toContain('There’s no rate of return for all time: Nya doesn’t know when the money before its records went in.');
    } finally {
      act(() => root.unmount());
    }
  });

  // Individual sends Roth IRA $3,000 in September: a withdrawal from one and a
  // deposit to the other, so the net is what it was without it.
  test('money moved between the accounts cancels out; the rows keep it', async () => {
    const { host, root } = setup({
      flows: { ind: [{ date: '2026-03-01', amount: 5000 }, { date: '2026-09-10', amount: -3000 }], roth: [{ date: '2026-04-15', amount: 2000 }, { date: '2026-09-12', amount: 3000 }] },
    });
    try {
      await pass(50);
      expect(card(host)).toContain('Deposits & withdrawals +$8,000.00 Investment returns +$22,500.00');
      expect(rows(host).slice(0, 2).map((r) => r.replace(/ · [+−][\d.]+%$/, ''))).toEqual(['Individual ••4421 Vanguard +$18,000.00 returns', 'Roth IRA ••3302 Vanguard −$500.00 returns']);
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

  test('two currencies: each added up on its own, the hero the home one', async () => {
    const { host, root } = setup({ currencies: { tfsa: 'CAD' } });
    try {
      await pass(50);
      expect(figure(host)).toBe('+$22,500.00');
      expect(hero(host)).toContain('In US dollars. Accounts in other currencies are added up on their own, below: nothing here is converted.');
      const cards = byClass(host, 'card').map(words);
      expect(cards[0]).toStartWith('US dollars, year to date Beginning balance $191,000.00');
      expect(cards[1]).toStartWith(
        'Canadian dollars, year to date Beginning balance CA$10,000.00 Deposits & withdrawals +CA$6,500.00 Investment returns +CA$500.00 Ending balance CA$17,000.00'
      );
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

  test('no linked investment accounts: what will be here', async () => {
    const { host, root } = setup({ only: [], manual: true });
    try {
      await pass(50);
      expect(words(host)).toContain('Linked investment accounts show their returns here.');
      expect(words(host)).toContain('Not counted: Robinhood ••1290 (manual) and Wealthfront ••7781 (through SimpleFIN).');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('the chooser', () => {
  test('presets check their accounts, and any set of accounts can be shown', async () => {
    const { host, root, chooser, sheet, presets, boxes, choose, tick, press } = setup({ manual: true });
    try {
      await pass(50);
      expect(words(chooser()!)).toBe('Accounts');
      expect(chooser()!.getAttribute('data-on')).toBeNull();

      await press(chooser()!);
      expect(presets().map((r) => [r.name, r.checked])).toEqual([
        ['All accounts', true],
        ['Retirement Tax-deferred and Roth', false],
        ['Non-retirement Brokerage, HSA, 529 and the rest', false],
      ]);
      expect(boxes().map((b) => [b.name, b.checked])).toEqual([
        ['Individual ••4421 Vanguard · Non-retirement', true],
        ['Roth IRA ••3302 Vanguard · Retirement', true],
        ['401(k) ••8810 Fidelity · Retirement', true],
      ]);

      // A preset checks its accounts; Show shows them.
      await choose('Retirement');
      expect(boxes().map((b) => b.checked)).toEqual([false, true, true]);
      await press(sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0]);
      expect(sheet()).toBeNull();
      expect(words(chooser()!)).toBe('Accounts: Retirement');
      expect(chooser()!.getAttribute('data-on')).toBe('');
      expect(card(host)).toContain('Beginning balance $91,000.00 Deposits & withdrawals +$3,000.00 Investment returns +$7,500.00 Ending balance $101,500.00');
      expect(rows(host).map((r) => r.split(' Vanguard')[0].split(' Fidelity')[0])).toEqual(['Roth IRA ••3302', '401(k) ••8810']);
      // The accounts not counted go with the preset.
      expect(words(host)).toContain('Not counted: Wealthfront ••7781 (through SimpleFIN). Nya has no investment activity for it.');
      expect(words(host)).not.toContain('Robinhood');

      // Any set: no preset is its own, so none shows as chosen.
      await press(chooser()!);
      expect(presets().map((r) => r.checked)).toEqual([false, true, false]);
      await tick('Roth IRA ••3302', false);
      await tick('Individual ••4421', true);
      expect(presets().map((r) => r.checked)).toEqual([false, false, false]);
      await press(sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0]);
      expect(words(chooser()!)).toBe('Accounts: 2 of 3');
      // The hero, the range's card, its rows and the rate follow the set.
      expect(figure(host)).toBe('+$20,000.00');
      expect(card(host)).toContain('Beginning balance $150,000.00 Deposits & withdrawals +$6,000.00 Investment returns +$20,000.00 Ending balance $176,000.00');
      expect(rows(host).map((r) => r.split(' Vanguard')[0].split(' Fidelity')[0])).toEqual(['Individual ••4421', '401(k) ••8810']);
      expect(heroLine(host)).toContain('rate of return');
      expect(words(host)).not.toContain('Not counted');

      // Checking the rest is All again; Cancel keeps what was shown.
      await press(chooser()!);
      await tick('Roth IRA ••3302', true);
      expect(presets().map((r) => r.checked)).toEqual([true, false, false]);
      await press(sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Cancel')[0]);
      expect(sheet()).toBeNull();
      expect(words(chooser()!)).toBe('Accounts: 2 of 3');
      expect(figure(host)).toBe('+$20,000.00');

      // Non-retirement is one account here: shown by the preset's name.
      await press(chooser()!);
      await choose('Non-retirement');
      await press(sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0]);
      expect(words(chooser()!)).toBe('Accounts: Non-retirement');
      expect(figure(host)).toBe('+$15,000.00');
      expect(words(host)).toContain('Not counted: Robinhood ••1290 (manual).');
    } finally {
      act(() => root.unmount());
    }
  });

  test('nothing checked: Show waits, and says to choose one', async () => {
    const { root, chooser, sheet, choose, tick, press } = setup();
    const show = () => sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0];
    try {
      await pass(50);
      await press(chooser()!);
      await choose('Retirement');
      await press(show());
      expect(words(chooser()!)).toBe('Accounts: Retirement');

      await press(chooser()!);
      // On the page throughout, so it is said as its words come.
      const status = () => sheet()!.findAll((e) => e.getAttribute('role') === 'status')[0];
      expect(words(status())).toBe('');
      for (const name of ['Roth IRA ••3302', '401(k) ••8810']) await tick(name, false);
      expect(show().getAttribute('disabled')).not.toBeNull();
      expect(words(status())).toBe('Choose at least one account.');
      // A press that gets past it anyway changes nothing: the sheet stays,
      // and what was shown is shown.
      await act(async () => void pressThrough(show()));
      await pass(400);
      expect(sheet()).not.toBeNull();
      expect(words(chooser()!)).toBe('Accounts: Retirement');
      await tick('Roth IRA ••3302', true);
      expect(show().getAttribute('disabled')).toBeNull();
      expect(words(status())).toBe('');
    } finally {
      act(() => root.unmount());
    }
  });

  test('a preset follows its accounts as they are linked; a set checked keeps to its own', async () => {
    const first = setup({ only: ['ind', 'roth'] });
    try {
      await pass(50);
      await first.press(first.chooser()!);
      await first.choose('Retirement');
      await first.press(first.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0]);
      expect(words(first.chooser()!)).toBe('Accounts: Retirement');
      expect(figure(first.host)).toBe('+$2,500.00');
      // A 401(k) is linked: Retirement takes it in.
      await first.relink(['ind', 'roth', 'k401']);
      expect(words(first.chooser()!)).toBe('Accounts: Retirement');
      expect(figure(first.host)).toBe('+$7,500.00');
    } finally {
      act(() => first.root.unmount());
    }

    const second = setup();
    try {
      await pass(50);
      await second.press(second.chooser()!);
      await second.tick('401(k) ••8810', false);
      await second.press(second.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0]);
      expect(words(second.chooser()!)).toBe('Accounts: 2 of 3');
      expect(figure(second.host)).toBe('+$17,500.00');
      // A TFSA is linked: the set checked doesn't take it in.
      await second.relink(['ind', 'roth', 'k401', 'tfsa']);
      expect(words(second.chooser()!)).toBe('Accounts: 2 of 4');
      expect(figure(second.host)).toBe('+$17,500.00');
      // Both of its accounts go: every account is shown again.
      await second.relink(['k401', 'tfsa']);
      expect(words(second.chooser()!)).toBe('Accounts');
      expect(figure(second.host)).toBe('+$5,500.00');
    } finally {
      act(() => second.root.unmount());
    }
  });

  test('an account that goes while the sheet is open is no longer checked', async () => {
    const { host, root, chooser, sheet, presets, boxes, press, relink } = setup();
    try {
      await pass(50);
      await press(chooser()!);
      await relink(['ind', 'k401']);
      // Every account left is checked: All, not a set of its own.
      expect(boxes().map((b) => [b.name.split(' ••')[0], b.checked])).toEqual([
        ['Individual', true],
        ['401(k)', true],
      ]);
      expect(presets().map((r) => [r.name.split(' ')[0], r.checked])).toEqual([
        ['All', true],
        ['Retirement', false],
        ['Non-retirement', false],
      ]);
      await press(sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0]);
      expect(words(chooser()!)).toBe('Accounts');
      // So it follows the accounts: the Roth IRA comes back with them.
      await relink(['ind', 'roth', 'k401']);
      expect(words(chooser()!)).toBe('Accounts');
      expect(figure(host)).toBe('+$22,500.00');
    } finally {
      act(() => root.unmount());
    }
  });

  // The bank's name may end in the account's last digits already: they are
  // written once, after the name, and stay in view when the chip cuts the
  // name short.
  test('one account: its own name, its last digits once', async () => {
    const { host, root, chooser, sheet, boxes, tick, press } = setup({ names: { ind: 'Brokerage Account Alex Morgan Joint ...4421' } });
    try {
      await pass(50);
      expect(rows(host)[0]).toStartWith('Brokerage Account Alex Morgan Joint ••4421 Vanguard');
      await press(chooser()!);
      expect(boxes()[0].name).toBe('Brokerage Account Alex Morgan Joint ••4421 Vanguard · Non-retirement');
      await tick('Roth IRA ••3302', false);
      await tick('401(k) ••8810', false);
      await press(sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0]);
      // Non-retirement's own account: the preset's name wins.
      expect(words(chooser()!)).toBe('Accounts: Non-retirement');
    } finally {
      act(() => root.unmount());
    }
    const two = setup({ names: { roth: 'Roth IRA Alex Morgan x3302' } });
    try {
      await pass(50);
      await two.press(two.chooser()!);
      await two.tick('Individual ••4421', false);
      await two.tick('401(k) ••8810', false);
      await two.press(two.sheet()!.findAll((e) => e.tagName === 'BUTTON' && words(e) === 'Show')[0]);
      const chip = two.chooser()!;
      expect(words(byClass(chip, 'chip-name')[0])).toBe('Accounts: Roth IRA Alex Morgan');
      expect(byClass(chip, 'chip-mask')[0].textContent).toBe(' ••3302');
      expect(figure(two.host)).toBe('+$2,500.00');
      expect(rows(two.host)).toEqual([]);
    } finally {
      act(() => two.root.unmount());
    }
  });

  test('the buckets the person set win over the kind of account', async () => {
    const { root, chooser, presets, boxes, press } = setup({ buckets: { ind: 'roth' } });
    try {
      await pass(50);
      // All three are retirement accounts now: no kinds to choose between.
      await press(chooser()!);
      expect(presets().map((r) => r.name)).toEqual(['All accounts']);
      expect(boxes().map((b) => b.name)).toEqual(['Individual ••4421 Vanguard', 'Roth IRA ••3302 Vanguard', '401(k) ••8810 Fidelity']);
    } finally {
      act(() => root.unmount());
    }
  });

  test('one account: nothing to choose', async () => {
    const { root, chooser, calls } = setup({ only: ['ind'] });
    try {
      await pass(50);
      expect(chooser()).toBeNull();
      expect(calls).not.toContain('settings');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('what the figures are short of', () => {
  test('activity that fails to load: a critical notice by the figures, and on its row', async () => {
    const { host, root, range } = setup({ answers: { roth: { status: 500 } } });
    try {
      await pass(50);
      expect(byClass(host, 'critical').map(words)).toEqual(['Critical: These figures leave out Roth IRA ••3302: its activity couldn’t be loaded just now.']);
      expect(card(host)).toContain('Beginning balance $150,000.00 Deposits & withdrawals +$6,000.00 Investment returns +$20,000.00 Ending balance $176,000.00');
      expect(rows(host)[1]).toBe('Roth IRA ••3302 Vanguard · Its activity couldn’t be loaded');
      // On All: all time waits for it, and there is no button to set its totals.
      range('All');
      expect(card(host)).toContain('All time is shown once Nya has the activity for Roth IRA ••3302.');
      expect(words(host)).not.toContain('Set deposits and withdrawals');
    } finally {
      act(() => root.unmount());
    }
  });

  test('activity still loading on another request: said as such', async () => {
    const { host, root } = setup({ answers: { roth: { note: ACTIVITY_STILL_LOADING } } });
    try {
      await pass(50);
      expect(byClass(host, 'critical').map(words)).toEqual(['Critical: These figures leave out Roth IRA ••3302: its activity is still loading, so refresh in a moment.']);
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
    const { host, root, range } = setup({ answers: { roth: { noActivity: true } } });
    try {
      await pass(50);
      expect(byClass(host, 'critical')).toHaveLength(0);
      expect(rows(host)[1]).toBe('Roth IRA ••3302 Vanguard · No investment activity yet');
      // The two left have their totals: all time across them.
      range('All');
      expect(card(host)).toContain('All time Beginning balance $0.00 Deposits & withdrawals +$108,000.00 Investment returns +$68,000.00 Ending balance $176,000.00');
    } finally {
      act(() => root.unmount());
    }
  });

  test('history that fails to load: said once, critical, and no figures', async () => {
    const { host, root } = setup({ history: 500 });
    try {
      await pass(50);
      expect(byClass(host, 'critical').map(words)).toEqual([
        'Critical: The accounts’ balance history couldn’t be loaded just now, so their returns over a range can’t be worked out. Refresh to try again.',
      ]);
      expect(figure(host)).toBe('Nothing to count yet');
      expect(byClass(host, 'card')).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('totals', () => {
  test('that can’t be read: a caution on All, and never a button', async () => {
    const { host, root, range } = setup({ answers: { roth: { unreadable: true } } });
    try {
      await pass(50);
      range('All');
      expect(byClass(host, 'caution').map(words)).toEqual([
        'Caution: Deposits and withdrawals for Roth IRA ••3302 can’t be read just now, so all-time returns across these accounts aren’t shown.',
      ]);
      expect(host.findAll((e) => e.tagName === 'BUTTON' && /^(Set|Change) deposits/.test(words(e)))).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });

  test('set for a day before the activity Nya has: change them', async () => {
    const { host, root, range, buttons } = setup({ answers: { roth: { totals: { in: 1, out: 0, as_of: '2025-01-01' } } } });
    try {
      await pass(50);
      range('All');
      expect(card(host)).toContain(
        'Change deposits and withdrawals for Roth IRA ••3302 to see all time for these accounts: its totals are for a day before the activity Nya now has. Until then, All counts from Dec 1, 2025, the first recorded day.'
      );
      expect(buttons('Change deposits and withdrawals')).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });

  test('several missing: named, with no button', async () => {
    const { host, root, range } = setup({ answers: { ind: { totals: null } } });
    try {
      await pass(50);
      range('All');
      expect(card(host)).toContain('Set deposits and withdrawals for Individual ••4421 and Roth IRA ••3302 to see all time for these accounts.');
      expect(host.findAll((e) => e.tagName === 'BUTTON' && words(e).startsWith('Set deposits'))).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });

  test('a save loads that account again', async () => {
    const { host, root, id, range } = setup();
    try {
      await pass(50);
      range('All');
      const totals = { in: 20_000, out: 0, as_of: '2026-05-01', currency: 'USD', set_at: '2026-11-06T00:00:00.000Z' };
      act(() => moneyInOutSaved(id('roth'), id('vg'), totals));
      await pass(50);
      expect(card(host)).toStartWith('All time Beginning balance $0.00 Deposits & withdrawals +$128,000.00');
    } finally {
      act(() => root.unmount());
    }
  });

  // The save takes the button away (all time takes its place), and the sheet
  // closes after: focus goes to the card's title, not to nothing.
  test('a save from its button: focus goes to the card’s title', async () => {
    const { root, id, close, range, buttons } = setup();
    try {
      await pass(50);
      range('All');
      const set = buttons('Set deposits and withdrawals')[0];
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
      expect(words(dom.document.activeElement)).toBe('All time');
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
      const activity = calls.filter((c) => c !== 'history' && c !== 'settings');
      expect(activity.slice(0, 2).sort()).toEqual(['ind', 'k401']);
      expect(activity[2]).toBe('roth');
    } finally {
      act(() => root.unmount());
    }
  });
});

// Individual alone, year to date: Jan 1, Jun 1 and Nov 5 on the chart.
describe('the hero, under a finger', () => {
  const xOf = (i: number) => 2 + (i * (LAID_OUT - 10)) / 2;
  const fire = (host: FakeElement, type: string, i: number) => {
    const svg = host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('role') === 'slider')[0];
    act(() => {
      svg.dispatchEvent(Object.assign(new FakeEvent(type), { pointerId: 1, button: 0, buttons: 1, pointerType: 'touch', clientX: xOf(i), clientY: 0 }));
    });
  };

  test('the returns to the day under it, the gap between the lines there; lifted, the range again', async () => {
    const { host, root } = setup({ only: ['ind'] });
    try {
      await pass(50);
      expect(figure(host)).toBe('+$15,000.00');
      fire(host, 'pointerdown', 0);
      fire(host, 'pointermove', 1);
      // Jun 1: $110,000 against $100,000 and the $5,000 deposited.
      expect(figure(host)).toBe('+$5,000.00');
      expect(words(byClass(host, 'hero-day')[0])).toBe('Jan 1 to Jun 1 · balance $110,000.00');
      fire(host, 'pointerup', 1);
      expect(figure(host)).toBe('+$15,000.00');
      expect(byClass(host, 'hero-day')).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });

  // Money in on Dec 30 may not be in Jan 1's balance yet, so the returns
  // count from Jun 1, while the chart starts with the range.
  test('a day before the returns count from says so, never a span run backwards', async () => {
    const { host, root } = setup({ only: ['ind'], flows: { ind: [{ date: '2025-12-30', amount: 1000 }, { date: '2026-03-01', amount: 5000 }] } });
    try {
      await pass(50);
      expect(figure(host)).toBe('+$10,000.00');
      fire(host, 'pointerdown', 1);
      fire(host, 'pointermove', 0);
      expect(figure(host)).toBe('$0.00');
      expect(words(byClass(host, 'hero-day')[0])).toBe('Jan 1 · balance $100,000.00 · returns count from Jun 1');
      fire(host, 'pointermove', 2);
      expect(words(byClass(host, 'hero-day')[0])).toBe('Jun 1 to yesterday · balance $120,000.00');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('hide amounts', () => {
  test('the chart is drawn again: its label and table hide their amounts too', async () => {
    const { host, root } = setup({ only: ['ind'] });
    const label = () => host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('role') === 'slider')[0].getAttribute('aria-label') ?? '';
    try {
      await pass(50);
      expect(label()).toContain('$120,000.00');
      act(() => setHideAmounts(true, null));
      expect(label()).not.toContain('$120,000.00');
      expect(figure(host)).not.toContain('15,000');
    } finally {
      act(() => setHideAmounts(false, null));
      act(() => root.unmount());
    }
  });
});
