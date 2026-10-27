import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type FakeElement } from './mini-dom';
import { cashPosition } from '@/lib/forecast';
import { RUNWAY_WINDOWS, buildRunwayInputs } from '@/lib/report/runway';
import type { RunwayReport } from '@/lib/report/runway-read';
import { PLANNED, ROWS, TODAY } from './runway-fixture';

// The Reports page's switches as underline switches (look and feel, step
// 2a): which report, as tabs over the one panel it is drawn in; the kind of
// accountant's report and Runway's window, as radio groups. Used as a person
// would (react-dom/client over test/mini-dom.ts), with the routes answered
// here.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: ReportsPage } = await import('@/components/ReportsPage');

const position = cashPosition([
  {
    institution_name: 'Chase',
    accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 7000, currency: 'USD' }],
  },
]);
const built = buildRunwayInputs({ today: TODAY, position, rows: ROWS, planned: PLANNED, dismissed: [] });
const RUNWAY: RunwayReport = {
  ...built,
  version: 1,
  time_zone: 'America/New_York',
  generated_at: '2026-10-22T15:00:00.000Z',
  cash_accounts: built.position.included.map((a) => ({ account_id: a.account_id, name: a.name, institution: a.institution, balance: a.balance, manual: a.manual, as_of: '2026-10-21' })),
  owed_on_cards: 0,
  stale_balances: [],
  gaps: RUNWAY_WINDOWS.map((months) => ({ months, gaps: [] })),
  data_as_of: '2026-10-22T13:00:00.000Z',
  notes: [],
};

const asked: string[] = [];
(globalThis as any).fetch = async (url: string) => {
  asked.push(url);
  const path = url.split('?')[0];
  const body =
    path === '/api/reports/runway'
      ? { runway: RUNWAY }
      : path === '/api/runway-scenarios'
        ? { scenarios: [], unreadable_ids: [], unrecognised_ids: [] }
        : path === '/api/connectors/ended'
          ? { accounts: [], unreadable: [] }
          : { error: 'Not made here.' };
  return new Response(JSON.stringify(body), { status: 'error' in body ? 500 : 200, headers: { 'content-type': 'application/json' } });
};
const win = globalThis.window as any;
win.history = { replaceState: () => {} };
win.location.search = '';

const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(<ReportsPage />));
  await settle();
  const group = (label: string) => host.findAll((e) => e.getAttribute('aria-label') === label)[0] ?? null;
  const item = (label: string, words: string) => group(label)?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
  const panel = () => host.findAll((e) => e.getAttribute('id') === 'report-panel')[0] ?? null;
  return { host, group, item, panel, unmount: () => act(async () => root.unmount()) };
}

describe('which report', () => {
  test('tabs over the one panel, the report shown labelling it', async () => {
    const v = await mount();
    expect(v.group('Which report')?.getAttribute('role')).toBe('tablist');
    expect(v.group('Which report')?.getAttribute('class')).toBe('segmented report-choice');
    const tab = v.item('Which report', 'For your accountant')!;
    expect(tab.getAttribute('role')).toBe('tab');
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.getAttribute('aria-controls')).toBe('report-panel');
    expect(v.panel()?.getAttribute('role')).toBe('tabpanel');
    expect(v.panel()?.getAttribute('aria-labelledby')).toBe(tab.getAttribute('id'));

    await press(v.item('Which report', 'Runway'));
    expect(v.item('Which report', 'Runway')?.getAttribute('aria-selected')).toBe('true');
    expect(v.panel()?.getAttribute('aria-labelledby')).toBe('report-tab-runway');
    await v.unmount();
  });
});

describe('the kind of accountant’s report', () => {
  test('a radio group on Tax year; Date range chosen asks for that report', async () => {
    const v = await mount();
    expect(v.group('Kind of report')?.getAttribute('role')).toBe('radiogroup');
    expect(v.item('Kind of report', 'Tax year')?.getAttribute('aria-checked')).toBe('true');
    asked.length = 0;
    await press(v.item('Kind of report', 'Date range'));
    expect(v.item('Kind of report', 'Date range')?.getAttribute('aria-checked')).toBe('true');
    expect(asked.some((u) => u.startsWith('/api/reports?') && u.includes('kind=range'))).toBe(true);
    await v.unmount();
  });
});

describe('Runway’s window', () => {
  test('a radio group on the last six months; three chosen is checked', async () => {
    const v = await mount();
    await press(v.item('Which report', 'Runway'));
    await settle();
    expect(v.group('Spending over')?.getAttribute('role')).toBe('radiogroup');
    expect(v.item('Spending over', 'Last 6 months')?.getAttribute('aria-checked')).toBe('true');
    await press(v.item('Spending over', 'Last 3 months'));
    expect(v.item('Spending over', 'Last 3 months')?.getAttribute('aria-checked')).toBe('true');
    expect(v.item('Spending over', 'Last 6 months')?.getAttribute('aria-checked')).toBe('false');
    await v.unmount();
  });
});
