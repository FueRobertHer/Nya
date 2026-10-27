import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, FakeElement, FakeEvent } from './mini-dom';
import { categoriesFor } from './category-fixture';
import { row } from './budget-notes-fixture';

// Budgets > Month's sheets (rollout phase 6a2, docs/design/information-
// architecture.md#budgets), used as a person would (react-dom/client over
// test/mini-dom.ts): a budget's row opens its sheet, with its amount, the
// suggestion from history, and its rollover, reset and remove as levels with
// Back; a deleted category's budget opens one that removes it; + Add budget
// opens Add budget's; "My income is irregular" is a row that opens its
// setting. A save that fails keeps the sheet open on what was typed and says
// why, through the real store (lib/whole-list-store.ts) and the month wired
// as the dashboard wires it.

const dom = installDom();
// The month and the budgets as the server answers them, for the tests that
// go through the store and the month's own hook; the rest never ask.
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: BudgetsCard } = await import('@/components/BudgetsCard');
const { default: BudgetsTab } = await import('@/components/BudgetsTab');
const { IncomeSetting } = await import('@/components/IncomePool');
const { useBudgetMonth } = await import('@/components/budget-month-state');
const { createWholeListStore } = await import('@/lib/whole-list-store');
const { suggestBudgets, consideredMonths } = await import('@/lib/budget-suggestions');
const { indexTaxonomy } = await import('@/lib/categories');
const { addMonths, monthName } = await import('@/lib/rollover');
const { localMonth } = await import('@/lib/local-date');
const { formatMoney } = await import('@/lib/format');
type Budgets = import('@/lib/budget-set').Budgets;
type Target = import('@/components/BudgetsCard').Target;
type RolloverChange = import('@/components/BudgetsCard').RolloverChange;
type RolloverSettings = import('@/components/BudgetsCard').RolloverSettings;
type BudgetMonthView = import('@/components/budget-month-state').BudgetMonthView;
type ListState = import('@/lib/whole-list-store').ListState<Budgets>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const NOW = localMonth();
const { taxonomy } = categoriesFor({}, { words: ['groceries', 'restaurants'], groups: { groceries: 'Food', restaurants: 'Food' } });
const ix = indexTaxonomy(taxonomy);
const GROCERIES = taxonomy.categories.find((c) => c.name === 'groceries')!.id;
const RESTAURANTS = taxonomy.categories.find((c) => c.name === 'restaurants')!.id;
const FOOD = taxonomy.groups.find((g) => g.name === 'Food')!.id;
const ONE: Budgets = { categories: { [GROCERIES]: { amount: 300 } }, groups: {} };
const money = (n: number) => formatMoney(n, 'USD');

// What was spent on groceries in the three months before: the sheet's suggestion.
const [JUL, AUG, SEP] = consideredMonths(NOW);
const SUGGESTIONS = suggestBudgets({
  month: NOW,
  rows: [JUL, AUG, SEP].map((m, i) => ({ transaction_id: `s${i}`, date: `${m}-03`, amount: 320, category: 'groceries', transaction_code: null, iso_currency_code: 'USD', excluded: false })),
  currency: 'USD',
  ix,
  earliest: addMonths(NOW, -24),
  gaps: () => [],
});
const SUGGESTED = SUGGESTIONS.categories[GROCERIES]!.amount!;

const settings = (rolling: Record<string, string> = {}): RolloverSettings => ({
  rolling: { categories: rolling, groups: {} },
  starts: { categories: { [GROCERIES]: addMonths(NOW, -6) }, groups: {} },
  ended: { categories: {}, groups: {} },
  earliest: addMonths(NOW, -6),
});

/** The time a sheet takes to slide in (one frame), or out. */
const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

function harness(host: FakeElement) {
  const all = (test: (e: FakeElement) => boolean) => host.findAll(test);
  /** A button by its words or its label, in `within` (the page by default). */
  const button = (label: string, within: FakeElement = host) =>
    within.findAll((e) => e.tagName === 'BUTTON' && (e.textContent.trim() === label || e.getAttribute('aria-label') === label))[0] ?? null;
  /** A row of the list, by the start of its title. */
  const row = (title: string, within: FakeElement = host) =>
    within.findAll(
      (e) =>
        (e.tagName === 'BUTTON' || e.tagName === 'DIV') &&
        (e.getAttribute('class') ?? '').split(' ').includes('list-row') &&
        e.findAll((x) => x.getAttribute('class') === 'list-row-title')[0]?.textContent.startsWith(title) === true
    )[0] ?? null;
  /** The sheet on the page (not one sliding out). */
  const dialog = () => all((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
  const field = (label: string) => dialog()?.findAll((e) => (e.tagName === 'INPUT' || e.tagName === 'SELECT') && e.getAttribute('aria-label') === label)[0] ?? null;
  /** The select in the sheet's field whose label starts so. */
  const select = (label: string) =>
    dialog()
      ?.findAll((e) => e.tagName === 'LABEL' && e.textContent.startsWith(label))[0]
      ?.findAll((e) => e.tagName === 'SELECT')[0] ?? null;
  const notices = () => dialog()?.findAll((e) => (e.getAttribute('class') ?? '').startsWith('notice ')).map((e) => e.textContent) ?? [];
  const open = async (title: string) => {
    const r = row(title)!;
    r.focus();
    act(() => click(r));
    await settle();
  };
  const add = () => all((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '').includes('budget-add-button'))[0] ?? null;
  const focused = () => dom.document.activeElement as unknown as FakeElement;
  const key = (k: string) => {
    const e = new FakeEvent('keydown');
    e.key = k;
    act(() => {
      (dom.document.defaultView as unknown as FakeElement).dispatchEvent(e);
    });
  };
  return { all, button, row, dialog, field, select, notices, open, add, focused, key };
}

type CardProps = Partial<React.ComponentProps<typeof BudgetsCard>>;
const REFUSED = 'Could not save budgets. Showing what is saved.';
/** The card, its budgets kept as the store keeps them: the list saved shows
 *  at once; `ok` false, it is put back and the refusal said, as a refused
 *  save does (lib/whole-list-store.ts, which clears its refusal as a save
 *  starts). */
function mountCard(props: CardProps & { initial?: Budgets; ok?: boolean | (() => Promise<boolean>) } = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const saved: Budgets[] = [];
  const { initial = ONE, ok = true, ...rest } = props;
  function Card() {
    const [budgets, setBudgets] = useState(initial);
    const [saveError, setSaveError] = useState<string | null>(rest.saveError ?? null);
    return (
      <BudgetsCard
        taxonomy={taxonomy}
        budgets={budgets}
        spent={{ [GROCERIES]: 120 }}
        currency="USD"
        editable
        noSpending={false}
        month={NOW}
        {...rest}
        saveError={saveError}
        onSave={async (next) => {
          saved.push(next);
          const before = budgets;
          setBudgets(next);
          setSaveError(null);
          const done = typeof ok === 'function' ? await ok() : ok;
          if (!done) {
            setBudgets(before);
            setSaveError(REFUSED);
          }
          return done;
        }}
      />
    );
  }
  act(() => root.render(<Card />));
  return { host, saved, ...harness(host as unknown as FakeElement), unmount: () => act(() => root.unmount()) };
}

describe('a budget’s sheet', () => {
  test('its row opens it, focus in it; Save saves the amount typed and closes it, focus back on the row', async () => {
    const v = mountCard({ open: [FOOD] });
    const r = v.row('Groceries')!;
    expect(r.getAttribute('aria-haspopup')).toBe('dialog');
    // Nothing to press inside a row: the whole row is the target.
    expect(r.findAll((e) => e !== r && ['BUTTON', 'A', 'INPUT', 'SELECT'].includes(e.tagName))).toHaveLength(0);
    await v.open('Groceries');
    const d = v.dialog()!;
    expect(d.getAttribute('aria-label')).toBe('Groceries');
    expect(d.contains(v.focused())).toBe(true);
    // Its figures as its row has them, and its amount as saved.
    expect(d.textContent).toContain(`${money(120)} of ${money(300)}`);
    const amount = v.field('Monthly budget for Groceries')!;
    expect(amount.value).toBe('300');
    act(() => type(amount, '450'));
    await act(async () => click(v.button('Save', d)!));
    await settle();
    expect(v.saved).toEqual([{ categories: { [GROCERIES]: { amount: 450 } }, groups: {} }]);
    expect(v.dialog()).toBeNull();
    expect(v.focused() === v.row('Groceries')).toBe(true);
    v.unmount();
  });

  test('Save waits for an amount above zero', async () => {
    const v = mountCard({ open: [FOOD] });
    await v.open('Groceries');
    const save = () => v.button('Save', v.dialog()!)!;
    for (const typed of ['', '0', '-5']) {
      act(() => type(v.field('Monthly budget for Groceries')!, typed));
      expect([typed, save().hasAttribute('disabled')]).toEqual([typed, true]);
    }
    act(() => type(v.field('Monthly budget for Groceries')!, '12.5'));
    expect(save().hasAttribute('disabled')).toBe(false);
    v.unmount();
  });

  test('a refused save keeps it open on what was typed, saying why, a caution at its top; one said before it opened isn’t said in it', async () => {
    const v = mountCard({ open: [FOOD], ok: false, saveError: REFUSED });
    await v.open('Groceries');
    expect(v.notices()).toEqual([]);
    act(() => type(v.field('Monthly budget for Groceries')!, '450'));
    await act(async () => click(v.button('Save', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Groceries');
    expect(v.field('Monthly budget for Groceries')!.value).toBe('450');
    // The same words, refused again: this save's, so said.
    expect(v.notices()).toEqual([`Caution: ${REFUSED}`]);
    v.unmount();
  });

  test('closing waits for a save under way, by its button, the backdrop and Escape', async () => {
    let finish: (ok: boolean) => void = () => {};
    const v = mountCard({ open: [FOOD], ok: () => new Promise<boolean>((r) => (finish = r)) });
    await v.open('Groceries');
    act(() => type(v.field('Monthly budget for Groceries')!, '450'));
    act(() => click(v.button('Save', v.dialog()!)!));
    expect(v.button('Saving…', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    act(() => click(v.button('Close', v.dialog()!)!));
    act(() => click(v.all((e) => (e.getAttribute('class') ?? '') === 'sheet-backdrop')[0]));
    v.key('Escape');
    expect(v.dialog()).not.toBeNull();
    await act(async () => finish(true));
    await settle();
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('Remove asks first: Keep it goes back; Remove takes it out, and with its group gone focus goes to + Add budget', async () => {
    const v = mountCard({ open: [FOOD] });
    await v.open('Groceries');
    act(() => click(v.button('Remove…', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Remove budget');
    expect(v.dialog()!.textContent).toContain('Remove the budget for Groceries?');
    // The safe answer has focus, so a stray Enter keeps the budget.
    expect(v.focused() === v.button('Keep it', v.dialog()!)).toBe(true);
    act(() => click(v.button('Keep it', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Groceries');
    act(() => click(v.button('Remove…', v.dialog()!)!));
    await act(async () => click(v.button('Remove', v.dialog()!)!));
    await settle();
    expect(v.saved).toEqual([{ categories: {}, groups: {} }]);
    expect(v.row('Food')).toBeNull();
    expect(v.dialog()).toBeNull();
    expect(v.focused() === v.add()).toBe(true);
    v.unmount();
  });

  test('a budget that rolls over says, when removed, that its rollover ends with it', async () => {
    const v = mountCard({ open: [FOOD], rollover: settings({ [GROCERIES]: addMonths(NOW, -2) }), onRollover: async () => null, editLevel: 'remove', edit: { kind: 'category', id: GROCERIES } });
    await settle();
    expect(v.dialog()!.textContent).toContain('Remove the budget for Groceries? Its rollover ends with it: adding it again starts without one.');
    v.unmount();
  });

  test('a failed Remove stays on its question, saying why at its top; Remove tries again', async () => {
    let answer = false;
    const v = mountCard({ open: [FOOD], ok: async () => answer, edit: { kind: 'category', id: GROCERIES }, editLevel: 'remove' });
    await settle();
    await act(async () => click(v.button('Remove', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Remove budget');
    expect(v.notices()).toEqual([`Caution: ${REFUSED}`]);
    // Back in the list, as the store puts back what is stored.
    expect(v.row('Food')).not.toBeNull();
    answer = true;
    await act(async () => click(v.button('Remove', v.dialog()!)!));
    await settle();
    expect(v.dialog()).toBeNull();
    expect(v.saved).toHaveLength(2);
    v.unmount();
  });

  test('the suggestion from history is used with one tap: saved, and closed', async () => {
    const v = mountCard({ open: [FOOD], suggestions: SUGGESTIONS });
    await v.open('Groceries');
    const use = v.button(`Use ${money(SUGGESTED)}`, v.dialog()!)!;
    expect(use.getAttribute('class')).toBe('btn secondary');
    await act(async () => click(use));
    await settle();
    expect(v.saved).toEqual([{ categories: { [GROCERIES]: { amount: SUGGESTED } }, groups: {} }]);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('each opening starts afresh: an amount typed and left isn’t there the next time', async () => {
    const v = mountCard({ open: [FOOD] });
    await v.open('Groceries');
    act(() => type(v.field('Monthly budget for Groceries')!, '999'));
    act(() => click(v.button('Remove…', v.dialog()!)!));
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    await v.open('Groceries');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Groceries');
    expect(v.field('Monthly budget for Groceries')!.value).toBe('300');
    v.unmount();
  });

  test('a group’s own budget: its sheet is the group as a whole’s', async () => {
    const v = mountCard({ open: [FOOD], initial: { categories: { [GROCERIES]: { amount: 300 } }, groups: { [FOOD]: { amount: 250 } } } });
    await v.open('For Food as a whole');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Food as a whole');
    expect(v.field('Monthly budget for Food as a whole')!.value).toBe('250');
    // The reconcile sentence, as the opened group says it.
    expect(v.dialog()!.textContent).toContain(`Its categories’ budgets add up to ${money(300)}, more than the ${money(250)} set for Food, so ${money(250)} is the limit.`);
    v.unmount();
  });
});

describe('focus after a sheet closes', () => {
  test('a Remove refused takes the row out and puts it back: closing gives focus to the row as it is drawn now', async () => {
    let finish: (ok: boolean) => void = () => {};
    const v = mountCard({ open: [FOOD], ok: () => new Promise<boolean>((r) => (finish = r)) });
    await v.open('Groceries');
    const before = v.row('Groceries')!;
    act(() => click(v.button('Remove…', v.dialog()!)!));
    act(() => click(v.button('Remove', v.dialog()!)!));
    // Its group's last budget: the list shown while it saves has no Food.
    expect(v.row('Food')).toBeNull();
    await act(async () => finish(false));
    // Put back: a row of its own, drawn again.
    const now = v.row('Groceries')!;
    expect(now === before).toBe(false);
    act(() => click(v.button('Keep it', v.dialog()!)!));
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle();
    expect(v.focused() === now).toBe(true);
    v.unmount();
  });
});

describe('a budget’s rollover, a level in', () => {
  const rolled: [Target, RolloverChange][] = [];
  const onRollover = async (t: Target, c: RolloverChange) => {
    rolled.push([t, c]);
    return null;
  };

  test('off: its row waits while a new amount is typed, saying why; then on, from the month chosen', async () => {
    rolled.length = 0;
    const v = mountCard({ open: [FOOD], rollover: settings(), onRollover });
    await v.open('Groceries');
    const r = () => v.row('Rollover', v.dialog()!)!;
    expect(r().textContent).toContain('Off');
    act(() => type(v.field('Monthly budget for Groceries')!, '400'));
    // Still in the tab order, so what it says under it is met.
    expect(r().getAttribute('aria-disabled')).toBe('true');
    expect(r().hasAttribute('disabled')).toBe(false);
    const why = v.dialog()!.findAll((e) => e.getAttribute('id') === r().getAttribute('aria-describedby'))[0];
    expect(why.textContent).toBe('Save the new amount first to change rollover.');
    act(() => click(r()));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Groceries');
    // The same amount as saved, written another way, is no new amount.
    act(() => type(v.field('Monthly budget for Groceries')!, '300.00'));
    expect(r().hasAttribute('aria-disabled')).toBe(false);
    act(() => click(r()));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Rollover for Groceries');
    expect(v.dialog()!.textContent).toContain('Roll over what’s left (or overspent) into the next month, counting from');
    act(() => type(v.select('Roll over')!, addMonths(NOW, -1)));
    await act(async () => click(v.button('Turn on rollover', v.dialog()!)!));
    await settle();
    expect(rolled).toEqual([[{ kind: 'category', id: GROCERIES }, { on: true, from: addMonths(NOW, -1) }]]);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('on: since when, turned off, or its carry reset, confirmed with Cancel focused and Back to the rollover', async () => {
    rolled.length = 0;
    const v = mountCard({ open: [FOOD], rollover: settings({ [GROCERIES]: addMonths(NOW, -2) }), onRollover });
    await v.open('Groceries');
    const r = v.row('Rollover', v.dialog()!)!;
    expect(r.textContent).toContain(`On since ${monthName(addMonths(NOW, -2), NOW)}`);
    act(() => click(r));
    expect(v.dialog()!.textContent).toContain(`Rolling over since ${monthName(addMonths(NOW, -2), NOW)}`);
    act(() => click(v.button('Reset carryover…', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Reset carryover');
    expect(v.focused() === v.button('Cancel', v.dialog()!)).toBe(true);
    // Back, one inner level to another: focus on the sheet, not lost.
    act(() => click(v.button('Back', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Rollover for Groceries');
    expect(v.focused() === v.dialog()).toBe(true);
    act(() => click(v.button('Reset carryover…', v.dialog()!)!));
    act(() => click(v.button('Cancel', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Rollover for Groceries');
    act(() => click(v.button('Reset carryover…', v.dialog()!)!));
    // Undone by turning it on again from the month it ran from: the level's
    // primary button, not a danger one.
    const reset = v.button('Reset carryover', v.dialog()!)!;
    expect(reset.getAttribute('class')).toBe('btn');
    await act(async () => click(reset));
    await settle();
    expect(rolled).toEqual([[{ kind: 'category', id: GROCERIES }, { reset: true }]]);
    await v.open('Groceries');
    act(() => click(v.row('Rollover', v.dialog()!)!));
    await act(async () => click(v.button('Turn off rollover', v.dialog()!)!));
    expect(rolled[1]).toEqual([{ kind: 'category', id: GROCERIES }, { on: false }]);
    v.unmount();
  });

  test('a change refused says why in its own sheet, which stays open', async () => {
    const v = mountCard({ open: [FOOD], rollover: settings(), onRollover: async () => 'That change couldn’t be saved. Try again.', edit: { kind: 'category', id: GROCERIES }, editLevel: 'rollover' });
    await settle();
    await act(async () => click(v.button('Turn on rollover', v.dialog()!)!));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Rollover for Groceries');
    expect(v.notices()).toEqual(['Caution: That change couldn’t be saved. Try again.']);
    // Back, and the refusal goes with the level it was said on.
    act(() => click(v.button('Back', v.dialog()!)!));
    expect(v.notices()).toEqual([]);
    v.unmount();
  });

  test('Back waits for a change under way, as closing does', async () => {
    let finish: (e: string | null) => void = () => {};
    const v = mountCard({ open: [FOOD], rollover: settings(), onRollover: () => new Promise((r) => (finish = r)), edit: { kind: 'category', id: GROCERIES }, editLevel: 'rollover' });
    await settle();
    act(() => click(v.button('Turn on rollover', v.dialog()!)!));
    act(() => click(v.button('Back', v.dialog()!)!));
    v.key('Escape');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Rollover for Groceries');
    await act(async () => finish(null));
    v.unmount();
  });

  for (const [level, control] of [
    ['rollover', 'Turn on rollover'],
    ['reset', 'Reset carryover'],
  ] as const) {
  test(`should the month’s view go, the ${level} level says why instead of its controls, and they come back with it`, async () => {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const draw = (known: boolean) =>
      act(() =>
        root.render(
          <BudgetsCard
            taxonomy={taxonomy}
            budgets={ONE}
            spent={{}}
            currency="USD"
            editable
            noSpending={false}
            onSave={async () => true}
            open={[FOOD]}
            month={NOW}
            edit={{ kind: 'category', id: GROCERIES }}
            editLevel={level}
            rollover={known ? settings() : null}
            onRollover={known ? onRollover : undefined}
            monthError={known ? null : 'Rollover couldn’t be worked out just now, so each budget shows its amount without it.'}
          />
        )
      );
    draw(true);
    const v = harness(host as unknown as FakeElement);
    await settle();
    expect(v.button(control, v.dialog()!)).not.toBeNull();
    draw(false);
    expect(v.notices()).toEqual(['Caution: Rollover couldn’t be worked out just now, so each budget shows its amount without it.']);
    expect(v.button(control, v.dialog()!)).toBeNull();
    draw(true);
    expect(v.button(control, v.dialog()!)).not.toBeNull();
    act(() => root.unmount());
  });
  }

  test('its row waits while a change is under way too: a suggestion just used, say', async () => {
    let finish: (ok: boolean) => void = () => {};
    const v = mountCard({ open: [FOOD], rollover: settings(), onRollover, suggestions: SUGGESTIONS, ok: () => new Promise<boolean>((r) => (finish = r)) });
    await v.open('Groceries');
    act(() => click(v.button(`Use ${money(SUGGESTED)}`, v.dialog()!)!));
    const r = v.row('Rollover', v.dialog()!)!;
    expect(r.getAttribute('aria-disabled')).toBe('true');
    act(() => click(r));
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Groceries');
    // Refused: the amount as saved, and the row open again.
    await act(async () => finish(false));
    expect(v.row('Rollover', v.dialog()!)!.hasAttribute('aria-disabled')).toBe(false);
    v.unmount();
  });

  test('its row names the month its carry counts from, as the level says it, when the two differ', async () => {
    // Rolling over from three months back, the carry counted from the first
    // month with transactions, two months back.
    const carries = { categories: { [GROCERIES]: { carry: 40, from: addMonths(NOW, -2), why: 'data' as const, start: addMonths(NOW, -3), uncertain: [] } }, groups: {} };
    const v = mountCard({ open: [FOOD], rollover: settings({ [GROCERIES]: addMonths(NOW, -3) }), onRollover, carries });
    await v.open('Groceries');
    const r = v.row('Rollover', v.dialog()!)!;
    expect(r.textContent).toContain(`On since ${monthName(addMonths(NOW, -2), NOW)}`);
    act(() => click(r));
    expect(v.dialog()!.textContent).toContain(`Rolling over since ${monthName(addMonths(NOW, -2), NOW)}, the first month with transactions`);
    v.unmount();
  });
});

describe('a budget on a category since deleted, and Add budget', () => {
  test('the deleted one’s row opens a sheet that removes it; focus then goes to + Add budget', async () => {
    const v = mountCard({ initial: { categories: { gone_1: { amount: 25 } }, groups: {} } });
    await v.open('A category since deleted');
    const d = v.dialog()!;
    expect(d.getAttribute('aria-label')).toBe('A category since deleted');
    expect(d.textContent).toContain(money(25));
    expect(v.button('Remove budget', d)!.getAttribute('class')).toBe('btn danger');
    await act(async () => click(v.button('Remove budget', d)!));
    await settle();
    expect(v.saved).toEqual([{ categories: {}, groups: {} }]);
    expect(v.focused() === v.add()).toBe(true);
    v.unmount();
  });

  test('Add: a category chosen and an amount typed, added; its group opens, and focus is back on + Add budget', async () => {
    const v = mountCard();
    expect(v.row('Food')!.getAttribute('aria-expanded')).toBe('false');
    v.add()!.focus();
    act(() => click(v.add()!));
    await settle();
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Add budget');
    const go = () => v.button('Add budget', v.dialog()!)!;
    expect(go().hasAttribute('disabled')).toBe(true);
    act(() => type(v.field('Category or group to budget')!, `category:${RESTAURANTS}`));
    expect(go().hasAttribute('disabled')).toBe(true);
    act(() => type(v.field('Monthly limit')!, '120'));
    await act(async () => click(go()));
    await settle();
    expect(v.saved).toEqual([{ categories: { [GROCERIES]: { amount: 300 }, [RESTAURANTS]: { amount: 120 } }, groups: {} }]);
    expect(v.dialog()).toBeNull();
    expect(v.row('Food')!.getAttribute('aria-expanded')).toBe('true');
    expect(v.focused() === v.add()).toBe(true);
    v.unmount();
  });

  test('each opening of Add starts afresh, and its suggestion adds at once', async () => {
    const v = mountCard({ suggestions: SUGGESTIONS, initial: { categories: {}, groups: {} } });
    act(() => click(v.add()!));
    await settle();
    act(() => type(v.field('Category or group to budget')!, `category:${GROCERIES}`));
    act(() => type(v.field('Monthly limit')!, '77'));
    act(() => click(v.button('Close', v.dialog()!)!));
    await settle(400);
    act(() => click(v.add()!));
    await settle();
    expect([v.field('Category or group to budget')!.value, v.field('Monthly limit')!.value]).toEqual(['', '']);
    act(() => type(v.field('Category or group to budget')!, `category:${GROCERIES}`));
    await act(async () => click(v.button(`Add at ${money(SUGGESTED)}`, v.dialog()!)!));
    await settle();
    expect(v.saved).toEqual([{ categories: { [GROCERIES]: { amount: SUGGESTED } }, groups: {} }]);
    v.unmount();
  });

  test('a month gone by: its rows open nothing, its groups still open and close, and nothing is added', async () => {
    const v = mountCard({ past: true, month: addMonths(NOW, -1) });
    expect(v.add()).toBeNull();
    act(() => click(v.row('Food')!));
    expect(v.row('Food')!.getAttribute('aria-expanded')).toBe('true');
    const r = v.row('Groceries')!;
    expect(r.tagName).toBe('DIV');
    expect(r.findAll((e) => e.tagName === 'svg')).toHaveLength(0);
    act(() => click(r));
    await settle();
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('with no spending to count: each limit, or "Nothing left", never "$0 of"', () => {
    const v = mountCard({
      noSpending: true,
      open: [FOOD],
      initial: { categories: { [GROCERIES]: { amount: 300 }, [RESTAURANTS]: { amount: 50 } }, groups: {} },
      carries: { categories: { [RESTAURANTS]: { carry: -80, from: addMonths(NOW, -2), why: 'start', start: addMonths(NOW, -2), uncertain: [] } }, groups: {} },
    });
    expect(v.row('Groceries')!.textContent).toContain(`${money(300)} limit`);
    expect(v.row('Restaurants')!.textContent).toContain('Nothing left');
    expect(v.host.textContent).not.toContain(`${money(0)} of`);
    v.unmount();
  });
});

describe('My income is irregular', () => {
  function mountSetting(onChange: (c: unknown) => Promise<string | null>, on = false) {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    act(() =>
      root.render(<IncomeSetting setting={on ? { version: 1, enabled: true, start: addMonths(NOW, -1) } : null} today={NOW} earliest={addMonths(NOW, -6)} disabled={false} onChange={onChange} />)
    );
    return { ...harness(host as unknown as FakeElement), unmount: () => act(() => root.unmount()) };
  }

  test('a row saying whether it is on, which opens its setting; Turn on from a month chosen closes it', async () => {
    const asked: unknown[] = [];
    const v = mountSetting(async (c) => (asked.push(c), null));
    expect(v.row('My income is irregular')!.textContent).toContain('Off');
    await v.open('My income is irregular');
    expect(v.dialog()!.textContent).toContain('Budgets work as they always do.');
    act(() => type(v.select('Count from')!, addMonths(NOW, -2)));
    await act(async () => click(v.button('Turn on', v.dialog()!)!));
    await settle();
    expect(asked).toEqual([{ enabled: true, start: addMonths(NOW, -2) }]);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });

  test('a change refused stays open, saying why; Turn off when it is on', async () => {
    const asked: unknown[] = [];
    let refuse = true;
    const v = mountSetting(async (c) => (asked.push(c), refuse ? 'That change couldn’t be saved. Check your connection and try again.' : null), true);
    expect(v.row('My income is irregular')!.textContent).toContain('On');
    await v.open('My income is irregular');
    await act(async () => click(v.button('Turn off', v.dialog()!)!));
    expect(v.notices()).toEqual(['Caution: That change couldn’t be saved. Check your connection and try again.']);
    refuse = false;
    await act(async () => click(v.button('Turn off', v.dialog()!)!));
    await settle();
    expect(asked).toEqual([{ enabled: false }, { enabled: false }]);
    expect(v.dialog()).toBeNull();
    v.unmount();
  });
});

describe('a save that fails, through the store and the month as the dashboard wires them', () => {
  // The server: the budgets stored, a save refused when told to, a read
  // held when told to (to look at the page while it is under way), and the
  // month's answer.
  let stored: Budgets = ONE;
  let refuse = 0;
  let hold: Promise<void> | null = null;
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
  const view = (): BudgetMonthView => ({
    history: true,
    month: NOW,
    today: NOW,
    currency: 'USD',
    budgets: stored,
    assumed: { categories: [], groups: [] },
    recorded_since: addMonths(NOW, -6),
    carries: { categories: {}, groups: {} },
    rollover: { categories: {}, groups: {} },
    starts: { categories: { [GROCERIES]: addMonths(NOW, -6) }, groups: {} },
    ended: { categories: {}, groups: {} },
    spent: {},
    income: null,
    pool: null,
    earliest: addMonths(NOW, -6),
    gaps: [],
    left_out_text: null,
    counted_left_out_text: null,
    notes: [],
    suggestions: SUGGESTIONS,
  });
  const server = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
    if (url.startsWith('/api/budgets/month')) return reply(200, view());
    if (url === '/api/budgets' && init?.method === 'PUT') {
      if (refuse > 0) {
        refuse--;
        return reply(500, {});
      }
      stored = JSON.parse(init.body!).budget_set;
      return reply(200, { budget_set: stored });
    }
    if (url === '/api/budgets') {
      if (hold) await hold;
      return reply(200, { budget_set: stored });
    }
    return reply(404, {});
  };

  test('the sheet stays open on what was typed, with its suggestion and rollover, and says the new refusal, not the one before it opened', async () => {
    globalThis.fetch = server as unknown as typeof fetch;
    let push: (s: ListState) => void = () => {};
    const store = createWholeListStore<Budgets>({
      url: '/api/budgets',
      field: 'budget_set',
      noun: 'budgets',
      empty: { categories: {}, groups: {} },
      isValid: (v): v is Budgets => !!v && typeof v === 'object',
      onChange: (s) => push(s),
      fetch: server as never,
    });
    /** The tab, wired as components/Dashboard.tsx wires it: once the budgets
     *  have been ready, a reload keeps the month, paused. */
    function Page() {
      const [s, setS] = useState(store.get());
      push = setS;
      const [wereReady, setWereReady] = useState(false);
      if (s.status !== 'loading' && wereReady !== (s.status === 'ready')) setWereReady(s.status === 'ready');
      const held = s.status === 'ready' || (s.status === 'loading' && wereReady);
      const month = useBudgetMonth(held ? NOW : null, [s.value], { paused: s.saving || s.status !== 'ready', history: true });
      return (
        <BudgetsTab
          txns={[row('g', { amount: 120 })]}
          budgets={s.value}
          taxonomy={taxonomy}
          budgetsStatus={s.status}
          budgetsError={s.error}
          budgetsSaveError={s.saveError}
          onSave={store.save}
          goals={[]}
          onSaveGoals={async () => true}
          accounts={[]}
          loading={false}
          series={[]}
          budgetMonth={month}
        />
      );
    }
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    act(() => root.render(<Page />));
    expect(host.textContent).toContain('Loading budgets');
    await act(async () => store.load());
    await settle();
    const v = harness(host as unknown as FakeElement);

    // A save refused before the sheet opens: said on the card, and not in
    // the sheet, which says only what arises while it is open.
    refuse = 1;
    await act(async () => void (await store.save({ categories: { [GROCERIES]: { amount: 350 } }, groups: {} })));
    await settle();
    expect(host.textContent).toContain(REFUSED);
    act(() => click(v.row('Food')!));
    await v.open('Groceries');
    expect(v.notices()).toEqual([]);
    act(() => type(v.field('Monthly budget for Groceries')!, '450'));

    // Refused, and the store reads the budgets again: held, to see the page
    // meanwhile.
    refuse = 1;
    let release: () => void = () => {};
    hold = new Promise((r) => (release = r));
    await act(async () => click(v.button('Save', v.dialog()!)!));
    await settle();
    // The store reading the budgets again: the card still drawn, read only,
    // and the sheet open on what was typed, its suggestion and rollover kept.
    expect(host.textContent).not.toContain('Loading budgets');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Groceries');
    expect(v.field('Monthly budget for Groceries')!.value).toBe('450');
    expect(v.button(`Use ${money(SUGGESTED)}`, v.dialog()!)).not.toBeNull();
    expect(v.row('Rollover', v.dialog()!)).not.toBeNull();
    expect(v.button('Saving…', v.dialog()!)!.hasAttribute('disabled')).toBe(true);
    await act(async () => release());
    hold = null;
    await settle();
    // Read again: still open, the same words said again as this save's refusal.
    expect(v.dialog()!.getAttribute('aria-label')).toBe('Groceries');
    expect(v.field('Monthly budget for Groceries')!.value).toBe('450');
    expect(v.notices()).toEqual([`Caution: ${REFUSED}`]);
    expect(v.row('Rollover', v.dialog()!)).not.toBeNull();
    expect(v.button('Save', v.dialog()!)!.hasAttribute('disabled')).toBe(false);
    // And Save again, this time saved.
    await act(async () => click(v.button('Save', v.dialog()!)!));
    await settle();
    expect(v.dialog()).toBeNull();
    expect(stored).toEqual({ categories: { [GROCERIES]: { amount: 450 } }, groups: {} });
    act(() => root.unmount());
  });
});

describe('the tab around its sheets: the income setting and a past month', () => {
  // The month's answers, as the server gives them, and whether it can be reached.
  let offline = false;
  const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;
  const monthView = (over: Partial<BudgetMonthView> = {}): BudgetMonthView => ({
    history: true,
    month: NOW,
    today: NOW,
    currency: 'USD',
    budgets: ONE,
    assumed: { categories: [], groups: [] },
    recorded_since: addMonths(NOW, -6),
    carries: { categories: {}, groups: {} },
    rollover: { categories: {}, groups: {} },
    starts: { categories: {}, groups: {} },
    ended: { categories: {}, groups: {} },
    spent: { [GROCERIES]: 80 },
    income: null,
    pool: null,
    earliest: addMonths(NOW, -6),
    gaps: [],
    left_out_text: null,
    counted_left_out_text: null,
    notes: [],
    ...over,
  });
  /** The answer for each month asked, by month. */
  let answers: Record<string, BudgetMonthView> = {};
  const server = async (url: string) => {
    if (offline) throw new TypeError('Failed to fetch');
    const month = new URL(url, 'https://nya.test').searchParams.get('month');
    if (url.startsWith('/api/budgets/month') && month && answers[month]) return reply(200, answers[month]);
    return reply(404, {});
  };

  type TabProps = Partial<React.ComponentProps<typeof BudgetsTab>>;
  /** The tab, its month read through the month's own hook. */
  function mountTab(props: TabProps = {}) {
    globalThis.fetch = server as unknown as typeof fetch;
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    let reload: () => void = () => {};
    function Page() {
      const month = useBudgetMonth(NOW, [], { history: true });
      reload = month.reload;
      return (
        <BudgetsTab
          txns={[row('g', { amount: 80 })]}
          budgets={ONE}
          taxonomy={taxonomy}
          onSave={async () => true}
          goals={[]}
          onSaveGoals={async () => true}
          accounts={[]}
          loading={false}
          series={[]}
          budgetMonth={month}
          {...props}
        />
      );
    }
    act(() => root.render(<Page />));
    const v = harness(host as unknown as FakeElement);
    const panel = () => v.all((e) => e.getAttribute('id') === 'budgets-panel-month')[0];
    /** The Month panel's notices before the Spent card: the month's one notice. */
    const notice = () => {
      const spent = panel().findAll((e) => e.getAttribute('aria-labelledby') === 'budgets-spent-title')[0];
      return panel()
        .findAll((e) => (e.getAttribute('class') ?? '').startsWith('notice ') && !spent.contains(e))
        .map((e) => e.textContent);
    };
    const badge = () => panel().findAll((e) => e.getAttribute('class') === 'badge warn' && e.textContent === 'May be incomplete');
    return { ...v, host, panel, notice, badge, reload: () => act(() => reload()), unmount: () => act(() => root.unmount()) };
  }

  test('a change refused offline, and the month not read again after it: the setting stays, its sheet open and saying both, and comes back with the month', async () => {
    offline = false;
    answers = { [NOW]: monthView() };
    const v = mountTab();
    await settle();
    await v.open('My income is irregular');
    expect(v.dialog()!.getAttribute('aria-label')).toBe('My income is irregular');
    offline = true;
    await act(async () => click(v.button('Turn on', v.dialog()!)!));
    await settle();
    // Still on the page, open, focus in it: why the change wasn't saved, and
    // why nothing is offered until the month is read again.
    expect(v.dialog()!.getAttribute('aria-label')).toBe('My income is irregular');
    expect(v.dialog()!.contains(v.focused())).toBe(true);
    expect(v.notices()).toEqual([
      'Caution: That change couldn’t be saved. Check your connection and try again.',
      'Caution: Rollover couldn’t be worked out just now, so each budget shows its amount without it.',
    ]);
    expect(v.button('Turn on', v.dialog()!)).toBeNull();
    expect(v.row('My income is irregular')!.textContent).toContain('Off');
    offline = false;
    v.reload();
    await settle();
    expect(v.button('Turn on', v.dialog()!)).not.toBeNull();
    expect(v.select('Count from')).not.toBeNull();
    v.unmount();
  });

  test('its months to count from are the ones the tab hands it: a year while the first month with transactions isn’t known, back to it once it is', async () => {
    offline = false;
    const months = async (earliest: string | null) => {
      answers = { [NOW]: monthView({ earliest, history: earliest !== null }) };
      const v = mountTab();
      await settle();
      await v.open('My income is irregular');
      const values = v.select('Count from')!.options.map((o) => o.value);
      v.unmount();
      return values;
    };
    const unknown = await months(null);
    expect([unknown.length, unknown[0], unknown[unknown.length - 1]]).toEqual([12, NOW, addMonths(NOW, -11)]);
    const known = await months(addMonths(NOW, -30));
    expect([known.length, known[known.length - 1]]).toEqual([31, addMonths(NOW, -30)]);
  });

  test('a month gone by: its own reasons in the month’s notice, and the Spent card’s badge', async () => {
    offline = false;
    const last = addMonths(NOW, -1);
    answers = {
      [NOW]: monthView(),
      [last]: monthView({ month: last, gaps: [{ month: last, gaps: [{ kind: 'stopped', institution: 'Chase', since: null }] }] }),
    };
    const v = mountTab();
    await settle();
    act(() => click(v.button('Earlier month')!));
    await settle();
    expect(v.notice()).toEqual([`Caution: ${monthName(last, NOW)} may be incomplete: Chase isn’t syncing.`]);
    expect(v.badge()).toHaveLength(1);
    v.unmount();
  });

  test('a month gone by whose carry counts one that may be incomplete: the carry’s note, and no badge on its own figures', async () => {
    offline = false;
    const last = addMonths(NOW, -1);
    const before = addMonths(NOW, -2);
    answers = {
      [NOW]: monthView(),
      [last]: monthView({
        month: last,
        carries: { categories: { [GROCERIES]: { carry: 20, from: addMonths(NOW, -3), why: 'start', start: addMonths(NOW, -3), uncertain: [before] } }, groups: {} },
        gaps: [{ month: before, gaps: [{ kind: 'stopped', institution: 'Chase', since: null }] }],
      }),
    };
    const v = mountTab();
    await settle();
    act(() => click(v.button('Earlier month')!));
    await settle();
    expect(v.notice()).toEqual([`Caution: Rollover may be off where a month is incomplete: Chase isn’t syncing (${monthName(before, NOW)}).`]);
    expect(v.badge()).toHaveLength(0);
    v.unmount();
  });
});
