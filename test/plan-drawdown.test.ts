import { describe, expect, test } from 'bun:test';
import { runDrawdown, type Drawdown, type DrawdownInput, type DrawdownYear } from '@/lib/fire/drawdown';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { MixSlot } from '@/lib/fire/tax/mix';
import type { IncomeRow } from '@/lib/fire/compile';
import { DEFAULT_TAX_CHOICES } from '@/lib/fire/tax-choices';
import { DEFAULT_TAX_FACTS } from '@/lib/fire/tax-facts';
import { markRows } from '@/components/DrawdownChart';
import { detailLines, healthSub, honestyNotes, householdLine, householdNotes, lawLabel, onAca, stageHelper, stageSentence, stageSources, stageTitle, survivorLine, taxLine, yearBadges, yearHelper, yearSections, yearSub, yearTitle, yearValueLabel, type YearContext } from '@/components/plan-drawdown';

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
const CONTEXT: YearContext = { money, realReturn: 0.05, healthGrowth: 0.021, acaLaw: '2026', lawYear: 2026, state: 'NV', stateTaxes: false, rmdAge: 75, gainsZeroTo: 98_900 };
const yearAt = (d: Drawdown, age: number): DrawdownYear => d.years.find((y) => y.age === age)!;
const titles = (y: DrawdownYear, c = CONTEXT) => yearSections(y, c).map((s) => s.title);
const lines = (y: DrawdownYear, title: string, c = CONTEXT) => yearSections(y, c).find((s) => s.title === title)!;

describe('the stages', () => {
  test('each says its ages and what it is', () => {
    const d = run();
    expect(d.stages.map(stageTitle)).toEqual(['50 to 59 · before 59½', '60 to 64 · before Medicare', '65 to 74 · before RMDs', '75 to 94 · RMD years']);
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
    expect(stageSources(d.stages.find((s) => s.key === 'rmd')!, d.years, money)).toContain('Nothing left in tax-deferred, so no RMD');
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
    expect(h).toContain('2.1 points a year faster than prices, 2026 tax law. Hypothetical, not tax advice.');
  });

  test('a state with no income tax is named as having none', () => {
    const pays = lines(yearAt(run(), 51), 'What it pays for').lines;
    expect(pays.map((l) => l.label)).toContain('Nevada: no income tax');
    const taxed = lines(yearAt(run({ state: 'CA', stateRate: 0.05 }), 51), 'What it pays for', { ...CONTEXT, state: 'CA', stateTaxes: true });
    expect(taxed.lines.map((l) => l.label)).toContain('California income tax');
  });

  test('the meter and its limit only on the ACA, and no limit under enhanced credits', () => {
    const d = run();
    expect(lines(yearAt(d, 51), 'Income the law counts').meter?.limitLabel).toBe('Limit 400%');
    expect(lines(yearAt(d, 51), 'Income the law counts', { ...CONTEXT, acaLaw: 'enhanced' }).meter?.limit).toBeNull();
    expect(lines(yearAt(d, 70), 'Income the law counts').meter).toBeUndefined();
  });

  test('its lines add up to what the year says it paid', () => {
    const y = yearAt(run(), 51);
    const parse = (v: string) => Number(v.replace(/[^\d.-]/g, ''));
    const paid = lines(y, 'What it pays for').lines.reduce((n, l) => n + parse(l.value), 0);
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

  test('the small lines', () => {
    expect(lawLabel(2026)).toBe('Hypothetical, 2026 tax law. Not tax advice.');
    expect(taxLine(0.034)).toBe('Tax at 3.4%, from the years below.');
    expect(survivorLine(95)).toBe('Assumes you both live to 95. A survivor files single, at higher rates.');
    expect(householdLine({ filing: 'joint' }, { state: 'NV' })).toBe('joint · Nevada');
    expect(householdLine({ filing: null }, { state: null })).toBe('single · no state yet');
    expect(healthSub(DEFAULT_TAX_CHOICES)).toContain('Not set');
    expect(healthSub({ ...DEFAULT_TAX_CHOICES, health: { ...DEFAULT_TAX_CHOICES.health, beforeMedicare: { kind: 'aca', adult: 1, quotedAge: 50, child: null } } })).toBe('ACA before 65, then Medicare · in Drawdown');
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
