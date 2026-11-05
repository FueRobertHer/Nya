// components/plan-scenario-text.ts
//
// The words a plan's settings and items are said in: each setting and item,
// each life event and where it counts, what a plan starts with, why the walk
// stops. Kept apart from the components so the exact sentences can be
// tested (test/plan-compare.test.tsx). Every amount goes through the `money`
// a caller gives (components/plan-text.ts wholeMoney), so hidden amounts
// stay hidden. No engine, no data.

import { allocationOf, type FirePlan, type PlanExpense, type PlanIncome } from '@/lib/fire/plan';
import { carAges, type EventPart, type LifeEvent, type Shortfall } from '@/lib/fire/events';
import type { PlanFigures, StartsWith } from '@/lib/fire/plan-figures';
import type { SetField } from '@/lib/fire/plan-list';
import { RULE_NAMES, REBALANCE_TEXT, pct } from './plan-text';

type Money = (n: number) => string;

export const SETTING_NAMES: Record<SetField, string> = {
  targetAge: 'Stop age',
  spending: 'Annual spending',
  savings: 'Annual savings',
  assets: 'Invested assets',
  withdrawalRate: 'Withdrawal rate',
  realReturn: 'Growth after inflation until FI',
  taxRate: 'Tax on withdrawals',
  rule: 'Withdrawal rule',
  floor: 'Floor',
  ceiling: 'Ceiling',
  start: 'Where the simulation starts',
  startBalance: 'Starting balance',
  horizon: 'Length',
  mix: 'Stock and bond mix',
  rebalance: 'Rebalancing',
  fee: 'Fund fees',
};

const START_NAMES: Record<FirePlan['start'], string> = {
  'fi-number': 'your FI number, at the stop age',
  assets: 'your invested assets, today',
  custom: 'a balance you typed, at the stop age',
  'at-stop': 'what you’d have at the stop age',
};

/** A setting's value in words. */
export function settingText(field: SetField, value: unknown, money: Money): string {
  if (field === 'mix') {
    const m = value as { stocksPct: number; bondsPct: number };
    const a = allocationOf({ stocksPct: m.stocksPct, bondsPct: m.bondsPct } as FirePlan);
    return `${pct(a.stocks, 0)} stocks, ${pct(a.bonds, 0)} bonds, ${pct(a.cash, 0)} cash`;
  }
  switch (field) {
    case 'targetAge':
      return value === null ? 'not set' : `${value}`;
    case 'spending':
    case 'savings':
      return value === null ? 'Nya’s measured figure' : `${money(value as number)} a year`;
    case 'assets':
      return value === null ? 'Nya’s measured figure' : money(value as number);
    case 'startBalance':
      return value === null ? 'not set' : money(value as number);
    case 'withdrawalRate':
    case 'realReturn':
    case 'taxRate':
    case 'fee':
    case 'floor':
    case 'ceiling':
      return pct(value as number);
    case 'rule':
      return RULE_NAMES[value as FirePlan['rule']];
    case 'start':
      return START_NAMES[value as FirePlan['start']];
    case 'horizon':
      return value === null ? 'to age 95' : `${value} years`;
    case 'rebalance':
      return REBALANCE_TEXT[value as FirePlan['rebalance']];
  }
}

export function itemText(list: 'income' | 'expenses', item: PlanIncome | PlanExpense, money: Money): string {
  if (list === 'income') {
    const x = item as PlanIncome;
    return `${money(x.amount)} a year from age ${x.fromAge}${x.inflationAdjusted ? ', rising with inflation' : ', fixed'}`;
  }
  const x = item as PlanExpense;
  return `${money(x.amount)} at age ${x.atAge}`;
}

const span = (years: number | null) => (years === null ? 'for good' : `for ${years} year${years === 1 ? '' : 's'}`);
const moreOrLess = (yearly: number, money: Money) => (yearly >= 0 ? `${money(yearly)} a year more` : `${money(-yearly)} a year less`);

/** A life event's figures, in a sentence. */
export function eventText(e: LifeEvent, money: Money): string {
  switch (e.kind) {
    case 'house': {
      const cost = e.cost > 0 ? `${money(e.cost)} from your investments` : 'nothing from your investments';
      const change = e.yearly !== 0 ? `, then spending ${moreOrLess(e.yearly, money)} ${span(e.years)}` : '';
      return `At ${e.atAge}: ${cost}${change}.`;
    }
    case 'child':
      return `From ${e.fromAge}: spending ${money(e.yearly)} a year more, for ${e.years} year${e.years === 1 ? '' : 's'}.`;
    case 'sabbatical':
      return `From ${e.fromAge}, for ${e.years} year${e.years === 1 ? '' : 's'}: saving ${money(e.savingsLost)} a year less.`;
    case 'part-time':
      return `From ${e.fromAge} to ${e.toAge}: ${money(e.yearly)} a year after tax.`;
    case 'spending':
      return `From ${e.fromAge}: spending ${moreOrLess(e.yearly, money)}, ${span(e.years)}.`;
    case 'car': {
      if (e.every === null) return `At ${e.atAge}: ${money(e.cost)} from your investments.`;
      const ages = carAges(e);
      return `From ${e.atAge}, every ${e.every} years, ${e.times} in all (the last at ${ages[ages.length - 1]}): ${money(e.cost)} each from your investments.`;
    }
    case 'raise':
      return `From ${e.fromAge}: saving ${money(e.yearly)} a year more.`;
    case 'windfall':
      return `At ${e.atAge}: ${money(e.amount)} in, after tax.`;
    case 'loan-end':
      return `From ${e.atAge}: spending ${money(e.yearly)} a year less, for good.`;
  }
}

export const EVENT_PART_TEXT: Record<EventPart, string> = {
  past: 'Some of it is before today: it counts from today, and your measured figures may already count what has begun.',
  already: 'It is before today, so it is left out: your measured figures may already count it.',
  'no-today': 'Without your age there is no today to count from, so the FI date leaves it out; the simulation places it from the stop age.',
  'no-today-walk': 'Without your age there is no today to count from, so it is left out: it counts only in the FI date.',
  'no-age': 'Without your age or a stop age it can’t be placed, so it is left out.',
  retired: 'Its years from the stop age change nothing: by then you have stopped working.',
  'before-start':
    'Its years before the stop age are left out: in this plan you work full time until then. For part-time work in place of full-time work, set this plan’s stop age to when full-time work stops.',
  'after-end': 'Some of it is after the plan ends: only the grid’s longer columns reach it.',
};

/** What a plan starts with, and what the walk says it would have then.
 *  `shortWhere` is where the shortfall that stops the walk is said: below,
 *  in compare mode; on Your path, from the simulation's card; or null, said
 *  here, from today's `age`, when nothing else says it. */
export function startsWithText(sw: StartsWith, money: Money, shortWhere: string | null = 'below', age: number | null = null): string {
  const from = sw.from === 'fi-number' ? 'your FI number' : sw.from === 'assets' ? 'your invested assets today' : sw.from === 'at-stop' ? 'what you’d have' : 'the balance you typed';
  const at = sw.from === 'assets' ? '' : sw.atAge !== null ? ` at ${sw.atAge}` : ' at the stop age';
  const head = `${money(sw.balance)}, ${from}${at}`;
  if (sw.from === 'assets') return `${head}.`;
  if (sw.short && shortWhere === null) return `${head}: it would never get that far. ${shortText(sw.short, age, money, `it never gets to ${sw.atAge ?? 'the stop age'}`)}`;
  if (sw.short) return `${head}: it would never get that far (${shortWhere}).`;
  if (sw.projected === null) return `${head}.`;
  if (!sw.more) return `${head}: you’d have about ${money(sw.projected)} then.`;
  return `${head}: you’d have about ${money(sw.projected)} then, ${money(sw.balance - sw.projected)} less.`;
}

/** Drawdown's start line (the tax plan's P), under Will it last?'s answer:
 *  what it starts from, against what the steady path has where Whole path
 *  starts drawing. Said for a start with less than that (a start with more
 *  keeps its caution, in startsWithText's words), and for a start from
 *  today's assets before the stop, either way. Null when they match (within
 *  50 cents, as `more` is), or with nothing to set it against. */
export function startLineText(sw: StartsWith, money: Money, at: { age: number | null; stopAge: number | null; atStop: number | null }): string | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  if (sw.from === 'assets') {
    const { age, stopAge, atStop } = at;
    // Once the stop has come, today's assets are where Whole path starts.
    if (age === null || stopAge === null || stopAge <= age || atStop === null || near(sw.balance, atStop)) return null;
    return `Starting today, at ${age}, from your invested assets, ${money(sw.balance)}, not the ${money(atStop)} you’d have at ${stopAge}.`;
  }
  if (sw.more || sw.projected === null || near(sw.balance, sw.projected)) return null;
  const from = sw.from === 'fi-number' ? 'your FI number' : 'the balance you typed';
  const then = at.age !== null && sw.atAge !== null && sw.atAge <= at.age ? 'you have today' : `you’d have at ${sw.atAge}`;
  return `Starting from ${from}, ${money(sw.balance)}, not the ${money(sw.projected)} ${then}.`;
}

/** Why the walk stops: with no FI date, or (`what`) with nothing else it
 *  would have reached. */
export function shortText(short: Shortfall, age: number | null, money: Money, what = 'there is no FI date'): string {
  const when = age !== null ? `at ${age + short.year}` : `in ${short.year} year${short.year === 1 ? '' : 's'}`;
  // Nothing grows from below zero: the walk and the projection stop there.
  if (short.have < 0) return `Your invested assets are below zero (${money(short.have)}) ${when}, so ${what}.`;
  return short.kind === 'cost'
    ? `You’d have about ${money(short.have)} ${when}, less than the ${money(short.need)} it takes from your investments, so ${what}: change the cost, or when it comes.`
    : `You’d have about ${money(short.have)} ${when}, and that year takes ${money(short.need)} out, more than there is, so ${what}.`;
}

/** The lasting changes in the FI number. Worked out, those are the ones at the
 *  stop, which a plan starting from today hasn't all reached where its own
 *  `retirement` reads them. */
export function numberSpending(f: Pick<PlanFigures, 'retirement' | 'shares' | 'view'>): PlanFigures['retirement'] {
  if (!f.shares) return f.retirement;
  const today = f.view.spending.value;
  if (today === null || f.shares.spending === today) return null;
  return { spending: f.shares.spending, lasting: f.shares.spending - today };
}

/** Retirement spending with lasting changes, beside the FI number. */
export function retirementText(spending: number, lasting: number, today: number, money: Money): string {
  return `${money(spending)} a year in retirement: ${money(today)} now, ${lasting >= 0 ? 'and' : 'less'} ${money(Math.abs(lasting))} a year of lasting changes from this plan’s items`;
}

/** Lasting changes that start after the retirement age, which the FI number
 *  leaves out and the simulation counts. */
export function laterText(later: { amount: number; fromAge: number }[], money: Money): string | null {
  if (later.length === 0) return null;
  const parts = later.map((l) => `${moreOrLess(l.amount, money)} from ${l.fromAge}`);
  return `The FI number leaves out ${parts.join(' and ')}, which the simulation counts.`;
}

export function currencyText(typedIn: string, planIn: string, known = true): string {
  if (!known) return `Its amounts were typed in ${typedIn}, and which currency your plan’s figures are in isn’t known yet (at the top of the Plan tab). Nothing is converted, so it isn’t worked out until you have said.`;
  return `Its amounts were typed in ${typedIn}, and your plan is now in ${planIn}. Nothing is converted, so it isn’t worked out: check its amounts, then say they are in ${planIn}.`;
}
