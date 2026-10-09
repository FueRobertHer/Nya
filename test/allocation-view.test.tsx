import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import AllocationCard, {
  AllocationHistoryChart,
  seriesAccountsOf,
  type HistoryAccount,
  type HistoryAnswer,
  AllocationNotes,
  BucketView,
  ClassView,
  DriftSection,
  HistoryBody,
  MixSection,
  ShareTable,
  UseMixForm,
  dayMixText,
  dayShares,
  readSplit,
  type AllocationState,
} from '@/components/AllocationCard';
import { CLASS_COLORS, mixBasisText, mixLeftOutText, mixText, noMixText, pointsText, tenthPct } from '@/components/allocation-text';
import { SimulationForm } from '@/components/PlanForms';
import { allocate, planMix, type AllocAccount, type AllocHolding, type AllocInstitution } from '@/lib/allocation/allocation';
import { CLASS_NAMES, SLOTS } from '@/lib/allocation/classes';
import { EMPTY_SETTINGS, type AllocationSettings } from '@/lib/allocation/settings';
import type { SeriesDay } from '@/lib/allocation/series';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';
import { wholeMoney } from '@/components/plan-text';
import { initialListState } from '@/lib/whole-list-store';

// The Allocation section of the Plan tab, rendered: the unclassified share
// shown plainly and never folded into a class, what is left out named, the
// as-of line, and the plan's mix changed only on the person's word.

const noop = () => {};
const money = (n: number) => wholeMoney(n, 'USD');
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    // A tag closing before punctuation leaves a space in front of it.
    .replace(/ ([.,:;])/g, '$1');
const acct = (account_id: string, over: Partial<AllocAccount> = {}): AllocAccount => ({ account_id, name: account_id, type: 'investment', subtype: 'brokerage', balance: 0, currency: 'USD', ...over });
const inst = (name: string, accounts: AllocAccount[], over: Partial<AllocInstitution> = {}): AllocInstitution => ({ name, error: false, staleAsOf: null, missing: 0, accounts, ...over });
const hold = (account_id: string, ticker: string | null, value: number | null, over: Partial<AllocHolding> = {}): AllocHolding => ({ account_id, ticker, name: ticker ?? 'Unknown', security_type: 'etf', is_cash_equivalent: false, value, ...over });

const institutions = [
  inst('Vanguard', [acct('brk', { name: 'Brokerage', balance: 100_000 }), acct('k', { name: '401(k)', subtype: '401k', balance: 50_000 })]),
  inst('Manual accounts', [acct('manual_1', { name: 'Old pension', subtype: null, balance: 10_000 })], { item_id: null }),
];
const holdings = [
  hold('brk', 'VTI', 50_000),
  hold('brk', 'VXUS', 22_000),
  hold('brk', 'BND', 20_000),
  hold('brk', 'VMFXX', 8_000, { security_type: 'mutual fund', name: 'Vanguard Federal Money Market Fund' }),
  hold('k', 'VFIFX', 50_000, { security_type: 'mutual fund', name: 'Vanguard Target Retirement 2050 Fund' }),
];
const alloc = (settings: AllocationSettings | null = null) => allocate({ institutions, holdings, settings, currency: 'USD' });

describe('the allocation by class', () => {
  test('shows every class held with its amount and share, the unclassified share plainly, and a way to classify it', () => {
    const t = text(renderToStaticMarkup(<ClassView alloc={alloc()} money={money} editable settings={EMPTY_SETTINGS} open={noop} />));
    expect(t).toContain('US stocks $50,000 31%');
    // 37.5% by the largest remainder, which gave the tie to bonds.
    expect(t).toContain('Unclassified $60,000 37%');
    expect(t).toContain('Unclassified: $60,000');
    expect(t).toContain("VFIFX $50,000 Vanguard Target Retirement 2050 Fund. Unclassified: a fund whose mix Nya doesn't know (a target-date fund, whose mix moves every year, or an actively managed one, say)");
    expect(t).not.toContain('balanced');
    expect(t).toContain('Old pension $10,000 Old pension is an account you track by hand, with no positions to go by.');
    expect(t).toContain('Classify');
    // Every holding, and how it is classified.
    expect(t).toContain("VTI $50,000 100% US stocks, from Nya's list of index funds.");
    expect(t).toContain('VMFXX $8,000 Cash: a cash or money market position.');
  });

  test('an account no positions came for says so, true whether its holdings call failed or answered none', () => {
    const a = allocate({ institutions: [inst('Fidelity', [acct('k', { name: '401(k)', balance: 30_000 })], { item_id: 'i' })], holdings: [], settings: null, currency: 'USD' });
    const t = text(renderToStaticMarkup(<ClassView alloc={a} money={money} editable settings={EMPTY_SETTINGS} open={noop} />));
    expect(t).toContain('401(k) $30,000 No positions came from Fidelity for 401(k).');
    expect(t).not.toContain('lists no position');
  });

  test('Classify is offered only for a security whose ticker or name a save takes', () => {
    const long = 'L'.repeat(41);
    const a = allocate({
      institutions: [inst('X', [acct('s', { balance: 300 })])],
      holdings: [hold('s', long, 100, { security_type: 'mutual fund', name: 'A fund' }), hold('s', 'T 2.5 05/15/30', 100, { security_type: 'mutual fund' }), hold('s', 'OK', 100, { security_type: 'mutual fund' })],
      settings: null,
      currency: 'USD',
    });
    const html = renderToStaticMarkup(<ClassView alloc={a} money={money} editable settings={EMPTY_SETTINGS} open={noop} />);
    expect(html).not.toContain(`aria-label="Classify ${long}"`);
    expect(text(html)).toContain("It can't be classified by hand: a ticker is 1 to 40 characters, with no control characters.");
    // A bond's ticker with spaces is one a save takes.
    expect(html).toContain('aria-label="Classify T 2.5 05/15/30"');
    expect(html).toContain('aria-label="Classify OK"');
  });

  test('a leveraged or inverse fund is unclassified, and says why', () => {
    const a = allocate({ institutions: [inst('X', [acct('s', { balance: 100 })])], holdings: [hold('s', 'SQQQ', 100, { security_type: 'equity', name: 'ProShares UltraPro Short QQQ' })], settings: null, currency: 'USD' });
    const t = text(renderToStaticMarkup(<ClassView alloc={a} money={money} editable settings={EMPTY_SETTINGS} open={noop} />));
    expect(t).toContain('Unclassified $100 100%');
    expect(t).toContain("Unclassified: a leveraged or inverse fund, which moves by a multiple of what it tracks, or against it, so it isn't counted as what it tracks.");
  });

  test('a split the person set classifies it, and says so', () => {
    const mine = { ...EMPTY_SETTINGS, funds: [{ ticker: 'VFIFX', split: { 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 } }], accounts: [{ account_id: 'manual_1', split: { bonds: 100 } }] };
    const t = text(renderToStaticMarkup(<ClassView alloc={alloc(mine)} money={money} editable settings={mine} open={noop} />));
    expect(t).not.toContain('Unclassified $');
    expect(t).toContain('VFIFX $50,000 54% US stocks, 36% international stocks, 10% bonds, as you set it.');
    expect(t).toContain('classified as you set it: 100% bonds');
  });

  test('the bar and the rows: a key beside every name, money owed named, never drawn', () => {
    const a = allocate({ institutions: [inst('X', [acct('m', { balance: 100_000 })])], holdings: [hold('m', 'VTI', 120_000), hold('m', 'CUR:USD', -20_000, { security_type: 'cash' })], settings: null, currency: 'USD' });
    const html = renderToStaticMarkup(<ShareTable totals={a.classes} order={SLOTS} colors={CLASS_COLORS} label={(s) => CLASS_NAMES[s]} money={money} />);
    const t = text(html);
    expect(t).toContain('US stocks $120,000 120%');
    expect(t).toContain('Cash -$20,000 -20%');
    expect(t).toContain('Cash is below zero (-$20,000): money owed');
    // One segment, US stocks: the negative cash isn't a part of the bar.
    expect([...html.matchAll(/class="alloc-seg"/g)].length).toBe(1);
    expect(html.match(/class="alloc-swatch"/g)!.length).toBe(2);
  });

  test('what is left out or can’t be seen is named, one sentence each', () => {
    const a = allocate({
      institutions: [
        inst('Vanguard', [acct('us', { balance: 10_000 })], { missing: 1 }),
        inst('Questrade', [acct('ca', { balance: 5_000, currency: 'CAD' })]),
        inst('Chase', [], { error: true }),
      ],
      holdings: [hold('us', 'VTI', 10_000), hold('us', 'NEW', null), { ticker: 'OLD', value: 5, name: 'Old' }],
      settings: null,
      currency: 'USD',
    });
    const t = text(renderToStaticMarkup(<AllocationNotes alloc={a} money={money} />));
    expect(t).toContain("1 position belongs to no account Nya can show, so it isn't counted.");
    expect(t).toContain("Left out: CA$5,000, in another currency. Nya doesn't convert currencies.");
    expect(t).toContain("Chase couldn't be reached and isn't counted");
    expect(t).toContain("1 account at Vanguard couldn't be shown");
    expect(t).toContain("1 position has no value from the institution, so it isn't counted.");
  });
});

describe('the allocation by tax bucket', () => {
  test('each account’s bucket and where it came from, with a way to change it', () => {
    const mine = { ...EMPTY_SETTINGS, buckets: [{ account_id: 'k', bucket: 'roth' as const }] };
    const t = text(renderToStaticMarkup(<BucketView alloc={alloc(mine)} money={money} editable open={noop} />));
    expect(t).toContain('Taxable $100,000');
    expect(t).toContain('Roth $50,000');
    expect(t).toContain('Unclassified $10,000');
    expect(t).toContain('Brokerage · Vanguard Taxable $100,000, from its type (brokerage).');
    expect(t).toContain('401(k) · Vanguard Roth $50,000, as you set it; its type says tax-deferred.');
    expect(t).toContain('Old pension · Manual accounts Unclassified $10,000, unclassified: an account you track by hand has no type to go by.');
    expect(t).toContain('A 401(k) can hold Roth money');
  });

  test('an account counted at a recovered balance says from when', () => {
    const a = allocate({
      institutions: [inst('Fidelity', [acct('f', { name: '401(k)', subtype: '401k', balance: 70_000 })], { error: true, staleAsOf: '2026-10-01' })],
      holdings: [],
      settings: null,
      currency: 'USD',
    });
    const t = text(renderToStaticMarkup(<BucketView alloc={a} money={money} editable open={noop} />));
    expect(t).toContain("401(k) · Fidelity Tax-deferred $70,000, its balance on Oct 1, 2026 (Fidelity couldn't be reached since), from its type (401k).");
  });
});

describe('drift', () => {
  test('without a target, offers to set one', () => {
    const t = text(renderToStaticMarkup(<DriftSection alloc={alloc()} target={null} money={money} editable onSet={noop} />));
    expect(t).toContain('Set a target');
  });

  test('against a target: each class’s target, where it is now, the drift and the money it takes; unclassified left out and said', () => {
    const t = text(renderToStaticMarkup(<DriftSection alloc={alloc()} target={{ 'us-stocks': 50, 'intl-stocks': 30, bonds: 20 }} money={money} editable onSet={noop} />));
    expect(t).toContain('Against your target: 50% US stocks, 30% international stocks, 20% bonds');
    // Of the $100,000 classified: US stocks are at 50%.
    expect(t).toContain('US stocks 50% 50% on target');
    expect(t).toContain('International stocks $8,000 under 30% 22% -8 points');
    expect(t).toContain('Cash $8,000 over 0% 8% +8 points');
    expect(t).toContain('$60,000 unclassified is left out of these shares');
    expect(pointsText(0.04)).toBe('on target');
    // The shares' rule: money that is there never reads 0%, a share short of
    // the whole never 100%.
    expect([tenthPct(0.03), tenthPct(99.97), tenthPct(100), tenthPct(0), tenthPct(54.25), tenthPct(-0.02)]).toEqual(['<0.1%', '>99.9%', '100%', '0%', '54.3%', '>-0.1%']);
    expect(pointsText(1)).toBe('+1 point');
    expect(pointsText(-2.25)).toBe('-2.3 points');
  });
});

describe('the target, while it isn’t known', () => {
  test('a tiny share in the Now column reads as there, and the whole as short of it', () => {
    const a = allocate({
      institutions: [inst('X', [acct('m', { balance: 100_030 })])],
      holdings: [hold('m', 'VTI', 100_000), hold('m', 'VMFXX', 30, { security_type: 'mutual fund' })],
      settings: null,
      currency: 'USD',
    });
    const t = text(renderToStaticMarkup(<DriftSection alloc={a} target={{ 'us-stocks': 100 }} money={money} editable onSet={noop} />));
    expect(t).toContain('US stocks 100% >99.9% on target');
    expect(t).toContain('Cash 0% <0.1% on target');
    // No money line beside "on target".
    expect(t).not.toContain('$30 under');
  });

  test('while the settings load, or can’t be read, no target is said to be missing', () => {
    const loading = text(renderToStaticMarkup(<DriftSection alloc={alloc()} target={null} waiting="loading" money={money} editable={false} onSet={noop} />));
    expect(loading).toContain('Loading your target…');
    expect(loading).not.toContain('Set the allocation you aim for');
    const unreadable = text(renderToStaticMarkup(<DriftSection alloc={alloc()} target={null} waiting="unreadable" money={money} editable={false} onSet={noop} />));
    expect(unreadable).toContain('Your target shows here once your settings can be read.');
    expect(unreadable).not.toContain('Set a target');
    // Loaded, with none set: the offer to set one.
    expect(text(renderToStaticMarkup(<DriftSection alloc={alloc()} target={null} money={money} editable onSet={noop} />))).toContain('Set the allocation you aim for');
  });
});

describe('the plan’s mix', () => {
  const m = () => planMix(alloc());

  test('offers the mix of what is classified, says what it left out and how much of the whole that is, and changes nothing by itself', () => {
    const t = text(renderToStaticMarkup(<MixSection mix={m()} plan={plan()} ready currency="USD" editable onUse={noop} />));
    // Never "your accounts hold" a mix of part of them.
    expect(t).not.toContain('Your accounts hold');
    expect(t).toContain('Of the $160,000 in your accounts, $100,000 is classified as stocks, bonds or cash: 72% stocks, 20% bonds, 8% cash.');
    expect(t).toContain("Your plan's simulation uses 75% stocks, 25% bonds, 0% cash.");
    // 37%, as the share table above has it (the largest remainder there gave
    // the tie to bonds), never a second rounding that reads 38%.
    expect(t).toContain("Left out: $60,000 unclassified, 37% of the $160,000, which can't be counted as stocks or bonds without knowing what it is.");
    expect(text(renderToStaticMarkup(<ClassView alloc={alloc()} money={money} editable settings={EMPTY_SETTINGS} open={noop} />))).toContain('Unclassified $60,000 37%');
    expect(t).toContain('Use my allocation in the plan');
  });

  test('says when the plan already uses it, and offers nothing then', () => {
    const t = text(renderToStaticMarkup(<MixSection mix={m()} plan={plan({ stocksPct: 72, bondsPct: 20 })} ready currency="USD" editable onUse={noop} />));
    expect(t).toContain("Your plan's simulation already uses this mix.");
    expect(t).not.toContain('Use my allocation');
  });

  test('offers nothing while the person’s settings aren’t in the figures, or when there is no mix to take', () => {
    expect(renderToStaticMarkup(<MixSection mix={m()} plan={plan()} ready={false} currency="USD" editable onUse={noop} />)).toBe('');
    const none = planMix(allocate({ institutions: [inst('X', [acct('s', { balance: 5 })])], holdings: [hold('s', 'VFIFX', 5, { security_type: 'mutual fund' })], settings: null, currency: 'USD' }));
    const t = text(renderToStaticMarkup(<MixSection mix={none} plan={plan()} ready currency="USD" editable onUse={noop} />));
    expect(t).toContain('Nothing is classified as stocks, bonds or cash yet');
    expect(t).not.toContain('Use my allocation');
  });

  test('the confirmation shows the mix now, the mix it would take and what that leaves out, and nothing is saved on showing it', () => {
    let confirmed = 0;
    const t = text(
      renderToStaticMarkup(
        <UseMixForm
          mix={m()}
          plan={plan()}
          currency="USD"
          editable
          onConfirm={async () => {
            confirmed++;
            return true;
          }}
          onCancel={noop}
        />
      )
    );
    expect(confirmed).toBe(0);
    expect(t).toContain(
      "Your plan's simulation uses 75% stocks, 25% bonds, 0% cash. Of the $160,000 in your accounts, $100,000 is classified as stocks, bonds or cash: 72% stocks, 20% bonds, 8% cash."
    );
    expect(t).toContain('Left out: $60,000 unclassified, 37% of the $160,000');
    expect(t).toContain("The plan keeps this mix until you change it: it doesn't follow your accounts.");
    expect(t).toContain('Use 72/20/8');
    expect(t).toContain('Cancel');
  });

  test('checking and savings, other currencies, and classes the simulation can’t hold are named in what it left out', () => {
    const a = allocate({
      institutions: [inst('X', [acct('s', { balance: 100_000 })]), inst('Q', [acct('c', { balance: 1_000, currency: 'CAD' })])],
      holdings: [hold('s', 'VTI', 80_000), hold('s', 'VNQ', 10_000), hold('s', 'IBIT', 10_000)],
      settings: null,
      currency: 'USD',
    });
    const mix = planMix(a, 5_000);
    expect(mixText(mix as never)).toBe('94% stocks, 0% bonds, 6% cash');
    expect(mixLeftOutText(mix, 'USD')).toBe(
      "Left out: $10,000 of real estate and $10,000 of crypto, 19% of the $105,000, which the simulation's stocks, bonds and cash can't stand for. CA$1,000 in another currency is left out too: Nya doesn't convert currencies."
    );
    const t = text(renderToStaticMarkup(<MixSection mix={mix} plan={plan()} ready currency="USD" editable onUse={noop} />));
    expect(t).toContain(
      'Of the $105,000 your accounts hold in USD, $85,000 is classified as stocks, bonds or cash (with $5,000 of checking and savings as cash, as your plan counts them): 94% stocks, 0% bonds, 6% cash.'
    );
  });

  test('another currency alone is left out, not left out "too"; with nothing left out, all of it is the mix', () => {
    const a = allocate({
      institutions: [inst('X', [acct('s', { balance: 1_000 })]), inst('Q', [acct('c', { balance: 1_000, currency: 'CAD' })])],
      holdings: [hold('s', 'VTI', 1_000)],
      settings: null,
      currency: 'USD',
    });
    const mix = planMix(a);
    expect(mixLeftOutText(mix, 'USD')).toBe("CA$1,000 in another currency is left out: Nya doesn't convert currencies.");
    expect(mixBasisText(mix, 'USD')).toBe('All $1,000 your accounts hold in USD is classified as stocks, bonds or cash');
    const solo = planMix(allocate({ institutions: [inst('X', [acct('s', { balance: 1_000 })])], holdings: [hold('s', 'VTI', 1_000)], settings: null, currency: 'USD' }));
    expect(mixBasisText(solo, 'USD')).toBe('All $1,000 in your accounts is classified as stocks, bonds or cash');
    expect(mixLeftOutText(solo, 'USD')).toBeNull();
  });

  test('a mix that can’t be taken says which class is below zero, and what could put it there', () => {
    const short = planMix(
      allocate({
        institutions: [inst('X', [acct('m', { balance: 10_000 })])],
        holdings: [hold('m', 'TSLA', -5_000, { security_type: 'equity' }), hold('m', 'CUR:USD', 15_000, { security_type: 'cash' })],
        settings: null,
        currency: 'USD',
      })
    );
    expect(short).toMatchObject({ ok: false, why: 'negative', below: ['stocks'] });
    expect(noMixText(short as never)).toBe("Your stocks (a short position, say) are below zero, which a mix of shares can't hold, so set the plan's mix yourself.");
    const margin = planMix(allocate({ institutions: [inst('X', [acct('m', { balance: 5_000 })])], holdings: [hold('m', 'VTI', 9_000), hold('m', 'CUR:USD', -4_000, { security_type: 'cash' })], settings: null, currency: 'USD' }));
    expect(noMixText(margin as never)).toBe("Your cash (money borrowed on margin, say) is below zero, which a mix of shares can't hold, so set the plan's mix yourself.");
    // An overdrawn checking account the plan counts as cash.
    const overdrawn = planMix(allocate({ institutions: [inst('X', [acct('m', { balance: 1_000 })])], holdings: [hold('m', 'VTI', 1_000)], settings: null, currency: 'USD' }), -300);
    expect(noMixText(overdrawn as never)).toBe(
      "Your cash (an overdrawn account the plan counts as cash, say) is below zero, which a mix of shares can't hold, so set the plan's mix yourself."
    );
  });

  test('the simulation’s form offers to fill in the allocation’s mix, saying what it is of and what it left out, and saves only with Save', () => {
    const offered = planMix(alloc());
    if (!offered.ok) throw new Error('a mix was expected');
    const html = renderToStaticMarkup(
      <SimulationForm plan={plan()} onSave={async () => true} onDone={noop} editable fiNumber={1} assets={1} spending={1} currency="USD" allocationMix={offered} />
    );
    const t = text(html);
    expect(t).not.toContain('Your accounts hold');
    expect(t).toContain('Of the $160,000 in your accounts, $100,000 is classified as stocks, bonds or cash: 72% stocks, 20% bonds, 8% cash.');
    expect(t).toContain("Left out: $60,000 unclassified, 37% of the $160,000, which can't be counted as stocks or bonds without knowing what it is.");
    expect(t).toContain('Fill in my allocation');
    // The fields still hold what the plan has: nothing is filled in by itself.
    expect(html).toContain('value="75"');
    expect(html).toContain('value="25"');
    const without = text(renderToStaticMarkup(<SimulationForm plan={plan()} onSave={async () => true} onDone={noop} editable fiNumber={1} assets={1} spending={1} currency="USD" />));
    expect(without).not.toContain('Fill in my allocation');
    expect(without).toContain('classify them under Allocation');
  });
});

describe('a split as typed', () => {
  test('percents that add up to 100, at most one decimal; an empty field is none', () => {
    expect(readSplit({ 'us-stocks': '54', 'intl-stocks': '36', bonds: '10', cash: '' })).toEqual({ 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 });
    expect(readSplit({ 'us-stocks': '33.3', bonds: '33.3', cash: '33.4' })).toEqual({ 'us-stocks': 33.3, bonds: 33.3, cash: 33.4 });
    expect(readSplit({ stocks: '100', bonds: '0' })).toEqual({ stocks: 100 });
    expect(() => readSplit({ 'us-stocks': '50', bonds: '45' })).toThrow('add up to 95%');
    expect(() => readSplit({ 'us-stocks': '50.55', bonds: '49.45' })).toThrow('one decimal');
    expect(() => readSplit({ 'us-stocks': '-5', bonds: '105' })).toThrow('from 0 to 100');
    expect(() => readSplit({ 'us-stocks': 'lots' })).toThrow('from 0 to 100');
    expect(() => readSplit({})).toThrow('at least one');
  });

  test('a target gives stocks one way or the other', () => {
    expect(() => readSplit({ stocks: '50', 'us-stocks': '30', bonds: '20' }, { target: true })).toThrow('not both');
    expect(readSplit({ stocks: '50', 'us-stocks': '30', bonds: '20' })).toEqual({ stocks: 50, 'us-stocks': 30, bonds: 20 });
  });
});

describe('the mix over time', () => {
  const day = (date: string, classes: SeriesDay['classes'], over: Partial<SeriesDay> = {}): SeriesDay => ({
    date,
    classes,
    total: Object.values(classes).reduce((s, n) => s + (n ?? 0), 0),
    unlisted: 0,
    missing: [],
    otherCurrencies: {},
    noCurrency: 0,
    unpriced: 0,
    ...over,
  });
  const names = new Map([
    ['b', 'IRA at Fidelity'],
    ['k', '401(k) at Fidelity'],
  ]);
  const span = (account_id: string, first: string | null, last: string | null, shown = true, label: string | null = null): HistoryAccount => ({ account_id, shown, first, last, label });
  const answer = (days: SeriesDay[], over: Partial<HistoryAnswer> = {}): HistoryAnswer => ({
    currency: 'USD',
    first_recorded: days[0]?.date ?? null,
    first_recorded_at: null,
    last_recorded: days.at(-1)?.date ?? null,
    days,
    accounts: [],
    unreadable_days: [],
    ...over,
  });
  const ready = (days: SeriesDay[], over: Partial<HistoryAnswer> = {}) => ({ kind: 'ready' as const, answer: answer(days, over) });
  const body = (days: SeriesDay[], over: Partial<HistoryAnswer> = {}) => renderToStaticMarkup(<HistoryBody state={ready(days, over)} accountNames={names} onRetry={noop} />);

  test('starts on the first recorded day, and says so in the axis’s own dates', () => {
    const t = text(body([day('2026-09-30', { 'us-stocks': 60, bonds: 40 }), day('2026-10-02', { 'us-stocks': 70, bonds: 30 })]));
    expect(t).toContain('Recorded from Sep 30, 2026, on 2 days: nothing is drawn before the first, or on a day nothing was recorded.');
    expect(t).toContain('Each day is counted as the allocation above is, from the positions and balances recorded that day.');
    // The readout reads the last day until another is touched.
    expect(t).toContain('70% US stocks, 30% bonds Oct 2, 2026 · $100 counted');
  });

  test('says from when it is shown, when recording began before the year it reads', () => {
    const t = text(body([day('2025-10-10', { bonds: 1 }), day('2026-10-09', { bonds: 1 })], { first_recorded: '2024-03-02' }));
    expect(t).toContain('Recorded from Mar 2, 2024, shown from Oct 10, 2025, on 2 days');
  });

  test('an account not recorded since a day: the latest days are marked, and the readout and the notes say since when', () => {
    const days = [day('2026-10-01', { 'us-stocks': 300, bonds: 100 }), day('2026-10-02', { 'us-stocks': 300, bonds: 100 }), day('2026-10-05', { bonds: 100 }, { missing: ['k'] }), day('2026-10-08', { bonds: 100 }, { missing: ['k'] })];
    const html = body(days, { accounts: [span('k', '2026-10-01', '2026-10-02')] });
    const t = text(html);
    expect(t).toContain('100% bonds Oct 8, 2026 · $100 counted · leaves out 401(k) at Fidelity (not recorded since Oct 2, 2026)');
    expect(t).toContain("401(k) at Fidelity hasn't been recorded since Oct 2, 2026, so the mix on the latest days leaves it out.");
    expect(t).toContain("On 2 days (marked), the mix leaves out 401(k) at Fidelity, which wasn't recorded then.");
    expect(t).toContain('Missing an account');
    expect(html.match(/opacity="0.45"/g)).toHaveLength(2);
    expect(html).toContain('leaving out 401(k) at Fidelity (not recorded since Oct 2, 2026)');
  });

  test('before an account was first recorded, and on a day between, each says which', () => {
    const days = [day('2026-10-01', { bonds: 1 }, { missing: ['k'] }), day('2026-10-04', { bonds: 1, 'us-stocks': 3 }), day('2026-10-05', { 'us-stocks': 3 }, { missing: ['b'] }), day('2026-10-06', { bonds: 1, 'us-stocks': 3 })];
    const t = text(body(days, { accounts: [span('b', '2026-10-04', '2026-10-06'), span('k', '2026-10-04', '2026-10-06')] }));
    expect(t).toContain('Leaves out 401(k) at Fidelity (first recorded on Oct 4, 2026)');
    expect(t).toContain('Leaves out IRA at Fidelity (not recorded that day)');
    // Two accounts on different days: the note agrees with the accounts, not the days.
    expect(t).toContain("On 2 days (marked), the mix leaves out accounts that weren't recorded then: 401(k) at Fidelity and IRA at Fidelity.");
    expect(t).not.toContain("hasn't been recorded since");
  });

  test('two accounts behind at the end are each said with since when', () => {
    const days = [day('2026-10-01', { bonds: 1 }), day('2026-10-08', { bonds: 1 }, { missing: ['b', 'k'] })];
    const t = text(body(days, { accounts: [span('b', '2026-09-20', '2026-10-01'), span('k', '2026-10-01', '2026-10-01')] }));
    expect(t).toContain("IRA at Fidelity (since Oct 1, 2026) and 401(k) at Fidelity (since Oct 1, 2026) haven't been recorded lately, so the mix on the latest days leaves them out.");
  });

  test('what the days count and leave out is said: money no position explains, accounts no longer linked, currencies, days that can’t be read', () => {
    const days = [
      day('2026-10-01', { 'us-stocks': 100, unclassified: 50 }, { unlisted: 50, noCurrency: 7, otherCurrencies: { CAD: 20 } }),
      day('2026-10-02', { 'us-stocks': 100 }, { missing: ['gone'] }),
      day('2026-10-03', { 'us-stocks': 100 }),
    ];
    const t = text(body(days, { accounts: [span('gone', '2026-10-01', '2026-10-03', false, 'Rollover IRA at Schwab')], unreadable_days: ['2026-09-30'] }));
    expect(t).toContain("Unclassified includes money no position explains: an account tracked by hand, a balance beyond its positions, or an account whose positions didn't come that day.");
    expect(t).toContain("Rollover IRA at Schwab isn't linked now, so on the days it was recorded it is counted from its positions alone.");
    expect(t).toContain('Leaves out Rollover IRA at Schwab (not recorded that day)');
    expect(t).toContain("Positions with no currency in an account that isn't linked now are left out: its currency isn't known.");
    expect(t).toContain("Money in CAD is left out: Nya doesn't convert currencies.");
    expect(t).toContain("1 recorded day couldn't be read, so it isn't drawn.");
  });

  test('nothing recorded, unreadable, or not loaded: each says so, never an empty chart', () => {
    expect(text(body([]))).toContain('Nothing recorded yet. Plaid keeps no past holdings');
    const damagedOnly = text(body([], { first_recorded: '2026-10-01', unreadable_days: ['2026-10-01', '2026-10-02'] }));
    expect(damagedOnly).toContain('Nothing recorded can be shown yet.');
    expect(damagedOnly).toContain("2 recorded days couldn't be read, so they aren't drawn.");
    const unreadable = text(
      renderToStaticMarkup(
        <HistoryBody state={{ kind: 'unreadable', message: 'Your saved allocation settings could not be read, so they were left untouched.' }} accountNames={names} onRetry={noop} />
      )
    );
    expect(unreadable).toContain("Your saved allocation settings could not be read, so they were left untouched. The mix over time can't be shown until it can be read.");
    expect(renderToStaticMarkup(<AllocationHistoryChart days={[]} currency="USD" answer={{ accounts: [] }} nameOf={(id) => id} />)).toBe('');
    const failed = text(renderToStaticMarkup(<HistoryBody state={{ kind: 'failed' }} accountNames={names} onRetry={noop} />));
    expect(failed).toContain("couldn't be loaded");
    expect(failed).toContain('Try again');
  });

  test('a column is the shares of what was held, in the classes’ order; money owed isn’t drawn but is said', () => {
    const d = day('2026-10-01', { cash: -20, 'us-stocks': 120 });
    expect(dayShares(d)).toEqual([{ slot: 'us-stocks', share: 1 }]);
    expect(dayMixText(d)).toBe('120% US stocks, -20% cash');
    expect(dayShares(day('2026-10-01', { bonds: 25, 'us-stocks': 75 }))).toEqual([
      { slot: 'us-stocks', share: 0.75 },
      { slot: 'bonds', share: 0.25 },
    ]);
    const t = text(renderToStaticMarkup(<AllocationHistoryChart days={[d]} currency="USD" answer={{ accounts: [] }} nameOf={(id) => id} />));
    expect(t).toContain("Money owed on a day (cash borrowed on margin, say) isn't drawn");
  });

  test('rounding residue is no share of a day', () => {
    const d = day('2026-10-01', { 'us-stocks': 1_000, cash: 5.551115123125783e-17 });
    expect(dayShares(d)).toEqual([{ slot: 'us-stocks', share: 1 }]);
    expect(dayMixText(d)).toBe('100% US stocks');
  });

  test('asks for the accounts the allocation above shows, with each one’s currency and whether it is kept by hand', () => {
    expect(seriesAccountsOf(institutions)).toEqual([
      { account_id: 'brk', currency: 'USD', manual: false },
      { account_id: 'k', currency: 'USD', manual: false },
      { account_id: 'manual_1', currency: 'USD', manual: true },
    ]);
    // Hidden accounts and accounts that aren't investments aren't in it.
    const more = [inst('Bank', [acct('chk', { type: 'depository' }), acct('ira', { hidden: true })], { item_id: 'x' })];
    expect(seriesAccountsOf(more)).toEqual([]);
  });
});

describe('the card', () => {
  const state = (over: Partial<AllocationState> = {}): AllocationState => {
    const a = alloc();
    return {
      settings: { ...initialListState<AllocationSettings | null>(null), status: 'ready' },
      load: async () => {},
      save: async () => true,
      withSettings: true,
      alloc: a,
      mix: planMix(a),
      ...over,
    };
  };

  test('says what it covers, as of when, in which currency', () => {
    const t = text(renderToStaticMarkup(<AllocationCard allocation={state()} plan={plan()} onSavePlan={async () => true} planEditable institutions={institutions} balancesAsOf="2026-10-09T15:04:00Z" />));
    expect(t).toContain('Allocation');
    expect(t).toMatch(/Your investment accounts, as loaded Oct 9, \d+:04 [AP]M, in USD\./);
    expect(t).toContain('Set a target');
    expect(t).toContain('Over time');
  });

  test('while the settings can’t be read, says the figures leave them out, and pauses editing', () => {
    const settings = { ...initialListState<AllocationSettings | null>(null), status: 'error' as const, error: 'Your saved allocation settings could not be read, so they have been left untouched and editing is paused.' };
    const html = renderToStaticMarkup(
      <AllocationCard allocation={state({ settings, withSettings: false })} plan={plan()} onSavePlan={async () => true} planEditable institutions={institutions} balancesAsOf={null} />
    );
    const t = text(html);
    expect(t).toContain('could not be read');
    expect(t).toContain('The figures below leave out the buckets, splits and target you set until they load.');
    expect(t).not.toContain('Use my allocation');
    expect(html).toMatch(/<button class="plan-edit" disabled="">Set a target<\/button>/);
  });

  test('with no investment account, says so', () => {
    const empty = allocate({ institutions: [], holdings: [], settings: null, currency: 'USD' });
    const t = text(renderToStaticMarkup(<AllocationCard allocation={state({ alloc: empty, mix: planMix(empty) })} plan={plan()} onSavePlan={async () => true} planEditable institutions={[]} balancesAsOf={null} />));
    expect(t).toContain('No investment accounts to show.');
  });
});
