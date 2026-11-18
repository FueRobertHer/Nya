import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { installDom, trackRoots, click, type, type FakeElement } from './mini-dom';
import { cashPosition } from '@/lib/forecast';
import { RUNWAY_WINDOWS, buildRunwayInputs } from '@/lib/report/runway';
import type { RunwayReport } from '@/lib/report/runway-read';
import { PLANNED, ROWS, TODAY } from './runway-fixture';

// Runway's saved scenarios on the page (components/RunwayReport.tsx): their
// card sits with "Save as a scenario", right after the what-if in the
// report's first page, never after the whole report; and a scenario saved
// through its sheet shows there, as the real route (app/api/runway-scenarios)
// stored it on test/fake-redis.ts. Used as a person would (react-dom/client
// over test/mini-dom.ts). As test/plan-tab-copies.test.tsx says, a rendered
// element never goes into toEqual or another matcher that diffs.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: RunwayReportPage } = await import('@/components/RunwayReport');
const scenarios = await import('@/app/api/runway-scenarios/route');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

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

// The runway is answered here; the scenarios go to their real route.
let inflight = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://nya.test');
  const method = init?.method ?? 'GET';
  inflight++;
  try {
    if (url.pathname === '/api/reports/runway') return Response.json({ runway: RUNWAY });
    if (url.pathname === '/api/runway-scenarios') {
      if (method === 'GET') return await scenarios.GET();
      const req = new Request(url, { method, headers: init?.headers, body: init?.body });
      return await (method === 'POST' ? scenarios.POST(req) : scenarios.DELETE(req));
    }
    return Response.json({ error: 'Not here.' }, { status: 404 });
  } finally {
    inflight--;
  }
}) as typeof fetch;

/** Until no route has been answering for three steps: a route seals what it
 *  stores on a real thread (crypto.subtle), so this waits for it. */
async function settle() {
  for (let quiet = 0; quiet < 3; ) {
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    quiet = inflight === 0 ? quiet + 1 : 0;
  }
}

const classOf = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
const press = async (el: FakeElement | null | undefined) => {
  if (!el) throw new Error('nothing to press');
  await act(async () => click(el));
  await settle();
};

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(<RunwayReportPage />));
  await settle();
  const all = () => host.findAll(() => true);
  const first = () => host.findAll((e) => e.tagName === 'SECTION' && classOf(e).includes('report-first'))[0] ?? null;
  const whatIf = () => host.findAll((e) => classOf(e).includes('runway-controls'))[0] ?? null;
  const savedCard = () => host.findAll((e) => classOf(e).includes('card') && e.textContent.startsWith('Saved scenarios'))[0] ?? null;
  const workedOut = () => host.findAll((e) => e.tagName === 'SECTION' && e.getAttribute('aria-label') === 'What it is worked out from')[0] ?? null;
  const button = (within: FakeElement | null, words: string) => within?.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === words)[0] ?? null;
  const sheet = () => host.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('aria-label') === 'Save as a scenario')[0] ?? null;
  return { host, all, first, whatIf, savedCard, workedOut, button, sheet, unmount: () => act(async () => root.unmount()) };
}

describe('the saved scenarios card', () => {
  test('sits with Save as a scenario: right after the what-if, in the report’s first page, before what it is worked out from; for the screen only', async () => {
    const v = await mount();
    const first = v.first();
    const whatIf = v.whatIf();
    const card = v.savedCard();
    expect(first !== null && whatIf !== null && card !== null).toBe(true);
    // In the first page, the what-if's next sibling.
    expect(card!.parentNode === first).toBe(true);
    expect(card!.previousElementSibling === whatIf).toBe(true);
    expect(v.button(whatIf, 'Save as a scenario') !== null).toBe(true);
    // Never after the whole report: before what it is worked out from.
    const order = v.all();
    expect(order.indexOf(card!)).toBeLessThan(order.indexOf(v.workedOut()!));
    expect(v.workedOut()!.contains(card)).toBe(false);
    // On paper neither shows.
    expect(classOf(card!)).toContain('no-print');
    expect(classOf(whatIf!)).toContain('no-print');
    expect(card!.textContent).toContain('None yet. Change the what-if above, then save it to come back to it.');
    await v.unmount();
  });

  test('a scenario saved through the sheet shows in that card, as the route stored it', async () => {
    const v = await mount();
    const lower = v.whatIf()!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('aria-label') === 'Spending lower by, a month, in USD')[0];
    await act(async () => type(lower!, '250'));
    await settle();
    await press(v.button(v.whatIf(), 'Save as a scenario'));
    const sheet = v.sheet();
    expect(sheet !== null).toBe(true);
    const name = sheet!.findAll((e) => e.tagName === 'INPUT' && e.getAttribute('placeholder') === 'If I took a year off')[0];
    await act(async () => type(name!, 'If I quit'));
    await settle();
    await press(v.button(sheet, 'Save'));
    // The sheet closes, and the card beside the button lists it.
    expect(v.sheet() === null || v.sheet()!.getAttribute('data-open') === 'false').toBe(true);
    const card = v.savedCard()!;
    expect(card.previousElementSibling === v.whatIf()).toBe(true);
    expect(card.textContent).toContain('If I quit');
    expect(card.textContent).toContain('spending lower by $250.00 a month');
    expect(v.button(card, 'Apply') !== null && v.button(card, 'Delete') !== null).toBe(true);
    expect(card.textContent).not.toContain('None yet.');
    // What the route keeps: the settings, by name.
    const stored = await (await scenarios.GET()).json();
    expect(stored.scenarios.map((s: { name: string; lower_by: number; currency: string | null }) => [s.name, s.lower_by, s.currency])).toEqual([['If I quit', 250, 'USD']]);
    await v.unmount();
  });
});
