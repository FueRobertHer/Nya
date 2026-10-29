import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, FakeElement, FakeEvent } from './mini-dom';

// Budgets > Upcoming's Recurring and Planned cards and their sheets (rollout
// phase 6a3, docs/design/information-architecture.md#budgets), used as a
// person would (react-dom/client over test/mini-dom.ts): a series' row opens
// its sheet, with what was seen of it and Not recurring; those marked not
// recurring open in place, each with Restore; a planned item's row opens its
// sheet, Add a planned item an empty one, and Delete is a level that asks
// first. A save that fails keeps the sheet open on what was typed and says
// why, once. The cards' stores are the dashboard's (lib/whole-list-store.ts):
// here a fake that does what a refused save does to the props, the list put
// back and the refusal said, cleared as the next save starts.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: RecurringCard } = await import('@/components/RecurringCard');
const { default: PlannedCard } = await import('@/components/PlannedCard');
const { detectRecurring, scheduleDates } = await import('@/lib/recurring');
const { EMPTY_PLANNED } = await import('@/lib/planned');
const { formatMoney } = await import('@/lib/format');
type RecurringRow = import('@/lib/recurring').RecurringRow;
type RecurringSeries = import('@/lib/recurring').RecurringSeries;
type Planned = import('@/lib/planned').Planned;
type PlannedItem = import('@/lib/planned').PlannedItem;
type ListStatus = import('@/lib/whole-list-store').ListStatus;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = '2026-10-09';
const money = (n: number) => formatMoney(n, 'USD');
const REFUSED = 'Could not save planned items. Showing what is saved.';

const recurring = (date: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
  date,
  name: 'Netflix',
  amount,
  institution_name: 'Chase',
  account_name: 'Checking',
  account_type: 'depository',
  category: 'entertainment',
  transaction_code: null,
  iso_currency_code: 'USD',
  ...over,
});
const monthly = (from: string, count: number, day: number) => scheduleDates({ unit: 'month', every: 1, days: [day], month: from, slot: 0 }, '2100-01-01', count);
/** Rent on the 15th and pay on the 25th, both detected from six months. */
const SERIES = detectRecurring([
  ...monthly('2026-04', 6, 15).map((d) => recurring(d, 1500, { name: 'Rent', category: 'rent and utilities' })),
  ...monthly('2026-04', 6, 25).map((d) => recurring(d, -2000, { name: 'Payroll', category: 'income' })),
]);
const RENT = SERIES.find((s) => s.name === 'Rent')!;
const PAYROLL = SERIES.find((s) => s.name === 'Payroll')!;

/** The time a sheet takes to slide in (one frame), or out. */
const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

function harness(host: FakeElement) {
  const all = (test: (e: FakeElement) => boolean, within: FakeElement = host) => within.findAll(test);
  const cls = (e: FakeElement) => (e.getAttribute('class') ?? '').split(' ');
  /** A button by its words or its label, in `within` (the page by default). */
  const button = (label: string, within: FakeElement = host) =>
    all((e) => e.tagName === 'BUTTON' && (e.textContent.trim() === label || e.getAttribute('aria-label') === label), within)[0] ?? null;
  /** A row of a list, by the start of its title. */
  const row = (title: string, within: FakeElement = host) =>
    all(
      (e) => (e.tagName === 'BUTTON' || e.tagName === 'DIV') && cls(e).includes('list-row') && e.findAll((x) => x.getAttribute('class') === 'list-row-title')[0]?.textContent.startsWith(title) === true,
      within
    )[0] ?? null;
  /** The sheet on the page (not one sliding out). */
  const dialog = () => all((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  /** Each notice's words, its level said first ("Caution: ..."). */
  const notices = (within: FakeElement | null = host) => (within ? all((e) => cls(e)[0] === 'notice', within).map((e) => e.textContent) : []);
  /** What a field says is wrong with it (FieldError), under it. */
  const fieldErrors = (within: FakeElement | null = host) => (within ? all((e) => cls(e)[0] === 'field-error', within) : []);
  /** The notices on the card, not in a sheet. */
  const cardNotices = () => {
    const sheets = all((e) => e.getAttribute('role') === 'dialog');
    return all((e) => cls(e)[0] === 'notice' && !sheets.some((d) => d.contains(e))).map((e) => e.textContent);
  };
  const field = (label: string) =>
    dialog()
      ?.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]
      ?.findAll((e) => e.tagName === 'INPUT' || e.tagName === 'SELECT')[0] ?? null;
  const open = async (title: string) => {
    const r = row(title)!;
    r.focus();
    act(() => click(r));
    await settle();
  };
  const focused = () => dom.document.activeElement as unknown as FakeElement;
  /** A key pressed on what has focus, as a keyboard sends it. */
  const press = (k: string) => {
    const e = new FakeEvent('keydown');
    e.key = k;
    act(() => {
      focused().dispatchEvent(e);
    });
  };
  return { all, button, row, dialog, notices, fieldErrors, cardNotices, field, open, focused, press };
}

function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  return { host, ...harness(host as unknown as FakeElement), unmount: () => act(() => root.unmount()) };
}

type RecurringProps = Partial<React.ComponentProps<typeof RecurringCard>>;
/** The card, its dismissals kept as the planned store keeps them: the change
 *  shows at once; `ok` false, it is put back and the refusal said, and with
 *  `reload` 'fails' the store's reading again fails too. */
function mountRecurring(props: RecurringProps & { marked?: string[]; ok?: boolean | (() => Promise<boolean>); reload?: 'fails'; readOnly?: boolean } = {}) {
  const calls: [string, boolean][] = [];
  const { marked = [], ok = true, reload, readOnly = false, ...rest } = props;
  function Card() {
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set(marked));
    const [saveError, setSaveError] = useState<string | null>(rest.saveError ?? null);
    const [status, setStatus] = useState<ListStatus>(rest.status ?? 'ready');
    return (
      <RecurringCard
        series={SERIES}
        today={TODAY}
        currency="USD"
        {...rest}
        dismissed={dismissed}
        saveError={saveError}
        status={status}
        onDismiss={
          readOnly
            ? undefined
            : async (s, dismiss) => {
                calls.push([s.id, dismiss]);
                const before = dismissed;
                const next = new Set(before);
                if (dismiss) next.add(s.id);
                else next.delete(s.id);
                setDismissed(next);
                setSaveError(null);
                const done = typeof ok === 'function' ? await ok() : ok;
                if (!done) {
                  setDismissed(before);
                  setSaveError(REFUSED);
                  if (reload === 'fails') setStatus('error');
                }
                return done;
              }
        }
      />
    );
  }
  return { calls, ...mount(<Card />) };
}

describe('Recurring', () => {
  test('a card headed Recurring, bills and income each under a heading, each series a row that opens its sheet with nothing to press inside it', () => {
    const v = mountRecurring();
    const card = v.all((e) => e.tagName === 'SECTION')[0];
    expect(card.getAttribute('aria-labelledby')).toBe('recurring-title');
    expect(v.all((e) => e.tagName === 'H3').map((e) => e.textContent)).toEqual(['Recurring']);
    expect(v.all((e) => e.tagName === 'H3')[0].getAttribute('id')).toBe('recurring-title');
    expect(card.textContent).toContain(`~${money(1500)}/mo out`);
    expect(v.all((e) => e.tagName === 'H4').map((e) => e.textContent)).toEqual(['Bills', `Income · ~${money(2000)}/mo in`]);
    const rent = v.row('Rent')!;
    expect(rent.tagName).toBe('BUTTON');
    expect(rent.getAttribute('aria-haspopup')).toBe('dialog');
    expect(rent.findAll((e) => ['BUTTON', 'A', 'INPUT', 'SELECT'].includes(e.tagName))).toHaveLength(0);
    // Its line's words, as the table's were.
    expect(rent.textContent).toContain('Chase · Checking · Monthly · seen 6 times · next ~Oct 15');
    expect(rent.textContent).toContain(money(1500));
    expect(v.row('Payroll')!.textContent).toContain(`+${money(2000)}`);
    // The closing note, a line of helper text.
    const note = v.all((e) => e.getAttribute('class') === 'helper').at(-1)!;
    expect(note.textContent).toStartWith('Detected from charges and deposits that repeat on a schedule at a consistent amount; dates and amounts are estimates.');
    v.unmount();
  });

  test('a series’ row opens its sheet, focus in it: its name, what was seen of it, and Not recurring; closed, focus is back on the row', async () => {
    const v = mountRecurring();
    await v.open('Rent');
    const d = v.dialog()!;
    expect(d.getAttribute('aria-label')).toBe('Rent');
    expect(d.contains(v.focused())).toBe(true);
    expect(d.textContent).toContain(`Seen 6 times from Apr 15 to Sep 15, about ${money(1500)} each time.`);
    expect(v.button('Not recurring', d)!.getAttribute('class')).toBe('btn secondary');
    expect(v.button('Not recurring', d)!.hasAttribute('disabled')).toBe(false);
    act(() => click(v.button('Close', d)!));
    await settle();
    expect(v.dialog()).toBeNull();
    expect(v.focused() === v.row('Rent')).toBe(true);
    v.unmount();
  });

  test('Not recurring saves the dismissal and closes the sheet; the series is listed as marked, and focus goes to that row', async () => {
    const v = mountRecurring();
    await v.open('Rent');
    await act(async () => click(v.button('Not recurring', v.dialog()!)!));
    await settle();
    expect(v.calls).toEqual([[RENT.id, true]]);
    expect(v.dialog()).toBeNull();
    expect(v.row('Rent')).toBeNull();
    const marked = v.row('1 marked not recurring')!;
    expect(marked.getAttribute('aria-expanded')).toBe('false');
    expect(v.focused() === marked).toBe(true);
    v.unmount();
  });

  test('a refused Not recurring keeps the sheet open, saying why once, in it; one said before it opened is said on the card, not in it', async () => {
    const v = mountRecurring({ ok: async () => false, saveError: REFUSED });
    expect(v.cardNotices()).toEqual([`Caution: ${REFUSED}`]);
    await v.open('Rent');
    expect(v.notices(v.dialog())).toEqual([]);
    expect(v.cardNotices()).toEqual([`Caution: ${REFUSED}`]);
    await act(async () => click(v.button('Not recurring', v.dialog()!)!));
    await settle();
    // The same words, refused again: this save's, so said in the sheet, and
    // only there while it is open.
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Rent');
    expect(v.notices(v.dialog())).toEqual([`Caution: ${REFUSED}`]);
    expect(v.cardNotices()).toEqual([]);
    expect(v.row('Rent')).not.toBeNull();
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle();
    expect(v.cardNotices()).toEqual([`Caution: ${REFUSED}`]);
    v.unmount();
  });

  test('a refused dismissal takes the row out and puts it back: closing gives focus to the row as it is drawn now', async () => {
    let finish: (ok: boolean) => void = () => {};
    const v = mountRecurring({ ok: () => new Promise<boolean>((r) => (finish = r)) });
    await v.open('Rent');
    const before = v.row('Rent')!;
    act(() => click(v.button('Not recurring', v.dialog()!)!));
    // The list shown while it saves: Rent marked.
    expect(v.row('Rent')).toBeNull();
    await act(async () => finish(false));
    const now = v.row('Rent')!;
    expect(now === before).toBe(false);
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle();
    expect(v.focused() === now).toBe(true);
    v.unmount();
  });

  test('closing waits for a save under way, by its button and Escape', async () => {
    let finish: (ok: boolean) => void = () => {};
    const v = mountRecurring({ ok: () => new Promise<boolean>((r) => (finish = r)) });
    await v.open('Payroll');
    act(() => click(v.button('Not recurring', v.dialog()!)!));
    expect(v.button('Not recurring', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    act(() => click(v.button('Close', v.dialog()!)!));
    v.press('Escape');
    expect(v.dialog()).not.toBeNull();
    await act(async () => finish(true));
    await settle();
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('refused, and the store’s reading again failing too: the sheet says both, the card says the refusal once it closes', async () => {
    const v = mountRecurring({ ok: async () => false, reload: 'fails' });
    await v.open('Rent');
    await act(async () => click(v.button('Not recurring', v.dialog()!)!));
    await settle();
    expect(v.notices(v.dialog())).toEqual([`Caution: ${REFUSED}`, "Caution: Your planned items couldn't be loaded, so this can't be saved now."]);
    expect(v.button('Not recurring', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle();
    expect(v.cardNotices()).toEqual([`Caution: ${REFUSED}`]);
    v.unmount();
  });

  test('why Not recurring is off is said in the sheet, where its button is, at its level: the card no longer says it', async () => {
    const cases: [RecurringProps & { readOnly?: boolean }, string, 'notice' | 'helper'][] = [
      // RecurringCard.tsx on main: a stale note (caution) on the card, and a
      // panel note (neutral) by the button.
      [{ status: 'error' }, "Your planned items couldn't be loaded, so this can't be saved now.", 'notice'],
      [{ status: 'loading' }, 'Your planned items are still loading.', 'helper'],
      [{ readOnly: true }, "This can't be changed here.", 'helper'],
    ];
    for (const [props, words, as] of cases) {
      const v = mountRecurring(props);
      expect([words, v.cardNotices()]).toEqual([words, []]);
      expect(v.host.textContent).not.toContain(words);
      await v.open('Rent');
      const d = v.dialog()!;
      expect(v.button('Not recurring', d)!.hasAttribute('disabled')).toBe(true);
      if (as === 'notice') expect(v.notices(d)).toEqual([`Caution: ${words}`]);
      else {
        expect(v.notices(d)).toEqual([]);
        expect(d.findAll((e) => e.getAttribute('class') === 'helper').map((e) => e.textContent)).toContain(words);
      }
      v.unmount();
    }
  });

  test('those marked not recurring open in place, each with Restore; Restore saves, and focus goes to the series’ row, back in the list', async () => {
    const v = mountRecurring({ marked: [RENT.id] });
    expect(v.row('Rent')).toBeNull();
    const marked = v.row('1 marked not recurring')!;
    // A row of its own, not a heading's toggle: the card's heading is an h3.
    expect(marked.tagName).toBe('BUTTON');
    expect(marked.textContent).toBe('1 marked not recurring');
    act(() => click(marked));
    expect(marked.getAttribute('aria-expanded')).toBe('true');
    const list = v.all((e) => e.getAttribute('id') === marked.getAttribute('aria-controls'))[0];
    const item = v.row('Rent', list)!;
    expect(item.tagName).toBe('DIV');
    expect(item.textContent).toContain('Chase · Checking · Monthly');
    const restore = v.button('Restore', item)!;
    expect(restore.getAttribute('class')).toBe('btn secondary');
    restore.focus();
    await act(async () => click(restore));
    await settle();
    expect(v.calls).toEqual([[RENT.id, false]]);
    expect(v.row('1 marked not recurring')).toBeNull();
    expect(v.focused() === v.row('Rent')).toBe(true);
    act(() => click(marked));
    v.unmount();
  });

  test('a refused Restore, which has no sheet, is said on the card, and focus goes to its Restore as drawn again', async () => {
    const v = mountRecurring({ marked: [RENT.id, PAYROLL.id], ok: async () => false });
    act(() => click(v.row('2 marked not recurring')!));
    const restore = v.button('Restore', v.row('Rent', v.all((e) => (e.getAttribute('class') ?? '').includes('recurring-marked'))[0])!)!;
    restore.focus();
    await act(async () => click(restore));
    await settle();
    expect(v.cardNotices()).toEqual([`Caution: ${REFUSED}`]);
    expect(v.row('Rent', v.all((e) => (e.getAttribute('class') ?? '').includes('recurring-marked'))[0])).not.toBeNull();
    const again = v.button('Restore', v.row('Rent', v.all((e) => (e.getAttribute('class') ?? '').includes('recurring-marked'))[0])!)!;
    expect(v.focused() === again).toBe(true);
    v.unmount();
  });

  test('while the planned items are still loading, Restore is off and the open list says why', () => {
    const v = mountRecurring({ marked: [RENT.id], status: 'loading' });
    act(() => click(v.row('1 marked not recurring')!));
    expect(v.button('Restore')!.hasAttribute('disabled')).toBe(true);
    expect(v.all((e) => e.getAttribute('class') === 'helper').map((e) => e.textContent)).toContain('Your planned items are still loading.');
    v.unmount();
  });

  test('a badge the panel gives it is drawn under its header, in the words its tone has; none by default', () => {
    const badges = (v: ReturnType<typeof mount>) => v.all((e) => (e.getAttribute('class') ?? '').startsWith('badge')).map((e) => [e.getAttribute('class'), e.textContent]);
    for (const [tone, words] of [
      ['warn', 'May be incomplete'],
      ['neg', 'Incomplete'],
    ] as const) {
      const v = mount(<RecurringCard series={SERIES} today={TODAY} currency="USD" dismissed={new Set()} badge={tone} />);
      expect(badges(v)).toEqual([[`badge ${tone}`, words]]);
      // Right after the header.
      const header = v.all((e) => e.getAttribute('class') === 'card-header')[0];
      expect(header.nextSibling?.textContent).toBe(words);
      v.unmount();
    }
    const none = mount(<RecurringCard series={SERIES} today={TODAY} currency="USD" dismissed={new Set()} />);
    expect(badges(none)).toEqual([]);
    none.unmount();
  });

  test('its empty and failed states keep their words: the failed load in red', () => {
    const failed = mount(<RecurringCard series={[]} today={TODAY} currency="USD" dismissed={new Set()} failed />);
    expect(failed.notices()).toEqual(["Critical: Transactions couldn't be loaded, so no bills or income can be found."]);
    failed.unmount();
    const loading = mount(<RecurringCard series={[]} today={TODAY} currency="USD" dismissed={new Set()} loading />);
    expect(loading.all((e) => e.getAttribute('class') === 'empty-note').map((e) => e.textContent)).toEqual(['Transactions are still loading.']);
    loading.unmount();
  });
});

const CAR: PlannedItem = { id: 'car', name: 'Car registration', kind: 'expense', amount: 212.5, currency: 'USD', date: '2025-11-03', cadence: 'yearly' };
const REFUND: PlannedItem = { id: 'refund', name: 'Tax refund', kind: 'income', amount: 1200, currency: 'USD', date: '2026-10-30', cadence: 'once' };
const TWO: Planned = { ...EMPTY_PLANNED, items: [CAR, REFUND] };

type PlannedProps = Partial<React.ComponentProps<typeof PlannedCard>>;
/** The card, its items kept as the planned store keeps them: the list saved
 *  shows at once; `ok` false, it is put back and the refusal said, the store
 *  reading the list again meanwhile (held until `reading` resolves, when
 *  given), and drawn through it, as components/BudgetsTab.tsx draws it; with
 *  `reload` 'fails', that reading fails (offline, say). */
function mountPlanned(props: PlannedProps & { initial?: Planned; ok?: boolean | (() => Promise<boolean>); reading?: () => Promise<void>; reload?: 'fails' } = {}) {
  const saved: Planned[] = [];
  const { initial = TWO, ok = true, reading, reload, ...rest } = props;
  function Card() {
    const [planned, setPlanned] = useState(initial);
    const [saveError, setSaveError] = useState<string | null>(rest.saveError ?? null);
    const [status, setStatus] = useState<ListStatus>(rest.status ?? 'ready');
    return (
      <PlannedCard
        today={TODAY}
        currency="USD"
        {...rest}
        planned={planned}
        status={status}
        drawn={rest.drawn ?? status !== 'error'}
        saveError={saveError}
        onSave={async (next) => {
          saved.push(next);
          const before = planned;
          setPlanned(next);
          setSaveError(null);
          const done = typeof ok === 'function' ? await ok() : ok;
          if (!done) {
            setPlanned(before);
            setSaveError(REFUSED);
            if (reading) {
              setStatus('loading');
              await reading();
              setStatus('ready');
            }
            if (reload === 'fails') setStatus('error');
          }
          return done;
        }}
      />
    );
  }
  return { saved, ...mount(<Card />) };
}

describe('Planned', () => {
  test('a card headed Planned, each item a row that opens its sheet, soonest first; Add a planned item under them', () => {
    const v = mountPlanned();
    expect(v.all((e) => e.tagName === 'SECTION')[0].getAttribute('aria-labelledby')).toBe('planned-title');
    expect(v.all((e) => e.tagName === 'H3').map((e) => e.textContent)).toEqual(['Planned']);
    const rows = v.all((e) => (e.getAttribute('class') ?? '').split(' ').includes('list-row'));
    expect(rows.map((r) => r.textContent)).toEqual([`Tax refundOnce · next Oct 30+${money(1200)}`, `Car registrationYearly · next Nov 3\u2212${money(212.5)}`]);
    for (const r of rows) {
      expect(r.tagName).toBe('BUTTON');
      expect(r.getAttribute('aria-haspopup')).toBe('dialog');
      expect(r.hasAttribute('aria-disabled')).toBe(false);
    }
    expect(v.button('Add a planned item')!.getAttribute('class')).toBe('btn secondary planned-add');
    v.unmount();
  });

  test('a row opens its sheet on the item, focus in it; Save saves what was typed and closes it, focus back on the row', async () => {
    const v = mountPlanned();
    await v.open('Car registration');
    const d = v.dialog()!;
    expect(d.getAttribute('aria-label')).toBe('Edit planned item');
    expect(d.contains(v.focused())).toBe(true);
    expect([v.field('Name')!.value, v.field('Amount')!.value, v.field('Currency')!.value, v.field('First date')!.value]).toEqual(['Car registration', '212.5', 'USD', '2025-11-03']);
    expect(v.all((e) => e.getAttribute('role') === 'radio', d).map((e) => [e.textContent, e.getAttribute('aria-checked')])).toEqual([
      ['Money out', 'true'],
      ['Money in', 'false'],
    ]);
    act(() => type(v.field('Amount')!, '230'));
    await act(async () => click(v.button('Save', d)!));
    await settle();
    expect(v.saved).toEqual([{ ...TWO, items: [{ ...CAR, amount: 230 }, REFUND] }]);
    expect(v.dialog()).toBeNull();
    expect(v.focused() === v.row('Car registration')).toBe(true);
    v.unmount();
  });

  test('Money out or in is a radio group: the arrow keys, Home and End choose as they go, one tab stop', async () => {
    const v = mountPlanned();
    await v.open('Car registration');
    const radios = () => v.all((e) => e.getAttribute('role') === 'radio', v.dialog()!);
    expect(v.all((e) => e.getAttribute('role') === 'radiogroup', v.dialog()!)[0].getAttribute('aria-label')).toBe('Money out or in');
    expect(radios().map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1']);
    radios()[0].focus();
    v.press('ArrowRight');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(v.focused() === radios()[1]).toBe(true);
    expect(v.field('Name')!.getAttribute('placeholder')).toBe('e.g. Tax refund');
    v.press('Home');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    v.press('End');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    v.press('ArrowRight');
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    act(() => click(radios()[1]));
    expect(radios().map((r) => [r.getAttribute('aria-checked'), r.getAttribute('tabindex')])).toEqual([
      ['false', '-1'],
      ['true', '0'],
    ]);
    v.unmount();
  });

  test('Add opens an empty sheet; an item typed is added, and focus goes to its row', async () => {
    const v = mountPlanned();
    const add = v.button('Add a planned item')!;
    add.focus();
    act(() => click(add));
    await settle();
    const d = v.dialog()!;
    expect(d.getAttribute('aria-label')).toBe('Add a planned item');
    expect([v.field('Name')!.value, v.field('Amount')!.value, v.field('Currency')!.value, v.field('Date')!.value]).toEqual(['', '', 'USD', TODAY]);
    // No Delete for an item not yet added.
    expect(v.button('Delete planned item', d)).toBeNull();
    expect(v.button('Add', d)!.hasAttribute('disabled')).toBe(true);
    act(() => type(v.field('Name')!, 'Dentist'));
    act(() => type(v.field('Amount')!, '180'));
    const go = v.button(`Add ${money(180)}`, d)!;
    expect(go.getAttribute('class')).toBe('btn');
    await act(async () => click(go));
    await settle();
    expect(v.saved).toHaveLength(1);
    const added = v.saved[0].items[2];
    expect({ ...added, id: '' }).toEqual({ id: '', name: 'Dentist', kind: 'expense', amount: 180, currency: 'USD', date: TODAY, cadence: 'once' });
    expect(v.dialog()).toBeNull();
    expect(v.focused() === v.row('Dentist')).toBe(true);
    v.unmount();
  });

  test('typing errors are said under the fields, in red, in main’s words, and Save waits', async () => {
    const v = mountPlanned();
    await v.open('Car registration');
    expect(v.notices(v.dialog())).toEqual([]);
    // PlannedCard.tsx:247-249 on main, in their words, each now under its
    // field (FieldError), which names it.
    act(() => type(v.field('Amount')!, 'abc'));
    act(() => type(v.field('Currency')!, 'ZZZ'));
    act(() => type(v.field('First date')!, '1999-01-01'));
    const errors = v.fieldErrors(v.dialog());
    expect(errors.map((e) => e.textContent)).toEqual([
      'Enter an amount, like 212.50.',
      'Enter a currency as its three-letter code, like USD or EUR.',
      'Pick a date between 2000 and 2100.',
    ]);
    expect(['Amount', 'Currency', 'First date'].map((f) => v.field(f)!.getAttribute('aria-describedby'))).toEqual(errors.map((e) => e.getAttribute('id')));
    expect(['Amount', 'Currency', 'First date'].map((f) => v.field(f)!.getAttribute('aria-invalid'))).toEqual(['true', 'true', 'true']);
    expect(v.notices(v.dialog())).toEqual([]);
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    v.unmount();
  });

  test('a refused save keeps the sheet open on what was typed, saying why in red at its top, once; one said before it opened is said on the card', async () => {
    const v = mountPlanned({ ok: async () => false, saveError: REFUSED });
    expect(v.cardNotices()).toEqual([`Caution: ${REFUSED}`]);
    await v.open('Car registration');
    expect(v.notices(v.dialog())).toEqual([]);
    act(() => type(v.field('Amount')!, '230'));
    await act(async () => click(v.button('Save', v.dialog()!)!));
    await settle();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Edit planned item');
    expect(v.field('Amount')!.value).toBe('230');
    // PlannedCard.tsx:256 on main: a .error (critical) in the sheet.
    expect(v.notices(v.dialog())).toEqual([`Critical: ${REFUSED}`]);
    expect(v.cardNotices()).toEqual([]);
    act(() => click(v.button('Cancel', v.dialog()!)!));
    await settle();
    expect(v.cardNotices()).toEqual([`Caution: ${REFUSED}`]);
    expect(v.focused() === v.row('Car registration')).toBe(true);
    v.unmount();
  });

  test('through the store’s reading again after a refused save, the list stays drawn and the sheet open on what was typed', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const v = mountPlanned({ ok: async () => false, reading: () => held });
    await v.open('Car registration');
    act(() => type(v.field('Amount')!, '230'));
    await act(async () => click(v.button('Save', v.dialog()!)!));
    await settle();
    // Read again: drawn, not "Loading planned items…", and nothing opens.
    expect(v.host.textContent).not.toContain('Loading planned items…');
    expect(v.row('Tax refund')!.getAttribute('aria-disabled')).toBe('true');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Edit planned item');
    expect(v.field('Amount')!.value).toBe('230');
    expect(v.button('Saving…', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    // Its own save under way: Saving… says it, not "still loading".
    expect(v.dialog()!.textContent).not.toContain('Your planned items are still loading.');
    await act(async () => release());
    await settle();
    expect(v.notices(v.dialog())).toEqual([`Critical: ${REFUSED}`]);
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(false);
    expect(v.row('Tax refund')!.hasAttribute('aria-disabled')).toBe(false);
    v.unmount();
  });

  test('refused, and the reading again failing too: the sheet says why Save is off, where it is, offers no Delete, and on closing focus goes to the card’s heading', async () => {
    const UNREAD = 'Planned items could not be loaded. Editing is paused until they are; press Refresh to try again.';
    const v = mountPlanned({ ok: async () => false, reload: 'fails', error: UNREAD });
    await v.open('Car registration');
    expect(v.button('Delete planned item', v.dialog()!)).not.toBeNull();
    act(() => type(v.field('Amount')!, '230'));
    await act(async () => click(v.button('Save', v.dialog()!)!));
    await settle();
    const d = v.dialog()!;
    expect(v.field('Amount')!.value).toBe('230');
    expect(v.button('Save', d)!.hasAttribute('disabled')).toBe(true);
    // The refusal at the top, why Save is off at the foot, as Recurring says it.
    expect(v.notices(d)).toEqual([`Critical: ${REFUSED}`, "Caution: Your planned items couldn't be loaded, so this can't be saved now."]);
    expect(v.button('Delete planned item', d)).toBeNull();
    // The card draws only why it can't be read: neither the row nor Add.
    expect(v.cardNotices()).toEqual([`Caution: ${UNREAD}`]);
    expect(v.row('Car registration')).toBeNull();
    expect(v.button('Add a planned item')).toBeNull();
    act(() => click(v.button('Close', d)!));
    await settle();
    const heading = v.all((e) => e.tagName === 'H3')[0];
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(v.focused() === heading).toBe(true);
    v.unmount();
  });

  test('while the list is read again, a sheet that saves nothing says the items are still loading, with Save off', async () => {
    const v = mount(<PlannedCard planned={TWO} status="loading" drawn today={TODAY} currency="USD" onSave={async () => true} edit="car" />);
    await settle();
    const d = v.dialog()!;
    expect(v.button('Save', d)!.hasAttribute('disabled')).toBe(true);
    expect(v.notices(d)).toEqual([]);
    expect(d.findAll((e) => e.getAttribute('class') === 'helper').map((e) => e.textContent)).toContain('Your planned items are still loading.');
    expect(v.button('Delete planned item', d)).toBeNull();
    v.unmount();
  });

  test('drawn while the list is read again, a press on a row or on Add opens nothing; not drawn, it is loading', async () => {
    const drawn = mount(<PlannedCard planned={TWO} status="loading" drawn today={TODAY} currency="USD" onSave={async () => true} />);
    expect(drawn.host.textContent).not.toContain('Loading planned items…');
    const r = drawn.row('Car registration')!;
    expect(r.getAttribute('aria-disabled')).toBe('true');
    act(() => click(r));
    act(() => click(drawn.button('Add a planned item')!));
    await settle();
    expect(drawn.dialog()).toBeNull();
    drawn.unmount();
    const loading = mount(<PlannedCard planned={TWO} status="loading" today={TODAY} currency="USD" onSave={async () => true} />);
    expect(loading.all((e) => e.getAttribute('class') === 'empty-note').map((e) => e.textContent)).toEqual(['Loading planned items…']);
    expect(loading.row('Car registration')).toBeNull();
    loading.unmount();
  });

  test('Delete planned item asks first, a level in with Keep it focused: Keep it and Back go back; Delete deletes, and focus goes to Add a planned item', async () => {
    const v = mountPlanned();
    await v.open('Car registration');
    act(() => click(v.button('Delete planned item', v.dialog()!)!));
    const d = () => v.dialog()!;
    expect(d().getAttribute('aria-label')).toBe('Delete planned item');
    expect(d().textContent).toContain('Delete Car registration?');
    expect(v.focused() === v.button('Keep it', d())).toBe(true);
    expect(v.button('Keep it', d())!.getAttribute('class')).toBe('btn secondary');
    expect(v.button('Delete', d())!.getAttribute('class')).toBe('btn danger');
    act(() => click(v.button('Keep it', d())!));
    expect(d().getAttribute('aria-label')).toBe('Edit planned item');
    act(() => click(v.button('Delete planned item', d())!));
    act(() => click(v.button('Back', d())!));
    expect(d().getAttribute('aria-label')).toBe('Edit planned item');
    act(() => click(v.button('Delete planned item', d())!));
    await act(async () => click(v.button('Delete', d())!));
    await settle();
    expect(v.saved).toEqual([{ ...TWO, items: [REFUND] }]);
    expect(v.dialog()).toBeNull();
    expect(v.row('Car registration')).toBeNull();
    expect(v.focused() === v.button('Add a planned item')).toBe(true);
    v.unmount();
  });

  test('a refused Delete stays on its question, saying why; Delete tries again', async () => {
    let answer = false;
    const v = mountPlanned({ ok: async () => answer });
    await v.open('Tax refund');
    act(() => click(v.button('Delete planned item', v.dialog()!)!));
    await act(async () => click(v.button('Delete', v.dialog()!)!));
    await settle();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Delete planned item');
    expect(v.notices(v.dialog())).toEqual([`Critical: ${REFUSED}`]);
    // Back in the list, as the store puts back what is stored.
    expect(v.row('Tax refund')).not.toBeNull();
    answer = true;
    await act(async () => click(v.button('Delete', v.dialog()!)!));
    await settle();
    expect(v.dialog()).toBeNull();
    expect(v.saved).toHaveLength(2);
    v.unmount();
  });

  test('each opening starts afresh: what was typed and left isn’t there the next time, nor the level it was left on', async () => {
    const v = mountPlanned();
    await v.open('Car registration');
    act(() => type(v.field('Name')!, 'Something else'));
    act(() => click(v.button('Delete planned item', v.dialog()!)!));
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    await v.open('Car registration');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Edit planned item');
    expect(v.field('Name')!.value).toBe('Car registration');
    act(() => click(v.button('Cancel', v.dialog()!)!));
    await settle(400);
    act(() => click(v.button('Add a planned item')!));
    await settle();
    expect(v.field('Name')!.value).toBe('');
    v.unmount();
  });

  test('unreadable, it says why on the card and offers nothing to edit', () => {
    const v = mount(<PlannedCard planned={TWO} status="error" error="Planned items could not be loaded." today={TODAY} currency="USD" onSave={async () => true} />);
    expect(v.cardNotices()).toEqual(['Caution: Planned items could not be loaded.']);
    expect(v.row('Car registration')).toBeNull();
    expect(v.button('Add a planned item')).toBeNull();
    v.unmount();
  });
});
