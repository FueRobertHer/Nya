import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type, FakeElement } from './mini-dom';

// The life event forms rollout 8d added (components/PlanEvents.tsx): a car,
// once or every few years; a raise; a windfall; a loan paid off. Rendered and
// filled in as a person would (react-dom/client over test/mini-dom.ts): what
// each saves, what each refuses and in what words, what an event already
// saved opens with, and that nothing is filled in but the name. Nothing
// reaches a network: the form's save is a function here.

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads (the
// input event among it): loaded afresh, after this file put a document there.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { EventForm } = await import('@/components/PlanEvents');
type LifeEvent = import('@/lib/fire/events').LifeEvent;
type Kind = import('@/lib/fire/events').LifeEventKind;

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));

async function form(kind: Kind, event: LifeEvent | null = null) {
  const saved: LifeEvent[] = [];
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <EventForm
        kind={kind}
        event={event}
        editable
        onCancel={() => {}}
        onRemove={null}
        onSave={async (e) => {
          saved.push(e);
          return true;
        }}
      />
    )
  );
  await settle();
  /** A field by the words of its label. */
  const field = (words: string) => {
    const label = container.findAll((e) => e.tagName === 'LABEL' && e.getAttribute('class') === 'field' && e.textContent.trim().startsWith(words))[0];
    const input = label?.findAll((e) => e.tagName === 'INPUT')[0];
    if (!input) throw new Error(`no field ${words}`);
    return input;
  };
  const labels = () => container.findAll((e) => e.tagName === 'LABEL').map((l) => l.textContent.trim());
  return {
    saved,
    labels,
    field,
    fill: async (words: string, value: string) => act(async () => type(field(words), value)),
    choose: async (words: string) => {
      const radio = container.findAll((e) => e.tagName === 'LABEL' && e.textContent.trim() === words)[0]?.findAll((e) => e.tagName === 'INPUT')[0] as FakeElement;
      await act(async () => {
        radio.checked = true;
        click(radio);
      });
    },
    save: async () => {
      await act(async () => click(container.findAll((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Save')[0]));
      await settle();
    },
    error: () => container.findAll((e) => e.getAttribute('class') === 'error')[0]?.textContent ?? null,
    text: () => container.textContent,
    unmount: () => act(async () => root.unmount()),
  };
}

const amountsIn = (f: Awaited<ReturnType<typeof form>>) =>
  ['At age', 'From age', 'Paid off at age', 'Paid from your investments, each', 'Saved more a year', 'Amount, after tax', 'Spending less a year']
    .flatMap((w) => {
      try {
        return [f.field(w).value];
      } catch {
        return [];
      }
    });

describe('a car', () => {
  test('once: its age and what it takes from investments, saved as one car', async () => {
    const f = await form('car');
    expect(f.text()).toContain('Payments on a car loan are already in your measured spending, so count only what comes from your investments, never a loan’s payments.');
    // Nothing filled in but the name.
    expect(f.field('Name').value).toBe('A car');
    expect(amountsIn(f).every((v) => v === '')).toBe(true);
    expect(f.labels()).not.toContain('Every how many years');
    await f.fill('At age', '45');
    await f.fill('Paid from your investments, each', '30000');
    await f.save();
    expect(f.error()).toBeNull();
    expect(f.saved).toEqual([{ id: expect.any(String), kind: 'car', label: 'A car', atAge: 45, cost: 30_000, every: null, times: 1 } as unknown as LifeEvent]);
    await f.unmount();
  });

  test('every few years: how often and how many, each asked for, and the last one within the ages a plan takes', async () => {
    const f = await form('car');
    await f.fill('At age', '45');
    await f.fill('Paid from your investments, each', '30000');
    await f.choose('Every few years');
    expect(f.labels()).toContain('Every how many years');
    expect(f.labels()).toContain('How many in all');
    await f.save();
    expect(f.error()).toBe('Fill in every how many years.');
    await f.fill('Every how many years', '8');
    await f.save();
    expect(f.error()).toBe('Fill in how many in all.');
    await f.fill('How many in all', '1');
    await f.save();
    expect(f.error()).toBe('Cars every few years are 2 to 20 in all.');
    await f.fill('How many in all', '10');
    await f.save();
    expect(f.error()).toBe('The last car would come after age 110.');
    await f.fill('How many in all', '4');
    await f.save();
    expect(f.error()).toBeNull();
    expect(f.saved.map(({ id: _, ...e }) => e)).toEqual([{ kind: 'car', label: 'A car', atAge: 45, cost: 30_000, every: 8, times: 4 }]);
    await f.unmount();
  });

  test('one saved every few years opens as it was saved, and back to once saves one', async () => {
    const f = await form('car', { id: 'v', kind: 'car', label: 'Cars', atAge: 46, cost: 25_000, every: 6, times: 3 });
    expect([f.field('At age').value, f.field('Paid from your investments, each').value, f.field('Every how many years').value, f.field('How many in all').value]).toEqual(['46', '25000', '6', '3']);
    await f.choose('Once');
    await f.save();
    expect(f.saved).toEqual([{ id: 'v', kind: 'car', label: 'Cars', atAge: 46, cost: 25_000, every: null, times: 1 }]);
    await f.unmount();
  });

  test('a car costing nothing is refused, in words', async () => {
    const f = await form('car');
    await f.fill('At age', '45');
    await f.fill('Paid from your investments, each', '0');
    await f.save();
    expect(f.error()).toBe('What each car takes from investments is an amount above 0, up to 100000000.');
    expect(f.saved).toEqual([]);
    await f.unmount();
  });
});

describe('a raise', () => {
  test('from an age, how much more is saved a year; never spending in retirement', async () => {
    const f = await form('raise');
    expect(f.text()).toContain('It moves your FI date only: it never changes your spending in retirement, or your FI number.');
    expect(f.labels()).not.toContain('More');
    await f.fill('From age', '42');
    await f.save();
    expect(f.error()).toBe('Fill in how much more you would save a year.');
    await f.fill('Saved more a year', '0');
    await f.save();
    expect(f.error()).toBe('How much more is saved a year is an amount above 0, up to 10000000.');
    await f.fill('Saved more a year', '10000');
    await f.save();
    expect(f.saved.map(({ id: _, ...e }) => e)).toEqual([{ kind: 'raise', label: 'A raise', fromAge: 42, yearly: 10_000 }]);
    await f.unmount();
  });
});

describe('a windfall', () => {
  test('an age and an amount after tax, money in once', async () => {
    const f = await form('windfall');
    expect(f.text()).toContain('Money that comes in once (an inheritance, a sale), after tax, added to your investments at that age.');
    await f.fill('At age', '60');
    await f.save();
    expect(f.error()).toBe('Fill in the amount.');
    await f.fill('Amount, after tax', '-5');
    await f.save();
    expect(f.error()).toBe('The amount is above 0, up to 100000000.');
    await f.fill('Amount, after tax', '200000');
    await f.save();
    expect(f.saved.map(({ id: _, ...e }) => e)).toEqual([{ kind: 'windfall', label: 'A windfall', atAge: 60, amount: 200_000 }]);
    await f.unmount();
  });
});

describe('a loan paid off', () => {
  test('the age it is paid off at and how much less is spent a year, for good', async () => {
    const f = await form('loan-end');
    expect(f.text()).toContain('its payments, which are in your measured spending until then.');
    // Always less, for good: no direction or length to choose.
    expect(f.labels()).not.toContain('More');
    expect(f.labels()).not.toContain('For good');
    await f.fill('Paid off at age', '48');
    await f.fill('Spending less a year', '18000');
    await f.save();
    expect(f.saved.map(({ id: _, ...e }) => e)).toEqual([{ kind: 'loan-end', label: 'A loan paid off', atAge: 48, yearly: 18_000 }]);
    await f.unmount();
  });

  test('an age a plan doesn’t take is refused, in words', async () => {
    const f = await form('loan-end');
    await f.fill('Paid off at age', '200');
    await f.fill('Spending less a year', '18000');
    await f.save();
    expect(f.error()).toBe('The age is a whole number from 16 to 110.');
    expect(f.saved).toEqual([]);
    await f.unmount();
  });
});
