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
import type { FiShares } from '@/lib/fire/plan-figures';
import { TAXED_GRID_RUNS, type Method } from '@/lib/fire/simulate';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import type { Owner, TaxFacts } from '@/lib/fire/tax-facts';
import type { Filing, StateCode } from '@/lib/fire/tax/law/types';
import type { FigureNote } from './plan-figure-notes';
import { plainNumber } from '@/lib/format';
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

/** The hero's label on a detailed plan: the two things it rests on, in one line. */
export const hypotheticalDrawdown = (year: number) => `Hypothetical, from US history and ${year} tax law: not a prediction, and not investment or tax advice.`;

/** The end of the setup: every start works out its own years. */
export const WITH_EACH_YEARS_TAX = 'With each year’s tax.';

/** The grid card, with each year's tax: it runs a sample, and says so
 *  (lib/fire/simulate.ts TAXED_GRID_STEP, TAXED_GRID_RUNS). */
export const gridSampleLine = (method: Method) => `With each year’s tax, ${method === 'historical' ? 'every sixth start' : `${plainNumber(TAXED_GRID_RUNS)} runs`}, to keep this quick, so a cell can differ a little from the answer above.`;

/** Who is on what, by the household's first age: the year's helper reads it. */
const ACA_KINDS: readonly PersonCare['status'][] = ['aca', 'medicaid', 'under-line', 'over-cliff'];
export const onAca = (y: Pick<DrawdownYear, 'care'>) => y.care.people.some((p) => ACA_KINDS.includes(p.status));

const words = (list: readonly string[]) => (list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const agesText = (from: number, to: number) => (from === to ? `${from}` : `${from} to ${to}`);

const STAGE_WORDS: Record<StageKey, string> = {
  'before-60': 'before 59½',
  'before-65': 'before Medicare',
  'before-rmd': 'before required withdrawals',
  rmd: 'required withdrawal years',
};

export const stageTitle = (s: Pick<DrawdownStage, 'key' | 'from' | 'to'>) => `${agesText(s.from, s.to)} · ${STAGE_WORDS[s.key]}`;

/** The year each kind of money first comes in a stage's years. */
const firstWith = (rows: readonly DrawdownYear[], paid: (y: DrawdownYear) => number) => rows.find((y) => some(paid(y)))?.age ?? null;

/** About this, to the nearest thousand: a stage's conversions move year to year. */
const aboutThousand = (n: number) => (n >= 500 ? Math.round(n / 1000) * 1000 : n);

/** What a stage's conversions do, in a line's part, or nothing. */
function convertingPart(s: Pick<DrawdownStage, 'converted'>, rows: readonly DrawdownYear[], money: Money): string | null {
  if (!some(s.converted)) return null;
  const emptied = rows.find((y) => some(y.conversion) && !some(y.end.deferred));
  if (emptied) return `tax-deferred converted by ${emptied.age}`;
  const converting = rows.filter((y) => some(y.conversion));
  const filled = rows.every((y) => !y.care.overLimit) && rows.some((y) => onAca(y) && y.care.povertyPercent >= 390);
  return `converting about ${money(aboutThousand(s.converted / converting.length))} a year${filled ? ', under the ACA limit' : ''}`;
}

/** Where a stage's money comes from, in a line. */
export function stageSources(s: DrawdownStage, years: readonly DrawdownYear[], money: Money): string {
  const rows = years.slice(s.first, s.last);
  const drawn: string[] = [];
  if (some(s.sources.taxable)) drawn.push('taxable');
  if (some(s.sources.deferred)) drawn.push('tax-deferred');
  if (some(s.sources.roth)) drawn.push('Roth');
  if (some(s.sources.hsa)) drawn.push('HSA');
  const parts: string[] = [];
  if (drawn.length > 0) parts.push(`From ${words(drawn)}`);
  if (some(s.sources.rmd)) parts.push('Required withdrawals from tax-deferred');
  else if (s.key === 'rmd') parts.push('Nothing left in tax-deferred, so none required');
  const named = (paid: (y: DrawdownYear) => number, name: string) => {
    const from = firstWith(rows, paid);
    if (from !== null) parts.push(from > s.from ? `${name} from ${from}` : name);
  };
  named((y) => y.income.socialSecurity, 'Social Security');
  named((y) => y.income.pension, 'pension');
  named((y) => y.income.wages, 'part-time work');
  named((y) => y.income.afterTax, 'income after tax');
  const converting = convertingPart(s, rows, money);
  if (converting) parts.push(converting);
  if (parts.length === 0) return 'Nothing drawn';
  const [head, ...rest] = parts;
  return [head.charAt(0).toUpperCase() + head.slice(1), ...rest].join(' · ');
}

/** What a stage is, at the head of its sheet. */
export function stageHelper(s: Pick<DrawdownStage, 'key' | 'to'>, rmdAge: number): string {
  switch (s.key) {
    case 'before-60':
      return 'Before 59½, Nya counts these as reachable without a penalty: taxable money, Roth contributions, conversions at least five tax years old, and a 457(b) from a job you’ve left.';
    case 'before-65':
      return 'From 59½ tax-deferred and Roth money can be drawn without a penalty, and an HSA from 65. Health coverage is yours to pay until Medicare at 65.';
    case 'before-rmd':
      return `Medicare from 65. Until required withdrawals start at ${rmdAge}, what you draw each year is up to you.`;
    case 'rmd':
      return 'The law now sets a smallest amount to take from tax-deferred money each year: a required minimum distribution (RMD). It counts as income whether or not you spend it.';
  }
}

/** Under Year by year and each rule's stages: what a stage's figure is. */
export const STAGE_TAX_NOTE = 'Each stage’s tax is a yearly average, with any penalty in it.';

/** What the before-59½ stage leaves out, since its helper says what it counts. */
export const EARLY_ACCESS_WHY = {
  label: 'What about the rule of 55 and 72(t) payments?',
  text: 'Nya doesn’t count them. The rule of 55 covers only the plan of a job you leave in or after the year you turn 55, not an IRA or an older job’s plan. 72(t) payments can reach tax-deferred money before 59½ with no penalty, on a fixed schedule that must run at least five years or until 59½, whichever is later. A plan that uses either could pay less than this shows.',
} as const;

/** What the percent on a stage's rows is, for a stage with someone on the ACA. */
export function stagePercentLine(s: Pick<DrawdownStage, 'first' | 'last'>, years: readonly DrawdownYear[], acaLaw: TaxChoices['health']['acaLaw']): string | null {
  if (!years.slice(s.first, s.last).some(onAca)) return null;
  return `Each row’s percent is that year’s ACA income against the poverty line.${acaLaw === '2026' ? ' Above 400% there is no credit.' : ''}`;
}

/** What a stage's years pay in penalties, and how many of them do, for its row. */
export function stagePenalties(s: Pick<DrawdownStage, 'first' | 'last'>, years: readonly DrawdownYear[]): { total: number; years: number } {
  const early = years.slice(s.first, s.last).filter((y) => some(y.law.penalty));
  return { total: early.reduce((n, y) => n + y.law.penalty, 0), years: early.length };
}

/** The year the Roth money that needs no penalty runs out: the year something is drawn
 *  early alongside it, or the year before one. */
function rothContributionsOut(rows: readonly DrawdownYear[]): DrawdownYear | undefined {
  const early = (y: DrawdownYear) => some(y.drawn.penalized + y.drawn.earnings);
  return rows.find((y, i) => some(y.drawn.roth) && (early(y) || (i + 1 < rows.length && !some(rows[i + 1].drawn.roth) && early(rows[i + 1]))));
}

/** What the years of a penalty drew early. */
function earlyKinds(years: readonly DrawdownYear[]): string {
  const kinds: string[] = [];
  if (years.some((y) => some(y.drawn.penalized))) kinds.push('tax-deferred');
  if (years.some((y) => some(y.drawn.young + y.drawn.earnings))) kinds.push('Roth');
  if (years.some((y) => some(y.drawn.hsaEarly))) kinds.push('HSA');
  return words(kinds);
}

/** The stage in a sentence: when each kind of money runs out, and what that costs. */
export function stageSentence(s: DrawdownStage, years: readonly DrawdownYear[], money: Money): string | null {
  const rows = years.slice(s.first, s.last);
  const parts: string[] = [];
  const ranOut = rows.find((y) => some(y.start.taxable) && !some(y.end.taxable));
  const rothOut = rothContributionsOut(rows);
  if (ranOut && rothOut) parts.push(`Taxable money runs out at ${ranOut.age} and penalty-free Roth money at ${rothOut.age}`);
  else if (ranOut) parts.push(`Taxable money runs out at ${ranOut.age}`);
  else if (rothOut) parts.push(`Penalty-free Roth money runs out at ${rothOut.age}`);
  const early = rows.filter((y) => some(y.law.penalty));
  const penalties = early.reduce((n, y) => n + y.law.penalty, 0);
  const sentences: string[] = [];
  if (early.length > 0) {
    const years_ = `${early.length} year${early.length === 1 ? '' : 's'} ${early.length === 1 ? 'draws' : 'draw'} ${earlyKinds(early)} money early, with ${money(penalties)} in penalties`;
    sentences.push(parts.length > 0 ? `${parts[0]}, so ${years_}.` : `${years_.charAt(0).toUpperCase()}${years_.slice(1)}.`);
  } else if (parts.length > 0) {
    sentences.push(`${parts[0]}.`);
  }
  const short = rows.find((y) => y.short);
  if (short) sentences.push(`At ${short.age} there isn’t enough left to pay the year.`);
  return sentences.length > 0 ? sentences.join(' ') : null;
}

/** Why a stage's last years read as they do: the money that needs no penalty ran out,
 *  so income, and with it coverage, moves. Null where it didn't. */
export function stageFoot(s: DrawdownStage, years: readonly DrawdownYear[]): string | null {
  const rows = years.slice(s.first, s.last);
  const firstEarly = rows.findIndex((y) => some(y.law.penalty));
  if (firstEarly < 0) return null;
  const early = rows[firstEarly];
  const drained = rows.find((y) => some(y.start.taxable) && !some(y.end.taxable));
  const from = drained && drained.age < early.age ? drained : early;
  return `From ${from.age}, the money you can reach without a penalty is running out, so income in these years changes${rows.some(onAca) ? ', and so does what coverage costs' : ''}.`;
}

/** How much faster than prices health costs rise. */
export function pointsText(growth: number): string {
  const n = Number((growth * 100).toFixed(2));
  return `${n} point${n === 1 ? '' : 's'}`;
}
const points = pointsText;

/** Health costs against prices, either way. */
export const healthPace = (growth: number) => `${points(Math.abs(growth))} a year ${growth < 0 ? 'slower' : 'faster'} than prices`;

/** What a year's row says but its income: where a run of years has to read the same. */
function yearSources(y: DrawdownYear): string[] {
  const d = y.drawn;
  const from: string[] = [];
  if (some(d.taxable)) from.push('taxable');
  if (some(d.deferred + d.deferred457)) from.push('tax-deferred');
  if (some(d.penalized)) from.push('tax-deferred, early');
  if (some(d.roth + d.young + d.earnings)) from.push('Roth');
  if (some(d.hsaPremiums + d.hsaTaxed + d.hsaEarly)) from.push('HSA');
  const parts: string[] = [];
  if (from.length > 0) parts.push(`From ${words(from)}`);
  if (some(y.rmd)) parts.push('Required withdrawals');
  if (parts.length === 0) parts.push(some(y.income.socialSecurity + y.income.pension + y.income.wages + y.income.afterTax) ? 'Income covers it' : 'Nothing drawn');
  if (some(y.conversion)) parts.push('Converting');
  return parts;
}

/** A year's row in its stage: the year, where its money comes from, its income
 *  against the poverty line for someone on the ACA. */
export function yearSub(y: DrawdownYear): string {
  return [...yearSources(y), ...(onAca(y) ? [`${Math.round(y.care.povertyPercent)}% of the poverty line`] : [])].join(' · ');
}

/** What the year's figure is. */
export const yearValueLabel = (y: Pick<DrawdownYear, 'law'>) => (some(y.law.penalty) ? 'tax and penalty' : 'tax');

/** Whether the state has a Medicaid line for adults this year. Where it has none, the
 *  floor under the credit is 100% of the poverty line (lib/fire/tax/health.ts). */
const hasMedicaidLine = (y: Pick<DrawdownYear, 'calendarYear'>, line: YearContext['medicaid'] | undefined) => line === undefined || (line !== null && (line.through === null || y.calendarYear <= line.through));

/** Whether an adult, not only a dependent at full price, is under the line that year. */
const adultUnderLine = (y: Pick<DrawdownYear, 'care'>) => y.care.people.some((p) => p.status === 'under-line');

/** The neutral badges where one applies; every ACA badge only for a person on it (D10).
 *  `medicaid` is the state's line; left out, it reads as a state with one. */
export function yearBadges(y: DrawdownYear, money: Money, medicaid?: YearContext['medicaid']): string[] {
  const out: string[] = [];
  if (onAca(y)) {
    if (y.care.overLimit) out.push('Over the ACA limit');
    if (y.care.underLine) out.push(!adultUnderLine(y) ? 'Dependents at full price' : hasMedicaidLine(y, medicaid) ? 'Under the Medicaid line' : 'Under 100%, no credit');
    if (y.care.people.some((p) => p.status === 'medicaid')) out.push('On Medicaid');
    if (y.care.lowerDeductibles) out.push('Lower deductibles on silver');
  }
  if (y.care.people.some((p) => p.irmaaTier > 0)) out.push('IRMAA');
  if (some(y.law.penalty)) out.push(`Penalty ${money(y.law.penalty)}`);
  if (y.short) out.push(`Short ${money(y.shortfall)}`);
  return out;
}

/** Adjacent years that read the same, a row of their own from three up: what they
 *  say is shorter than ten near-identical rows, and each year is still a tap away. */
export type YearRun = { first: number; last: number };

export function yearRuns(rows: readonly DrawdownYear[], medicaid?: YearContext['medicaid']): YearRun[] {
  // Figures as they are, not as the page writes them, so hiding amounts draws the same rows.
  const say = (y: DrawdownYear) => JSON.stringify([yearSources(y), onAca(y), yearBadges(y, String, medicaid), yearValueLabel(y)]);
  const runs: YearRun[] = [];
  for (let i = 0; i < rows.length; ) {
    let j = i + 1;
    // A penalty's or a short year's badge holds its amount, so those never run on.
    while (j < rows.length && say(rows[j]) === say(rows[i])) j++;
    runs.push({ first: i, last: j });
    i = j;
  }
  return runs.flatMap((r) => (r.last - r.first >= 3 ? [r] : Array.from({ length: r.last - r.first }, (_, k) => ({ first: r.first + k, last: r.first + k + 1 }))));
}

/** A run's row: its ages and calendar years, what its years share, and its income from
 *  first to last, as a person on the ACA reads it. */
export function runTitle(rows: readonly DrawdownYear[]): string {
  const a = rows[0];
  const b = rows[rows.length - 1];
  return `${a.age} to ${b.age} · ${a.calendarYear} to ${b.calendarYear}`;
}

export function runSub(rows: readonly DrawdownYear[]): string {
  const a = rows[0];
  const percents = rows.map((y) => Math.round(y.care.povertyPercent));
  const low = Math.min(...percents);
  const high = Math.max(...percents);
  return [...yearSources(a), ...(onAca(a) ? [low === high ? `${low}% of the poverty line` : `${low}% to ${high}% of the poverty line`] : [])].join(' · ');
}

export function runTax(rows: readonly DrawdownYear[], money: Money): string {
  const taxes = rows.map((y) => money(y.tax));
  const lowest = Math.min(...rows.map((y) => y.tax));
  const highest = Math.max(...rows.map((y) => y.tax));
  return taxes.every((t) => t === taxes[0]) ? taxes[0] : `${money(lowest)} to ${money(highest)}`;
}

/** A line of a sum: `sum` adds up what's above it, and `part` is part of the line above
 *  it, not one more to add. */
export type YearLine = { label: string; value: string; sum?: boolean; part?: boolean };
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
  /** Where gains stop being taxed at 0%, for this household's return. */
  gainsZeroTo: number;
  /** The state's Medicaid line for adults: null where it has none, or no state is given. */
  medicaid: { through: number | null } | null;
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
  parts.push(`Assumes steady ${pct(c.realReturn)} growth after inflation, health costs rising ${healthPace(c.healthGrowth)}, and ${c.lawYear} tax law. Hypothetical, not tax advice.`);
  return parts.join(' ');
}

const POVERTY_SCALE = 500;

/** The benchmark's line: who it prices, by their ages. */
function benchmarkLabel(y: DrawdownYear): string {
  const onIt = (p: PersonCare) => ACA_KINDS.includes(p.status);
  const ages = [...(onIt(y.care.people[0]) ? [y.age] : []), ...(y.partnerAge !== null && onIt(y.care.people[1]) ? [y.partnerAge] : [])];
  const kids = ACA_KINDS.includes(y.care.dependents.status) ? ' and your dependents' : '';
  return ages.length === 0 ? 'Benchmark plan, full price' : `Benchmark plan for ${ages.length === 1 ? `age ${ages[0]}` : `ages ${words(ages.map(String))}`}${kids}, full price`;
}

/** The year's sections, in order. Each line only where the year has it. The two money
 *  sections hold the same total, which is the point of showing it: a conversion funds
 *  nothing, so it has a section of its own. */
export function yearSections(y: DrawdownYear, c: YearContext): YearSection[] {
  const { money } = c;
  const d = y.drawn;
  const line = (label: string, n: number, sum = false): YearLine[] => (some(n) ? [{ label, value: money(n), sum }] : []);

  const source: YearLine[] = [
    ...line('Sold from taxable', d.taxable),
    ...(some(d.taxable) ? [{ label: 'of it gains', value: money(d.gain), part: true }] : []),
    ...line('Dividends and interest', y.income.yield),
    ...line('Drawn from tax-deferred', d.deferred),
    ...line('Drawn from a 457(b)', d.deferred457),
    ...line('Drawn from tax-deferred early', d.penalized),
    ...line('Required minimum distribution (RMD)', y.rmd),
    // Before 60 this is contributions and conversions at least five tax years old; from 60, all of it.
    ...line('Drawn from Roth, no penalty', d.roth),
    ...line('Roth conversions under five years old', d.young),
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
  const sourceTotal = d.taxable + y.income.yield + d.deferred + d.deferred457 + d.penalized + y.rmd + d.roth + d.young + d.earnings + d.hsaPremiums + d.hsaTaxed + d.hsaEarly + y.income.socialSecurity + y.income.pension + y.income.wages + y.income.afterTax + y.income.windfall + y.shortfall;

  const stateName = c.state ? STATE_NAMES[c.state] : null;
  // What's left of the year's tax, not its parts added: the return's tax is the smaller
  // of two worksheets' figures, so ordinary tax and gains tax can come to more than it.
  const federal = y.tax - y.law.state - y.law.penalty - y.law.fica;
  const pays: YearLine[] = [
    { label: 'Spending', value: money(y.living) },
    ...line('One-off costs', y.oneOffs),
    ...line(onAca(y) ? 'Health coverage, after the credit' : 'Health coverage', y.health),
    { label: 'Federal tax', value: money(federal) },
    ...(stateName ? [{ label: c.stateTaxes === false ? `${stateName}: no income tax` : `${stateName} income tax`, value: money(y.law.state) }] : []),
    ...line('Early withdrawal penalty', y.law.penalty),
    ...line('Payroll tax', y.law.fica),
    ...line('Left over, invested', y.surplus),
    { label: 'Total', value: money(y.living + y.oneOffs + y.health + y.tax + y.surplus), sum: true },
  ];

  const moved: YearSection[] = some(y.conversion) ? [{ title: 'Moved, not spent', lines: line('Converted to Roth', y.conversion), note: 'From tax-deferred to Roth. None of it is spent, but it counts as income below.' }] : [];

  const gains = y.income.qualified + d.gain;
  const income: YearSection = {
    title: 'Income the law counts',
    lines: [
      { label: 'Ordinary income', value: money(Math.max(0, y.law.agi - Math.max(0, gains))) },
      ...(some(y.law.taxableSocialSecurity) ? [{ label: 'of it Social Security', value: money(y.law.taxableSocialSecurity), part: true }] : []),
      ...(some(y.conversion) ? [{ label: 'of it converted to Roth', value: money(y.conversion), part: true }] : []),
      ...line('Gains and qualified dividends', Math.max(0, gains)),
      ...(onAca(y) ? line('Social Security that isn’t taxed, which the ACA counts', y.law.magiAca - y.law.agi) : []),
      onAca(y) ? { label: 'ACA income (MAGI)', value: money(y.law.magiAca), sum: true } : { label: 'Adjusted gross income', value: money(y.law.agi), sum: true },
    ],
  };
  // The limit and its meter only for someone on the ACA (D10).
  if (onAca(y)) {
    const percent = y.care.povertyPercent;
    const limit = c.acaLaw === '2026' ? 400 : null;
    const family = y.care.family;
    income.meter = { percent: Math.min(100, (percent / POVERTY_SCALE) * 100), limit: limit === null ? null : (limit / POVERTY_SCALE) * 100, label: `${Math.round(percent)}% of the poverty line, for ${family} ${family === 1 ? 'person' : 'people'}`, limitLabel: limit === null ? null : percent > 0 ? `Limit ${limit}%, ${money((y.law.magiAca / percent) * limit)}` : `Limit ${limit}%` };
  }

  const tax: YearSection = {
    title: 'How the tax is worked out',
    lines: [
      { label: `Ordinary income, after ${money(y.law.deduction)} in deductions`, value: money(y.law.ordinaryTaxable) },
      { label: `Tax on it, up to the ${pct(y.law.topRate)} bracket`, value: money(y.law.ordinaryTax) },
      ...(some(gains) ? [{ label: 'Tax on gains and dividends, on top', value: money(y.law.gainsTax) }] : []),
      ...line('Tax on investment income', y.law.niit),
      some(y.law.penalty) ? { label: 'Early withdrawal penalty', value: money(y.law.penalty) } : { label: 'Early withdrawal penalty', value: 'None' },
    ],
  };
  const taxableIncome = Math.max(0, y.law.agi - y.law.deduction);
  // A loss carried in can leave gains untaxed above that line, which this wouldn't explain.
  if (some(gains) && !some(y.law.gainsTax) && taxableIncome <= c.gainsZeroTo) tax.why = { label: 'Why are the gains taxed at 0%?', text: `Gains stack on top of ordinary income. They’re taxed at 0% while taxable income stays under ${money(c.gainsZeroTo)}, and this year’s is ${money(taxableIncome)}.` };
  else if (some(y.law.penalty)) tax.why = { label: 'Why a penalty?', text: 'Money drawn early pays a penalty on top of its tax, once the money that can be reached without one has run out: 10% from tax-deferred money, a Roth conversion under five years old or a Roth’s earnings before 59½, 20% from an HSA before 65. Nya knows your age in whole years, so the year you turn 59 counts as before 59½.' };

  const [you, them] = y.care.people;
  const people = y.partnerAge === null ? [you] : [you, them];
  const total = (pick: (p: PersonCare) => number) => people.reduce((n, p) => n + pick(p), 0);
  const credit = total((p) => p.credit) + y.care.dependents.credit;
  const health: YearSection = {
    title: 'Health coverage',
    lines: [
      ...(onAca(y) ? line(benchmarkLabel(y), y.care.benchmark) : []),
      ...(some(credit) ? [{ label: 'Premium tax credit', value: money(-credit) }] : []),
      ...line('Medicare Part B', total((p) => p.partB)),
      ...line('Medicare income surcharge (IRMAA)', total((p) => p.irmaa)),
      ...line('Part D or a supplement', total((p) => p.extra)),
      ...line('The coverage you typed', total((p) => p.typed)),
      { label: 'You pay', value: money(y.health), sum: true },
    ],
  };
  const notes: string[] = [];
  if (onAca(y) && y.care.figure > 0) {
    // Only the 2026 schedule is indexed, so only its later years are a projection.
    const projected = c.acaLaw === '2026' && y.calendarYear > c.lawYear ? `, as projected to ${y.calendarYear}` : '';
    notes.push(some(credit) ? `At this income, the law sets your share of the benchmark plan at ${pct(y.care.figure, 2)} of income${projected}.` : `At this income your share, ${pct(y.care.figure, 2)} of income, comes to more than the benchmark plan, so there is no credit.`);
  }
  if (y.care.overLimit && c.acaLaw === '2026') notes.push(`Over 400% of the poverty line, ${y.care.povertyPercent > 0 ? `${money((y.law.magiAca / y.care.povertyPercent) * 400)} for ${y.care.family}, ` : ''}there is no credit, so coverage is counted at full price.`);
  const covered = people.filter((p) => p.status === 'medicaid');
  if (y.care.underLine && !adultUnderLine(y)) {
    notes.push('Your dependents are under Medicaid’s line for children, and counted at full price, as you chose.');
  } else if (y.care.underLine) {
    if (covered.length > 0) notes.push('Under the Medicaid line, so Medicaid covers who meets its rule, with no premium.');
    else if (hasMedicaidLine(y, c.medicaid)) notes.push('Under the Medicaid line with no credit, so coverage is counted at full price.');
    else notes.push(`Under 100% of the poverty line there is no credit${stateName ? `, and ${stateName} has no Medicaid for most adults` : ''}, so coverage is counted at full price.`);
  } else if (covered.length > 0) {
    const who = y.partnerAge === null ? 'you' : covered.length === 2 ? 'you both' : covered[0] === you ? 'you' : 'your partner';
    notes.push(`Under the Medicaid line, so Medicaid covers ${who}, with no premium.`);
  }
  if (y.care.irmaaUnknown) notes.push('IRMAA reads income from two years back, before this plan’s years, so it isn’t counted here.');
  if (notes.length > 0) health.note = notes.join(' ');

  const sources = source.length > 0 ? [...source, { label: 'Total', value: money(sourceTotal), sum: true }] : [{ label: 'Nothing', value: money(0) }];
  return [{ title: 'Where the money comes from', lines: sources }, { title: 'What it pays for', lines: pays }, ...moved, income, tax, health];
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

/** What the FI number's own tax and health come to a year, before the withdrawal rate. */
export const fiYearly = (s: Pick<FiShares, 't' | 'h' | 'spending' | 'paid'>) => (Math.max(0, s.spending - s.paid) + s.h) / (1 - s.t);

/** The FI number's sum, line by line, on its own sheet and on Tax after you stop. Each
 *  figure is rounded before tax is taken as what's left, so the lines add up as written.
 *  `health` is null on a flat plan, which has no such line. */
export function fiLines(a: { spending: number; spendingLabel?: string; paid: number; health: number | null; t: number; tText: string; rate: number; worked: number; own: boolean }, money: Money): YearLine[] {
  const spending = Math.round(a.spending);
  const paid = Math.round(Math.min(a.paid, a.spending));
  const health = a.health === null ? 0 : Math.round(a.health);
  const draw = Math.round(a.worked * a.rate);
  return [
    { label: a.spendingLabel ?? 'Spending', value: money(spending) },
    ...(paid >= 1 ? [{ label: 'Coverage you already pay for, taken off', value: money(-paid) }] : []),
    ...(a.health !== null ? [{ label: 'Health coverage, on average', value: money(health) }] : []),
    ...(a.t > 0 ? [{ label: `Tax, ${a.tText} of what you draw`, value: money(draw - spending + paid - health) }] : []),
    { label: 'What you’d draw each year', value: money(draw), sum: true },
    { label: a.own ? `Worked out, at a ${pct(a.rate)} withdrawal rate` : `At a ${pct(a.rate)} withdrawal rate`, value: money(a.worked), sum: true },
  ];
}

/** What the run behind the FI number says of how it was worked out. A small back and
 *  forth isn't said: the number moves by less than it can be known to. */
export function sharesNote(s: Pick<FiShares, 'settled' | 'gap' | 'noMix'>, money: Money): string[] {
  const out: string[] = [];
  if (!s.settled && s.gap > 1000) out.push(`Your FI number’s tax and health move with it and didn’t settle on one figure: its last two were ${money(s.gap)} apart, and this takes the higher.`);
  if (s.noMix) out.push(NOTE_WORDS['no-mix'] as string);
  return out;
}

/** The last line of Tax after you stop: what it all rests on. */
export function taxHypothetical(a: { lawYear: number; state: StateCode | null; stateRate: number; stateTaxes: boolean | null; converts: boolean; realReturn: number; healthGrowth: number }): string {
  const state = a.state === null ? 'no state tax counted' : a.stateTaxes === false || a.stateRate === 0 ? `${STATE_NAMES[a.state]} with no income tax` : `${STATE_NAMES[a.state]} at ${pct(a.stateRate, 1)}`;
  return `Hypothetical: ${a.lawYear} federal tax law held in today’s dollars, ${state}, ${a.converts ? 'the conversion rule you picked' : 'no conversions'}, a steady ${pct(a.realReturn)} after inflation, and health costs rising ${healthPace(a.healthGrowth)}. Not tax advice.`;
}

/** A joint plan's one line (the tax plan's Plan outcomes). */
export const survivorLine = (endAge: number) => `Assumes you both live to ${endAge}. A survivor files single, at higher rates.`;

export const HEALTH_NOT_SET = 'Not set: measured spending leaves out coverage through work.';

/** The Health coverage row's sub. */
export function healthSub(choices: TaxChoices, inNumber: boolean): string {
  const before = choices.health.beforeMedicare;
  if (!before) return 'Not set yet';
  return `${before.kind === 'aca' ? 'ACA' : 'Your own coverage'} before 65, then Medicare${inNumber ? ' · in your FI number' : ''}`;
}

/** Each part of coverage in each stage, a year on average, as the years have it. */
export function stageHealthLines(stages: readonly DrawdownStage[], years: readonly DrawdownYear[], money: Money): { title: string; lines: YearLine[] }[] {
  return stages.flatMap((s) => {
    const rows = years.slice(s.first, s.last);
    if (rows.length === 0) return [];
    const mean = (pick: (y: DrawdownYear) => number) => rows.reduce((n, y) => n + pick(y), 0) / rows.length;
    const both = (y: DrawdownYear, pick: (p: PersonCare) => number) => pick(y.care.people[0]) + (y.partnerAge === null ? 0 : pick(y.care.people[1]));
    const line = (label: string, n: number): YearLine[] => (some(n) ? [{ label, value: money(n) }] : []);
    const credit = mean((y) => both(y, (p) => p.credit) + y.care.dependents.credit);
    return [
      {
        title: stageTitle(s),
        lines: [
          ...line('Premiums, full price', mean((y) => both(y, (p) => p.premium) + y.care.dependents.premium)),
          ...(some(credit) ? [{ label: 'Premium tax credit', value: money(-credit) }] : []),
          ...line('Medicare Part B', mean((y) => both(y, (p) => p.partB))),
          ...line('Medicare income surcharge (IRMAA)', mean((y) => both(y, (p) => p.irmaa))),
          ...line('Part D or a supplement', mean((y) => both(y, (p) => p.extra))),
          ...line('The coverage you typed', mean((y) => both(y, (p) => p.typed))),
          { label: 'You pay', value: money(mean((y) => y.health)), sum: true },
        ],
      },
    ];
  });
}

/** What the Assumptions row says of a detailed plan, beside its flat rate. */
export const assumptionsLine = (choices: Pick<TaxChoices, 'inflation'>, growth: number) => `${pct(choices.inflation)} inflation · health costs ${points(Math.abs(growth))} ${growth < 0 ? 'below' : 'above'} inflation`;

/** The Assumptions row of a plan whose tax has its own row. */
export const assumptionsWorked = (plan: { withdrawalRate: number; realReturn: number; partTimeIncome: number }, choices: Pick<TaxChoices, 'inflation'>, growth: number, money: Money) =>
  `${pct(plan.withdrawalRate)} withdrawal · ${pct(plan.realReturn)} growth · ${assumptionsLine(choices, growth)}${plan.partTimeIncome > 0 ? ` · ${money(plan.partTimeIncome)} part-time` : ''}`;

/** Under measured spending, a name for what could already be paying for coverage. */
export const namesCoverage = (name: string) => /\b(health|medical|dental)\b/i.test(name) && /\b(insurance|premiums?|coverage)\b/i.test(name);

type NoteArgs = {
  today: Pick<BucketsToday, 'groups' | 'roth'> | null;
  choices: TaxChoices;
  items: readonly Pick<PlanItem, 'kind' | 'beforeTax' | 'label'>[];
  law: { year: number; behind: boolean } | null;
  /** What measured spending holds under a name for health insurance, while nothing
   *  has said whether it is the coverage below. */
  unansweredPaid: { name: string; amount: number } | null;
  money: Money;
};

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const adder = (notes: FigureNote[]) => (level: FigureNote['level'], kind: string, text: string) => notes.push({ key: `detail:${kind}`, level, kind, text });

/** What the person hasn't said of their accounts and income. */
function accountNotes(a: Pick<NoteArgs, 'today' | 'items'>): FigureNote[] {
  const notes: FigureNote[] = [];
  const add = adder(notes);
  const groups = a.today?.groups ?? [];
  const unclassified = groups.find((g) => g.bucket === 'unclassified')?.accounts.length ?? 0;
  if (unclassified > 0) add('caution', 'no tax bucket', `${counted(unclassified, 'account has', 'accounts have')} no tax bucket, counted as tax-deferred. Set ${unclassified === 1 ? 'it' : 'them'} on Invested assets.`);
  const noBasis = groups.find((g) => g.bucket === 'taxable')?.accounts.filter((x) => x.basisFrom === 'none').length ?? 0;
  if (noBasis > 0) add('caution', 'no cost basis', `${counted(noBasis, 'taxable account has', 'taxable accounts have')} no cost basis, so all of ${noBasis === 1 ? 'it' : 'them'} counts as gain. Say what you paid on Invested assets.`);
  const rothOwners = new Set(groups.find((g) => g.bucket === 'roth')?.accounts.map((x) => x.owner));
  for (const r of a.today?.roth ?? []) {
    if (r.amount !== null || !rothOwners.has(r.owner)) continue;
    const who = r.owner === ('you' satisfies Owner) ? 'your' : 'your partner’s';
    add('caution', r.owner === 'you' ? 'Roth put-in not given' : 'partner’s Roth put-in not given', `What went into ${who} Roth isn’t given, so none of it counts as reachable before 59½. Say how much on Invested assets.`);
  }
  const afterTax = a.items.filter((x) => x.beforeTax === false && (x.kind === 'pension' || x.kind === 'social-security' || x.kind === 'other-income'));
  if (afterTax.length > 0) add('caution', 'income after tax', `${words(afterTax.map((x) => x.label))} ${afterTax.length === 1 ? 'is' : 'are'} given after tax, so ${afterTax.length === 1 ? 'it isn’t' : 'they aren’t'} in your ACA income. Give ${afterTax.length === 1 ? 'it' : 'them'} before tax on your Timeline.`);
  const partTime = a.items.filter((x) => x.beforeTax === false && x.kind === 'part-time');
  if (partTime.length > 0) add('caution', 'part-time after tax', `${words(partTime.map((x) => x.label))} ${partTime.length === 1 ? 'is' : 'are'} given after tax, which may hide a year over the ACA limit.`);
  return notes;
}

/** The ones Needs attention lists too (the tax plan's Honesty): Home reads only what
 *  these need, so no plan is worked out for them. */
const ON_HOME = new Set(['no tax bucket', 'Roth put-in not given', 'partner’s Roth put-in not given', 'income after tax']);
export const attentionNotes = (a: Pick<NoteArgs, 'today' | 'items'>): FigureNote[] => accountNotes(a).filter((n) => ON_HOME.has(n.kind));

/** Each gap in what the drawdown rests on (the tax plan's Honesty), in its level: for
 *  Drawdown's notice and the sheet each is about. A flat plan draws none of them. */
export function honestyNotes(a: NoteArgs): FigureNote[] {
  const notes = accountNotes(a);
  const add = adder(notes);
  if (a.choices.state === null) add('caution', 'no household', 'No state given: counted with no state tax and no Medicaid expansion. Set your state on Household.');
  if (a.choices.health.beforeMedicare === null) add('caution', 'health not set', 'Health coverage isn’t set: no cost before 65, then Medicare Part B only. Measured spending leaves out coverage through work.');
  if (a.unansweredPaid) add('caution', 'coverage counted twice', `Your spending has ${a.money(a.unansweredPaid.amount)} a year in ${a.unansweredPaid.name}. If that’s the coverage below, say so on Health coverage, so it isn’t counted twice.`);
  if (a.law?.behind) add('caution', 'older tax law', `Uses ${a.law.year} tax law, the newest Nya has.`);
  return notes;
}

/** Household's own, since these name what can't be set there. */
export function householdNotes(a: { facts: Pick<TaxFacts, 'dependents'>; choices: Pick<TaxChoices, 'state'> }): FigureNote[] {
  const notes: FigureNote[] = [];
  if (a.choices.state === null) notes.push({ key: 'detail:no-state', level: 'caution', kind: 'no household', text: 'No state given: counted with no state tax and no Medicaid expansion.' });
  if (a.choices.state === 'WA') notes.push({ key: 'detail:washington', level: 'info', kind: 'Washington', text: 'Washington taxes capital gains only, which isn’t counted here.' });
  if (a.facts.dependents.length > 0) notes.push({ key: 'detail:dependents', level: 'caution', kind: 'dependents', text: 'Dependents count in your household’s size. The child tax credit and head of household aren’t counted.' });
  return notes;
}

/** About these numbers, under a detailed plan: how tax is worked out, what stands in
 *  for what, and what isn't modeled. */
export const ABOUT_DETAIL = {
  how: 'Drawdown works out each year from your accounts at a steady return: federal income tax, your state’s one rate, penalties, required withdrawals and health coverage, under one year’s law held in today’s dollars. Your FI number takes its tax and health coverage from those years run from the FI number itself, so it doesn’t move with where a plan starts. Will it last? works out the same years in every start, on that start’s own returns and inflation. Its grid does that for every sixth start, or 250 runs, to keep it quick.',
  standIns: [
    'Of dividends and interest, 75% counts as qualified.',
    'Only premiums count as health costs: deductibles, coinsurance, dental, vision and hearing don’t. Premiums are about 45% of a 65-year-old’s lifetime health costs (Fidelity’s 2026 estimate).',
    'Your state takes one rate on ordinary income and gains, with Social Security left out. Washington’s tax on capital gains isn’t counted.',
    'Medicare’s income surcharge (IRMAA) reads your income from two years before, and nothing for a year with no such year in the plan.',
    'Where a flexible rule’s spending falls to your average health cost in a run, it holds there: all of it goes to coverage, with nothing left to live on.',
    'An education account you count stands in as tax-deferred.',
    'What’s left at the end takes taxable at full value, Roth as it is, and tax-deferred and an HSA after the federal tax on drawing them evenly over ten years, bracket by bracket on top of the last year’s income, the way most heirs must draw an IRA. An heir’s own income, a state’s tax and an HSA taxed all at once aren’t counted, which favours a rule that leaves more tax-deferred.',
    'A year you’d draw before you stop has no wages counted beside it.',
  ],
  notModeled: 'Not modeled: the rule of 55 and 72(t) payments, either of which can reach tax-deferred money before 59½ with no penalty; the child tax credit and head of household filing; nondeductible IRA basis and its pro-rata rule; specific-lot sales; the chained-CPI drift of brackets; tax drag on taxable accounts before you stop; Roth 401(k) withdrawals before 59½, counted as not reachable unless you say; the self-employed health insurance deduction; rating only the three oldest children under 21; the 0.9% Additional Medicare Tax; the Roth five-year rule for earnings at 60, taken as met; the Medicaid work rule’s exemptions and month-by-month test; Basic Health Programs; children’s Medicaid and CHIP lines above 138%; the joint life table for a spouse more than 10 years younger; and putting the first required withdrawal off to April.',
} as const;

/** The Household row's line. */
export function householdLine(facts: Pick<TaxFacts, 'filing'>, choices: Pick<TaxChoices, 'state'>): string {
  return [facts.filing === 'joint' ? 'joint' : 'single', choices.state ? STATE_NAMES[choices.state] : 'no state yet'].join(' · ');
}
