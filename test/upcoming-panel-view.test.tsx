import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, FakeElement, FakeEvent } from './mini-dom';
import { CAR, REFUND, RENT_AND_PAY, SCENES, chase, derived, txn, type UpcomingScene } from './upcoming-notes-fixture';
import { PLANNED_TEXT } from '@/components/upcoming-notes';

// Budgets > Upcoming (rollout phase 6a3, docs/design/information-
// architecture.md#budgets), used as a person would (react-dom/client over
// test/mini-dom.ts): the notice, the forecast, List or Calendar, Recurring and
// Planned, in that order; the two views as tabs, both mounted; the forecast's
// range moving the list's end; the warning as a row that opens its sheet,
// saved through the real store (lib/whole-list-store.ts) as the dashboard
// wires it, a refused save keeping the sheet open on what was typed and the
// planned items drawn while the store reads them again; and the what-if
// sheet's words at their levels.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: UpcomingPanel } = await import('@/components/UpcomingPanel');
const { default: BudgetsTab } = await import('@/components/BudgetsTab');
const { createWholeListStore } = await import('@/lib/whole-list-store');
const { EMPTY_PLANNED, isPlanned } = await import('@/lib/planned');
const { addDays } = await import('@/lib/recurring');
const { localDate } = await import('@/lib/local-date');
type Planned = import('@/lib/planned').Planned;
type ListState = import('@/lib/whole-list-store').ListState<Planned>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

/** The time a sheet takes to slide in (one frame), or out. */
const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

function harness(host: FakeElement) {
  const all = (test: (e: FakeElement) => boolean) => host.findAll(test);
  const cls = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
  const button = (label: string, within: FakeElement = host) =>
    within.findAll((e) => e.tagName === 'BUTTON' && (e.textContent.trim() === label || e.getAttribute('aria-label') === label))[0] ?? null;
  /** The sheet on the page (not one sliding out). */
  const dialog = () => all((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const notices = (within: FakeElement | null = dialog()) => within?.findAll((e) => cls(e)[0] === 'notice' && e.tagName === 'DIV').map((e) => `${cls(e)[1]}: ${e.textContent}`) ?? [];
  const warnRow = () => all((e) => (e.tagName === 'BUTTON' || e.tagName === 'DIV') && cls(e).includes('list-row') && e.textContent.startsWith('Warns below'))[0] ?? null;
  const warnTitle = () => warnRow()?.findAll((e) => cls(e).includes('list-row-title'))[0]?.textContent ?? null;
  const warnSub = () => warnRow()?.findAll((e) => cls(e).includes('list-row-sub'))[0]?.textContent ?? null;
  const field = (label: string) => dialog()?.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]?.findAll((e) => e.tagName === 'INPUT')[0] ?? null;
  const radio = (label: string) => all((e) => e.getAttribute('role') === 'radio' && e.textContent === label)[0];
  const viewTab = (label: string) => all((e) => e.getAttribute('role') === 'tab' && e.getAttribute('id')?.startsWith('upcoming-tab-') === true && e.textContent === label)[0];
  const viewPanel = (v: 'list' | 'calendar') => all((e) => e.getAttribute('id') === `upcoming-panel-${v}`)[0];
  const focused = () => dom.document.activeElement as unknown as FakeElement;
  const key = (el: FakeElement, k: string) => {
    const e = new FakeEvent('keydown');
    e.key = k;
    act(() => {
      el.dispatchEvent(e);
    });
  };
  /** The rows of the list, by their titles. */
  const listed = () => viewPanel('list').findAll((e) => cls(e).includes('list-row-title')).map((e) => e.textContent);
  return { all, button, dialog, notices, warnRow, warnTitle, warnSub, field, radio, viewTab, viewPanel, focused, key, listed };
}

type PanelProps = Partial<React.ComponentProps<typeof UpcomingPanel>>;
/** The segment over a scene, as the Budgets tab hands it over. */
function mountPanel(s: UpcomingScene, over: PanelProps = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const d = derived(s);
  act(() =>
    root.render(
      <UpcomingPanel
        institutions={s.institutions}
        series={s.series}
        planned={s.planned}
        plannedStatus={s.plannedStatus}
        plannedDrawn={s.plannedStatus === 'ready'}
        plannedError={s.plannedError}
        plannedSaveError={s.plannedSaveError}
        onSavePlanned={async () => true}
        dismissed={d.dismissed}
        onDismiss={async () => true}
        txns={s.txns}
        failed={s.failed}
        balancesAsOf={s.balancesAsOf}
        balancesSaved={s.balancesSaved}
        incomplete={s.incomplete}
        stopped={s.stopped}
        withoutTransactions={s.withoutTransactions}
        fx={s.fx}
        today={s.today}
        currency={d.currency}
        plannedCurrency={d.plannedCurrency}
        noSpending={d.noSpending}
        {...over}
      />
    )
  );
  return { ...harness(host as unknown as FakeElement), host: host as unknown as FakeElement, unmount: () => act(() => root.unmount()) };
}

describe('the segment, top to bottom', () => {
  test('the notice, the forecast, List or Calendar, the two views, Recurring, Planned', () => {
    const v = mountPanel(SCENES['connections that leave it short']);
    const parts = v.host.childNodes[0] as FakeElement;
    const kids = parts.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
    const heading = (e: FakeElement) => e.findAll((x) => /^H[1-6]$/.test(x.tagName))[0]?.textContent ?? null;
    expect(kids).toHaveLength(7);
    expect(kids[0].findAll((e) => e.getAttribute('class') === 'notice-summary')).toHaveLength(1);
    expect([kids[1].tagName, kids[1].getAttribute('aria-labelledby'), heading(kids[1])]).toEqual(['SECTION', 'forecast-title', 'Cash forecast']);
    expect([kids[2].getAttribute('role'), kids[2].getAttribute('aria-label')]).toEqual(['tablist', 'List or calendar']);
    expect([kids[3].getAttribute('role'), kids[3].getAttribute('aria-labelledby')]).toEqual(['tabpanel', 'upcoming-tab-list']);
    expect([kids[4].getAttribute('role'), kids[4].getAttribute('aria-labelledby')]).toEqual(['tabpanel', 'upcoming-tab-calendar']);
    // The list's rows are plain, so its panel takes focus; the calendar's
    // own arrows come first in it.
    expect([kids[3].getAttribute('tabindex'), kids[4].getAttribute('tabindex')]).toEqual(['0', null]);
    expect(heading(kids[5])).toBe('Recurring');
    expect(heading(kids[6])).toBe('Planned');
    // The views' cards have no title row of their own: their tabs name them.
    const titled = (e: FakeElement) => {
      const card = e.findAll((x) => (x.getAttribute('class') ?? '').split(' ').includes('card'))[0];
      const first = card.childNodes.find((c): c is FakeElement => c instanceof FakeElement);
      return first?.getAttribute('class') === 'card-header';
    };
    expect([titled(kids[3]), titled(kids[4])]).toEqual([false, false]);
    v.unmount();
  });

  test('nothing missing: no notice above the forecast', () => {
    const v = mountPanel(SCENES['as it usually is']);
    const parts = v.host.childNodes[0] as FakeElement;
    const first = parts.childNodes.find((c): c is FakeElement => c instanceof FakeElement)!;
    expect(first.getAttribute('aria-labelledby')).toBe('forecast-title');
    v.unmount();
  });
});

describe('List or Calendar', () => {
  test('List first; a tap, the arrows, Home and End switch; both stay mounted, the other hidden', () => {
    const v = mountPanel(SCENES['as it usually is']);
    const list = v.viewPanel('list');
    const calendar = v.viewPanel('calendar');
    const selected = () => ['List', 'Calendar'].filter((l) => v.viewTab(l).getAttribute('aria-selected') === 'true');
    const shown = () => [list, calendar].filter((p) => !p.hasAttribute('hidden')).map((p) => p.getAttribute('id'));
    expect(selected()).toEqual(['List']);
    expect(shown()).toEqual(['upcoming-panel-list']);
    for (const l of ['List', 'Calendar']) expect(v.viewTab(l).getAttribute('aria-controls')).toBe(`upcoming-panel-${l.toLowerCase()}`);
    act(() => click(v.viewTab('Calendar')));
    expect([selected(), shown()]).toEqual([['Calendar'], ['upcoming-panel-calendar']]);
    const tabs = v.all((e) => e.getAttribute('role') === 'tablist' && e.getAttribute('aria-label') === 'List or calendar')[0];
    v.key(tabs, 'ArrowRight');
    expect([selected(), v.focused() === v.viewTab('List')]).toEqual([['List'], true]);
    v.key(tabs, 'End');
    expect(selected()).toEqual(['Calendar']);
    v.key(tabs, 'Home');
    expect(selected()).toEqual(['List']);
    v.key(tabs, 'ArrowLeft');
    expect(selected()).toEqual(['Calendar']);
    expect(['List', 'Calendar'].map((l) => v.viewTab(l).getAttribute('tabindex'))).toEqual(['-1', '0']);
    // The calendar keeps the month it was moved to across a switch.
    const month = () => calendar.findAll((e) => e.getAttribute('aria-live') === 'polite')[0].textContent;
    const first = month();
    act(() => click(v.button('Next month', calendar)!));
    const next = month();
    expect(next).not.toBe(first);
    act(() => click(v.viewTab('List')));
    act(() => click(v.viewTab('Calendar')));
    expect(v.viewPanel('calendar') === calendar && v.viewPanel('list') === list).toBe(true);
    expect(month()).toBe(next);
    v.unmount();
  });
});

describe('how far ahead', () => {
  test('a radio group of 30, 60 and 90 days; the list runs as far as the forecast does', () => {
    const v = mountPanel(SCENES['as it usually is']);
    const checked = () => ['30 days', '60 days', '90 days'].filter((l) => v.radio(l).getAttribute('aria-checked') === 'true');
    const group = v.all((e) => e.getAttribute('role') === 'radiogroup')[0];
    expect(group.getAttribute('aria-label')).toBe('How far ahead');
    expect(checked()).toEqual(['30 days']);
    // Rent on the 15th, pay on the 25th, from Oct 9: once each in 30 days.
    const count = (name: string) => v.listed().filter((t) => t === name).length;
    expect([count('Rent'), count('Payroll')]).toEqual([1, 1]);
    act(() => click(v.radio('60 days')));
    expect(checked()).toEqual(['60 days']);
    expect([count('Rent'), count('Payroll')]).toEqual([2, 2]);
    // The arrows choose as they go, up and down too, and keep focus on the choice.
    v.key(group, 'ArrowRight');
    expect([checked(), v.focused() === v.radio('90 days')]).toEqual([['90 days'], true]);
    expect([count('Rent'), count('Payroll')]).toEqual([3, 3]);
    v.key(group, 'ArrowDown');
    expect(checked()).toEqual(['30 days']);
    v.key(group, 'ArrowUp');
    expect(checked()).toEqual(['90 days']);
    v.key(group, 'Home');
    expect(checked()).toEqual(['30 days']);
    expect(['30 days', '60 days', '90 days'].map((l) => v.radio(l).getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    v.unmount();
  });

  test('with nothing coming, the list says so for the days the forecast covers', () => {
    const v = mountPanel({ ...SCENES['nothing detected yet'], planned: EMPTY_PLANNED });
    expect(v.viewPanel('list').textContent).toContain('Nothing expected in the next 30 days.');
    act(() => click(v.radio('90 days')));
    expect(v.viewPanel('list').textContent).toContain('Nothing expected in the next 90 days.');
    v.unmount();
  });
});

describe('the what-if sheet', () => {
  // Rent of $1,500 on the 15th from $1,900, warned below $100: lowest $400.
  const scene: UpcomingScene = {
    ...SCENES['as it usually is'],
    institutions: [chase({ accounts: [{ account_id: 'chk', name: 'Checking', type: 'depository', balance: 1900, currency: 'USD' }] })],
    planned: EMPTY_PLANNED,
  };

  test('its words, each at its level as main had them (ForecastCard.tsx:364-381)', async () => {
    const v = mountPanel(scene);
    act(() => click(v.button('What if I buy…')!));
    await settle();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('What if I buy…');
    expect(v.dialog()!.textContent).toContain('One purchase, on one day, added to the forecast. Nothing is saved.');
    act(() => type(v.field('Amount')!, 'lots'));
    expect(v.notices()).toEqual(['critical: Critical: Enter an amount, like 250 or 1,299.99.']);
    act(() => type(v.field('Amount')!, '350'));
    act(() => type(v.field('On')!, '2026-12-01'));
    expect(v.notices()).toEqual(['critical: Critical: Pick a day from today to Nov 8, the end of this 30-day forecast.']);
    // Below the warning with it, not without it: a caution.
    act(() => type(v.field('On')!, '2026-10-10'));
    expect(v.dialog()!.textContent).toContain('Expected lowest $50.00 around Oct 15, $350.00 lower than $400.00 without it.');
    expect(v.notices()).toEqual(['caution: Caution: With it, the balance is expected below $100.00 from around Oct 15.']);
    // Below zero with it: critical.
    act(() => type(v.field('Amount')!, '500'));
    expect(v.notices()).toEqual(['critical: Critical: With it, the balance is expected to drop below zero around Oct 15.']);
    // Done, at its foot.
    const done = v.button('Done', v.dialog()!)!;
    expect(done.getAttribute('class')).toBe('btn');
    act(() => click(done));
    await settle(400);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });
});

describe('the warning’s sheet, through the store as the dashboard wires it', () => {
  // The tab works from the viewer's day: two items planned in the days to come.
  const SOON = [
    { ...CAR, date: addDays(localDate(), 5) },
    { ...REFUND, date: addDays(localDate(), 12) },
  ];
  const START: Planned = { ...EMPTY_PLANNED, items: SOON, threshold: { amount: 100, currency: 'USD' } };
  // The server: the planned items stored, a save refused when told to, and a
  // read held when told to (to look at the page while it is under way).
  let stored: Planned = START;
  let refuse = 0;
  let hold: Promise<void> | null = null;
  let offline = false;
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
  const server = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
    if (url === '/api/planned-items' && init?.method === 'PUT') {
      if (refuse > 0) {
        refuse--;
        return reply(500, {});
      }
      stored = JSON.parse(init.body!).planned;
      return reply(200, { planned: stored });
    }
    if (url === '/api/planned-items') {
      if (hold) await hold;
      if (offline) throw new TypeError('Failed to fetch');
      return reply(200, { planned: stored });
    }
    return reply(404, {});
  };
  const REFUSED = 'Could not save planned items. Showing what is saved.';

  function mountTab() {
    globalThis.fetch = server as unknown as typeof fetch;
    let push: (s: ListState) => void = () => {};
    const store = createWholeListStore<Planned>({
      url: '/api/planned-items',
      field: 'planned',
      noun: 'planned items',
      empty: EMPTY_PLANNED,
      isValid: isPlanned,
      onChange: (s) => push(s),
      fetch: server as never,
    });
    /** The tab, wired as components/Dashboard.tsx wires it. */
    function Page() {
      const [s, setS] = useState(store.get());
      push = setS;
      return (
        <BudgetsTab
          txns={[txn({ transaction_id: 'a', date: '2026-10-05', name: 'Corner shop', amount: 30 })]}
          series={RENT_AND_PAY}
          institutions={[chase()]}
          budgets={{ categories: {}, groups: {} }}
          onSave={async () => true}
          goals={[]}
          onSaveGoals={async () => true}
          accounts={[]}
          loading={false}
          planned={s.value}
          plannedStatus={s.status}
          plannedError={s.error}
          plannedSaveError={s.saveError}
          onSavePlanned={store.save}
          segment="upcoming"
        />
      );
    }
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    act(() => root.render(<Page />));
    const v = harness(host as unknown as FakeElement);
    const upcoming = () => v.all((e) => e.getAttribute('id') === 'budgets-panel-upcoming')[0];
    /** The segment's notice: what is said above the forecast's card. */
    const top = () => {
      const card = upcoming().findAll((e) => e.getAttribute('aria-labelledby') === 'forecast-title')[0];
      const notices = upcoming().findAll((e) => (e.getAttribute('class') ?? '').startsWith('notice '));
      return notices.filter((n) => !card.contains(n)).map((n) => n.textContent);
    };
    const open = async (focus = true) => {
      if (focus) v.warnRow()!.focus();
      act(() => click(v.warnRow()!));
      await settle();
    };
    return { ...v, store, upcoming, top, open, unmount: () => act(() => root.unmount()) };
  }

  test('loading at first: said at the top, and the row opens nothing until the items are there', async () => {
    stored = START;
    const v = mountTab();
    expect(v.top()).toContain(`Caution: ${PLANNED_TEXT}`);
    expect(v.warnRow()!.getAttribute('aria-disabled')).toBe('true');
    expect([v.warnTitle(), v.warnSub()]).toEqual(['Warns below $100.00', 'Your planned items are still loading.']);
    await v.open();
    expect(v.dialog()).toBeNull();
    await act(async () => v.store.load());
    await settle();
    expect(v.top().join(' ')).not.toContain(PLANNED_TEXT);
    expect(v.warnTitle()).toBe('Warns below $100.00');
    expect(v.warnSub()).toBeNull();
    expect(v.warnRow()!.hasAttribute('aria-disabled')).toBe(false);
    expect(v.listed()).toContain('Car registration');
    v.unmount();
  });

  test('opens afresh from the saved figure each time; Cancel and the close give focus back to the row', async () => {
    stored = START;
    const v = mountTab();
    await act(async () => v.store.load());
    await v.open();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Low-balance warning');
    const warn = v.field('Warn below')!;
    expect([warn.getAttribute('aria-label'), warn.getAttribute('placeholder'), warn.value]).toEqual(['Warn below, in USD', '0', '100']);
    expect(v.dialog()!.textContent).toContain('Blank warns only below zero.');
    act(() => type(warn, '250'));
    act(() => click(v.button('Cancel', v.dialog()!)!));
    await settle(400);
    expect(v.dialog()).toBeNull();
    expect(v.focused() === v.warnRow()).toBe(true);
    await v.open();
    expect(v.field('Warn below')!.value).toBe('100');
    // Not typed as an amount: said, critical, and Save is off.
    act(() => type(v.field('Warn below')!, 'abc'));
    expect(v.notices()).toEqual(['critical: Critical: Enter an amount, like 250 or 1,299.99.']);
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    // Blank is below zero only.
    act(() => type(v.field('Warn below')!, ''));
    expect(v.notices()).toEqual([]);
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(false);
    // Opened without the row focused (a tap that doesn't focus a button):
    // focus still comes back to it.
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    dom.document.body.focus();
    await v.open(false);
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    expect(v.focused() === v.warnRow()).toBe(true);
    v.unmount();
  });

  test('a refusal from before isn’t said; one while open is, once, the sheet open on what was typed and the planned items drawn while they are read again', async () => {
    stored = START;
    const v = mountTab();
    await act(async () => v.store.load());
    await settle();
    // Where the forecast starts and ends, as drawn from the items saved.
    const ends = () => v.all((e) => e.tagName === 'P' && e.textContent.startsWith('Starts from'))[0].textContent;
    const saved = ends();
    expect(saved).toContain('Expected to end near');
    // A save refused before the sheet opens (a planned item, say).
    refuse = 1;
    await act(async () => void (await v.store.save({ ...stored, items: [SOON[0]] })));
    await settle();
    expect(v.upcoming().textContent).toContain(REFUSED);
    await v.open();
    expect(v.notices()).toEqual([]);
    act(() => type(v.field('Warn below')!, '250'));

    // Refused, and the store reads the planned items again: held, to see the
    // page meanwhile.
    refuse = 1;
    let release: () => void = () => {};
    hold = new Promise((r) => (release = r));
    await act(async () => click(v.button('Save', v.dialog()!)!));
    await settle();
    expect(v.store.get().status).toBe('loading');
    // Drawn from what the page holds, which is what is saved: the forecast
    // keeps its items and its warning, the list its planned rows, and
    // nothing says they aren't loaded.
    expect(v.warnTitle()).toBe('Warns below $100.00');
    expect(v.warnRow()!.getAttribute('aria-disabled')).toBe('true');
    expect(v.listed()).toContain('Car registration');
    expect(ends()).toBe(saved);
    expect(v.top().join(' ')).not.toContain("planned items aren't loaded");
    expect(v.upcoming().textContent).not.toContain('Loading planned items');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Low-balance warning');
    expect(v.field('Warn below')!.value).toBe('250');
    expect(v.button('Saving…', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    await act(async () => release());
    hold = null;
    await settle();
    // Read again: still open on what was typed, the refusal said once.
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Low-balance warning');
    expect(v.field('Warn below')!.value).toBe('250');
    expect(v.notices()).toEqual([`caution: Caution: ${REFUSED}`]);
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(false);
    // And Save again, this time saved: closed, focus on the row, its figure.
    await act(async () => click(v.button('Save', v.dialog()!)!));
    await settle(400);
    expect(v.dialog()).toBeNull();
    expect(stored.threshold).toEqual({ amount: 250, currency: 'USD' });
    expect(v.warnTitle()).toBe('Warns below $250.00');
    expect(v.warnSub()).toBeNull();
    expect(v.focused() === v.warnRow()).toBe(true);
    v.unmount();
  });

  test('a refused save whose reload fails too: the sheet stays open on what was typed, and says why Save is off', async () => {
    stored = START;
    offline = false;
    const v = mountTab();
    await act(async () => v.store.load());
    await settle();
    await v.open();
    act(() => type(v.field('Warn below')!, '250'));
    refuse = 1;
    offline = true;
    await act(async () => click(v.button('Save', v.dialog()!)!));
    await settle();
    expect(v.store.get().status).toBe('error');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Low-balance warning');
    expect(v.field('Warn below')!.value).toBe('250');
    expect(v.notices()).toEqual([`caution: Caution: ${REFUSED}`, "caution: Caution: Your planned items couldn't be loaded, so this can't be saved now."]);
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    // The row says it too, and the top that the items aren't in the forecast.
    expect(v.warnSub()).toBe("Your planned items couldn't be loaded, so this can't be saved now.");
    expect(v.top()).toContain(`Caution: ${PLANNED_TEXT}`);
    offline = false;
    v.unmount();
  });

  test('read again while the sheet is open (a refresh): Save waits, and the sheet says why, then doesn’t', async () => {
    stored = START;
    const v = mountTab();
    await act(async () => v.store.load());
    await settle();
    await v.open();
    act(() => type(v.field('Warn below')!, '250'));
    let release: () => void = () => {};
    hold = new Promise((r) => (release = r));
    let reading: Promise<void> = Promise.resolve();
    act(() => {
      reading = v.store.load();
    });
    await settle();
    expect(v.store.get().status).toBe('loading');
    const helpers = () => v.dialog()!.findAll((e) => e.getAttribute('class') === 'helper').map((e) => e.textContent);
    expect(helpers()).toContain('Your planned items are still loading.');
    expect(v.notices()).toEqual([]);
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    expect(v.field('Warn below')!.value).toBe('250');
    await act(async () => {
      release();
      await reading;
    });
    hold = null;
    await settle();
    expect(helpers()).not.toContain('Your planned items are still loading.');
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(false);
    v.unmount();
  });
});

describe('the warning’s row, when it can’t be changed', () => {
  test('it says why in its line, in Recurring’s words; with nothing to save it with, it is plain text', () => {
    const error = mountPanel(SCENES['planned items not read']);
    expect([error.warnRow()!.tagName, error.warnRow()!.getAttribute('aria-disabled')]).toEqual(['BUTTON', 'true']);
    expect(error.warnSub()).toBe("Your planned items couldn't be loaded, so this can't be saved now.");
    error.unmount();
    const loading = mountPanel(SCENES['planned items loading']);
    expect(loading.warnSub()).toBe('Your planned items are still loading.');
    loading.unmount();
    const ready = mountPanel(SCENES['as it usually is']);
    expect([ready.warnRow()!.getAttribute('aria-disabled'), ready.warnSub()]).toEqual([null, null]);
    ready.unmount();
    // Nothing to save it with: a plain row, no chevron, nothing to open.
    const plain = mountPanel(SCENES['as it usually is'], { onSavePlanned: undefined });
    const row = plain.warnRow()!;
    expect([row.tagName, row.hasAttribute('aria-haspopup'), row.findAll((e) => e.tagName === 'svg').length, plain.warnTitle()]).toEqual(['DIV', false, 0, 'Warns below $100.00']);
    plain.unmount();
  });
});

describe('the notes follow the range', () => {
  // Sapphire's statement due 45 days out: past 30 days, inside 60.
  const due: UpcomingScene = {
    ...SCENES['as it usually is'],
    institutions: [
      chase({
        accounts: [
          { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 900, currency: 'USD' },
          { account_id: 'card', name: 'Sapphire', type: 'credit', balance: 600, currency: 'USD', liability: { minimum_payment: 35, next_due_date: '2026-11-23', last_statement_balance: 600 } },
        ],
      }),
    ],
  };
  const NOTE = "Sapphire's payment, statement balance $600.00, is due Nov 23 and isn't in this forecast, since it changes each month. Add it as a planned expense if you'll pay it from checking.";

  test('a card’s payment due past 30 days is said at the top at 60, and not at 30', () => {
    const v = mountPanel(due);
    const top = () => {
      const card = v.all((e) => e.getAttribute('aria-labelledby') === 'forecast-title')[0];
      return v.all((e) => (e.getAttribute('class') ?? '').startsWith('notice ') && !card.contains(e)).map((e) => e.textContent);
    };
    expect(top()).toEqual([]);
    act(() => click(v.radio('60 days')));
    expect(top()).toEqual([`Caution: ${NOTE}`]);
    act(() => click(v.radio('30 days')));
    expect(top()).toEqual([]);
    v.unmount();
  });
});

describe('the planned items, only once they are drawn', () => {
  test('not read, or still loading: none of them is listed', () => {
    for (const name of ['planned items not read', 'planned items loading']) {
      const v = mountPanel(SCENES[name]);
      expect([name, v.listed().filter((t) => t === CAR.name || t === REFUND.name)]).toEqual([name, []]);
      v.unmount();
    }
    const v = mountPanel(SCENES['as it usually is']);
    expect(v.listed()).toEqual(expect.arrayContaining([CAR.name, REFUND.name]));
    v.unmount();
  });
});
