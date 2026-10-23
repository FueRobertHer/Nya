import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MASK, setAmountsHidden } from '@/lib/format';
import { balancesIn } from '@/lib/fx/net-worth';
import { balancesNow, needsConverting, type PageFx } from '@/lib/fx/view';
import type { NetWorthBase } from '@/lib/fx/net-worth-base';
import type { OwnRate } from '@/lib/fx/rates';
import { chartGapLines, codedMoney, convertedHeading, convertedText, institutionNote, leftOutLines, noRateText, partText, rateEffectText, staleText, unknownText } from '@/components/currency-text';
import { ChartCurrencyNote, CurrencyOffer, HeroCurrencyNote, offerFor } from '@/components/CurrencyNotes';
import { CurrencyChoiceBody, CurrencyOptions, choiceText, manualText } from '@/components/CurrencyChoiceSheet';
import { CurrencyCardBody, OwnRateForm, draftProblem, ecbBeside, ownRateText, type RateDraft } from '@/components/CurrencyCard';
import { affectedText, type HealthInstitution } from '@/components/ConnectionHealth';
import type { CurrencySettingsView } from '@/components/currency-state';
import { ecbTable } from './fx-fixture';

// What the page says and shows of a home currency (step 1: net worth): the
// hero's note and change, the chart's note, the offer to choose one, the
// sheet that chooses it, the Currency card, an institution's converted total
// and connection health's share of net worth. With the ECB's rates of 14 Sep
// 2026 (USD 1.1551, GBP 0.85598 per euro).

const noop = () => {};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1])).filter(Boolean);
/** Each button an element draws, with what tapping it does: function
 *  components called through, as a static render would. */
function tappable(node: any): { text: string; tap: () => void }[] {
  const out: { text: string; tap: () => void }[] = [];
  const walk = (n: any): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.type === 'function') return walk(n.type(n.props));
    if (n.type === 'button') out.push({ text: text(renderToStaticMarkup(n)), tap: n.props.onClick });
    walk(n.props?.children);
  };
  walk(node);
  return out;
}

/** As in a browser's page: only there can amounts be hidden. */
function hidden<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const none = g.window === undefined;
  if (none) g.window = {};
  try {
    setAmountsHidden(true);
    return fn();
  } finally {
    setAmountsHidden(false);
    if (none) delete g.window;
  }
}
afterEach(() => setAmountsHidden(false));

const FX = ecbTable({ home: 'EUR' });
const DAY = '2026-09-14';
const BTC_RATE: OwnRate = { currency: 'BTC', rate: '61000', quote: 'USD', from: null, set_at: '2026-09-01T10:00:00.000Z' };
const PAGE_FX: PageFx = { home: 'EUR', latest: { date: DAY, rates: { USD: '1.1551', GBP: '0.85598' } }, own: [] };

/** Net worth now as the server answers it, from these balances. */
function base(rows: { amount: number; currency: string | null }[], over: Partial<NetWorthBase> = {}, own: OwnRate[] = []): NetWorthBase {
  const fx = ecbTable({ home: 'EUR', own });
  const b = balancesIn(rows, fx, 'EUR', DAY, 'USD');
  return {
    currency: 'EUR',
    net_worth: b.total,
    parts: b.parts,
    left_out: b.left_out,
    unknown: b.unknown,
    history: [],
    gaps: { unsplit: 0, main_unrated: [], left_out: [], unknown_currency: 0 },
    delta: null,
    rates: { day: DAY, stale: false, own, unusable: [] },
    fx: { home: 'EUR', latest: fx.latest, own },
    ...over,
  };
}

describe('the words of a converted figure', () => {
  test('each currency’s part, with its code, what it came to and the rate, which stays while amounts are hidden', () => {
    const b = balancesIn([{ amount: 1000, currency: 'USD' }, { amount: 2000, currency: 'EUR' }], FX, 'EUR', DAY, 'USD');
    expect(convertedText(b, [])).toBe('USD $1,000.00 is €865.73 (1 USD = 0.86573 EUR)');
    expect(hidden(() => convertedText(b, []))).toBe(`USD $${MASK} is €${MASK} (1 USD = 0.86573 EUR)`);
    // Nothing to say when everything is in the home currency.
    expect(convertedText(balancesIn([{ amount: 5, currency: 'EUR' }], FX, 'EUR', DAY, 'EUR'), [])).toBe('');
  });

  test('the person’s own rate is said to be theirs, and through which of the ECB’s it goes', () => {
    const fx = ecbTable({ home: 'EUR', own: [BTC_RATE] });
    const b = balancesIn([{ amount: 0.5, currency: 'BTC' }], fx, 'EUR', DAY, 'USD');
    // 0.5 × 61,000 USD / 1.1551
    // Intl writes a code it doesn't know as BTC with a no-break space.
    expect(partText(b.parts[0], 'EUR', [BTC_RATE])).toBe('BTC\u00a00.50 is €26,404.64 at your rate, through the ECB’s USD rate (1 BTC = 52,809 EUR)');
    expect(codedMoney(12, 'DOGE')).toBe('12.00 DOGE');
  });

  test('what was left out, and why, never guessed', () => {
    const b = balancesIn([{ amount: 1, currency: 'BTC' }, { amount: 2, currency: 'BTC' }, { amount: 5, currency: 'AED' }], FX, 'EUR', DAY, 'USD');
    expect(leftOutLines(b)).toEqual([
      { text: '2 accounts in BTC aren’t in this total: there is no rate for BTC.', rateFor: 'BTC' },
      { text: '1 account in AED isn’t in this total: there is no rate for AED.', rateFor: 'AED' },
    ]);
    expect(noRateText('USD', 'not-fetched')).toBe('Nya doesn’t have the ECB’s rates yet');
    expect(noRateText('BTC', 'quote')).toBe('your rate for BTC is in a currency the ECB has no rate for');
  });

  test('a home currency with no rate is named, once, as the one needing a rate: never the accounts’ own', () => {
    const fx = ecbTable({ home: 'ARS' });
    const b = balancesIn([{ amount: 100, currency: 'USD' }, { amount: 50, currency: 'GBP' }, { amount: 5000, currency: 'ARS' }], fx, 'ARS', DAY, 'USD');
    expect(leftOutLines(b)).toEqual([{ text: 'Nothing can be converted into ARS yet: the ECB doesn’t publish ARS, so 2 accounts in other currencies aren’t in this total.', rateFor: 'ARS' }]);
    expect(institutionNote(b)).toBe('Mixed currencies: nothing can be converted into ARS yet, as the ECB doesn’t publish it.');
  });

  test('rates Nya hasn’t fetched yet are said as that, with no rate to set', () => {
    const none = ecbTable({ home: 'EUR', latest: false });
    const b = balancesIn([{ amount: 100, currency: 'USD' }], { ...none, days: {}, series: {} }, 'EUR', '2026-10-01', 'USD');
    expect(leftOutLines(b)).toEqual([{ text: '1 account in USD isn’t in this total: Nya doesn’t have the ECB’s rates yet.', rateFor: null }]);
    expect(institutionNote(b)).toBe('Mixed currencies, converted into EUR at the ECB’s newest rates; USD isn’t in it (no rates yet).');
  });

  test('the heading, stale rates, and accounts saying no currency', () => {
    expect(convertedHeading('EUR', DAY, false)).toBe('Converted into EUR at the ECB’s rates of Sep 14, 2026');
    expect(convertedHeading('EUR', DAY, true)).toBe('Converted into EUR at the ECB’s rates of Sep 14, 2026, and your own');
    expect(staleText('2026-09-09')).toBe('The newest rates Nya has are from Sep 9, 2026: it couldn’t fetch newer ones, so converted figures may be out of date.');
    expect(staleText(null)).toBe('Nya has no exchange rates yet, so nothing in another currency can be converted.');
    expect(unknownText(2, 'USD')).toBe('2 accounts say no currency, so they are counted in USD.');
  });

  test('how much of the change came from exchange rates, the same way or the other', () => {
    expect(rateEffectText(3.07, 3.07, 'EUR')).toBe('€3.07 of it from exchange rates');
    expect(rateEffectText(-400, -120, 'EUR')).toBe('€120.00 of it from exchange rates');
    expect(rateEffectText(100, -50, 'EUR')).toBe('after €50.00 lost to exchange rates');
    expect(rateEffectText(-400, 80, 'EUR')).toBe('after €80.00 gained from exchange rates');
    // No more than rounding: nothing said.
    expect(rateEffectText(12, null, 'EUR')).toBe('');
    expect(hidden(() => rateEffectText(3.07, 3.07, 'EUR'))).toBe(`€${MASK} of it from exchange rates`);
  });

  test('the chart’s note: days not drawn, currencies left out with their days, accounts with no currency', () => {
    expect(
      chartGapLines(
        {
          unsplit: 3,
          main_unrated: [{ why: 'not-fetched', unrated: 'USD', from: '2024-06-03', to: '2024-06-03', days: 1 }],
          left_out: [
            { currency: 'ARS', why: 'not-published', unrated: 'ARS', from: '2026-03-01', to: '2026-03-04', days: 4 },
            { currency: 'GBP', why: 'not-fetched', unrated: 'GBP', from: '2024-01-02', to: '2024-01-05', days: 4 },
          ],
          unknown_currency: 1,
        },
        'EUR',
        'USD'
      )
    ).toEqual([
      '3 days couldn’t be converted: Nya didn’t keep their balances by account, so they aren’t drawn.',
      '1 day isn’t drawn, on Jun 3, 2024: Nya doesn’t have the ECB’s rates for that day yet.',
      'What is in ARS isn’t in the chart from Mar 1, 2026 to Mar 4, 2026: there is no rate for ARS on those days.',
      'What is in GBP isn’t in the chart from Jan 2, 2024 to Jan 5, 2024: Nya doesn’t have the ECB’s rates for those days yet.',
      'Nya knows of 1 account with no currency recorded: any balance it held is counted in USD.',
    ]);
    // A home currency with no rate: the days not drawn say so.
    expect(chartGapLines({ unsplit: 0, main_unrated: [{ why: 'not-published', unrated: 'ARS', from: '2026-09-01', to: '2026-09-14', days: 10 }], left_out: [], unknown_currency: 0 }, 'ARS', 'USD')).toEqual([
      '10 days aren’t drawn, from Sep 1, 2026 to Sep 14, 2026: nothing can be converted into ARS, as the ECB doesn’t publish it.',
    ]);
    expect(chartGapLines({ unsplit: 0, main_unrated: [], left_out: [], unknown_currency: 0 }, 'EUR', 'USD')).toEqual([]);
  });
});

describe('what the page converts itself, at the newest rates', () => {
  test('an institution’s mixed total, as the hero converts: each currency once', () => {
    const rows = [
      { amount: 1000, currency: 'USD' },
      { amount: -250, currency: 'USD' },
      { amount: 500, currency: 'GBP' },
    ];
    const b = balancesNow(rows, PAGE_FX, 'USD', Date.parse('2026-09-14T18:00:00Z'));
    // 750 / 1.1551 + 500 / 0.85598
    expect(b.total).toBe(649.29 + 584.13);
    expect(institutionNote(b)).toBe('Mixed currencies, converted into EUR at the ECB’s newest rates.');
    const left = balancesNow([...rows, { amount: 1, currency: 'BTC' }], PAGE_FX, 'USD');
    expect(institutionNote(left)).toBe('Mixed currencies, converted into EUR at the ECB’s newest rates; BTC isn’t in it (no rate).');
  });

  test('only when something is in another currency than the home one', () => {
    expect(needsConverting([{ amount: 1, currency: 'EUR' }], PAGE_FX, 'EUR')).toBe(false);
    expect(needsConverting([{ amount: 1, currency: 'USD' }], null, 'USD')).toBe(false);
    expect(needsConverting([{ amount: 1, currency: 'USD' }], PAGE_FX, 'USD')).toBe(true);
    // An account saying none counts in the main currency.
    expect(needsConverting([{ amount: 1, currency: null }], PAGE_FX, 'USD')).toBe(true);
  });

  test('a device whose clock is behind the server’s still converts at the newest rates', () => {
    const b = balancesNow([{ amount: 1000, currency: 'USD' }], PAGE_FX, 'USD', Date.parse('2026-09-13T23:00:00Z'));
    expect(b.total).toBe(865.73);
  });

  test('connection health’s share of net worth, in the home currency', () => {
    const inst: HealthInstitution = {
      institution_name: 'Bank',
      item_id: 'item_bank',
      error: null,
      health: { state: 'partial', cause: 'ok', side: 'bank', last_ok_at: '2026-09-12T12:00:00.000Z' } as any,
      accounts: [
        { account_id: 'a', name: 'Dollars', mask: null, type: 'depository', balance: 1000, currency: 'USD', held: { as_of: '2026-09-12' } },
        { account_id: 'b', name: 'Euros', mask: null, type: 'depository', balance: 2000, currency: 'EUR', held: { as_of: '2026-09-12' } },
      ] as any,
    };
    const [line] = affectedText(inst, undefined, PAGE_FX);
    expect(line).toContain('Dollars and Euros, together €2,865.73 of net worth.');
    // Without a home currency, nothing is added across currencies.
    expect(affectedText(inst)[0]).not.toContain('together');
  });
});

describe('Home’s notes', () => {
  test('under the hero: converted into what, at whose rates, each part, what was left out with the way to set a rate, and old rates', () => {
    const b = base([{ amount: 1000, currency: 'USD' }, { amount: 2000, currency: 'EUR' }, { amount: 0.5, currency: 'BTC' }], { rates: { day: DAY, stale: true, own: [], unusable: [] } });
    const html = renderToStaticMarkup(<HeroCurrencyNote base={b} main="USD" onOpen={noop} />);
    expect(text(html)).toBe(
      [
        'Converted into EUR at the ECB’s rates of Sep 14, 2026: USD $1,000.00 is €865.73 (1 USD = 0.86573 EUR).',
        '1 account in BTC isn’t in this total: there is no rate for BTC. Set a rate for BTC',
        'The newest rates Nya has are from Sep 14, 2026: it couldn’t fetch newer ones, so converted figures may be out of date.',
      ].join(' ')
    );
    // With amounts hidden: no figure of the person's, the rate kept.
    const masked = text(hidden(() => renderToStaticMarkup(<HeroCurrencyNote base={b} main="USD" onOpen={noop} />)));
    expect(masked).toContain('1 USD = 0.86573 EUR');
    expect(masked).not.toMatch(/1,000|865\.73/);
  });

  test('a home currency the ECB doesn’t publish: one note naming it, its link the form for its rate', () => {
    const fx = ecbTable({ home: 'ARS' });
    const b = balancesIn([{ amount: 100, currency: 'USD' }, { amount: 5000, currency: 'ARS' }], fx, 'ARS', DAY, 'USD');
    const asked: (string | null)[] = [];
    const node = <HeroCurrencyNote base={{ ...base([]), currency: 'ARS', net_worth: b.total, parts: b.parts, left_out: b.left_out }} main="USD" onOpen={(c) => asked.push(c)} />;
    const html = renderToStaticMarkup(node);
    expect(text(html)).toBe('Nothing can be converted into ARS yet: the ECB doesn’t publish ARS, so 1 account in another currency isn’t in this total. Set a rate for ARS');
    expect(text(html)).not.toContain('no rate for USD');
    // The link opens the form for ARS's rate.
    const [link] = tappable(node);
    expect(link.text).toBe('Set a rate for ARS');
    link.tap();
    expect(asked).toEqual(['ARS']);
  });

  test('rates Nya keeps that couldn’t be read are named, and their days said as rates it lacks', () => {
    const b = base([{ amount: 1000, currency: 'USD' }], { rates: { day: DAY, stale: false, own: [], unusable: ['USD:2025', 'days:2024', 'fetch'] } });
    expect(text(renderToStaticMarkup(<HeroCurrencyNote base={b} main="USD" onOpen={noop} />))).toContain(
      'Some of the ECB’s rates Nya keeps couldn’t be read (the USD rates of 2025 and the ECB’s calendar of 2024), so those days have no rate until the nightly fetch writes them again.'
    );
    // A series that couldn't be read: no rate on its days, said as rates Nya lacks.
    const fx = { ...ecbTable({ home: 'EUR' }), unusable: ['USD:2026'] };
    const series = { ...fx.series };
    delete (series as Record<string, unknown>)['USD:2026'];
    const day = balancesIn([{ amount: 1000, currency: 'USD' }], { ...fx, series, latest: null }, 'EUR', '2026-09-11', 'USD');
    expect(day.left_out).toEqual([{ currency: 'USD', accounts: 1, why: 'not-fetched', unrated: 'USD' }]);
  });

  test('under the chart: the days it couldn’t convert, or nothing', () => {
    const none = renderToStaticMarkup(<ChartCurrencyNote base={base([{ amount: 1, currency: 'USD' }])} main="USD" />);
    expect(none).toBe('');
    const html = renderToStaticMarkup(<ChartCurrencyNote base={base([{ amount: 1, currency: 'USD' }], { gaps: { unsplit: 2, main_unrated: [], left_out: [], unknown_currency: 0 } })} main="USD" />);
    expect(text(html)).toBe('2 days couldn’t be converted: Nya didn’t keep their balances by account, so they aren’t drawn.');
  });
});

describe('the offer to show totals in one currency (decision 1)', () => {
  test('nothing while the accounts’ balances are in one currency and so are the last year’s transactions', () => {
    expect(offerFor({ accounts: ['USD', 'USD', null], budgets: 'USD', main: 'USD' })).toBeNull();
    expect(offerFor({ accounts: ['USD'], budgets: 'JPY', main: 'USD', transactions: ['JPY', 'JPY', null] })).toBeNull();
  });

  test('for transactions in more than one over the last year (decision A, step 2): offered, saying why', () => {
    expect(offerFor({ accounts: ['USD'], budgets: 'USD', main: 'USD', transactions: ['USD', 'EUR', null] })).toEqual({ budgets: 'USD', accounts: null, why: 'transactions' });
    const html = renderToStaticMarkup(<CurrencyOffer offer={{ budgets: 'USD', accounts: null, why: 'transactions' }} onChoose={noop} onDismiss={noop} />);
    expect(text(html)).toContain('Your transactions over the last year are in more than one currency, and your spending totals leave out those in the others.');
    expect(text(html)).toContain('Nothing changes until you do.');
    expect(buttons(html)).toEqual(['Use USD your budgets are in it', 'Choose another', 'Not now']);
  });

  test('for accounts in more than one: the budgets’ currency, and the accounts’ main one beside it when they differ', () => {
    expect(offerFor({ accounts: ['USD', 'EUR', 'EUR'], budgets: 'USD', main: 'EUR' })).toEqual({ budgets: 'USD', accounts: 'EUR' });
    expect(offerFor({ accounts: ['USD', 'EUR'], budgets: 'USD', main: 'USD' })).toEqual({ budgets: 'USD', accounts: null });
  });

  test('says nothing changes until the person chooses, and offers each with why', () => {
    const html = renderToStaticMarkup(<CurrencyOffer offer={{ budgets: 'USD', accounts: 'EUR' }} onChoose={noop} onDismiss={noop} />);
    expect(text(html)).toContain('Your accounts are in more than one currency, and your net worth adds them up unconverted.');
    expect(text(html)).toContain('Nothing changes until you do.');
    expect(buttons(html)).toEqual(['Use USD your budgets are in it', 'Use EUR most of your accounts are in it', 'Choose another', 'Not now']);
  });
});

describe('the sheet that chooses a home currency', () => {
  const VIEW: CurrencySettingsView = {
    home: null,
    own: [],
    problem: null,
    removable: false,
    ecb: { date: DAY, rates: { USD: '1.1551', GBP: '0.85598', JPY: '178.52' }, stale: false, fetch_ok: true },
  };
  const body = (over: Partial<Parameters<typeof CurrencyChoiceBody>[0]> = {}) =>
    renderToStaticMarkup(<CurrencyChoiceBody view={VIEW} chosen="EUR" onChosen={noop} first={['USD', 'EUR']} manual={[]} saving={false} error={null} onSave={noop} onClose={noop} {...over} />);

  test('says what changes in this step, and what doesn’t, in the decision’s words', () => {
    expect(choiceText('EUR')).toBe(
      'Your net worth will be shown in EUR, with accounts in other currencies converted at the European Central Bank’s daily rates. Your budgets, goals and the Plan stay as they are, in the currencies they’re shown in now.'
    );
    expect(text(body())).toContain(choiceText('EUR'));
    expect(buttons(body())).toEqual(['Show my net worth in EUR', 'Not now']);
  });

  test('names the manual accounts that stay in their own currency', () => {
    expect(manualText([{ name: 'House', currency: 'USD' }], 'EUR')).toBe('Your manual account House stays in USD; its balance is converted for the total.');
    expect(manualText([{ name: 'House', currency: 'USD' }, { name: 'Car', currency: 'USD' }], 'EUR')).toBe(
      'Your manual accounts House and Car stay in USD; their balances are converted for the total.'
    );
    expect(manualText([{ name: 'House', currency: 'USD' }, { name: 'Flat', currency: 'GBP' }], 'EUR')).toBe(
      'Your manual accounts House and Flat stay in their own currencies; their balances are converted for the total.'
    );
    expect(manualText([{ name: 'House', currency: 'EUR' }], 'EUR')).toBeNull();
  });

  test('lists each manual account with its currency, to correct before confirming, never its balance', () => {
    const manual = [
      { account_id: 'manual_house', name: 'House', currency: 'USD' },
      { account_id: 'manual_flat', name: 'Flat', currency: 'USD' },
    ];
    /** The currency chosen in the select labelled `name`. */
    const chosenFor = (html: string, name: string) => new RegExp(`<label class="field">${name}<select[^>]*>[\\s\\S]*?<option value="([A-Z]{3})" selected=""`).exec(html)?.[1];
    const html = body({ manual });
    expect(text(html)).toContain(
      'Your manual accounts are counted in the currencies below. If one is in another, correct it before you confirm: only the currency changes, never the balance you typed.'
    );
    expect([chosenFor(html, 'House'), chosenFor(html, 'Flat')]).toEqual(['USD', 'USD']);
    // A correction shows at once, in what the sheet says of them too.
    const fixed = body({ manual, fixes: { manual_flat: 'GBP' } });
    expect([chosenFor(fixed, 'House'), chosenFor(fixed, 'Flat')]).toEqual(['USD', 'GBP']);
    expect(text(fixed)).toContain('Your manual accounts House and Flat stay in their own currencies; their balances are converted for the total.');
    // What a correction doesn't change, said once one is made.
    const keeps =
      'Correcting an account changes only its currency. The transactions already on it keep the currency they were entered in, so budgets and Activity, which add up one currency, may name them rather than count them.';
    expect(text(fixed)).toContain(keeps);
    expect(text(html)).not.toContain(keeps);
    // One account: said of it alone.
    expect(text(body({ manual: manual.slice(0, 1) }))).toContain('Your manual account is counted in the currency below.');
    // With the home currency already chosen, corrections alone can be saved.
    const home = { ...VIEW, home: 'EUR' };
    expect(body({ view: home, manual })).toMatch(/<button disabled="">Show my net worth in EUR<\/button>/);
    expect(text(body({ view: home, manual }))).toContain('It is your home currency now.');
    const saving = body({ view: home, manual, fixes: { manual_flat: 'GBP' } });
    expect(saving).toMatch(/<button>Save the currencies<\/button>/);
    expect(text(saving)).not.toContain('It is your home currency now.');
  });

  test('a runtime without Intl’s list of currencies still offers the common ones', () => {
    const intl = Intl as { supportedValuesOf?: unknown };
    const saved = intl.supportedValuesOf;
    delete intl.supportedValuesOf;
    try {
      const html = renderToStaticMarkup(
        <select value="ARS" onChange={noop}>
          <CurrencyOptions first={['USD']} value="ARS" />
        </select>
      );
      expect([...html.matchAll(/value="([A-Z]{3})"/g)].map((m) => m[1])).toEqual(['ARS', 'USD', 'EUR', 'GBP', 'CAD', 'MXN', 'JPY', 'AUD', 'CHF', 'INR', 'CNY']);
    } finally {
      intl.supportedValuesOf = saved;
    }
  });

  test('offers the accounts’ currencies first, then the ECB’s, then every other', () => {
    const groups = [...body().matchAll(/<optgroup label="([^"]*)">([\s\S]*?)<\/optgroup>/g)].map((m) => [m[1].replace(/&#x27;|’/g, '’'), [...m[2].matchAll(/value="([A-Z]+)"/g)].map((v) => v[1])]);
    expect(groups[0]).toEqual(['Your accounts’ currencies', ['USD', 'EUR']]);
    expect(groups[1]).toEqual(['Published daily by the ECB', ['GBP', 'JPY']]);
    expect((groups[2][1] as string[]).includes('ARS')).toBe(true);
  });

  test('a currency the ECB doesn’t publish needs a rate of the person’s own', () => {
    expect(text(body({ chosen: 'ARS' }))).toContain('The ECB doesn’t publish a rate for ARS, so nothing can be converted into it until you set a rate of your own for it');
    const priced = { ...VIEW, own: [{ currency: 'ARS', rate: '0.00071', quote: 'USD', from: null, set_at: '2026-09-01T10:00:00.000Z' }] };
    expect(text(body({ chosen: 'ARS', view: priced }))).not.toContain('doesn’t publish');
  });

  test('the person’s accounts in a currency the ECB doesn’t publish are said to be left out until they set a rate', () => {
    expect(text(body({ first: ['USD', 'BTC', 'ARS'] }))).toContain(
      'The ECB doesn’t publish BTC and ARS, so your accounts in them are left out of the total until you set a rate of your own for each'
    );
    const priced = { ...VIEW, own: [{ currency: 'BTC', rate: '61000', quote: 'USD', from: null, set_at: '2026-09-01T10:00:00.000Z' }] };
    expect(text(body({ first: ['USD', 'BTC'], view: priced }))).not.toContain('left out of the total');
  });

  test('before Nya has any rates, nothing is said to be unpublished: only that the rates aren’t in yet', () => {
    const empty = { ...VIEW, ecb: { date: null, rates: {}, stale: true, fetch_ok: null } };
    const t = text(body({ view: empty, first: ['USD', 'BTC'] }));
    expect(t).toContain('Nya doesn’t have the ECB’s rates yet, so nothing in another currency can be converted until it has fetched them');
    expect(t).not.toContain('doesn’t publish');
  });

  test('settings that can’t be read are never saved over', () => {
    const html = body({ view: { ...VIEW, problem: 'unreadable', removable: true } });
    expect(text(html)).toContain('Your currency settings couldn’t be read, so nothing can be saved over them.');
    expect(html).toMatch(/<button disabled="">Show my net worth in EUR<\/button>/);
  });
});

describe('the Currency card', () => {
  const ready = (view: Partial<CurrencySettingsView>) => ({
    kind: 'ready' as const,
    view: { home: null, own: [], problem: null, removable: false, ecb: { date: DAY, rates: { USD: '1.1551', GBP: '0.85598' }, stale: false, fetch_ok: true }, ...view },
  });
  const card = (load: Parameters<typeof CurrencyCardBody>[0]['load'], over: Partial<Parameters<typeof CurrencyCardBody>[0]> = {}) =>
    renderToStaticMarkup(
      <CurrencyCardBody load={load} busy={false} confirm={null} error={null} onChoose={noop} onConfirm={noop} onStop={noop} onRepair={noop} onRemove={noop} onEdit={noop} onRateFor={noop} {...over} />
    );

  test('without a home currency: what Nya does now, and the way to choose one', () => {
    const html = card(ready({}));
    expect(text(html)).toContain('adds your net worth up in the currency most of your accounts are in, unconverted');
    expect(text(html)).toContain('The ECB’s newest rates: Sep 14, 2026.');
    expect(buttons(html)).toEqual(['Choose a home currency', 'Add a rate']);
  });

  test('with one: what it converts, what it doesn’t, and the person’s rates with the ECB’s beside them', () => {
    const own: OwnRate[] = [BTC_RATE, { currency: 'USD', rate: '0.92', quote: 'EUR', from: '2026-09-01', set_at: '2026-09-01T10:00:00.000Z' }];
    const html = card(ready({ home: 'EUR', own }));
    const t = text(html);
    expect(t).toContain('Your net worth is shown in EUR, with accounts in other currencies converted at the European Central Bank’s daily reference rates, or your own.');
    expect(t).toContain('Your budgets, goals and the Plan stay as they are');
    expect(t).toContain('1 BTC = 61,000 USD, every day, past ones included The ECB doesn’t publish BTC');
    expect(t).toContain('1 USD = 0.92 EUR, from Sep 1, 2026 The ECB’s of Sep 14, 2026: 1 USD = 0.86573 EUR');
    expect(buttons(html)).toEqual(['Change', 'Stop converting', 'Change', 'Remove…', 'Change', 'Remove…', 'Add a rate']);
    // Stopping is confirmed, and says what it keeps.
    expect(text(card(ready({ home: 'EUR' }), { confirm: 'stop' }))).toContain('Every figure goes back to its own currency, as before you chose one. Your own rates are kept.');
  });

  test('a home currency the ECB doesn’t publish asks for a rate for it, and stops asking once there is one', () => {
    const html = card(ready({ home: 'ARS' }));
    expect(text(html)).toContain('The ECB doesn’t publish ARS, so nothing can be converted into it until you set a rate of your own for ARS.');
    expect(buttons(html)).toContain('Set a rate for ARS');
    const priced = card(ready({ home: 'ARS', own: [{ currency: 'ARS', rate: '0.00071', quote: 'USD', from: null, set_at: '2026-09-01T10:00:00.000Z' }] }));
    expect(text(priced)).not.toContain('nothing can be converted into it');
    // Before Nya has any rates, nothing is said to be unpublished.
    expect(text(card(ready({ home: 'ARS', ecb: { date: null, rates: {}, stale: true, fetch_ok: null } })))).not.toContain('doesn’t publish ARS');
  });

  test('rates older than they should be are said', () => {
    expect(text(card(ready({ home: 'EUR', ecb: { date: '2026-09-09', rates: {}, stale: true, fetch_ok: false } })))).toContain(
      'The ECB’s newest rates: Sep 9, 2026. Nya couldn’t fetch newer ones, so converted figures may be out of date.'
    );
  });

  test('newest rates Nya keeps but couldn’t read are said as such, never as no rates', () => {
    const html = text(card(ready({ home: 'EUR', ecb: { date: null, rates: {}, stale: true, fetch_ok: true, unusable: ['latest'] } })));
    expect(html).toContain('Nya couldn’t read the newest ECB rates it keeps. The nightly fetch writes them again.');
    expect(html).not.toContain('Nya has no ECB rates yet');
  });

  test('damaged settings can be removed once confirmed; a newer release’s are kept as they are', () => {
    const damaged = card(ready({ problem: 'unreadable', removable: true }));
    expect(text(damaged)).toContain('Your currency settings couldn’t be read, so nothing is converted until they can be.');
    expect(buttons(damaged)).toEqual(['Remove the damaged settings…']);
    expect(buttons(card(ready({ problem: 'unreadable', removable: true }), { confirm: 'repair' }))).toEqual(['Remove them', 'Keep them']);
    const newer = card(ready({ problem: 'unrecognised', removable: false }));
    expect(text(newer)).toContain('saved by a newer version of Nya');
    expect(buttons(newer)).toEqual([]);
  });

  test('a rate of one’s own: refused with why, the ECB’s beside it', () => {
    const draft: RateDraft = { currency: 'usd', rate: '0,92', quote: 'EUR', every: false, from: '2026-09-01' };
    expect(draftProblem(draft)).toBe('Use a full stop for decimals: 0.92.');
    expect(draftProblem({ ...draft, rate: '0.92' })).toBeNull();
    expect(draftProblem({ ...draft, currency: 'EUR', rate: '1' })).toBe('A rate is in another currency than the one it prices.');
    expect(draftProblem({ ...draft, rate: '0.92', every: false, from: '' })).toBe('Choose the day it starts, or every day.');
    const html = renderToStaticMarkup(
      <OwnRateForm draft={{ ...draft, rate: '0.92' }} onDraft={noop} view={ready({}).view} currencies={['USD']} busy={false} error={null} onSave={noop} onCancel={noop} />
    );
    expect(text(html)).toContain('The ECB’s of Sep 14, 2026: 1 USD = 0.86573 EUR');
    expect(ownRateText(BTC_RATE)).toBe('1 BTC = 61,000 USD, every day, past ones included');
    expect(ecbBeside({ currency: 'GBP', quote: 'USD' }, ready({}).view.ecb)).toBe('The ECB’s of Sep 14, 2026: 1 GBP = 1.3494 USD');
  });
});
