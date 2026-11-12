// lib/demo-seed/scenarios.ts
//
// The kinds of data a demo account can be reset to (lib/demo-seed/reset.ts),
// for trying Nya as different people or testing it against different shapes
// of money. Each builds a profile (lib/demo-seed/profiles.ts) as of a day. A
// new kind of test data is one more entry here.
//
// Safe to import from the page: the list says what each is, and nothing here
// reads storage.

import { demoProfile, type DemoName, type DemoProfile } from './profiles';
import { earlyRetiree, needsAttention, vanguardHistory } from './scenario-profiles';

export type Scenario = {
  id: string;
  title: string;
  /** One line, for the Demo data card. */
  description: string;
  build(today: string): DemoProfile;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'single-renter',
    title: 'Single renter',
    description: 'One income and a rented flat: a card, a student loan, three investment accounts, saving about half of what comes in.',
    build: (today) => demoProfile('Alex', today),
  },
  {
    id: 'household',
    title: 'Two-income household',
    description: 'Two incomes and a child: a mortgage, a car loan, a family card and six investment accounts.',
    build: (today) => demoProfile('Sam', today),
  },
  {
    id: 'early-retiree',
    title: 'Early retiree',
    description: 'Stopped work at 44, now 47: living on a taxable brokerage drawn on each month, consulting now and then, ACA cover and Roth conversions planned.',
    build: (today) => earlyRetiree(today),
  },
  {
    id: 'needs-attention',
    title: 'Needs attention',
    description: 'The single renter with things to fix: a loan to sign in to again, a connection ending soon, new accounts, an account at $0. No estimated history while a bank needs signing in.',
    build: (today) => needsAttention(today),
  },
  {
    id: 'vanguard-history',
    title: 'History from Vanguard',
    description: 'The single renter with the brokerage at Vanguard: its months since it opened four years ago imported from Vanguard’s Performance page, before Nya’s own.',
    build: (today) => vanguardHistory(today),
  },
];

/** What each demo account is reset to unless another is chosen. */
export const DEFAULT_SCENARIO: Readonly<Record<DemoName, string>> = { Alex: 'single-renter', Sam: 'household' };

export function scenarioById(id: unknown): Scenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

/** What the page is told of each. */
export type ScenarioView = { id: string; title: string; description: string };
export const scenarioViews = (): ScenarioView[] => SCENARIOS.map(({ id, title, description }) => ({ id, title, description }));
