import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// A bank whose transactions Plaid doesn't provide (or the person didn't
// allow), with files imported into its accounts (#52): a month the files
// cover for every one of its bank accounts and cards holds its transactions
// in the bank's place, and the four places that say a month may be short
// agree on it: the Activity month's notes, the cash flow chart beside it, a
// report on the month and the months budget rollover counts. A month the
// files don't cover is said to be short by all four.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid is not called here');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { connectWithoutTransactions } = await import('./api-fixture');
const { forgetEpochs } = await import('@/lib/sessions');
const { setAccountHidden } = await import('@/lib/hidden');
const { noTransactionsView, coveredOutOf, missingMonthNotes } = await import('@/lib/no-transactions');
const { cashFlow, cashFlowNotes, inPeriod } = await import('@/lib/cash-flow');
const { monthGapsOf } = await import('@/lib/rollover');
const { readMonthActivity } = await import('@/lib/budget-month');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { indexTaxonomy } = await import('@/lib/categories');
const { trailingMonths } = await import('@/lib/goal-projection');
const MonthBreakdown = (await import('@/components/MonthBreakdown')).default;
const routes = await import('@/app/api/history-import/route');
const transactionsRoute = await import('@/app/api/transactions/route');
const { readSpending, queryTransactions, readBudgets } = await import('@/lib/api-read');
const { readCashFlow } = await import('@/lib/api-cash-flow');

const ctx = TEST_CTX;
const NOW = new Date().toISOString().slice(0, 7);
// Two complete months before this one, oldest first.
const [M1, M2] = trailingMonths(NOW);
const lastDayOf = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const REFUSED = "Doesn't include the bank or card accounts at Credit Union: Plaid doesn't provide their transactions, so this month may be incomplete.";
/** A month's name, as the chart says one ("August"). */
const nameOf = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await connectWithoutTransactions(fake, {
    item_id: 'item_cu',
    name: 'Credit Union',
    accounts: [
      { account_id: 'acc_cu', type: 'depository' },
      { account_id: 'acc_cu_card', type: 'credit' },
    ],
    refused: { code: 'PRODUCTS_NOT_SUPPORTED' },
  });
});

const OPTIONS = { csv: { columns: { date: 0, description: 1, amount: 2, category: 3 }, sign: 'negative-out' } };
const csv = (rows: { date: string; name: string; amount: number; category: string }[]) =>
  ['Date,Description,Amount,Category', ...rows.map((r) => `${r.date},${r.name},${r.amount.toFixed(2)},${r.category}`)].join('\n');
function upload(meta: Record<string, unknown>, file: string): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'export.csv');
  form.set('meta', JSON.stringify({ file_name: 'export.csv', options: OPTIONS, ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
async function importCsv(account_id: string, file: string, covers: { from: string; to: string }) {
  const preview = await (await routes.POST(upload({ action: 'preview', account_id, covers }, file))).json();
  const res = await routes.POST(upload({ action: 'import', account_id, covers, review: preview.preview.review }, file));
  expect(res.status).toBe(200);
}
/** Both accounts' files, each covering the whole of M1 and nothing of M2. */
async function importM1() {
  const whole = { from: `${M1}-01`, to: lastDayOf(M1) };
  await importCsv('acc_cu', csv([{ date: `${M1}-10`, name: 'GROCER', amount: -42, category: 'food and drink' }]), whole);
  await importCsv('acc_cu_card', csv([{ date: `${M1}-12`, name: 'CAFE', amount: -8, category: 'food and drink' }]), whole);
}

/** What the four say of each month, from what is stored. */
async function whatEachSays() {
  const answer = await quietly(async () => (await transactionsRoute.GET(new Request('http://x/api/transactions'))).json());
  const view = noTransactionsView(answer);
  const activity = (m: string) => missingMonthNotes(view, m);
  const chart = (months: string[]) => {
    const period = { key: 'last-3-months' as const, months, from: `${months[0]}-01`, to: lastDayOf(months[months.length - 1]) };
    const ix = indexTaxonomy(answer.categories);
    const flow = cashFlow(answer.transactions, inPeriod(period), 'USD', ix);
    return cashFlowNotes({ flow, period, rows: answer.transactions, view, today: `${NOW}-15`, day: (d) => d }).gaps.filter((g) => g.includes('Credit Union'));
  };
  const months = await quietly(() => readMonthActivity(ctx, { since: `${M1}-01` }));
  const rollover = (m: string) => monthGapsOf(m, months.facts).filter((g) => g.kind === 'without');
  const report = async (m: string) => {
    const period = resolvePeriod({ kind: 'range', start: `${m}-01`, end: lastDayOf(m) }, 'UTC', Date.now());
    if ('error' in period) throw new Error(period.error);
    return (await quietly(() => readReport(ctx, period))).gaps.filter((g) => g.kind === 'refused');
  };
  return { answer, view, activity, chart, rollover, report };
}

describe('a bank whose transactions Plaid doesn’t provide, and files that cover a month for it', () => {
  test('the files’ coverage is sent with the connection, and only once a file was imported', async () => {
    let says = await whatEachSays();
    expect(says.answer.without_transactions).toEqual([{ item_id: 'item_cu', institution_name: 'Credit Union', reason: 'refused' }]);
    await importM1();
    says = await whatEachSays();
    expect(says.answer.without_transactions).toEqual([
      {
        item_id: 'item_cu',
        institution_name: 'Credit Union',
        reason: 'refused',
        files: [
          { covers: [{ from: `${M1}-01`, to: lastDayOf(M1) }], end: null },
          { covers: [{ from: `${M1}-01`, to: lastDayOf(M1) }], end: null },
        ],
      },
    ]);
    expect(coveredOutOf(says.view, M1).without).toEqual([]);
    expect(coveredOutOf(says.view, M2).without.map((w) => w.institution_name)).toEqual(['Credit Union']);
  });

  test('a month the files cover is complete in all four; a month they don’t is short in all four', async () => {
    await importM1();
    const says = await whatEachSays();
    // M1: covered for both accounts.
    expect(says.activity(M1)).toEqual([]);
    expect(says.chart([M1])).toEqual([]);
    expect(says.rollover(M1)).toEqual([]);
    expect(await says.report(M1)).toEqual([]);
    // M2: nothing covers it.
    expect(says.activity(M2)).toEqual([REFUSED]);
    expect(says.chart([M2])).toEqual([expect.stringMatching(new RegExp(`^Doesn't include the bank or card accounts at Credit Union: Plaid doesn't provide their transactions, so ${nameOf(M2)}( \\d{4})? may be incomplete\\.$`))]);
    expect(says.rollover(M2)).toEqual([{ kind: 'without', institution: 'Credit Union', reason: 'refused' }]);
    expect((await says.report(M2)).map((g) => g.kind)).toEqual(['refused']);
    // Over both, the chart names the month that is short, not the period.
    const both = says.chart([M1, M2]);
    expect(both).toHaveLength(1);
    expect([both[0].includes(nameOf(M2)), both[0].includes(nameOf(M1)), both[0].includes('this period')]).toEqual([true, false, false]);
  });

  test('one account’s files alone leave the month short in all four, unless the other is hidden', async () => {
    await importCsv('acc_cu', csv([{ date: `${M1}-10`, name: 'GROCER', amount: -42, category: 'food and drink' }]), { from: `${M1}-01`, to: lastDayOf(M1) });
    let says = await whatEachSays();
    expect(says.activity(M1)).toEqual([REFUSED]);
    expect(says.chart([M1])).toHaveLength(1);
    expect(says.rollover(M1)).toHaveLength(1);
    expect(await says.report(M1)).toHaveLength(1);
    // The card hidden: it needs no covering, as everywhere.
    await setAccountHidden(ctx, 'acc_cu_card', 'credit', true);
    says = await whatEachSays();
    expect(says.activity(M1)).toEqual([]);
    expect(says.chart([M1])).toEqual([]);
    expect(says.rollover(M1)).toEqual([]);
    expect(await says.report(M1)).toEqual([]);
  });

  test('the read-only API agrees with the chart: spending, the cash flow and the list over a month the files cover say nothing of the bank', async () => {
    await importM1();
    const of = (notes: string[]) => notes.filter((n) => n.includes('Credit Union'));
    const range = (m: string) => ({ from: `${m}-01`, to: lastDayOf(m) });
    const api = async (m: string) => [
      of((await quietly(() => readSpending(ctx, range(m)))).notes),
      of((await quietly(() => readCashFlow(ctx, range(m)))).notes),
      of((await quietly(() => queryTransactions(ctx, { ...range(m), limit: 50 }))).notes),
    ];
    // M1: its files hold its transactions, as in the chart.
    expect(await api(M1)).toEqual([[], [], []]);
    expect((await quietly(() => readSpending(ctx, range(M1)))).groups.length).toBeGreaterThan(0);
    // M2, and a range over both: nothing covers M2, so it is said, as the chart says it.
    for (const said of await api(M2)) expect(said).toHaveLength(1);
    const both = { from: `${M1}-01`, to: lastDayOf(M2) };
    expect(of((await quietly(() => readCashFlow(ctx, both))).notes)).toHaveLength(1);
  });

  test('the read-only API’s budgets agree with the Budgets tab: a month the files cover says nothing of the bank', async () => {
    await importM1();
    const says = await whatEachSays();
    const of = async (m: string) => (await quietly(() => readBudgets(ctx, { month: m }))).notes.filter((n) => n.includes('Credit Union'));
    // M1: covered, as the Budgets tab's month notes have it.
    expect(says.activity(M1)).toEqual([]);
    expect(await of(M1)).toEqual([]);
    // M2: nothing covers it, so both name it.
    expect(says.activity(M2)).toEqual([REFUSED]);
    expect(await of(M2)).toHaveLength(1);
  });

  test('the Activity tab says it under the month only where the files don’t cover it', async () => {
    await importM1();
    const says = await whatEachSays();
    // The only rows are the files', in M1: the month the tab opens on.
    const render = (view: typeof says.view) =>
      renderToStaticMarkup(
        createElement(MonthBreakdown, { txns: says.answer.transactions, notes: [], loading: false, taxonomy: says.answer.categories, withoutTransactions: view, onRecategorize: () => {}, onRename: () => {} })
      );
    // The month's own note (the chart's, on this month, which nothing
    // covers, names the month).
    const monthNote = 'Plaid doesn&#x27;t provide their transactions, so this month may be incomplete.';
    expect(render(says.view)).not.toContain(monthNote);
    // Without what the files cover (a payload from before it was sent), as before.
    expect(render({ ...says.view, without: says.view.without.map(({ files: _f, ...w }) => w) })).toContain(monthNote);
  });
});
