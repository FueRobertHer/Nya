import { describe, expect, test } from 'bun:test';
import { choicesDiffParts, convertedIn, copyNameFor, endAgeOf, endWords, ORDER_WORDS, previewLine, ruleName, ruleSentence, ruleTitle, strategyDiffParts } from '@/components/plan-conversions';
import { fiYearly, pointsText, runSub, runTax, runTitle, sharesNote, stageFoot, stageSentence, stageSources, taxHypothetical, yearRuns } from '@/components/plan-drawdown';
import type { Drawdown, DrawdownStage, DrawdownYear } from '@/lib/fire/drawdown';
import { DEFAULT_TAX_CHOICES, type TaxChoices } from '@/lib/fire/tax-choices';
import { NO_STRATEGY, type Strategy } from '@/lib/fire/tax/rules';

// What How you draw, Compare and a copy say of a rule, and what Tax after you stop and a
// stage say of what the years come to. Neutral: nothing here is better than anything else.

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const fill: Strategy = { order: 'standard', conversions: { kind: 'bracket', top: 0.12 }, convertUntil: null };
const aca: Strategy = { order: 'standard', conversions: { kind: 'aca-then-bracket', top: 0.22 }, convertUntil: null };
const fixed: Strategy = { order: 'standard', conversions: { kind: 'fixed', yearly: 40_000 }, convertUntil: 60 };

describe('a rule’s words', () => {
  test('its short name, as Compare has it', () => {
    expect(ruleName(NO_STRATEGY.conversions, money)).toBe('None');
    expect(ruleName(fill.conversions, money)).toBe('Fill 12%');
    expect(ruleName(aca.conversions, money)).toBe('ACA limit, then 22%');
    expect(ruleName(fixed.conversions, money)).toBe('$40,000 a year');
  });

  test('a title, read out whole, and a copy’s name hold no amount', () => {
    expect(ruleTitle(fixed.conversions)).toBe('A fixed amount');
    expect(ruleTitle(fill.conversions)).toBe('Fill 12%');
    expect(copyNameFor(fixed.conversions, [])).toBe('A fixed amount');
  });

  test('in a line, to the age it runs: its own, or the one by default', () => {
    expect(ruleSentence(NO_STRATEGY, 74, money)).toBe('None');
    expect(ruleSentence(fill, 74, money)).toBe('Fill the 12% bracket, until 74');
    expect(ruleSentence(aca, 74, money)).toBe('Up to the ACA limit, then the 22% bracket, until 74');
    expect(ruleSentence(fixed, 74, money)).toBe('$40,000 a year, until 60');
    expect(ruleSentence(fill, null, money)).toBe('Fill the 12% bracket');
  });

  test('a copy’s name after its rule, with a number where that is taken', () => {
    expect(copyNameFor(fill.conversions, [])).toBe('Fill 12%');
    expect(copyNameFor(fill.conversions, ['Fill 12%'])).toBe('Fill 12% 2');
    expect(copyNameFor(fill.conversions, ['Fill 12%', 'Fill 12% 2'])).toBe('Fill 12% 3');
  });

  test('neither says one is better than another', () => {
    const said = [NO_STRATEGY, fill, aca, fixed].flatMap((s) => [ruleName(s.conversions, money), ruleSentence(s, 74, money)]).join(' ');
    expect(said).not.toMatch(/best|better|recommend|optimal|should/i);
  });
});

describe('where a run ends', () => {
  const run = (over: Partial<Drawdown>) => ({ years: [{ age: 94, conversion: 1_000 }], runsOutAt: null, leftAtEnd: 2_000_000, taxAndHealth: 300_000, ...over }) as Drawdown;

  test('what is left, or the age it runs short', () => {
    expect(endWords(run({}), money)).toBe('$2,000,000');
    expect(endWords(run({ runsOutAt: 88 }), money)).toBe('Runs short at 88');
  });

  test('the age after its last year; none with no years', () => {
    expect(endAgeOf(run({}))).toBe(95);
    expect(endAgeOf(run({ years: [] }))).toBeNull();
  });

  test('what it moved in all', () => {
    expect(convertedIn(run({ years: [{ conversion: 10 }, { conversion: 5 }] as DrawdownYear[] }))).toBe(15);
  });

  test('the preview: the rule, then none', () => {
    const rule = run({ years: [{ age: 60, conversion: 60_400 }, { age: 61, conversion: 0 }] as DrawdownYear[], leftAtEnd: 3_660_060, taxAndHealth: 497_310 });
    const none = run({ years: [{ age: 60, conversion: 0 }] as DrawdownYear[], leftAtEnd: 2_850_840, taxAndHealth: 707_530 });
    expect(previewLine(rule, none, money)).toBe('With this rule: about $60,000 converted by 60, tax and health costs $497,310 in all, and $3,660,060 left at 62 after tax. With none: $707,530 and $2,850,840.');
    expect(previewLine(run({ years: [{ age: 60, conversion: 0 }] as DrawdownYear[], runsOutAt: 88 }), { ...none, runsOutAt: 90 }, money)).toBe('With this rule: nothing converted, tax and health costs $300,000 in all, and it runs short at 88. With none: $707,530 and runs short at 90.');
  });
});

describe('a copy beside your plan', () => {
  test('says each thing that differs, and nothing where nothing does', () => {
    expect(strategyDiffParts(NO_STRATEGY, NO_STRATEGY, 74, money)).toEqual([]);
    expect(strategyDiffParts(NO_STRATEGY, fill, 74, money)).toEqual(['Roth conversions: Fill the 12% bracket, until 74 (your plan: None)']);
    expect(strategyDiffParts(NO_STRATEGY, { ...NO_STRATEGY, order: 'roth-before-deferred' }, 74, money)).toEqual([`Order: ${ORDER_WORDS['roth-before-deferred']} (your plan: ${ORDER_WORDS.standard})`]);
  });

  test('the same words are no difference: the age set that is the age by default', () => {
    expect(strategyDiffParts(fill, { ...fill, convertUntil: 74 }, 74, money)).toEqual([]);
  });

  test('other choices are said once, with no list of them', () => {
    const mine: TaxChoices = DEFAULT_TAX_CHOICES;
    const copy: TaxChoices = { ...DEFAULT_TAX_CHOICES, stateRate: 0.05, strategy: fill };
    expect(choicesDiffParts({ mine, copy: mine, until: 74 }, money)).toEqual([]);
    expect(choicesDiffParts({ mine, copy, until: 74 }, money)).toEqual(['Roth conversions: Fill the 12% bracket, until 74 (your plan: None)', 'Other settings differ']);
  });
});

// Years with only what these words read.
const year = (age: number, over: Record<string, unknown> = {}): DrawdownYear =>
  ({
    age,
    calendarYear: 2026 + age - 50,
    start: { taxable: 0, deferred: 100_000, roth: 0, hsa: 0 },
    end: { taxable: 0, deferred: 90_000, roth: 0, hsa: 0 },
    tax: 1_000,
    short: false,
    shortfall: 0,
    conversion: 0,
    rmd: 0,
    income: { socialSecurity: 0, pension: 0, wages: 0, afterTax: 0 },
    drawn: { taxable: 0, deferred: 40_000, deferred457: 0, penalized: 0, roth: 0, young: 0, earnings: 0, hsaPremiums: 0, hsaTaxed: 0, hsaEarly: 0 },
    law: { penalty: 0 },
    care: { people: [{ status: 'other', irmaaTier: 0 }, { status: 'none', irmaaTier: 0 }], povertyPercent: 300, overLimit: false, underLine: false, lowerDeductibles: false },
    ...over,
  }) as unknown as DrawdownYear;
const stage = (rows: readonly DrawdownYear[], over: Partial<DrawdownStage> = {}): DrawdownStage =>
  ({ key: 'before-60', from: rows[0].age, to: rows[rows.length - 1].age, first: 0, last: rows.length, yearlyTax: 1_000, converted: 0, sources: { taxable: 0, deferred: 1, roth: 0, hsa: 0, rmd: 0, socialSecurity: 0, pensions: 0 }, ...over }) as DrawdownStage;

describe('what a stage says of its conversions', () => {
  test('about how much a year, to the nearest thousand', () => {
    const rows = [year(50, { conversion: 56_400 }), year(51, { conversion: 55_800 })];
    expect(stageSources(stage(rows, { converted: 112_200 }), rows, money)).toBe('From tax-deferred · converting about $56,000 a year');
  });

  test('that it stays under the ACA limit, where a year on it reached near it', () => {
    const on = { people: [{ status: 'aca', irmaaTier: 0 }, { status: 'none', irmaaTier: 0 }], povertyPercent: 398, overLimit: false, underLine: false, lowerDeductibles: false };
    const rows = [year(50, { conversion: 30_000, care: on })];
    expect(stageSources(stage(rows, { converted: 30_000 }), rows, money)).toBe('From tax-deferred · converting about $30,000 a year, under the ACA limit');
  });

  test('the age it emptied tax-deferred', () => {
    const rows = [year(50, { conversion: 90_000 }), year(51, { conversion: 40_000, end: { taxable: 0, deferred: 0, roth: 100, hsa: 0 } })];
    expect(stageSources(stage(rows, { converted: 130_000 }), rows, money)).toBe('From tax-deferred · tax-deferred converted by 51');
  });

  test('nothing, with no conversions', () => {
    const rows = [year(50)];
    expect(stageSources(stage(rows), rows, money)).toBe('From tax-deferred');
  });
});

describe('a stage’s sentence and its foot', () => {
  const drawing = (over: Record<string, number>) => ({ taxable: 0, deferred: 0, deferred457: 0, penalized: 0, roth: 0, young: 0, earnings: 0, hsaPremiums: 0, hsaTaxed: 0, hsaEarly: 0, ...over });

  test('Roth contributions running out are named, with what follows', () => {
    const rows = [
      year(50, { drawn: drawing({ roth: 40_000 }) }),
      year(51, { drawn: drawing({ roth: 20_000, penalized: 20_000 }), law: { penalty: 2_000 } }),
      year(52, { drawn: drawing({ penalized: 40_000 }), law: { penalty: 4_000 } }),
    ];
    expect(stageSentence(stage(rows), rows, money)).toBe('Roth contributions run out at 51, so 2 years draw tax-deferred money early, with $6,000 in penalties.');
  });

  test('taxable money and Roth contributions together', () => {
    const rows = [
      year(50, { start: { taxable: 40_000, deferred: 100, roth: 0, hsa: 0 }, end: { taxable: 0, deferred: 100, roth: 0, hsa: 0 }, drawn: drawing({ taxable: 40_000, roth: 1 }) }),
      year(51, { drawn: drawing({ penalized: 40_000 }), law: { penalty: 4_000 } }),
    ];
    expect(stageSentence(stage(rows), rows, money)).toBe('Taxable money runs out at 50 and Roth contributions at 50, so 1 year draws tax-deferred money early, with $4,000 in penalties.');
  });

  test('its foot: from when income and coverage change', () => {
    const rows = [year(50), year(51, { start: { taxable: 100, deferred: 100, roth: 0, hsa: 0 }, end: { taxable: 0, deferred: 100, roth: 0, hsa: 0 } }), year(52, { law: { penalty: 1_000 } })];
    expect(stageFoot(stage(rows), rows)).toBe('From 51 what can be reached without a penalty is going, so these years’ income, and the coverage it pays for, change.');
  });

  test('no foot where nothing is drawn early', () => {
    const rows = [year(50), year(51)];
    expect(stageFoot(stage(rows), rows)).toBeNull();
  });
});

describe('years that read the same', () => {
  const spans = (rows: readonly DrawdownYear[]) => yearRuns(rows).map((r) => [rows[r.first].age, rows[r.last - 1].age]);

  test('three up are one row; two stay two', () => {
    expect(spans([year(50), year(51), year(52), year(53)])).toEqual([[50, 53]]);
    expect(spans([year(50), year(51)])).toEqual([
      [50, 50],
      [51, 51],
    ]);
  });

  test('a year that reads otherwise breaks the run', () => {
    expect(spans([year(50), year(51), year(52), year(53, { conversion: 5_000 }), year(54), year(55), year(56)])).toEqual([
      [50, 52],
      [53, 53],
      [54, 56],
    ]);
  });

  test('a penalty’s amount keeps its year apart, with amounts hidden too', () => {
    const rows = [year(50, { law: { penalty: 1_000 } }), year(51, { law: { penalty: 2_000 } }), year(52, { law: { penalty: 3_000 } })];
    expect(spans(rows)).toEqual([
      [50, 50],
      [51, 51],
      [52, 52],
    ]);
  });

  test('a run’s row says its years, what they share, and how they range', () => {
    const on = (povertyPercent: number) => ({ people: [{ status: 'aca', irmaaTier: 0 }, { status: 'none', irmaaTier: 0 }], povertyPercent, overLimit: false, underLine: false, lowerDeductibles: false });
    const rows = [year(50, { care: on(200), tax: 900 }), year(51, { care: on(210), tax: 1_000 }), year(52, { care: on(205), tax: 1_100 })];
    expect(runTitle(rows)).toBe('50 to 52 · 2026 to 2028');
    expect(runSub(rows)).toBe('From tax-deferred · 200% to 210% of the poverty line');
    expect(runTax(rows, money)).toBe('$900 to $1,100');
    expect(runTax([year(50), year(51)], money)).toBe('$1,000');
  });
});

describe('Tax after you stop', () => {
  test('what the number’s tax and health come to a year', () => {
    expect(fiYearly({ t: 0.1, h: 6_000, spending: 60_000, paid: 12_000 })).toBeCloseTo((48_000 + 6_000) / 0.9, 6);
    expect(fiYearly({ t: 0, h: 0, spending: 5_000, paid: 12_000 })).toBe(0);
  });

  test('a small back and forth isn’t said; a large one is, and an unknown mix', () => {
    expect(sharesNote({ settled: true, gap: 0, noMix: false }, money)).toEqual([]);
    expect(sharesNote({ settled: false, gap: 900, noMix: false }, money)).toEqual([]);
    expect(sharesNote({ settled: false, gap: 4_000, noMix: false }, money)[0]).toContain('$4,000 apart, and this takes the higher');
    expect(sharesNote({ settled: true, gap: 0, noMix: true }, money)[0]).toContain('it starts with today’s shares');
  });

  test('its last line names what it rests on', () => {
    const line = (over: Partial<Parameters<typeof taxHypothetical>[0]>) => taxHypothetical({ lawYear: 2026, state: null, stateRate: 0, stateTaxes: null, converts: false, realReturn: 0.05, healthGrowth: 0.021, ...over });
    expect(line({})).toContain('2026 federal tax law');
    expect(line({})).toContain('no state tax counted');
    expect(line({})).toContain('no conversions');
    expect(line({ converts: true })).toContain('the conversion rule you picked');
    expect(line({ state: 'NV', stateTaxes: false })).toContain('Nevada with no income tax');
    expect(line({ state: 'CO', stateRate: 0.044, stateTaxes: true })).toContain('Colorado at 4.4%');
  });

  test('points of growth, one or many', () => {
    expect(pointsText(0.021)).toBe('2.1 points');
    expect(pointsText(0.01)).toBe('1 point');
  });
});
