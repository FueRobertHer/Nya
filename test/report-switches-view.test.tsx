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
    const tab = v.item('Which report', 'Accountant')!;
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
    expect(v.item('Spending over', '6 months')?.getAttribute('aria-checked')).toBe('true');
    await press(v.item('Spending over', '3 months'));
    expect(v.item('Spending over', '3 months')?.getAttribute('aria-checked')).toBe('true');
    expect(v.item('Spending over', '6 months')?.getAttribute('aria-checked')).toBe('false');
    // The short items keep their meaning: the window's name is on screen over
    // them, as a field's is, and named for a screen reader once, on the group.
    const field = v.group('Spending over')!.parentNode as unknown as FakeElement;
    expect(field.getAttribute('class')).toBe('field');
    const name = elements(field)[0];
    expect([name.textContent, name.getAttribute('aria-hidden')]).toEqual(['Spending over', 'true']);
    await v.unmount();
  });
});

/** An element's own element children. */
const elements = (e: FakeElement) => e.childNodes.filter((n) => n.nodeType === 1) as unknown as FakeElement[];

/** The buttons of a report's action row, by their words, with their class. */
const actionRow = (host: FakeElement) => {
  const row = host.findAll((e) => (e.getAttribute('class') ?? '').includes('report-actions'))[0];
  if (!row) throw new Error('no action row');
  return row;
};
const buttons = (row: FakeElement) =>
  row
    .findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-haspopup') !== 'menu')
    .map((b) => [b.textContent.trim(), b.getAttribute('class')]);

describe('a report’s buttons on a phone', () => {
  test('the accountant’s: Print, the one filled button, last; the CSV, marking and stopped accounts under its ⋯', async () => {
    const v = await mount();
    const row = actionRow(v.host);
    expect(buttons(row)).toEqual([['Print or save as PDF', 'btn']]);
    const more = row.findAll((e) => e.getAttribute('aria-label') === 'More for this report')[0];
    expect(more?.getAttribute('aria-haspopup')).toBe('menu');
    expect(elements(row).at(-1)?.textContent.trim()).toBe('Print or save as PDF');
    // No report here (the route answers with an error), so the CSV waits.
    await press(more);
    const items = row.findAll((e) => e.getAttribute('role') === 'menuitem');
    expect(items.map((i) => [i.textContent.trim(), i.tagName, i.getAttribute('disabled') !== null])).toEqual([
      ['Download as CSV', 'BUTTON', true],
      ['Mark categories', 'BUTTON', true],
    ]);
    // Make report is tonal: Print is the one filled button in the card.
    await press(v.item('Kind of report', 'Date range'));
    const make = v.host.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Make report')[0];
    expect(make?.getAttribute('class')).toBe('btn secondary btn-block');
    await v.unmount();
  });

  test('Runway’s: Start over quiet, Save as a scenario tonal, Print filled and last', async () => {
    const v = await mount();
    await press(v.item('Which report', 'Runway'));
    await settle();
    expect(buttons(actionRow(v.host))).toEqual([
      ['Start over', 'btn ghost'],
      ['Save as a scenario', 'btn secondary'],
      ['Print or save as PDF', 'btn'],
    ]);
    await v.unmount();
  });
});
