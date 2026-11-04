import { describe, expect, test } from 'bun:test';
import { planPage } from './plan-page';

// The FI number's row and sheet (the tax plan's E2), used on the real plan
// routes: how it is worked out, what it leaves out, your own number, and the
// answer's How it's worked out, which opens the same sheet.

const page = await planPage();
const { dom, PLAN, settle, seedPlan, stored, writes, render, press, button, closeOf, field, fill, classOf } = page;
const { itemFromIncome } = await import('@/lib/fire/items');
type Tab = Awaited<ReturnType<typeof render>>;

const subOf = (tab: Tab, title: string) => tab.row(title)?.findAll((e) => classOf(e).includes('list-row-sub'))[0]?.textContent;
const valueOf = (tab: Tab, title: string) => tab.row(title)?.findAll((e) => classOf(e).includes('list-row-value'))[0]?.textContent;
const SOCIAL = itemFromIncome({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true });

describe('its row', () => {
  test('first of Your figures, worked out or set by you', async () => {
    await seedPlan();
    const tab = await render();
    const rows = tab.container.findAll((e) => e.tagName === 'BUTTON' && classOf(e).includes('list-row'));
    expect(rows.some((r) => r === tab.row('FI number'))).toBe(true);
    expect(subOf(tab, 'FI number')).toBe('Worked out from spending and tax, at 4%');
    expect(valueOf(tab, 'FI number')).toBe('$1,000,000');
    await tab.unmount();
  }, 20_000);

  test('set by you', async () => {
    await seedPlan({ ...PLAN, fiNumber: 1_500_000 });
    const tab = await render();
    expect(subOf(tab, 'FI number')).toBe('Set by you');
    expect(valueOf(tab, 'FI number')).toBe('$1,500,000');
    await tab.unmount();
  }, 20_000);
});

describe('its sheet', () => {
  test('the number, and how it’s worked out, each figure read-only and said where it is set', async () => {
    await seedPlan({ ...PLAN, taxRate: 0.15 });
    const tab = await render();
    await press(tab.row('FI number'));
    const form = tab.dialog()!;
    expect(form.getAttribute('aria-label')).toBe('FI number');
    const t = form.textContent;
    expect(form.findAll((e) => classOf(e).includes('total-value'))[0].textContent).toBe('$1,176,471');
    expect(t).toContain('Spending$40,000 a year');
    expect(t).toContain('÷ (1 − tax)15% tax');
    expect(t).toContain('÷ withdrawal rate4%');
    expect(t).toContain('FI number$1,176,471');
    expect(t).toContain('Each is a row on Your figures, or under Assumptions.');
    expect(t).toContain('Will it last? starts from this number.');
    expect(button(form, 'Use the worked-out number')).toBeNull();
    await tab.unmount();
  }, 20_000);

  test('what it leaves out, behind Why', async () => {
    await seedPlan({ ...PLAN, items: [SOCIAL] });
    const tab = await render();
    await press(tab.row('FI number'));
    const why = tab.dialog()!.findAll((e) => e.tagName === 'DETAILS')[0];
    expect(why.textContent).toContain('What it leaves out');
    expect(why.textContent).toContain('Social Security from 67: your path and Will it last? count it.');
    await tab.unmount();
  }, 20_000);

  test('your own number: saved, shown as yours, with what is worked out beside it; Use the worked-out number takes it back', async () => {
    await seedPlan();
    const tab = await render();
    await press(tab.row('FI number'));
    await fill(tab.dialog()!, 'Use your own number', '1500000');
    await press(button(tab.dialog(), 'Save'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/fire-plan']);
    expect((await stored()).byName['First plan'].plan.fiNumber).toBe(1_500_000);
    expect(tab.text()).toContain('Your own FI number $1,500,000 · worked out $1,000,000');
    await press(tab.row('FI number'));
    const form = tab.dialog()!;
    expect(form.textContent).toContain('Worked out$1,000,000');
    expect(field(form, 'Use your own number')?.value).toBe('1500000');
    await press(button(form, 'Use the worked-out number'));
    await settle(400);
    expect((await stored()).byName['First plan'].plan.fiNumber).toBeNull();
    expect(valueOf(tab, 'FI number')).toBe('$1,000,000');
    await tab.unmount();
  }, 30_000);

  test('a number out of range is refused, in words', async () => {
    await seedPlan();
    const tab = await render();
    await press(tab.row('FI number'));
    await fill(tab.dialog()!, 'Use your own number', '-5');
    await press(button(tab.dialog(), 'Save'));
    expect(tab.dialog()).not.toBeNull();
    expect(writes()).toEqual([]);
    await tab.unmount();
  }, 20_000);
});

describe('the answer’s link', () => {
  test('How it’s worked out opens the sheet, and closing it puts focus back; the arithmetic is no longer under the meter', async () => {
    await seedPlan();
    const tab = await render();
    expect(tab.text()).not.toContain('$40,000 a year ÷ 4% withdrawal rate');
    const link = button(tab.container, "How it's worked out");
    expect(link).not.toBeNull();
    expect(classOf(link!)).toEqual(['btn', 'ghost']);
    await page.act(async () => link!.focus());
    await press(link);
    expect(tab.dialog()?.getAttribute('aria-label')).toBe('FI number');
    await press(closeOf(tab.dialog()!));
    await settle(400);
    expect(dom.document.activeElement).toBe(link!);
    await tab.unmount();
  }, 20_000);
});
