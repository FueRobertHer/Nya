import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, FakeElement } from './mini-dom';
import { cardOf, shared as sharedOf } from './shared-expenses-fixture';

// The first steps the screen review after step 5 gave Goals, Shared and
// Budgets, used as a person would (react-dom/client over test/mini-dom.ts).
// The empty states (components/EmptyState.tsx): once the first goal or
// person is in, the empty state and the button that opened the sheet are
// gone, so the sheet, closing, can't give focus back to it; focus goes to the
// Add button drawn now, as Budgets' does (test/budget-sheets-view.test.tsx),
// never to nothing. And Budgets' starter-sets offer, one row
// (components/TemplateOffer.tsx): the row opens the sets, the × beside it
// keeps your categories, and either ends the offer.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { GoalsCardView } = await import('@/components/GoalsCard');
const { default: SharedExpensesCard } = await import('@/components/SharedExpensesCard');
const { default: TemplateOffer, TEMPLATE_OFFER_KEY } = await import('@/components/TemplateOffer');
const { seedTaxonomy, textKeys } = await import('@/lib/categories');
type Goal = import('@/lib/goal-model').Goal;
type CardAnswer = import('@/lib/shared-expenses/read').CardAnswer;
type SharedOpen = import('@/components/shared-expenses-state').SharedOpen;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(FakeElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

/** The time a sheet takes to slide in (one frame), or out. */
const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

function mounted(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  const all = (test: (e: FakeElement) => boolean) => (host as unknown as FakeElement).findAll(test);
  const button = (label: string, cls: string) => all((e) => e.tagName === 'BUTTON' && e.textContent === label && e.getAttribute('class') === cls)[0] ?? null;
  return { all, button, focused: () => dom.document.activeElement as unknown as FakeElement, unmount: () => act(() => root.unmount()) };
}

describe('Goals', () => {
  const FUND: Goal = { id: 'fund', name: 'Fund', target: 1000, account_id: null };
  let setGoals: (g: Goal[]) => void = () => {};
  function Card() {
    const [goals, set] = useState<Goal[]>([]);
    setGoals = set;
    return <GoalsCardView goals={goals} accounts={[]} onSave={async () => true} flows={{ status: 'ready', flows: {}, notes: [] } as never} />;
  }

  test('the first goal in: the sheet closes, the empty state gone, and focus lands on the Add goal under the list', async () => {
    const v = mounted(<Card />);
    const first = v.button('Add goal', 'btn')!;
    expect(first.getAttribute('aria-haspopup')).toBe('dialog');
    first.focus();
    act(() => click(first));
    await settle();
    const dialog = () => v.all((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0] ?? null;
    expect(dialog()).not.toBeNull();
    // Saved meanwhile (as the editor's save does), then the sheet closes.
    act(() => setGoals([FUND]));
    expect(v.button('Add goal', 'btn')).toBeNull();
    act(() => click(dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === 'Close')[0]));
    await settle(400);
    expect(dialog()).toBeNull();
    expect(v.focused() === v.button('Add goal', 'secondary')).toBe(true);
    v.unmount();
  });
});

describe('Shared expenses', () => {
  const NOBODY = cardOf({ people: [], items: [], shares: [], balances: {} });
  let setCard: (c: CardAnswer) => void = () => {};
  let setOpened: (o: SharedOpen | null) => void = () => {};
  let opened: SharedOpen | null = null;
  function Card() {
    const [card, set] = useState<CardAnswer>(NOBODY);
    const [open, setOpen] = useState<SharedOpen | null>(null);
    setCard = set;
    setOpened = setOpen;
    opened = open;
    return <SharedExpensesCard shared={{ ...sharedOf(card), open, setOpen }} txns={[]} facts={null} tags={[]} taxonomy={null} currency="USD" />;
  }

  test('the first person in: the sheet closes, the empty state gone, and focus lands on the Add someone there now', () => {
    const v = mounted(<Card />);
    const first = v.button('Add someone', 'btn')!;
    expect(first.getAttribute('aria-haspopup')).toBe('dialog');
    first.focus();
    act(() => click(first));
    expect(opened).toEqual({ kind: 'person', id: null });
    // Saved meanwhile (as the person's sheet does), taking the empty state
    // and its button with it; then the sheet closes, with nowhere to give
    // focus back to.
    act(() => setCard(cardOf({ items: [], shares: [], balances: {} })));
    expect(v.button('Add someone', 'btn')).toBeNull();
    act(() => setOpened(null));
    expect(v.focused() === v.button('Add someone', 'secondary')).toBe(true);
    v.unmount();
  });

  test('a sheet that gives focus back itself keeps it there', () => {
    setCard(cardOf({ items: [], shares: [], balances: {} }));
    const v = mounted(<Card />);
    act(() => setCard(cardOf({ items: [], shares: [], balances: {} })));
    const add = v.button('Add someone', 'secondary')!;
    act(() => click(add));
    const settings = v.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Settings')[0];
    settings.focus();
    act(() => setOpened(null));
    expect(v.focused() === settings).toBe(true);
    v.unmount();
  });
});

describe('the starter sets’ offer', () => {
  let made = 0;
  const seeded = () => seedTaxonomy(textKeys([]), () => `id${++made}`);
  // What this device keeps (a convenience: components/TemplateOffer.tsx).
  const kept = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) } });

  const mount = () => {
    kept.clear();
    const landed: string[] = [];
    let landing: () => FakeElement | undefined = () => undefined;
    const v = mounted(
      <div>
        <h2 id="landing" tabIndex={-1}>
          October 2026
        </h2>
        <TemplateOffer
          taxonomy={seeded()}
          onTaxonomy={() => {}}
          onKept={() => {
            landed.push('kept');
            landing()?.focus();
          }}
        />
      </div>
    );
    landing = () => v.all((e) => e.getAttribute('id') === 'landing')[0];
    const row = () => v.all((e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row')[0] ?? null;
    const keep = () => v.all((e) => e.getAttribute('aria-label') === 'Keep my categories')[0] ?? null;
    return { ...v, row, keep, landed };
  };

  test('the row opens the sets and ends the offer here', async () => {
    const v = mount();
    expect(v.row()!.textContent).toBe('Categories that fit youA starter set may suit you better');
    expect(v.row()!.getAttribute('aria-haspopup')).toBe('dialog');
    act(() => click(v.row()!));
    await settle();
    expect(kept.get(TEMPLATE_OFFER_KEY)).toBe('1');
    expect(v.row()).toBeNull();
    expect(v.all((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('aria-label') === 'Starter sets' && e.getAttribute('data-open') === 'true')).toHaveLength(1);
    v.unmount();
  });

  test('the × keeps your categories: the row goes, no sheet, and focus goes where the caller says', async () => {
    const v = mount();
    v.keep()!.focus();
    act(() => click(v.keep()!));
    await settle();
    expect(kept.get(TEMPLATE_OFFER_KEY)).toBe('1');
    expect(v.row()).toBeNull();
    expect(v.all((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')).toHaveLength(0);
    expect(v.landed).toEqual(['kept']);
    expect(v.focused().getAttribute('id')).toBe('landing');
    v.unmount();
  });
});
