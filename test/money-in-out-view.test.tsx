import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type, fakeClock, FakeElement, FakeEvent } from './mini-dom';
import { holdDay, HELD_DAY } from './held-day';

holdDay();

// An investment account's money in and out on its sheet (components/
// MoneyInOutFigures.tsx) and the form that sets them (components/
// MoneyInOutSheet.tsx): the figures for each state the totals can be in, and
// the form used as a person would (react-dom/client over test/mini-dom.ts),
// with what it says as they type and what it sends.

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
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: MoneyInOutFigures } = await import('@/components/MoneyInOutFigures');
const { default: MoneyInOutSheet } = await import('@/components/MoneyInOutSheet');
const { default: AccountSparkline } = await import('@/components/AccountSparkline');
type Target = import('@/components/MoneyInOutFigures').MoneyInOutTarget;
type Point = import('@/lib/growth').BalancePoint;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const pass = fakeClock({ now: HELD_DAY });

// The mocks' account: $2,000 in on the 1st of each month, and totals of
// $152,000 in and $12,000 out for Oct 15. Today is Nov 6.
const monthly = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'].map((date) => ({ date, amount: 2000 }));
const TOTALS = { in: 152_000, out: 12_000, as_of: '2026-10-15', currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' };
const POINTS: Point[] = [{ date: '2026-07-01', value: 160_000, estimated: true }, { date: '2026-07-12', value: 170_207.65 }, { date: '2026-11-02', value: 183_000 }];
const target = (over: Partial<Target> = {}): Target => ({
  account_id: 'acc_inv',
  item_id: 'item_vg',
  label: 'Individual ••4421 · Vanguard',
  currency: 'USD',
  totals: TOTALS,
  flows: monthly,
  flows_from: '2026-06-01',
  ...over,
});

/** The figures as markup. */
function figures(over: Partial<Target> = {}, props: Partial<React.ComponentProps<typeof MoneyInOutFigures>> = {}) {
  return renderToStaticMarkup(
    <MoneyInOutFigures target={target(over)} unreadable={false} flowsTo="2026-11-05" balance={184_520.4} points={POINTS} onEdit={() => {}} {...props} />
  );
}
/** Its words, each notice's spoken label ("Note:", "Caution:") with them. */
// The words as read: tags gone, and the one entity the figures' labels use.
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

describe('the figures', () => {
  // The figures are the chart's: its All reads all time (components/
  // NetWorthChart.tsx `allTime`). Above it, one line says where from.
  test('set: where all time counts from, and what moved since', () => {
    const html = figures();
    expect(text(html)).toBe('All time counts from your totals for Oct 15, and $2,000.00 deposited since. Change deposits and withdrawals');
    expect(html).not.toContain('stat-strip');
  });

  test('withdrawn since, or both', () => {
    const ira = { in: 120_000, out: 138_000, as_of: '2026-09-30', currency: 'USD', set_at: '2026-10-01T00:00:00.000Z' };
    const withdrawals = ['2026-10-01', '2026-11-01'].map((date) => ({ date, amount: -4000 }));
    expect(text(figures({ totals: ira, flows: withdrawals }, { balance: 115_846.2 }))).toBe(
      'All time counts from your totals for Sep 30, and $8,000.00 withdrawn since. Change deposits and withdrawals'
    );
    const both = [{ date: '2026-10-20', amount: -500 }, { date: '2026-11-01', amount: 2000 }];
    expect(text(figures({ flows: both }))).toStartWith('All time counts from your totals for Oct 15, and $2,000.00 deposited and $500.00 withdrawn since.');
  });

  test('nothing moved since: the day alone', () => {
    expect(text(figures({ flows: [] }))).toBe('All time counts from your totals for Oct 15. Change deposits and withdrawals');
  });

  // The chart starts its line with each range, so no one day is named.
  test('none set: what setting them shows, and where returns count from for now', () => {
    expect(text(figures({ totals: null }))).toBe(
      'Set your deposits and withdrawals to see your all-time returns. For now, returns count from the start of the range shown. Set deposits and withdrawals'
    );
  });

  test('none set on a Vanguard account with nothing imported: the Performance page named too', () => {
    expect(text(figures({ totals: null }, { importable: true }))).toBe(
      'Set your deposits and withdrawals to see your all-time returns. For now, returns count from the start of the range shown. To see further back, import Vanguard’s Performance page from ⋯. Set deposits and withdrawals'
    );
  });

  test('set for a day before the activity Nya now has: a note, no figures', () => {
    const html = figures({ totals: { ...TOTALS, as_of: '2026-05-01' } });
    expect(html).toContain('notice info');
    expect(text(html)).toBe(
      'Note: Change deposits and withdrawals to see your all-time returns again: your totals are for May 1, and Nya’s activity for this account now starts Jun 1. For now, returns count from the start of the range shown. Change deposits and withdrawals'
    );
  });

  test('totals that can’t be read: a caution, and nothing to change them with', () => {
    const html = figures({ totals: null }, { unreadable: true });
    expect(html).toContain('notice caution');
    expect(text(html)).toBe('Caution: Your deposits and withdrawals for this account can’t be read just now, so its returns count from the start of the range shown.');
  });

  test('the button opens the form on the account', () => {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const opened: Target[] = [];
    act(() => root.render(<MoneyInOutFigures target={target()} unreadable={false} flowsTo="2026-11-05" balance={1} points={POINTS} onEdit={(t) => opened.push(t)} />));
    act(() => click(host.findAll((e) => e.tagName === 'BUTTON')[0]));
    expect(opened).toEqual([target()]);
    act(() => root.unmount());
  });
});

describe('on the account’s sheet', () => {
  // InvestmentActivity, below the chart, says the activity failed: the
  // figures' place is given up rather than shimmering for good.
  test('activity that fails to load leaves no placeholder above the chart', async () => {
    globalThis.fetch = (async (url: string) =>
      url.startsWith('/api/account-history') ? Response.json({ points: [] }) : Response.json({ error: 'Failed' }, { status: 500 })) as unknown as typeof fetch;
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    act(() =>
      root.render(<AccountSparkline accountId="acc_fails" itemId="item_fails" investment moneyInOut={{ balance: 1, label: 'Individual', onEdit: () => {} }} />)
    );
    try {
      // Counted, never the nodes: a failure would print the page's whole tree.
      const placeholders = () => host.findAll((e) => (e.getAttribute('class') ?? '').includes('skeleton')).length;
      expect(placeholders()).toBe(1);
      await pass(20);
      expect(placeholders()).toBe(0);
      expect(host.textContent).toContain('Not enough history for this account yet');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('the form', () => {
  type Sent = { url: string; body: Record<string, unknown> };
  /** The sheet open on `t`, the server answering `answer`. */
  async function mount(t: Target, answer: () => Response = () => Response.json({ money_in_out: { ...TOTALS, set_at: '2026-11-06T12:00:00.000Z' } })) {
    const sent: Sent[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return answer();
    }) as unknown as typeof fetch;
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    let done = 0;
    act(() => root.render(<MoneyInOutSheet target={t} onClose={() => {}} onDone={() => done++} />));
    await pass(5);
    const sheet = () => host.findAll((e) => e.getAttribute('role') === 'dialog')[0];
    const field = (label: string) => sheet().findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0].findAll((e) => e.tagName === 'INPUT')[0];
    const notices = () => sheet().findAll((e) => (e.getAttribute('class') ?? '').startsWith('notice ')).map((e) => `${e.getAttribute('class')}: ${e.textContent}`);
    const button = (words: string) => host.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
    return {
      sent,
      done: () => done,
      sheet,
      field,
      notices,
      button,
      typeIn: (label: string, value: string) => act(() => type(field(label), value)),
      output: () => sheet().findAll((e) => e.tagName === 'OUTPUT')[0]?.textContent ?? null,
      submit: async () => {
        await act(async () => {
          sheet().findAll((e) => e.tagName === 'FORM')[0].dispatchEvent(new FakeEvent('submit'));
        });
        await pass(5);
      },
      unmount: () => act(() => root.unmount()),
    };
  }

  test('opens on the totals set, and says their net', async () => {
    const v = await mount(target());
    expect(v.field('Deposits').value).toBe('152000.00');
    expect(v.field('Withdrawals').value).toBe('12000.00');
    expect(v.field('As of').value).toBe('2026-10-15');
    expect(v.output()).toBe('Deposits & withdrawals: +$140,000.00');
    expect(v.button('Clear deposits and withdrawals')).not.toBeNull();
    v.unmount();
  });

  test('opens empty, on today, with nothing to clear', async () => {
    const v = await mount(target({ totals: null }));
    expect(v.field('Deposits').value).toBe('');
    expect(v.field('As of').value).toBe('2026-11-06');
    expect(v.output()).toBeNull();
    expect(v.button('Clear deposits and withdrawals')).toBeNull();
    v.unmount();
  });

  test('deposits below what Nya has seen go in: a caution, and it still saves', async () => {
    const v = await mount(target({ totals: null }));
    v.typeIn('Deposits', '5,000');
    expect(v.output()).toBe('Deposits & withdrawals: +$5,000.00');
    expect(v.notices()).toEqual([
      'notice caution: Caution: Check that it counts transfers, rollovers and your employer’s match: it’s less than the $8,000.00 Nya has seen go in from Jun 1 to today. If it’s your net, you can save it as it is.',
    ]);
    await v.submit();
    expect(v.sent).toEqual([{ url: '/api/money-in-out', body: { account_id: 'acc_inv', in: 5000, out: 0, as_of: '2026-11-06', currency: 'USD' } }]);
    expect(v.done()).toBe(1);
    v.unmount();
  });

  test('money that moved in the days up to the day is named', async () => {
    const v = await mount(target({ totals: null }));
    v.typeIn('As of', '2026-11-02');
    expect(v.notices()).toEqual(['notice info: Note: Make sure your brokerage’s figures include the $2,000.00 that went in on Nov 1: Nya counts it in these totals.']);
    v.unmount();
  });

  test('a day before the activity is an error, and nothing is sent', async () => {
    const v = await mount(target({ totals: null }));
    v.typeIn('Deposits', '200000');
    v.typeIn('As of', '2026-05-01');
    expect(v.sheet().textContent).toContain('Pick Jun 1 or later: Nya has no activity for this account before then.');
    expect(v.field('As of').getAttribute('aria-invalid')).toBe('true');
    await v.submit();
    expect(v.sent).toEqual([]);
    expect(v.done()).toBe(0);
    v.unmount();
  });

  test('an amount that isn’t one is said on its field after a try', async () => {
    const v = await mount(target({ totals: null }));
    v.typeIn('Withdrawals', 'lots');
    expect(v.sheet().textContent).not.toContain('Enter an amount');
    await v.submit();
    expect(v.sheet().textContent).toContain('Enter an amount, like');
    expect(v.field('Withdrawals').getAttribute('aria-invalid')).toBe('true');
    expect(v.sent).toEqual([]);
    v.unmount();
  });

  test('a refusal is said, and the sheet stays open on what was typed', async () => {
    const v = await mount(target({ totals: null }), () => Response.json({ error: 'Deposits and withdrawals are for investment accounts' }, { status: 400 }));
    v.typeIn('Deposits', '9000');
    await v.submit();
    expect(v.notices()).toEqual(['notice critical: Critical: Deposits and withdrawals are for investment accounts']);
    expect(v.field('Deposits').value).toBe('9000');
    expect(v.done()).toBe(0);
    v.unmount();
  });

  test('clear sends the account alone', async () => {
    const v = await mount(target(), () => Response.json({ money_in_out: null }));
    await act(async () => click(v.button('Clear deposits and withdrawals')!));
    await pass(5);
    expect(v.sent).toEqual([{ url: '/api/money-in-out', body: { account_id: 'acc_inv', clear: true } }]);
    expect(v.done()).toBe(1);
    v.unmount();
  });
});
