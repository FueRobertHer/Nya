// components/plan-drawdown.ts
//
// The words of Year by year (components/PlanDrawdown.tsx) and of what a detailed plan
// can't know (the tax plan's Honesty): the stages, a stage's years, a year's sheet.
// Pure strings, so a view test and a sheet read one set of them. A plan's outcome (a
// year over the ACA limit, a penalty) is a neutral badge, never a warning: nothing is
// wrong with the data. What holds an amount is drawn through Masked by the view.

import type { BucketsToday } from '@/lib/fire/buckets-today';
import type { DrawdownNote, DrawdownStage, DrawdownYear, PersonCare, StageKey } from '@/lib/fire/drawdown';
import type { PlanItem } from '@/lib/fire/items';
import type { DetailNote, PlanDetail } from '@/lib/fire/plan-detail';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import type { Owner, TaxFacts } from '@/lib/fire/tax-facts';
import type { Filing, StateCode } from '@/lib/fire/tax/law/types';
import type { FigureNote } from './plan-figure-notes';
import { pct } from './plan-text';

type Money = (n: number) => string;

/** Under a cent of a dollar's worth is nothing. */
const some = (n: number) => n >= 0.5;

export const STATE_NAMES: Record<StateCode, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'the District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export const FILING_NAMES: Record<Filing, string> = { single: 'Single', joint: 'Married, filing jointly' };

/** On each result. */
export const lawLabel = (year: number) => `Hypothetical, ${year} tax law. Not tax advice.`;

/** The hero's line, beside the rate it ran at. */
export const taxLine = (t: number) => `Tax at ${pct(t, 1)}, from the years below.`;

/** Who is on what, by the household's first age: the year's helper reads it. */
const ACA_KINDS: readonly PersonCare['status'][] = ['aca', 'medicaid', 'under-line', 'over-cliff'];
export const onAca = (y: Pick<DrawdownYear, 'care'>) => y.care.people.some((p) => ACA_KINDS.includes(p.status));

const words = (list: readonly string[]) => (list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const agesText = (from: number, to: number) => (from === to ? `${from}` : `${from} to ${to}`);

const STAGE_WORDS: Record<StageKey, string> = {
  'before-60': 'before 59½',
  'before-65': 'before Medicare',
  'before-rmd': 'before RMDs',
  rmd: 'RMD years',
};

export const stageTitle = (s: Pick<DrawdownStage, 'key' | 'from' | 'to'>) => `${agesText(s.from, s.to)} · ${STAGE_WORDS[s.key]}`;

/** The year each kind of money first comes in a stage's years. */
const firstWith = (rows: readonly DrawdownYear[], paid: (y: DrawdownYear) => number) => rows.find((y) => some(paid(y)))?.age ?? null;

/** Where a stage's money comes from, in a line. */
export function stageSources(s: DrawdownStage, years: readonly DrawdownYear[]): string {
  const rows = years.slice(s.first, s.last);
  const drawn: string[] = [];
  if (some(s.sources.taxable)) drawn.push('taxable');
  if (some(s.sources.deferred)) drawn.push('tax-deferred');
  if (some(s.sources.roth)) drawn.push('Roth');
  if (some(s.sources.hsa)) drawn.push('HSA');
  const parts: string[] = [];
  if (drawn.length > 0) parts.push(`From ${words(drawn)}`);
  if (some(s.sources.rmd)) parts.push('Required withdrawals from tax-deferred');
  else if (s.key === 'rmd') parts.push('Nothing left in tax-deferred, so no RMD');
  const named = (paid: (y: DrawdownYear) => number, name: string) => {
    const from = firstWith(rows, paid);
    if (from !== null) parts.push(from > s.from ? `${name} from ${from}` : name);
  };
  named((y) => y.income.socialSecurity, 'Social Security');
  named((y) => y.income.pension, 'pension');
  named((y) => y.income.wages, 'part-time work');
  named((y) => y.income.afterTax, 'income after tax');
  if (parts.length === 0) return 'Nothing drawn';
  const [head, ...rest] = parts;
  return [head.charAt(0).toUpperCase() + head.slice(1), ...rest].join(' · ');
}

/** What a stage is, at the head of its sheet. */
export function stageHelper(s: Pick<DrawdownStage, 'key' | 'to'>, rmdAge: number): string {
  switch (s.key) {
    case 'before-60':
      return 'Before 59½ only taxable money, Roth contributions and a 457(b) from a job you’ve left can be reached without a penalty.';
    case 'before-65':
      return 'Any account can be drawn without a penalty now. Health coverage is yours to pay until Medicare at 65.';
    case 'before-rmd':
      return `Medicare from 65. Until required withdrawals start at ${rmdAge}, what you draw each year is up to you.`;
    case 'rmd':
      return 'The law now sets a smallest amount to take from tax-deferred money each year: a required minimum distribution (RMD). It counts as income whether or not you spend it.';
  }
}

/** The stage in a sentence: when each kind of money runs out, and what that costs. */
export function stageSentence(s: DrawdownStage, years: readonly DrawdownYear[], money: Money): string | null {
  const rows = years.slice(s.first, s.last);
  const parts: string[] = [];
  const ranOut = rows.find((y) => some(y.start.taxable) && !some(y.end.taxable));
  if (ranOut) parts.push(`Taxable money runs out at ${ranOut.age}`);
  const early = rows.filter((y) => some(y.law.penalty));
  const penalties = early.reduce((n, y) => n + y.law.penalty, 0);
  const sentences: string[] = [];
  if (early.length > 0) {
    const years_ = `${early.length} year${early.length === 1 ? '' : 's'} ${early.length === 1 ? 'draws' : 'draw'} tax-deferred money early, with ${money(penalties)} in penalties`;
    sentences.push(parts.length > 0 ? `${parts[0]}, so ${years_}.` : `${years_.charAt(0).toUpperCase()}${years_.slice(1)}.`);
  } else if (parts.length > 0) {
    sentences.push(`${parts[0]}.`);
  }
  const short = rows.find((y) => y.short);
  if (short) sentences.push(`At ${short.age} there isn’t enough left to pay the year.`);
  return sentences.length > 0 ? sentences.join(' ') : null;
}

/** A year's row in its stage: the year, where its money comes from, its income
 *  against the poverty line for someone on the ACA. */
export function yearSub(y: DrawdownYear): string {
  const d = y.drawn;
  const from: string[] = [];
  if (some(d.taxable)) from.push('taxable');
  if (some(d.deferred + d.deferred457)) from.push('tax-deferred');
  if (some(d.penalized)) from.push('tax-deferred, early');
  if (some(d.roth + d.young + d.earnings)) from.push('Roth');
  if (some(d.hsaPremiums + d.hsaTaxed + d.hsaEarly)) from.push('HSA');
  const parts = [from.length > 0 ? `From ${words(from)}` : some(y.income.socialSecurity + y.income.pension + y.income.wages + y.income.afterTax) ? 'Income covers it' : 'Nothing drawn'];
  if (onAca(y)) parts.push(`${Math.round(y.care.povertyPercent)}% of the poverty line`);
  return parts.join(' · ');
}

/** What the year's figure is. */
export const yearValueLabel = (y: Pick<DrawdownYear, 'law'>) => (some(y.law.penalty) ? 'tax and penalty' : 'tax');

/** The neutral badges where one applies; every ACA badge only for a person on it (D10). */
export function yearBadges(y: DrawdownYear, money: Money): string[] {
  const out: string[] = [];
  if (onAca(y)) {
    if (y.care.overLimit) out.push('Over the ACA limit');
    if (y.care.underLine) out.push('Under the Medicaid line');
    if (y.care.lowerDeductibles) out.push('Lower deductibles');
  }
  if (y.care.people.some((p) => p.irmaaTier > 0)) out.push('IRMAA');
  if (some(y.law.penalty)) out.push(`Penalty ${money(y.law.penalty)}`);
  if (y.short) out.push(`Short ${money(y.shortfall)}`);
  return out;
}

export type YearLine = { label: string; value: string; sum?: boolean };
export type YearMeter = { percent: number; limit: number | null; label: string; limitLabel: string | null };
export type YearSection = { title: string; lines: YearLine[]; meter?: YearMeter; note?: string; why?: { label: string; text: string } };

export type YearContext = {
  money: Money;
  realReturn: number;
  /** Fractions of a point: 0.021 is 2.1 points. */
  healthGrowth: number;
  acaLaw: TaxChoices['health']['acaLaw'];
  lawYear: number;
  state: StateCode | null;
  /** What the law has this state charging income tax, or not. */
  stateTaxes: boolean | null;
  rmdAge: number;
};

const CARE_WORDS: Partial<Record<PersonCare['status'], string>> = {
  aca: 'ACA coverage',
  medicaid: 'Medicaid',
  'under-line': 'ACA coverage at full price',
  'over-cliff': 'ACA coverage at full price',
  medicare: 'Medicare',
  other: 'your own coverage',
};

/** "Both on ACA coverage." and the like, for the people the year has. */
function coverageWords(y: DrawdownYear): string | null {
  const you = CARE_WORDS[y.care.people[0].status];
  if (y.partnerAge === null) return you ? `On ${you}.` : null;
  const them = CARE_WORDS[y.care.people[1].status];
  if (you && you === them) return `Both on ${you}.`;
  if (you && them) return `You on ${you}, your partner on ${them}.`;
  return you ? `You on ${you}.` : them ? `Your partner on ${them}.` : null;
}

/** The head of a year's sheet. */
export function yearHelper(y: DrawdownYear, c: YearContext): string {
  const parts: string[] = [];
  if (y.partnerAge !== null) parts.push(`Your partner is ${y.partnerAge}.`);
  const covered = coverageWords(y);
  if (covered) parts.push(covered);
  parts.push(`At a steady ${pct(c.realReturn)} after inflation, health costs ${Number((c.healthGrowth * 100).toFixed(2))} points a year faster than prices, ${c.lawYear} tax law. Hypothetical, not tax advice.`);
  return parts.join(' ');
}

const POVERTY_SCALE = 500;

/** The year's five sections, in order. Each line only where the year has it. */
export function yearSections(y: DrawdownYear, c: YearContext): YearSection[] {
  const { money } = c;
  const d = y.drawn;
  const line = (label: string, n: number, sum = false): YearLine[] => (some(n) ? [{ label, value: money(n), sum }] : []);

  const source: YearLine[] = [
    ...line('Sold from taxable', d.taxable),
    ...(some(d.taxable) ? [{ label: 'of it gains', value: money(d.gain) }] : []),
    ...line('Dividends and interest', y.income.yield),
    ...line('Drawn from tax-deferred', d.deferred),
    ...line('Drawn from a 457(b)', d.deferred457),
    ...line('Drawn from tax-deferred early', d.penalized),
    ...line('Required minimum distribution (RMD)', y.rmd),
    ...line('Roth contributions', d.roth),
    ...line('Roth conversions over five years old', d.young),
    ...line('Roth earnings', d.earnings),
    ...line('HSA, for premiums', d.hsaPremiums),
    ...line('HSA, taxed', d.hsaTaxed + d.hsaEarly),
    ...line('Social Security', y.income.socialSecurity),
    ...line('Pension and other income', y.income.pension),
    ...line('Part-time work', y.income.wages),
    ...line('Income after tax', y.income.afterTax),
    ...line('Windfall', y.income.windfall),
    ...line('Short of what the year needs', y.shortfall),
  ];

  const stateName = c.state ? STATE_NAMES[c.state] : null;
  const federal = y.law.ordinaryTax + y.law.gainsTax + y.law.niit;
  const pays: YearLine[] = [
    { label: 'Spending', value: money(y.living) },
    ...line('One-off costs', y.oneOffs),
    ...line(onAca(y) ? 'Health coverage, after the credit' : 'Health coverage', y.health),
    { label: 'Federal tax', value: money(federal) },
    ...(stateName ? [{ label: c.stateTaxes === false ? `${stateName}: no income tax` : `${stateName} income tax`, value: money(y.law.state) }] : []),
    ...line('Early withdrawal penalty', y.law.penalty),
    ...line('Payroll tax', y.law.fica),
    ...line('Left over, invested', y.surplus),
  ];

  const gains = y.income.qualified + d.gain;
  const income: YearSection = {
    title: 'Income the law counts',
    lines: [
      { label: 'Ordinary income', value: money(Math.max(0, y.law.agi - Math.max(0, gains))) },
      ...line('Gains and qualified dividends', Math.max(0, gains)),
      ...(some(y.law.taxableSocialSecurity) ? [{ label: 'of it Social Security', value: money(y.law.taxableSocialSecurity) }] : []),
      onAca(y) ? { label: 'ACA income (MAGI)', value: money(y.law.magiAca), sum: true } : { label: 'Adjusted gross income', value: money(y.law.agi), sum: true },
    ],
  };
  // The limit and its meter only for someone on the ACA (D10).
  if (onAca(y)) {
    const percent = y.care.povertyPercent;
    const limit = c.acaLaw === '2026' ? 400 : null;
    income.meter = { percent: Math.min(100, (percent / POVERTY_SCALE) * 100), limit: limit === null ? null : (limit / POVERTY_SCALE) * 100, label: `${Math.round(percent)}% of the poverty line`, limitLabel: limit === null ? null : `Limit ${limit}%` };
  }

  const tax: YearSection = {
    title: 'How the tax is worked out',
    lines: [
      { label: `Ordinary, after the ${money(y.law.deduction)} deduction`, value: money(y.law.ordinaryTaxable) },
      { label: `Tax on it, up to the ${pct(y.law.topRate)} bracket`, value: money(y.law.ordinaryTax) },
      ...(some(gains) ? [{ label: 'Tax on gains and dividends, on top', value: money(y.law.gainsTax) }] : []),
      ...line('Tax on investment income', y.law.niit),
      some(y.law.penalty) ? { label: 'Early withdrawal penalty', value: money(y.law.penalty) } : { label: 'Early withdrawal penalty', value: 'None' },
    ],
  };
  if (some(gains) && !some(y.law.gainsTax)) tax.why = { label: 'Why are the gains taxed at 0%?', text: 'Gains sit on top of ordinary income. Up to a limit set for each filing status, taxable income takes gains at 0%, and this year’s stay under it.' };
  else if (some(y.law.penalty)) tax.why = { label: 'Why a penalty?', text: 'Tax-deferred money drawn before 59½ pays 10% on top of its tax, once the money that can be reached without one has run out. Nya knows your age in whole years, so the year you turn 59 counts as before 59½.' };

  const [you, them] = y.care.people;
  const people = y.partnerAge === null ? [you] : [you, them];
  const total = (pick: (p: PersonCare) => number) => people.reduce((n, p) => n + pick(p), 0);
  const credit = total((p) => p.credit) + y.care.dependents.credit;
  const health: YearSection = {
    title: 'Health coverage',
    lines: [
      ...(onAca(y) ? line('Benchmark plan, full price', y.care.benchmark) : []),
      ...line('Premium tax credit', credit),
      ...line('Medicare Part B', total((p) => p.partB)),
      ...line('IRMAA', total((p) => p.irmaa)),
      ...line('Part D or a supplement', total((p) => p.extra)),
      ...line('The coverage you typed', total((p) => p.typed)),
      { label: 'You pay', value: money(y.health), sum: true },
    ],
  };
  const notes: string[] = [];
  if (onAca(y) && y.care.figure > 0) notes.push(`At ${pct(y.care.figure, 2)} of income, the share the law sets at this income.`);
  if (y.care.overLimit && c.acaLaw === '2026') notes.push('Over 400% of the poverty line there is no credit, so coverage is counted at full price.');
  if (y.care.underLine) notes.push(you.status === 'medicaid' || them.status === 'medicaid' ? 'Under the Medicaid line, so Medicaid covers who meets its rule, with no premium.' : 'Under the Medicaid line with no credit, so coverage is counted at full price.');
  if (y.care.irmaaUnknown) notes.push('IRMAA reads income from two years back, before this plan’s years, so it isn’t counted here.');
  if (notes.length > 0) health.note = notes.join(' ');

  return [{ title: 'Where the money comes from', lines: source.length > 0 ? source : [{ label: 'Nothing', value: money(0) }] }, { title: 'What it pays for', lines: pays }, income, tax, health];
}

export const yearTitle = (y: Pick<DrawdownYear, 'age' | 'calendarYear'>) => `Age ${y.age} · ${y.calendarYear}`;

const NOTE_WORDS: Record<DrawdownNote | DetailNote, string | null> = {
  'folded-partner': 'Filing as single, your partner’s accounts and income are counted as yours.',
  unsettled: 'The rule’s spending didn’t settle on one figure, so this takes the higher of its last two.',
  'held-at-zero': 'In some years the rule’s spending is less than health coverage, so living spending is held at zero.',
  'irmaa-unknown': null,
  'no-mix': 'Your accounts’ mix couldn’t be projected to the start, so it starts with today’s shares.',
};

/** Under Year by year: what the years themselves say about how they were worked out. */
export const detailLines = (d: Pick<PlanDetail, 'notes' | 'start'>): string[] => [...d.notes, ...d.start.notes].flatMap((n) => NOTE_WORDS[n] ?? []);

/** A joint plan's one line (the tax plan's Plan outcomes). */
export const survivorLine = (endAge: number) => `Assumes you both live to ${endAge}. A survivor files single, at higher rates.`;

export const HEALTH_NOT_SET = 'Not set: measured spending leaves out coverage through work.';

/** The Health coverage row's sub. */
export function healthSub(choices: TaxChoices): string {
  const before = choices.health.beforeMedicare;
  if (!before) return HEALTH_NOT_SET;
  return `${before.kind === 'aca' ? 'ACA' : 'Your own coverage'} before 65, then Medicare · in Drawdown`;
}

type NoteArgs = {
  today: Pick<BucketsToday, 'groups' | 'roth'> | null;
  facts: Pick<TaxFacts, 'filing' | 'dependents'>;
  choices: TaxChoices;
  items: readonly Pick<PlanItem, 'kind' | 'beforeTax' | 'label'>[];
  /** The partner's age, for who a Roth note is about. */
  partner: boolean;
  law: { year: number; behind: boolean } | null;
  /** What measured spending holds under a name for health insurance, while nothing
   *  has said whether it is the coverage below. */
  unansweredPaid: { name: string; amount: number } | null;
  money: Money;
};

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Each gap in what the drawdown rests on (the tax plan's Honesty), in its level: for
 *  Drawdown's notice and the sheet each is about. A flat plan draws none of them. */
export function honestyNotes(a: NoteArgs): FigureNote[] {
  const notes: FigureNote[] = [];
  const add = (level: FigureNote['level'], kind: string, text: string) => notes.push({ key: `detail:${kind}`, level, kind, text });
  const groups = a.today?.groups ?? [];
  const unclassified = groups.find((g) => g.bucket === 'unclassified')?.accounts.length ?? 0;
  if (unclassified > 0) add('caution', 'no tax bucket', `${counted(unclassified, 'account has', 'accounts have')} no tax bucket, counted as tax-deferred. Set ${unclassified === 1 ? 'it' : 'them'} on Invested assets.`);
  const noBasis = groups.find((g) => g.bucket === 'taxable')?.accounts.filter((x) => x.basisFrom === 'none').length ?? 0;
  if (noBasis > 0) add('caution', 'no cost basis', `${counted(noBasis, 'taxable account has', 'taxable accounts have')} no cost basis, so all of ${noBasis === 1 ? 'it' : 'them'} counts as gain. Say what you paid on Invested assets.`);
  for (const r of a.today?.roth ?? []) {
    if (r.amount !== null) continue;
    const who = r.owner === ('you' satisfies Owner) ? 'your' : 'your partner’s';
    add('caution', r.owner === 'you' ? 'Roth put-in not given' : 'partner’s Roth put-in not given', `What went into ${who} Roth isn’t given, so none of it counts as reachable before 59½. Say how much on Invested assets.`);
  }
  const afterTax = a.items.filter((x) => x.beforeTax === false && (x.kind === 'pension' || x.kind === 'social-security' || x.kind === 'other-income'));
  if (afterTax.length > 0) add('caution', 'income after tax', `${words(afterTax.map((x) => x.label))} ${afterTax.length === 1 ? 'is' : 'are'} given after tax, so ${afterTax.length === 1 ? 'it isn’t' : 'they aren’t'} in your ACA income. Give ${afterTax.length === 1 ? 'it' : 'them'} before tax on your Timeline.`);
  const partTime = a.items.filter((x) => x.beforeTax === false && x.kind === 'part-time');
  if (partTime.length > 0) add('caution', 'part-time after tax', `${words(partTime.map((x) => x.label))} ${partTime.length === 1 ? 'is' : 'are'} given after tax, which may hide a year over the ACA limit.`);
  if (a.choices.state === null) add('caution', 'no household', 'No state given: counted with no state tax and no Medicaid expansion. Say on Household.');
  if (a.choices.health.beforeMedicare === null) add('caution', 'health not set', 'Health coverage isn’t set: no cost before 65, then Medicare Part B only. Measured spending leaves out coverage through work.');
  if (a.unansweredPaid) add('caution', 'coverage counted twice', `Your spending has ${a.money(a.unansweredPaid.amount)} a year in ${a.unansweredPaid.name}. If that’s the coverage below, say so on Health coverage, so it isn’t counted twice.`);
  if (a.law?.behind) add('caution', 'older tax law', `Uses ${a.law.year} tax law, the newest Nya has.`);
  return notes;
}

/** Household's own, since these name what can't be set there. */
export function householdNotes(a: Pick<NoteArgs, 'facts' | 'choices'>): FigureNote[] {
  const notes: FigureNote[] = [];
  if (a.choices.state === 'WA') notes.push({ key: 'detail:washington', level: 'info', kind: 'Washington', text: 'Washington taxes capital gains only, which isn’t counted here.' });
  if (a.facts.dependents.length > 0) notes.push({ key: 'detail:dependents', level: 'caution', kind: 'dependents', text: 'Dependents count in your household’s size. The child tax credit and head of household aren’t counted.' });
  return notes;
}

/** The Household row's line. */
export function householdLine(facts: Pick<TaxFacts, 'filing'>, choices: Pick<TaxChoices, 'state'>): string {
  return [facts.filing === 'joint' ? 'joint' : 'single', choices.state ? STATE_NAMES[choices.state] : 'no state yet'].join(' · ');
}
