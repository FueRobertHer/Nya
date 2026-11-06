import { describe, expect, test } from 'bun:test';
import { runDrawdown, type Drawdown, type DrawdownInput, type DrawdownYear } from '@/lib/fire/drawdown';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { MixSlot } from '@/lib/fire/tax/mix';
import type { IncomeRow } from '@/lib/fire/compile';
import { DEFAULT_TAX_CHOICES } from '@/lib/fire/tax-choices';
import { DEFAULT_TAX_FACTS } from '@/lib/fire/tax-facts';
import { markRows } from '@/components/DrawdownChart';
import { wholeMoney } from '@/components/plan-text';
import { assumptionsWorked, EARLY_ACCESS_WHY, healthPace, STAGE_TAX_NOTE, stagePenalties, stagePercentLine, detailLines, healthSub, honestyNotes, householdLine, householdNotes, lawLabel, onAca, fiLines, stageHelper, stageSentence, stageSources, stageTitle, survivorLine, taxLine, yearBadges, yearRuns, yearHelper, yearSections, yearSub, yearTitle, yearValueLabel, type YearContext } from '@/components/plan-drawdown';

// What Year by year says, on real years: the stages, a stage's rows and a year's sheet.

const slot = (owner: MixSlot['owner'], bucket: MixSlot['bucket'], value: number, more: Partial<MixSlot> = {}): MixSlot => ({ owner, bucket, value, basis: 0, reachable: 0, ...more });
const income = (over: Partial<IncomeRow>): IncomeRow => ({ amount: 0, fromYear: 0, inflationAdjusted: true, kind: 'social-security', owner: 'you', beforeTax: true, gross: 0, ...over });

const COUPLE: DrawdownInput = {
  startAge: 50,
  years: 45,
  today: { age: 41, partnerAge: 40, calendarYear: 2026 },
  filing: 'joint',
  dependents: [],
  rmdAges: { you: 75, partner: 75 },
  slots: [slot('you', 'taxable', 420_000, { basis: 280_000 }), slot('you', 'tax-deferred', 700_000), slot('partner', 'tax-deferred', 200_000), slot('you', 'roth', 120_000, { reachable: 70_000 }), slot('you', 'hsa', 35_000)],
  share457: { you: 0, partner: 0 },
  spending: 64_000,
  rule: (rate) => ({ kind: 'constant', rate }),
  realReturn: 0.05,
  inflation: 0.03,
  taxableYield: 0.02,
  oneOffs: [],
  lower: [],
  income: [income({ fromYear: 17, gross: 30_000 }), income({ fromYear: 18, gross: 18_000, owner: 'partner' })],
  health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
  state: 'NV',
  stateRate: 0,
  law: LAW_2026,
};

const run = (over: Partial<DrawdownInput> = {}): Drawdown => {
  const d = runDrawdown({ ...COUPLE, ...over });
  if ('failed' in d) throw new Error(d.failed);
  return d;
};

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const CONTEXT: YearContext = { money, realReturn: 0.05, healthGrowth: 0.021, acaLaw: '2026', lawYear: 2026, state: 'NV', stateTaxes: false, rmdAge: 75, gainsZeroTo: 98_900, medicaid: { through: null } };
const yearAt = (d: Drawdown, age: number): DrawdownYear => d.years.find((y) => y.age === age)!;
const titles = (y: DrawdownYear, c = CONTEXT) => yearSections(y, c).map((s) => s.title);
const lines = (y: DrawdownYear, title: string, c = CONTEXT) => yearSections(y, c).find((s) => s.title === title)!;

describe('the stages', () => {
  test('each says its ages and what it is', () => {
    const d = run();
    expect(d.stages.map(stageTitle)).toEqual(['50 to 59 · before 59½', '60 to 64 · before Medicare', '65 to 74 · before required withdrawals', '75 to 94 · required withdrawal years']);
  });

  test('a stage of one age says the one', () => {
    expect(stageTitle({ key: 'before-65', from: 64, to: 64 })).toBe('64 · before Medicare');
  });

  test('where a stage’s money comes from, and when income starts within it', () => {
    const d = run();
    const late = d.stages.find((s) => s.key === 'before-rmd')!;
    expect(stageSources(late, d.years, money)).toContain('Social Security from 67');
    expect(stageSources(d.stages[0], d.years, money)).toStartWith('From ');
  });

  test('RMD years with nothing left in tax-deferred say there is no RMD', () => {
    const d = run({ slots: [slot('you', 'roth', 2_000_000, { reachable: 2_000_000 })] });
    expect(stageSources(d.stages.find((s) => s.key === 'rmd')!, d.years, money)).toContain('Nothing left in tax-deferred, so none required');
  });

  test('a stage says what it is, and RMD spelled out once', () => {
    expect(stageHelper({ key: 'rmd', to: 94 }, 75)).toContain('required minimum distribution (RMD)');
    expect(stageHelper({ key: 'before-rmd', to: 74 }, 75)).toContain('start at 75');
  });

  test('money drawn early says what it costs, in the stage it happens', () => {
    const d = run({ slots: [slot('you', 'taxable', 150_000, { basis: 150_000 }), slot('you', 'tax-deferred', 1_600_000)] });
    const first = d.stages[0];
    const said = stageSentence(first, d.years, money)!;
    expect(said).toContain('Taxable money runs out at');
    expect(said).toMatch(/draws? tax-deferred money early, with \$[\d,]+ in penalties/);
  });

  test('a partner under 59½ draws early after you have passed it: the sentence names what they drew', () => {
    const d = run({ startAge: 62, years: 8, today: { age: 62, partnerAge: 50, calendarYear: 2026 }, slots: [slot('partner', 'roth', 700_000)], income: [] });
    const stage = d.stages[0];
    expect(stage.key).toBe('before-65');
    expect(stageSentence(stage, d.years, money)).toMatch(/draws? Roth money early, with \$[\d,]+ in penalties/);
    // And what the stage says at its head is true of them as well.
    expect(stageHelper(stage, 75)).toContain('From 59½');
  });

  test('a stage with nothing to say says nothing', () => {
    const d = run({ slots: [slot('you', 'roth', 3_000_000, { reachable: 3_000_000 })], income: [] });
    expect(stageSentence(d.stages[2], d.years, money)).toBeNull();
  });
});

describe('a year’s row', () => {
  test('says where its money comes from, and its income against the poverty line on the ACA', () => {
    const y = yearAt(run(), 51);
    expect(y.care.people[0].status).not.toBe('medicare');
    expect(yearSub(y)).toMatch(/^From .* · \d+% of the poverty line$/);
    expect(yearTitle(y)).toBe(`Age 51 · ${y.calendarYear}`);
  });

  test('after 65 it doesn’t speak of the ACA', () => {
    const y = yearAt(run(), 70);
    expect(onAca(y)).toBe(false);
    expect(yearSub(y)).not.toContain('poverty line');
  });

  test('a penalty is a neutral badge with its amount, and the row’s figure says it holds one', () => {
    const d = run({ slots: [slot('you', 'tax-deferred', 1_800_000)] });
    const y = d.years.find((x) => x.law.penalty > 0)!;
    expect(yearBadges(y, money).join()).toMatch(/Penalty \$[\d,]+/);
    expect(yearValueLabel(y)).toBe('tax and penalty');
    expect(yearValueLabel(yearAt(d, 70))).toBe('tax');
  });

  test('no ACA badge for someone covered another way (D10)', () => {
    const d = run({ health: { ...COUPLE.health, coverage: { kind: 'other', yearly: 9_000 } }, slots: [slot('you', 'tax-deferred', 3_000_000), slot('you', 'taxable', 60_000, { basis: 60_000 })] });
    for (const y of d.years) {
      expect(onAca(y)).toBe(false);
      expect(yearBadges(y, money).filter((b) => /ACA|Medicaid|deductibles/.test(b))).toEqual([]);
    }
  });

  test('a year over the ACA limit and one under the line say so', () => {
    const over = run({ spending: 200_000, slots: [slot('you', 'tax-deferred', 4_000_000), slot('you', 'taxable', 3_000_000, { basis: 300_000 })] });
    expect(yearBadges(over.years[0], money)).toContain('Over the ACA limit');
    const under = run({ spending: 6_000, income: [], slots: [slot('you', 'roth', 3_000_000, { reachable: 3_000_000 })] });
    expect(yearBadges(under.years[0], money)).toContain('Under the Medicaid line');
  });
});

describe('a year’s sheet', () => {
  test('has its five sections, in order', () => {
    expect(titles(yearAt(run(), 51))).toEqual(['Where the money comes from', 'What it pays for', 'Income the law counts', 'How the tax is worked out', 'Health coverage']);
  });

  test('its helper says who is covered how, the growth, the law, and that it is hypothetical', () => {
    const h = yearHelper(yearAt(run({ slots: [slot('you', 'taxable', 3_000_000, { basis: 2_000_000 })], taxableYield: 0.01 }), 51), CONTEXT);
    expect(h).toContain('Your partner is 50.');
    expect(h).toContain('Both on ACA coverage.');
    expect(h).toContain('Assumes steady 5% growth after inflation, health costs rising 2.1 points a year faster than prices, and 2026 tax law. Hypothetical, not tax advice.');
  });

  test('a state with no income tax is named as having none', () => {
    const pays = lines(yearAt(run(), 51), 'What it pays for').lines;
    expect(pays.map((l) => l.label)).toContain('Nevada: no income tax');
    const taxed = lines(yearAt(run({ state: 'CA', stateRate: 0.05 }), 51), 'What it pays for', { ...CONTEXT, state: 'CA', stateTaxes: true });
    expect(taxed.lines.map((l) => l.label)).toContain('California income tax');
  });

  test('the meter and its limit only on the ACA, and no limit under enhanced credits', () => {
    const d = run();
    expect(lines(yearAt(d, 51), 'Income the law counts').meter?.limitLabel).toMatch(/^Limit 400%, \$[\d,]+$/);
    expect(lines(yearAt(d, 51), 'Income the law counts', { ...CONTEXT, acaLaw: 'enhanced' }).meter?.limit).toBeNull();
    expect(lines(yearAt(d, 70), 'Income the law counts').meter).toBeUndefined();
  });

  test('the meter counts the family it measures, and the limit is in dollars', () => {
    const y = yearAt(run(), 51);
    const meter = lines(y, 'Income the law counts').meter!;
    expect(meter.label).toMatch(/^\d+% of the poverty line, for 2 people$/);
    expect(meter.limitLabel).toMatch(/^Limit 400%, \$[\d,]+$/);
    const withChild = yearAt(run({ dependents: [{ untilAge: 60 }] }), 51);
    expect(lines(withChild, 'Income the law counts').meter!.label).toMatch(/, for 3 people$/);
  });

  test('the benchmark says whose it is', () => {
    const labels = (y: DrawdownYear) => yearSections(y, CONTEXT).flatMap((s) => s.lines.map((l) => l.label));
    const d = run();
    const both = d.years.find((y) => y.care.benchmark > 0 && y.age < 65)!;
    expect(labels(both)).toContain(`Benchmark plan for ages ${both.age} and ${both.partnerAge}, full price`);
    // You at Medicare, your partner still on it.
    expect(labels(yearAt(d, 65))).toContain('Benchmark plan for age 64, full price');
  });

  test('gains at 0% say up to where, in dollars', () => {
    const why = lines(yearAt(run(), 51), 'How the tax is worked out').why!;
    expect(why.text).toContain('$98,900');
  });

  test('gains at 0%: the year’s taxable income is after the whole deduction, which gains can use', () => {
    const y = yearAt(run(), 51);
    // Ordinary income under the deduction: $1,000 of it is left for the gains.
    const gainsYear: DrawdownYear = { ...y, income: { ...y.income, qualified: 0 }, drawn: { ...y.drawn, taxable: 60_000, gain: 60_000 }, law: { ...y.law, agi: 75_000, deduction: 16_000, ordinaryTaxable: 0, gainsTax: 0, penalty: 0 } };
    expect(lines(gainsYear, 'How the tax is worked out').why!.text).toContain('They’re taxed at 0% while taxable income stays under $98,900, and this year’s is $59,000.');
    // Over that line and still untaxed (a loss carried in), it says nothing it can't explain.
    expect(lines(gainsYear, 'How the tax is worked out', { ...CONTEXT, gainsZeroTo: 49_450 }).why).toBeUndefined();
  });

  test('money from a Roth conversion under five years old is named as that, and in why there is a penalty', () => {
    const y = yearAt(run(), 51);
    const early: DrawdownYear = { ...y, drawn: { ...y.drawn, young: 20_000, gain: 0, taxable: 0 }, income: { ...y.income, qualified: 0 }, law: { ...y.law, penalty: 2_000, gainsTax: 0 } };
    expect(lines(early, 'Where the money comes from').lines.map((l) => l.label)).toContain('Roth conversions under five years old');
    expect(lines(early, 'How the tax is worked out').why!.text).toContain('a Roth conversion under five years old');
  });

  test('what is of ordinary income sits under it, not under gains', () => {
    const y = yearAt(run(), 51);
    const labels = lines({ ...y, conversion: 20_000, drawn: { ...y.drawn, gain: 5_000 }, law: { ...y.law, taxableSocialSecurity: 1_000 } }, 'Income the law counts').lines.map((l) => l.label);
    expect(labels.slice(0, 4)).toEqual(['Ordinary income', 'of it Social Security', 'of it converted to Roth', 'Gains and qualified dividends']);
  });

  test('a conversion is in the year’s income and in what it says it did', () => {
    const y = yearAt(run({ strategy: { order: 'standard', conversions: { kind: 'bracket', top: 0.12 }, convertUntil: null } }), 51);
    expect(y.conversion).toBeGreaterThan(0);
    const all = yearSections(y, CONTEXT).flatMap((s) => s.lines.map((l) => l.label));
    expect(all.some((l) => l.includes('converted to Roth') || l === 'Converted to Roth')).toBe(true);
  });

  test('its lines add up to what the year says it paid', () => {
    const y = yearAt(run(), 51);
    const parse = (v: string) => Number(v.replace(/[^\d.-]/g, ''));
    const paid = lines(y, 'What it pays for').lines.filter((l) => !l.sum).reduce((n, l) => n + parse(l.value), 0);
    expect(Math.abs(paid - (y.living + y.oneOffs + y.health + y.tax + y.surplus))).toBeLessThan(8);
  });

  test('RMD years show the distribution, under its full name', () => {
    const y = run({ slots: [slot('you', 'tax-deferred', 3_500_000)] }).years.find((x) => x.rmd > 0)!;
    expect(lines(y, 'Where the money comes from').lines.map((l) => l.label)).toContain('Required minimum distribution (RMD)');
  });

  test('a Why? says why a penalty, and gains at 0%', () => {
    const d = run({ slots: [slot('you', 'tax-deferred', 1_800_000)] });
    expect(lines(d.years.find((x) => x.law.penalty > 0)!, 'How the tax is worked out').why?.label).toBe('Why a penalty?');
    expect(lines(yearAt(run(), 51), 'How the tax is worked out').why?.label).toBe('Why are the gains taxed at 0%?');
  });
});

describe('what a detailed plan says it can’t know', () => {
  const none = { today: null, facts: DEFAULT_TAX_FACTS, choices: DEFAULT_TAX_CHOICES, items: [], partner: false, law: null, unansweredPaid: null, money };
  const account = (basisFrom: string) => ({ account_id: 'a', basisFrom }) as never;
  const kinds = (args: Partial<Parameters<typeof honestyNotes>[0]>) => honestyNotes({ ...none, ...args }).map((n) => n.kind);

  test('no state and no coverage, always asked until said', () => {
    expect(kinds({})).toEqual(['no household', 'health not set']);
    const set = { ...DEFAULT_TAX_CHOICES, state: 'NV' as const, health: { ...DEFAULT_TAX_CHOICES.health, beforeMedicare: { kind: 'other' as const, yearly: 5_000 } } };
    expect(kinds({ choices: set })).toEqual([]);
  });

  test('an account with no bucket counts as tax-deferred, and says so', () => {
    const [note] = honestyNotes({ ...none, today: { groups: [{ bucket: 'unclassified', total: 2, accounts: [account('none'), account('none')] }], roth: [] } });
    expect(note.text).toContain('2 accounts have no tax bucket, counted as tax-deferred.');
    expect(note.level).toBe('caution');
  });

  test('a taxable account with no basis is all gain; one with some is not said', () => {
    const notes = honestyNotes({ ...none, today: { groups: [{ bucket: 'taxable', total: 2, accounts: [account('none'), account('partial')] }], roth: [] } });
    expect(notes[0].text).toContain('1 taxable account has no cost basis');
  });

  test('a Roth put-in not given, for whom', () => {
    const roth = (...owners: string[]) => ({ bucket: 'roth', total: owners.length, accounts: owners.map((owner) => ({ owner })) }) as never;
    const said = (groups: never[]) => honestyNotes({ ...none, today: { groups, roth: [{ owner: 'you', amount: 5 }, { owner: 'partner', amount: null }] } }).filter((n) => n.text.includes('Roth'));
    expect(said([roth('you', 'partner')])[0].text).toContain('your partner’s Roth');
    // Nothing to say of a Roth they don't have.
    expect(said([roth('you')])).toEqual([]);
    expect(said([roth('you', 'partner')])[0].text).toContain('none of it counts as reachable before 59½');
  });

  test('income given after tax is named, part-time apart', () => {
    const item = (label: string, kind: string, beforeTax: boolean) => ({ label, kind, beforeTax }) as never;
    const notes = honestyNotes({ ...none, items: [item('Pension', 'pension', false), item('Work', 'part-time', false), item('SS', 'social-security', true)] });
    expect(notes[0].text).toContain('Pension is given after tax');
    expect(notes[1].text).toContain('Work is given after tax, which may hide a year over the ACA limit.');
  });

  test('coverage in spending not answered, and a law year behind', () => {
    const notes = honestyNotes({ ...none, unansweredPaid: { name: 'Health insurance', amount: 9_600 }, law: { year: 2027, behind: true } });
    expect(notes.map((n) => n.kind)).toContain('coverage counted twice');
    expect(notes.map((n) => n.text).join()).toContain('Your spending has $9,600 a year in Health insurance.');
    expect(notes.map((n) => n.text).join()).toContain('Uses 2027 tax law, the newest Nya has.');
  });

  test('Household’s own: Washington’s gains tax, and dependents', () => {
    const choices = { ...DEFAULT_TAX_CHOICES, state: 'WA' as const };
    const notes = householdNotes({ facts: { ...DEFAULT_TAX_FACTS, dependents: [{ id: 'k', untilAge: 60 }] }, choices });
    expect(notes.map((n) => n.level)).toEqual(['info', 'caution']);
    expect(notes[0].text).toContain('capital gains only');
    expect(notes[1].text).toContain('The child tax credit and head of household aren’t counted.');
  });

  test('the Assumptions row: its rate and growth, what prices and health do, no tax of its own', () => {
    const plan = { withdrawalRate: 0.04, realReturn: 0.05, partTimeIncome: 0 };
    expect(assumptionsWorked(plan, { inflation: 0.03 }, 0.021, money)).toBe('4% withdrawal · 5% growth · 3% inflation · health costs 2.1 points above inflation');
    expect(assumptionsWorked({ ...plan, partTimeIncome: 12_000 }, { inflation: 0.03 }, 0.021, money)).toContain('$12,000 part-time');
    expect(assumptionsWorked(plan, { inflation: 0.03 }, 0.021, money)).not.toContain('tax');
  });

  test('the small lines', () => {
    expect(lawLabel(2026)).toBe('Hypothetical, 2026 tax law. Not tax advice.');
    expect(taxLine(0.034)).toBe('Tax is one rate, 3.4%, from the steady years below.');
    expect(survivorLine(95)).toBe('Assumes you both live to 95. A survivor files single, at higher rates.');
    expect(householdLine({ filing: 'joint' }, { state: 'NV' })).toBe('joint · Nevada');
    expect(householdLine({ filing: null }, { state: null })).toBe('single · no state yet');
    expect(healthSub(DEFAULT_TAX_CHOICES, true)).toContain('Not set');
    const onTheAca = { ...DEFAULT_TAX_CHOICES, health: { ...DEFAULT_TAX_CHOICES.health, beforeMedicare: { kind: 'aca' as const, adult: 1, quotedAge: 50, child: null } } };
    expect(healthSub(onTheAca, true)).toBe('ACA before 65, then Medicare · in your FI number');
    expect(healthSub(onTheAca, false)).toBe('ACA before 65, then Medicare');
  });

  test('a plan folded to single, and one that held spending at zero, say so', () => {
    const d = run({ filing: null });
    expect(detailLines({ notes: ['no-mix'], start: d })).toContain('Filing as single, your partner’s accounts and income are counted as yours.');
    expect(detailLines({ notes: ['no-mix'], start: d })).toContain('Your accounts’ mix couldn’t be projected to the start, so it starts with today’s shares.');
  });
});

describe('the chart’s marks', () => {
  test('a name goes on the first row it clears, so none is lost', () => {
    expect(markRows([{ x: 10, label: '59½' }, { x: 16, label: '65' }, { x: 200, label: 'RMD age 75' }])).toEqual([0, 1, 0]);
  });
});

describe('a year’s two money sections', () => {
  const exact = (n: number) => n.toFixed(2);
  const money2 = { ...CONTEXT, money: exact };
  const parse = (v: string) => Number(v.replace(/[^\d.-]/g, ''));
  const addUp = (y: DrawdownYear, title: string) => {
    const s = lines(y, title, money2).lines;
    return { items: s.filter((l) => !l.sum && !l.part).reduce((n, l) => n + parse(l.value), 0), total: parse(s.find((l) => l.sum)!.value) };
  };
  const fillBracket = { order: 'standard', conversions: { kind: 'bracket', top: 0.12 }, convertUntil: null } as const;
  const plans: Partial<DrawdownInput>[] = [
    {},
    { spending: 30_000 },
    { spending: 90_000 },
    { spending: 160_000 },
    { state: 'CA', stateRate: 0.05 },
    { strategy: fillBracket },
    { strategy: fillBracket, spending: 110_000 },
    { filing: null },
    { slots: [slot('you', 'roth', 2_000_000, { reachable: 2_000_000 })] },
    { slots: [slot('you', 'tax-deferred', 3_500_000)] },
    { slots: [slot('you', 'taxable', 1_500_000, { basis: 300_000 }), slot('you', 'tax-deferred', 1_500_000)], strategy: fillBracket },
  ];

  test('hold the same total, and their lines come to it, on every year of many plans', () => {
    for (const over of plans) {
      for (const y of run(over).years) {
        const from = addUp(y, 'Where the money comes from');
        const to = addUp(y, 'What it pays for');
        expect(Math.abs(from.total - to.total)).toBeLessThan(0.02);
        expect(Math.abs(from.items - from.total)).toBeLessThan(0.02);
        expect(Math.abs(to.items - to.total)).toBeLessThan(0.02);
      }
    }
  });

  test('just under the 12% bracket’s top with a gain, where the return’s two worksheets part, federal tax is what’s left of the year’s', () => {
    const inBand = plans.flatMap((over) => run(over).years).filter((y) => y.drawn.gain > 0 && y.law.ordinaryTaxable >= 98_900 && y.law.ordinaryTaxable <= 100_800);
    expect(inBand.length).toBeGreaterThan(0);
    for (const y of inBand) expect(Math.abs(addUp(y, 'Where the money comes from').total - addUp(y, 'What it pays for').total)).toBeLessThan(0.02);
  });

  test('a conversion funds nothing: it has its own section, and counts as income below', () => {
    const y = yearAt(run({ strategy: fillBracket }), 51);
    expect(y.conversion).toBeGreaterThan(0);
    for (const t of ['Where the money comes from', 'What it pays for']) expect(lines(y, t).lines.map((l) => l.label)).not.toContain('Converted to Roth');
    const moved = lines(y, 'Moved, not spent');
    expect(moved.lines.map((l) => l.label)).toEqual(['Converted to Roth']);
    expect(moved.note).toContain('None of it is spent');
    expect(lines(y, 'Income the law counts').lines.find((l) => l.label === 'of it converted to Roth')?.part).toBe(true);
  });

  test('Roth drawn says no penalty, before 60 and after', () => {
    const d = run({ slots: [slot('you', 'roth', 2_000_000, { reachable: 2_000_000 })] });
    for (const age of [55, 70]) expect(lines(yearAt(d, age), 'Where the money comes from').lines.map((l) => l.label)).toContain('Drawn from Roth, no penalty');
  });
});

describe('a year on the ACA, by what the state does', () => {
  const y = yearAt(run(), 51);
  const person = (status: string) => ({ ...y.care.people[0], status }) as DrawdownYear['care']['people'][0];
  const withCare = (over: Partial<DrawdownYear['care']>, partnerAge: number | null = y.partnerAge): DrawdownYear => ({ ...y, partnerAge, care: { ...y.care, ...over } });
  const note = (year: DrawdownYear, c = CONTEXT) => lines(year, 'Health coverage', c).note ?? '';

  test('Medicaid covering someone says so, by who, and has its own badge', () => {
    const both = withCare({ people: [person('medicaid'), person('medicaid')] });
    expect(yearBadges(both, money)).toContain('On Medicaid');
    expect(note(both)).toContain('Medicaid covers you both, with no premium.');
    expect(note(withCare({ people: [person('medicaid'), person('aca')] }))).toContain('Medicaid covers you, with no premium.');
    expect(note(withCare({ people: [person('aca'), person('medicaid')] }))).toContain('Medicaid covers your partner, with no premium.');
    // Your partner on it, you on Medicare: not the two of you.
    expect(note(withCare({ people: [person('medicare'), person('medicaid')] }))).toContain('Medicaid covers your partner, with no premium.');
    expect(note(withCare({ people: [person('medicaid'), person('none')] }, null))).toContain('Medicaid covers you, with no premium.');
  });

  test('a year on Medicaid doesn’t run on with those around it', () => {
    const aca = withCare({ people: [person('aca'), person('aca')] });
    const covered = withCare({ people: [person('medicaid'), person('medicaid')] });
    expect(yearRuns([aca, aca, covered, aca, aca]).length).toBe(5);
    expect(yearRuns([aca, aca, aca]).length).toBe(1);
  });

  test('under the line, where the state has no Medicaid for adults, it never says there is a line', () => {
    const under = withCare({ underLine: true, people: [person('under-line'), person('under-line')] });
    const none = { ...CONTEXT, medicaid: null };
    expect(yearBadges(under, money, null)).toContain('Under 100%, no credit');
    expect(yearBadges(under, money, null)).not.toContain('Under the Medicaid line');
    expect(note(under, none)).toContain('Under 100% of the poverty line there is no credit, and Nevada has no Medicaid for most adults, so coverage is counted at full price.');
    expect(yearBadges(under, money, { through: null })).toContain('Under the Medicaid line');
    expect(note(under)).toContain('Under the Medicaid line with no credit, so coverage is counted at full price.');
    // A state's line that ended by this year.
    expect(yearBadges(under, money, { through: y.calendarYear - 1 })).toContain('Under 100%, no credit');
  });

  test('only a dependent under the line, counted at full price by choice: nothing of the adults’ credit is denied', () => {
    const kids = withCare({ underLine: true, people: [person('aca'), person('aca')], dependents: { ...y.care.dependents, status: 'under-line' } });
    expect(yearBadges(kids, money, null)).toContain('Dependents at full price');
    expect(yearBadges(kids, money, null)).not.toContain('Under 100%, no credit');
    expect(yearBadges(kids, money, { through: null })).not.toContain('Under the Medicaid line');
    expect(note(kids, { ...CONTEXT, medicaid: null })).toContain('Your dependents are under Medicaid’s line for children, and counted at full price, as you chose.');
    expect(note(kids, { ...CONTEXT, medicaid: null })).not.toContain('Under 100% of the poverty line');
  });

  test('years either side of the end of a state’s line don’t run together', () => {
    const under = (calendarYear: number): DrawdownYear => ({ ...withCare({ underLine: true, people: [person('under-line'), person('under-line')] }), calendarYear });
    const rows = [2026, 2027, 2028, 2029].map(under);
    expect(yearRuns(rows, { through: 2026 }).map((r) => [r.first, r.last])).toEqual([
      [0, 1],
      [1, 4],
    ]);
    expect(yearRuns(rows, { through: null }).length).toBe(1);
  });

  test('the income lines come to ACA income, with the Social Security the law doesn’t tax', () => {
    const y2: DrawdownYear = { ...withCare({ people: [person('aca'), person('aca')] }), law: { ...y.law, agi: 27_000, magiAca: 47_000 } };
    const l = lines(y2, 'Income the law counts').lines;
    expect(l.find((x) => x.label === 'Social Security that isn’t taxed, which the ACA counts')?.value).toBe(money(20_000));
    const onMedicare: DrawdownYear = { ...withCare({ people: [person('medicare'), person('medicare')] }), law: { ...y.law, agi: 27_000, magiAca: 47_000 } };
    expect(lines(onMedicare, 'Income the law counts').lines.map((x) => x.label)).not.toContain('Social Security that isn’t taxed, which the ACA counts');
  });

  test('the credit is a minus, and your share is projected only where the schedule moves', () => {
    const helped = [40_000, 50_000, 60_000].flatMap((spending) => run({ spending }).years).find((x) => x.calendarYear > 2026 && x.care.figure > 0 && x.care.people.some((p) => p.credit > 0))!;
    const real = { ...CONTEXT, money: (n: number) => wholeMoney(n, 'USD') };
    expect(lines(helped, 'Health coverage', real).lines.find((l) => l.label === 'Premium tax credit')?.value).toMatch(/^−\$[\d,]+$/);
    expect(note(helped)).toContain(`, as projected to ${helped.calendarYear}.`);
    expect(note(helped, { ...CONTEXT, acaLaw: 'enhanced' })).not.toContain('as projected');
    expect(note({ ...helped, calendarYear: 2026 })).not.toContain('as projected');
    const noCredit: DrawdownYear = { ...helped, care: { ...helped.care, people: helped.care.people.map((p) => ({ ...p, credit: 0 })) as DrawdownYear['care']['people'], dependents: { ...helped.care.dependents, credit: 0 } } };
    expect(lines(noCredit, 'Health coverage').lines.map((l) => l.label)).not.toContain('Premium tax credit');
    expect(note(noCredit)).toContain('comes to more than the benchmark plan, so there is no credit.');
  });
});

describe('what a stage’s row and sheet say', () => {
  const d = run();
  const first = d.stages[0];

  test('what the percent on each row is, for someone on the ACA, and the limit only where the law has one', () => {
    expect(stagePercentLine(first, d.years, '2026')).toBe('Each row’s percent is that year’s ACA income against the poverty line. Above 400% there is no credit.');
    expect(stagePercentLine(first, d.years, 'enhanced')).toBe('Each row’s percent is that year’s ACA income against the poverty line.');
    const onMedicare = d.stages.find((s) => s.key === 'rmd')!;
    expect(stagePercentLine(onMedicare, d.years, '2026')).toBeNull();
  });

  test('a stage’s penalties, added up, and how many years pay one', () => {
    const y = yearAt(d, 51);
    const rows = [{ ...y, law: { ...y.law, penalty: 1_000 } }, { ...y, law: { ...y.law, penalty: 0 } }, { ...y, law: { ...y.law, penalty: 2_500 } }];
    expect(stagePenalties({ first: 0, last: 3 }, rows)).toEqual({ total: 3_500, years: 2 });
    expect(stagePenalties({ first: 1, last: 2 }, rows)).toEqual({ total: 0, years: 0 });
  });

  test('its figure is said to be an average, and what it leaves out before 59½ is said with the law’s limits', () => {
    expect(STAGE_TAX_NOTE).toBe('Each stage’s tax is a yearly average, with any penalty in it.');
    expect(EARLY_ACCESS_WHY.text).toContain('in or after the year you turn 55');
    expect(EARLY_ACCESS_WHY.text).toContain('not an IRA');
  });

  test('health costs rising slower than prices say so', () => {
    expect(healthPace(0.021)).toBe('2.1 points a year faster than prices');
    expect(healthPace(-0.01)).toBe('1 point a year slower than prices');
    const plan = { withdrawalRate: 0.04, realReturn: 0.05, partTimeIncome: 0 };
    expect(assumptionsWorked(plan, { inflation: 0.03 }, -0.01, money)).toContain('health costs 1 point below inflation');
  });
});

describe('the FI number’s lines', () => {
  const base = { spending: 64_000.4, paid: 0, health: 4_188.6, t: 0.137, tText: '13.7%', rate: 0.04, worked: 2_000_000, own: false };
  const parse = (v: string) => Number(v.replace(/[^\d.-]/g, ''));

  test('add up as written, to what you’d draw', () => {
    for (const over of [{}, { paid: 12_000.3 }, { health: null }, { worked: 1_245_423 }]) {
      const l = fiLines({ ...base, ...over }, money);
      const draw = l.findIndex((x) => x.label === 'What you’d draw each year');
      expect(l.slice(0, draw).reduce((n, x) => n + parse(x.value), 0)).toBe(parse(l[draw].value));
    }
  });

  test('its last line says what it is, and no tax line where there is none', () => {
    expect(fiLines(base, money).at(-1)!.label).toBe('At a 4% withdrawal rate');
    expect(fiLines({ ...base, own: true }, money).at(-1)!.label).toBe('Worked out, at a 4% withdrawal rate');
    expect(fiLines({ ...base, t: 0 }, money).map((l) => l.label).join()).not.toContain('Tax,');
    expect(fiLines(base, money).map((l) => l.label)).toContain('Tax, 13.7% of what you draw');
    expect(fiLines({ ...base, paid: 12_000 }, money).find((l) => l.label.startsWith('Coverage you already pay'))?.value).toBe(money(-12_000));
  });
});
