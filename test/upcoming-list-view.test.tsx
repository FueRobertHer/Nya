import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { installDom, click, FakeElement } from './mini-dom';
import { notesIn } from './budget-notes-fixture';
import { CAR, KINDS, REFUND, RENT_AND_PAY, TODAY, chase, txn } from './upcoming-notes-fixture';
import { ecbTable } from './fx-fixture';
import { MASK, setAmountsHidden } from '@/lib/format';
import type { ForecastInstitution } from '@/lib/forecast';

// Budgets > Upcoming's list and its calendar (rollout phase 6a3,
// docs/design/information-architecture.md#budgets): the list's day bars and
// plain rows in the calendar's own words, the same rows the calendar's day
// list draws; what an empty list says, by what has loaded; the load states
// the list says itself when there is no forecast above it to say them; a
// badge at a card's top; and every amount masked while amounts are hidden.
// The calendar as rollout 6a3 redraws it, used as a person would
// (react-dom/client over test/mini-dom.ts): its 44px month arrows, Today, the
// day's list as rows, and its load line as a notice at its level.

const dom = installDom();
afterAll(() => dom.uninstall());
afterEach(() => setAmountsHidden(false));

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: UpcomingList } = await import('@/components/UpcomingList');
const { default: CalendarView } = await import('@/components/CalendarView');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Markup as text, tags dropped and entities decoded, for reading sentences. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

/** Checking, and the Sapphire card with $35.00 due on Oct 22. */
const SAPPHIRE: ForecastInstitution = chase({
  accounts: [
    { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balance: 900, currency: 'USD' },
    { account_id: 'card', name: 'Sapphire', type: 'credit', balance: 600, currency: 'USD', liability: { minimum_payment: 35, next_due_date: '2026-10-22' } },
  ],
});
const LOADED = { failed: false, loading: false, plannedReady: true };

type ListProps = Parameters<typeof UpcomingList>[0];
const list = (over: Partial<ListProps> = {}) =>
  renderToStaticMarkup(
    <UpcomingList
      series={[...RENT_AND_PAY, ...KINDS]}
      planned={[CAR, REFUND]}
      dismissed={new Set()}
      institutions={[SAPPHIRE]}
      today={TODAY}
      days={30}
      currency="USD"
      states={LOADED}
      sayStates={false}
      {...over}
    />
  );

type CalendarProps = Parameters<typeof CalendarView>[0];
const calendar = (over: Partial<CalendarProps> = {}) =>
  renderToStaticMarkup(
    <CalendarView
      txns={[txn({ transaction_id: 'a', date: '2026-10-05', name: 'Corner shop', amount: 30 })]}
      series={[...RENT_AND_PAY, ...KINDS]}
      planned={[CAR, REFUND]}
      dismissed={new Set()}
      institutions={[SAPPHIRE]}
      today={TODAY}
      currency="USD"
      {...over}
    />
  );

/** Each entry's row, as drawn. */
const rows = (html: string) => html.match(/<li><div class="list-row upcoming-row">.*?<\/div><\/li>/g) ?? [];
/** Each notice, as its level and its words (what a screen reader is given first left out). */
const notices = (html: string) =>
  notesIn(html)
    .filter((n) => ['critical', 'caution', 'info'].includes(n.level))
    .map((n) => [n.level, n.text.replace(/^(?:Critical|Caution|Note): /, '')]);

/** As in a browser's page: only there can amounts be hidden. */
function hidden<T>(fn: () => T): T {
  setAmountsHidden(true);
  try {
    return fn();
  } finally {
    setAmountsHidden(false);
  }
}

/** The text a person sees, but each mask said to a screen reader as
 *  "hidden" (components/HideAmounts.tsx Masked): what is left once those are
 *  taken out holds no mask, and no figure. */
function expectMasked(html: string) {
  expect(html).toContain(MASK);
  expect(html).toContain('<span class="visually-hidden">');
  const unmasked = text(html.replace(/<span aria-hidden="true">[^<]*<\/span>/g, ''));
  expect(unmasked).not.toContain(MASK);
  expect(text(html)).not.toMatch(/[$€]\s?[-+]?\d|\d[\d,]*\.\d{2}/);
}

describe("Upcoming's list", () => {
  test('a bar for each day from today, with its expected figure, then a plain row for each entry in the calendar\'s words', () => {
    const html = list();
    const t = text(html);
    // Today: pay that varies and a card's own charge, both listed, neither in the day's figure.
    expect(t).toContain(
      "Fri, Oct 9 Gig pay income · Every 2 weeks · its amount varies, not in the day's figure +$1,768.18 Spotify bill · Monthly · on the Sapphire card, not in the day's figure: the card's payment is what leaves cash -$10.99"
    );
    expect(t).toContain("Mon, Oct 12 Gym bill · Monthly · on an account of unknown type, not in the day's figure -$45.00");
    expect(t).toContain('Thu, Oct 15 -$1,500.00 Rent bill · Monthly -$1,500.00');
    expect(t).toContain('Tue, Oct 20 -$212.50 Car registration planned · Once -$212.50');
    // A payment due: badged, its minimum's size, never in a figure.
    expect(t).toContain('Thu, Oct 22 Sapphire Due minimum due, not in the figures $35.00');
    expect(t).toContain('Sun, Oct 25 +$2,000.00 Payroll income · Monthly +$2,000.00');
    expect(t).toContain('Fri, Oct 30 +$1,200.00 Tax refund planned · Once +$1,200.00');
    expect(t).toContain('Fri, Nov 6 Gig pay');
    // The range ends on Nov 8: Spotify's next, on the 9th, is past it; pay that stopped isn't listed.
    expect(t).not.toContain('Nov 9');
    expect(t).not.toContain('Old job');
    expect(t).toContain(
      "From today, what is expected to leave or reach your checking and savings, an estimate, as the forecast counts it; a card's own charges and the payments due on cards and loans are listed, not added."
    );
    // Day bars as Activity's, rows that open nothing (Recurring and Planned do), no heading of its own.
    expect(html).toContain('<li class="txn-day"><span>Thu, Oct 15</span><span class="money">-$1,500.00</span></li>');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/<h[1-6]/);
    expect(html).toContain('<span class="badge warn">Due</span>');
    // Quieter when not in the day's figure; money in green.
    expect(html).toContain('<span class="list-row-value upcoming-amount uncounted">-$10.99</span>');
    expect(html).toContain('<span class="list-row-value upcoming-amount inflow">+$2,000.00</span>');
    expect(html).toContain('<span class="list-row-value upcoming-amount">-$1,500.00</span>');
  });

  test("its rows are the calendar's day list's rows, word for word", () => {
    // Today, Oct 9, as both draw it.
    expect(rows(list()).slice(0, 2)).toEqual(rows(calendar()));
    // A day the calendar's list is opened on: the list badges the payment due, as it has no "Payment due" bar over it.
    const due = rows(list()).find((r) => r.includes('>Sapphire<'))!;
    expect(due.replace('<span class="badge warn">Due</span>', '')).toBe(
      '<li><div class="list-row upcoming-row"><span class="list-row-text"><span class="list-row-title">Sapphire</span><span class="list-row-sub"><span>minimum due, not in the figures</span></span></span><span class="list-row-value upcoming-amount uncounted">$35.00</span></div></li>'
    );
  });

  test('a late one, and what is in another currency, converted or not', () => {
    // Rent was due on the 15th: expected today, the 17th.
    expect(text(list({ today: '2026-10-17' }))).toContain('Sat, Oct 17 -$1,500.00 Rent bill · Monthly · due Oct 15, not in yet -$1,500.00');
    const eur = { ...CAR, currency: 'EUR' };
    expect(text(list({ planned: [eur] }))).toContain("Car registration planned · Once · in EUR, not in the day's figure -€212.50");
    // With a home currency, at the newest rates (1 EUR = 1.1551 USD, test/fx-fixture.ts).
    expect(text(list({ planned: [eur], fx: ecbTable({ home: 'EUR' }) }))).toContain(
      "Tue, Oct 20 -$245.46 Car registration planned · Once · -$245.46 in the day's figure, at today's rates -€212.50"
    );
  });

  test('the range sets how far it runs', () => {
    expect(text(list({ days: 60 }))).toContain('Mon, Nov 9 Spotify');
    expect(text(list({ days: 60 }))).toContain('Sun, Nov 15 -$1,500.00 Rent');
  });

  test('a badge at its top, from the notice above it', () => {
    const html = list({ badge: 'warn' });
    expect(html.startsWith('<div class="card stack upcoming-list"><div><span class="badge warn">May be incomplete</span></div>')).toBe(true);
    expect(list({ badge: 'neg' })).toContain('<span class="badge neg">Incomplete</span>');
    expect(list()).not.toContain('class="badge neg"');
  });

  test('empty: "nothing expected" only once everything it reads has loaded, with the range\'s length', () => {
    const none = { series: [], planned: [], institutions: [chase()] };
    expect(text(list(none))).toContain('Nothing expected in the next 30 days.');
    expect(text(list({ ...none, days: 90 }))).toContain('Nothing expected in the next 90 days.');
    for (const states of [
      { ...LOADED, failed: true },
      { ...LOADED, loading: true },
      { ...LOADED, plannedReady: false },
    ]) {
      const html = list({ ...none, states });
      expect(notesIn(html).filter((n) => n.level === 'empty')).toEqual([{ text: 'Nothing to list yet.', level: 'empty' }]);
      expect(text(html)).not.toContain('Nothing expected');
      // With a forecast, the notice at the top says why.
      expect(notices(html)).toEqual([]);
    }
  });

  test('with no forecast above it, it says what has not loaded itself, each at its level', () => {
    const none = { series: [], planned: [], institutions: [chase()], sayStates: true };
    expect(notices(list({ ...none, states: { ...LOADED, failed: true } }))).toEqual([['critical', "Transactions couldn't be loaded, so no bills or income can be found."]]);
    expect(notices(list({ ...none, states: { ...LOADED, loading: true } }))).toEqual([['caution', 'Transactions are still loading.']]);
    expect(notices(list({ ...none, states: { ...LOADED, plannedReady: false } }))).toEqual([
      ['caution', "Your planned items aren't loaded, so they aren't in this, and bills you marked not recurring may be."],
    ]);
    expect(notices(list({ ...none, states: { failed: true, loading: false, plannedReady: false } }))).toEqual([
      ['critical', "Transactions couldn't be loaded, so no bills or income can be found."],
      ['caution', "Your planned items aren't loaded, so they aren't in this, and bills you marked not recurring may be."],
    ]);
    // Everything loaded: nothing to say.
    expect(notices(list({ ...none, states: LOADED }))).toEqual([]);
  });

  test('hide amounts masks every amount: the day figures, the values, what a conversion counts', () => {
    const eur = { ...CAR, currency: 'EUR' };
    const shown = list({ planned: [eur, REFUND], fx: ecbTable({ home: 'EUR' }) });
    expect(shown).toContain('$1,500.00');
    expectMasked(hidden(() => list({ planned: [eur, REFUND], fx: ecbTable({ home: 'EUR' }) })));
  });
});

describe('the calendar, redrawn', () => {
  test('no heading of its own, a badge at its top, its load line as a notice at its level', () => {
    const html = calendar({ badge: 'warn' });
    expect(html.startsWith('<div class="card stack"><div><span class="badge warn">May be incomplete</span></div>')).toBe(true);
    expect(text(html)).not.toContain('Calendar');
    expect(notices(calendar({ txns: null, failed: true }))).toEqual([['critical', "Transactions couldn't be loaded, so what posted isn't shown."]]);
    expect(notices(calendar({ txns: null }))).toEqual([['caution', 'Transactions are still loading.']]);
    expect(notices(calendar())).toEqual([]);
    // Its closing note is helper text now, its words unchanged.
    expect(notesIn(calendar()).filter((n) => n.level === 'helper')).toEqual([
      {
        text: "Days gone by show what posted. From today, what is expected to leave or reach your checking and savings, an estimate, as the forecast counts it; a card's own charges and the payments due on cards and loans are listed, not added.",
        level: 'helper',
      },
    ]);
  });

  test("the day's list as rows under a bar for what posted and what is expected, in the same words", () => {
    const html = calendar({
      txns: [
        txn({ transaction_id: 'a', name: 'Corner shop', amount: 30 }),
        txn({ transaction_id: 'b', name: 'Ramen', amount: 3200, iso_currency_code: 'JPY' }),
        txn({ transaction_id: 'c', name: 'Work trip', amount: 400, excluded: true }),
        txn({ transaction_id: 'd', name: 'Coffee', amount: 4.5, pending: true }),
      ],
    });
    const t = text(html);
    expect(t).toContain('Friday, October 9');
    expect(t).toContain('Posted · -$34.50 Corner shop -$30.00');
    expect(t).toContain("Ramen in JPY, not in the day's figure -¥3,200");
    expect(t).toContain("Work trip excluded, not in the day's figure -$400.00");
    expect(t).toContain('Coffee pending -$4.50');
    expect(t).toContain("Expected Gig pay income · Every 2 weeks · its amount varies, not in the day's figure +$1,768.18");
    expect(html).not.toContain('<table');
    expect(html).toContain('<li class="txn-day"><span>Posted · -$34.50</span></li>');
    expect(html).toContain('<div class="card-header"><h3>Friday, October 9</h3></div>');
    expect(html).toContain('<span class="list-row-value upcoming-amount uncounted">-$400.00</span>');
  });

  test('hide amounts masks the cells, the bars and the rows', () => {
    const draw = () => calendar({ txns: [txn({ transaction_id: 'a', name: 'Corner shop', amount: 30.25 }), txn({ transaction_id: 'b', name: 'Euro shop', amount: 12, iso_currency_code: 'EUR' })], fx: ecbTable({ home: 'EUR' }) });
    expect(draw()).toContain('$30.25');
    const html = hidden(draw);
    expectMasked(html);
    for (const m of html.matchAll(/aria-label="([^"]*)"/g)) expect(m[1]).not.toContain(MASK);
  });

  /** What a person sees in each day's cell, by the day of the month: the
   *  words a screen reader is given left out. */
  const cellFigures = (html: string): Record<number, string> =>
    Object.fromEntries(
      [...html.matchAll(/<span class="cal-num">(\d+)<\/span><span class="cal-fig[^"]*">(.*?)<\/span><span class="cal-dots"/g)].map((m) => [
        Number(m[1]),
        text(m[2].replace(/<span class="visually-hidden">[^<]*<\/span>/g, '')).trim(),
      ])
    );

  // A cell's figure has no currency ("-143", "+13K"), and the backstop over
  // every view (test/hide-amounts.test.tsx AMOUNT) knows an amount by its
  // currency, so it can't see one shown while hidden: these two tests are
  // the cells' guard.
  test("hide amounts leaves a cell's figure its sign and the mask, or nothing, never a size", () => {
    // Shown: its sign, whole units, a thousand shortened, no currency.
    expect(Object.values(cellFigures(calendar())).filter(Boolean)).toEqual(['-30', '-1.5K', '-213', '+2K', '+1.2K']);
    const masked = Object.values(cellFigures(hidden(calendar)));
    expect(masked.filter(Boolean)).toEqual(['-•••', '-•••', '-•••', '+•••', '+•••']);
    for (const f of masked) expect(f).toMatch(/^(?:[+-]?•••)?$/);
  });

  test('hidden, a figure under 0.5 keeps its sign, so the mask never says it is that small; a zero has none', () => {
    const draw = () =>
      calendar({
        txns: [
          txn({ transaction_id: 'a', date: '2026-10-06', name: 'Refund', amount: -0.3 }),
          txn({ transaction_id: 'b', date: '2026-10-07', name: 'Corner shop', amount: 20 }),
          txn({ transaction_id: 'c', date: '2026-10-07', name: 'Corner shop refund', amount: -20 }),
        ],
      });
    expect(cellFigures(draw())).toMatchObject({ 6: '0', 7: '0' });
    expect(cellFigures(hidden(draw))).toMatchObject({ 6: '+•••', 7: '•••' });
  });

  describe('used as a person would', () => {
    const mount = (over: Partial<CalendarProps> = {}) => {
      const host = dom.document.createElement('div');
      dom.document.body.appendChild(host);
      const root = createRoot(host as unknown as HTMLElement);
      act(() =>
        root.render(
          <CalendarView
            txns={[]}
            series={RENT_AND_PAY}
            planned={[CAR]}
            dismissed={new Set()}
            institutions={[SAPPHIRE]}
            today={TODAY}
            currency="USD"
            {...over}
          />
        )
      );
      const button = (label: string) =>
        host.findAll((e) => e.tagName === 'BUTTON' && (e.textContent.trim() === label || e.getAttribute('aria-label') === label))[0] ?? null;
      const cell = (date: string) => host.findAll((e) => e.tagName === 'BUTTON' && (e.getAttribute('aria-label') ?? '').startsWith(date))[0] ?? null;
      const title = () => host.findAll((e) => e.getAttribute('aria-live') === 'polite')[0]?.textContent;
      const press = (el: FakeElement) => {
        el.focus();
        act(() => click(el));
      };
      return { host, root, button, cell, title, press };
    };

    test('the month arrows are 44px icon buttons, and Today brings back this month with focus on today', () => {
      const { root, host, button, cell, title, press } = mount();
      const next = button('Next month')!;
      const previous = button('Previous month')!;
      for (const arrow of [next, previous]) expect(arrow.getAttribute('class')).toBe('icon-btn');
      // .icon-btn is a 44px square (app/globals.css), the size of a touch target.
      const css = readFileSync(join(import.meta.dir, '../app/globals.css'), 'utf8');
      expect(css).toMatch(/\.icon-btn \{[^}]*min-width: var\(--tap\);[^}]*min-height: var\(--tap\);/);
      expect(css).toMatch(/--tap: 44px;/);
      expect(title()).toBe('October 2026');
      expect(button('Today')).toBeNull();

      press(next);
      expect(title()).toBe('November 2026');
      const today = button('Today')!;
      expect(today.getAttribute('class')).toBe('btn ghost');
      // Beside the month's name, outside what is announced as it changes.
      const live = host.findAll((e) => e.getAttribute('aria-live') === 'polite')[0]!;
      expect(today.parentElement).toBe(live.parentElement);
      expect(live.textContent).toBe('November 2026');
      press(today);
      expect(title()).toBe('October 2026');
      expect(button('Today')).toBeNull();
      // Focus goes to today's cell, chosen, not to nothing.
      expect(dom.document.activeElement).toBe(cell('Friday, October 9')!);
      expect(cell('Friday, October 9')!.getAttribute('aria-pressed')).toBe('true');
      act(() => root.unmount());
    });

    test('at the furthest month, the arrow says it is off and keeps focus', () => {
      const { root, button, title, press } = mount();
      const next = button('Next month')!;
      expect(next.getAttribute('aria-disabled')).toBe('false');
      for (let i = 0; i < 12; i++) press(next);
      expect(title()).toBe('October 2027');
      expect(next.getAttribute('aria-disabled')).toBe('true');
      press(next);
      expect(title()).toBe('October 2027');
      expect(dom.document.activeElement).toBe(next);
      act(() => root.unmount());
    });

    test("a day's list: its bars and rows, a payment due under its own bar", () => {
      const { root, host, cell, press } = mount();
      press(cell('Thursday, October 22')!);
      const day = host.findAll((e) => (e.getAttribute('class') ?? '').includes('cal-detail'))[0]!;
      const bars = day.findAll((e) => e.getAttribute('class') === 'txn-day').map((e) => e.textContent);
      expect(bars).toEqual(['Payment due']);
      const row = day.findAll((e) => e.getAttribute('class') === 'list-row upcoming-row')[0]!;
      expect(row.textContent).toBe('Sapphireminimum due, not in the figures$35.00');
      expect(day.findAll((e) => e.getAttribute('class') === 'badge warn')).toEqual([]);
      press(cell('Thursday, October 15')!);
      expect(day.findAll((e) => e.getAttribute('class') === 'txn-day').map((e) => e.textContent)).toEqual(['Expected · -$1,500.00']);
      act(() => root.unmount());
    });
  });
});
