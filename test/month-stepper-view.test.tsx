import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDom, click, type, type FakeElement } from './mini-dom';

// The one month control (look and feel, step 2b1): components/MonthStepper.tsx,
// used as a person would (react-dom/client over test/mini-dom.ts).

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act, useState } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: MonthStepper } = await import('@/components/MonthStepper');

const MONTHS = ['2026-10', '2026-09', '2026-08'];
const words = (m: string) => ({ '2026-10': 'October 2026', '2026-09': 'September 2026', '2026-08': 'August 2026' })[m] ?? m;

function Harness({ months = MONTHS, start = '2026-10', disabled = false }: { months?: string[]; start?: string | null; disabled?: boolean }) {
  const [month, setMonth] = useState<string | null>(start);
  return (
    <MonthStepper
      month={month}
      months={months}
      label={words}
      optionLabel={(m) => (m === '2026-10' ? `${words(m)} (this month)` : words(m))}
      onMonth={setMonth}
      disabled={disabled}
      back={month !== null && month !== '2026-10' ? { label: 'This month', onBack: () => setMonth('2026-10') } : null}
      skeleton="activity-skeleton-month"
    />
  );
}

function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  const find = (pred: (e: FakeElement) => boolean) => host.findAll(pred)[0] ?? null;
  return {
    host,
    arrow: (label: string) => find((e) => e.getAttribute('aria-label') === label)!,
    title: () => find((e) => e.getAttribute('class') === 'month-stepper-title')!,
    list: () => find((e) => e.tagName === 'SELECT'),
    back: () => find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'This month'),
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

const press = (el: FakeElement) => {
  el.focus();
  act(() => click(el));
};

describe('the month stepper', () => {
  test('its name is announced and can take focus; the arrows are named and bare', () => {
    const v = mount(<Harness />);
    expect(v.title().tagName).toBe('H2');
    expect(v.title().textContent).toBe('October 2026');
    expect(v.title().getAttribute('aria-live')).toBe('polite');
    expect(v.title().getAttribute('tabindex')).toBe('-1');
    expect(v.arrow('Earlier month').getAttribute('class')).toBe('icon-btn');
    expect(v.arrow('Later month').getAttribute('class')).toBe('icon-btn');
    v.unmount();
  });

  test('the arrows step through the months, and at either end say so and keep focus', () => {
    const v = mount(<Harness />);
    expect(v.arrow('Later month').getAttribute('aria-disabled')).toBe('true');
    press(v.arrow('Earlier month'));
    press(v.arrow('Earlier month'));
    expect(v.title().textContent).toBe('August 2026');
    const earlier = v.arrow('Earlier month');
    expect(earlier.getAttribute('aria-disabled')).toBe('true');
    expect(earlier.hasAttribute('disabled')).toBe(false);
    press(earlier);
    expect(v.title().textContent).toBe('August 2026');
    expect(dom.document.activeElement).toBe(earlier);
    press(v.arrow('Later month'));
    expect(v.title().textContent).toBe('September 2026');
    v.unmount();
  });

  test('the list lies over the name alone, named for the month it shows, and picks any month', () => {
    const v = mount(<Harness />);
    const list = v.list()!;
    expect((list.parentNode as FakeElement).getAttribute('class')).toBe('month-stepper-name');
    expect(list.getAttribute('aria-label')).toBe('Month to show: October 2026');
    expect(list.findAll((e) => e.tagName === 'OPTION').map((o) => o.textContent)).toEqual(['October 2026 (this month)', 'September 2026', 'August 2026']);
    act(() => type(list, '2026-08'));
    expect(v.title().textContent).toBe('August 2026');
    expect(v.list()!.getAttribute('aria-label')).toBe('Month to show: August 2026');
    v.unmount();
  });

  test('away, the return button follows the name, outside the list, and focus goes to the list before it goes', () => {
    const v = mount(<Harness start="2026-08" />);
    const back = v.back()!;
    expect(back.getAttribute('class')).toBe('btn ghost month-stepper-back');
    // On the stepper's second line, its own (app/globals.css), not inside the name.
    expect((back.parentNode as FakeElement).getAttribute('class')).toBe('month-stepper');
    press(back);
    expect(v.title().textContent).toBe('October 2026');
    expect(v.back()).toBeNull();
    expect(dom.document.activeElement).toBe(v.list());
    v.unmount();
  });

  test('in the order they are seen, so Tab goes the same way: the earlier arrow, the name, the later arrow, then This month', () => {
    const v = mount(<Harness start="2026-09" />);
    const stepper = v.host.findAll((e) => (e.getAttribute('class') ?? '').startsWith('month-stepper'))[0];
    const kids = stepper.childNodes as FakeElement[];
    expect(kids.map((k) => k.getAttribute('aria-label') ?? k.getAttribute('class'))).toEqual(['Earlier month', 'month-stepper-name', 'Later month', 'btn ghost month-stepper-back']);
    v.unmount();
  });

  test('on the month it returns to, no return button: its line is held by the grid, with nothing in it to reach or hear', () => {
    const v = mount(<Harness />);
    expect(v.back()).toBeNull();
    const stepper = v.host.findAll((e) => (e.getAttribute('class') ?? '').startsWith('month-stepper'))[0];
    // A tab's bar holds the line (the default): nothing hidden, no slot, just the grid's second row.
    expect(stepper.getAttribute('class')).toBe('month-stepper');
    expect((stepper.childNodes as FakeElement[]).map((k) => k.getAttribute('aria-label') ?? k.getAttribute('class'))).toEqual(['Earlier month', 'month-stepper-name', 'Later month']);
    // Pending too, so nothing moves when the month comes.
    const pending = mount(<Harness start={null} />);
    expect(pending.host.findAll((e) => e.getAttribute('class') === 'month-stepper')).toHaveLength(1);
    pending.unmount();
    v.unmount();
  });

  test('the stylesheet holds the second line everywhere, the calendar too, with no wrap', () => {
    const css = readFileSync(join(import.meta.dir, '../app/globals.css'), 'utf8').replace(/\r/g, '');
    // The body of the rule whose selector is `selector` alone.
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      return at < 0 ? '' : css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    };
    // Two rows, each at least a 44px target, with the arrows and the name on the first.
    expect(rule('.month-stepper')).toContain('display: grid;');
    expect(rule('.month-stepper')).toContain('grid-template-columns: var(--tap) minmax(0, 1fr) var(--tap);');
    expect(rule('.month-stepper')).toContain('grid-template-rows: minmax(var(--tap), auto) minmax(var(--tap), auto);');
    expect(rule('.month-stepper')).not.toContain('row-gap');
    expect(rule('.month-stepper-back')).toContain('grid-row: 2;');
    expect(rule('.month-stepper-back')).toContain('grid-column: 2;');
    // No variant lets the line go: one that did moved the calendar's days down 44px on a wide screen.
    expect(css).not.toMatch(/\.month-stepper\.[\w-]+ \{/);
    expect(css).not.toContain('.month-stepper-mid');
    // The rows without a month are as tall, so the segments under them never move.
    expect(rule('.activity-month,\n.budgets-heading')).toContain('min-height: calc(2 * var(--tap));');
  });

  test('with one month there is no list, and focus after the return button goes to the name', () => {
    function One() {
      const [month, setMonth] = useState('2026-08');
      return <MonthStepper month={month} months={[month]} label={words} onMonth={setMonth} back={month !== '2026-10' ? { label: 'This month', onBack: () => setMonth('2026-10') } : null} />;
    }
    const v = mount(<One />);
    expect(v.list()).toBeNull();
    press(v.back()!);
    expect(dom.document.activeElement).toBe(v.title());
    v.unmount();
  });

  test('pending: a placeholder in the name, the arrows off and no list; the same elements once the month comes', () => {
    const v = mount(<Harness start={null} />);
    expect(v.title().textContent).toBe('');
    expect(v.title().findAll((e) => (e.getAttribute('class') ?? '').includes('skeleton')).length).toBe(1);
    expect(v.arrow('Earlier month').getAttribute('aria-disabled')).toBe('true');
    expect(v.list()).toBeNull();
    v.unmount();
  });

  test('the month coming fills the same elements, so focus on an arrow survives it', () => {
    const v = mount(<MonthStepper month={null} months={[]} label={words} onMonth={() => {}} />);
    const [earlier, title] = [v.arrow('Earlier month'), v.title()];
    v.rerender(<MonthStepper month="2026-10" months={MONTHS} label={words} onMonth={() => {}} />);
    expect(v.arrow('Earlier month')).toBe(earlier);
    expect(v.title()).toBe(title);
    expect(v.title().textContent).toBe('October 2026');
    expect(v.arrow('Earlier month').getAttribute('aria-disabled')).toBe('false');
    v.unmount();
  });

  test('disabled: the arrows say so and there is no list, but the return button still works', () => {
    const v = mount(<Harness start="2026-09" disabled />);
    expect(v.arrow('Earlier month').getAttribute('aria-disabled')).toBe('true');
    expect(v.arrow('Later month').getAttribute('aria-disabled')).toBe('true');
    expect(v.list()).toBeNull();
    press(v.back()!);
    expect(v.title().textContent).toBe('October 2026');
    // No list to go to: focus goes to the name.
    expect(dom.document.activeElement).toBe(v.title());
    v.unmount();
  });
});
