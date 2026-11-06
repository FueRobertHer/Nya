import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MoneyLines } from '@/components/PlanDrawdown';
import { BesideTable } from '@/components/PlanBeside';
import { wholeMoney } from '@/components/plan-text';

// Two figures beside each other: a table, so a screen reader says which figure is which.
// And a sheet's lines of money, where a part of a line isn't one more line to add. Each
// writes its figures as it draws, as a sheet does, so hiding amounts reaches them.

const money = (n: number) => wholeMoney(n, 'USD');

function Preview() {
  return (
    <BesideTable
      caption="This rule beside no conversions"
      heads={['This rule', 'None']}
      rows={[
        ['Converted', `About ${money(60_000)}, by 60`, money(0)],
        ['Left at 62, after tax', money(3_660_060), money(2_850_840)],
      ]}
    />
  );
}

function Lines() {
  return (
    <MoneyLines
      lines={[
        { label: 'Ordinary income', value: money(50_000) },
        { label: 'of it Social Security', value: money(10_000), part: true },
        { label: 'Adjusted gross income', value: money(50_000), sum: true },
      ]}
    />
  );
}

describe('BesideTable', () => {
  test('says what it holds, and each figure’s row and column', () => {
    const h = renderToStaticMarkup(<Preview />);
    expect(h).toContain('<caption class="visually-hidden">This rule beside no conversions</caption>');
    expect(h.match(/<th scope="col"/g)?.length).toBe(3);
    expect(h.match(/<th scope="row"/g)?.length).toBe(2);
    expect(h).toContain('<span class="visually-hidden">Figure</span>');
  });

  test('scrolls on its own if it must, and its figures are money', () => {
    const h = renderToStaticMarkup(<Preview />);
    expect(h).toContain('class="plan-table-scroll"');
    expect(h).toContain('class="plan-compare-table plan-beside-table"');
    expect(h.match(/<td class="money"/g)?.length).toBe(4);
  });
});

describe('MoneyLines', () => {
  test('a part and a sum each have their own class, and a plain line neither', () => {
    const h = renderToStaticMarkup(<Lines />);
    expect(h).toContain('class="txn-detail txn-detail-wide"');
    expect(h.match(/class="txn-detail-row"/g)?.length).toBe(1);
    expect(h).toContain('class="txn-detail-row txn-detail-part"');
    expect(h).toContain('class="txn-detail-row txn-detail-sum"');
  });
});
