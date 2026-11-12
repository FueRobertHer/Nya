// lib/demo-seed/extras.ts
//
// What a demo profile (lib/demo-seed/profiles.ts) says beyond its banks,
// budgets, goals and Plan: what someone who had used Nya for a year would
// have set up by now (tags, rules, a split, people they share costs with,
// their deposits and withdrawals, plan copies), and what a scenario puts
// wrong (a connection that needs signing in again). lib/demo-seed/fill.ts
// writes each through its own store, as its route does.
//
// A transaction is named by the row the profile made for it (RowRef): the
// account's mask, its day, amount and description, which is how the seed
// finds the transaction Plaid made from it.
//
// Categories are named by Plaid's primary key (FOOD_AND_DRINK), as budgets
// are, and found in the taxonomy the seed makes. Pure: types and one helper.

import type { AllocationSettings } from '../allocation/settings';
import type { Conversions } from '../fire/tax-choices';
import type { FirePlanV2 } from '../fire/plan-v2';
import type { PlanItem } from '../fire/items';
import type { SeedTxn } from './profiles';

/** One of the profile's rows, as the seed finds the transaction Plaid made of it. */
export type RowRef = { mask: string; date: string; amount: number; description: string };

/** The row `row` (on the account ending `mask`) names, or null for one the
 *  profile never made (a day after today). */
export const ref = (mask: string, row: SeedTxn | null): RowRef | null =>
  row === null ? null : { mask, date: row.date, amount: row.amount, description: row.description };

/** A plan item, every field its kind doesn't take at its resting value
 *  (lib/fire/items.ts: null, `inflationAdjusted` true, `beforeTax` false). */
export const planItem = (item: Pick<PlanItem, 'id' | 'label' | 'kind' | 'from'> & Partial<PlanItem>): PlanItem => ({
  until: null,
  once: null,
  yearly: null,
  replaces: null,
  every: null,
  times: null,
  inflationAdjusted: true,
  owner: null,
  beforeTax: false,
  ...item,
});

/** From an age (yours, or the partner's for a partner's item). */
export const atAge = (age: number, offset = 0) => ({ anchor: { at: 'age' as const, age }, offset });
/** From the plan's stop. */
export const atStop = (offset = 0) => ({ anchor: { at: 'stop' as const }, offset });

/** A rule, matching the words a transaction's name contains (or is). */
export type SeedRule = {
  name: string;
  op?: 'contains' | 'equals';
  rename?: string;
  tags?: string[];
  category?: string;
  hide?: true;
  /** Left off: the rule is kept but doesn't apply. */
  off?: true;
};

/** A transactions download from Vanguard, imported (lib/demo-seed/
 *  imports.ts): the profile's rows for the accounts `masks` names, from
 *  `from` to the day before `made`, the day it was downloaded and imported. */
export type SeedImport = {
  source: 'vanguard-csv' | 'vanguard-qfx';
  file_name: string;
  masks: string[];
  from: string;
  made: string;
  /** A CSV's Transaction Type for each cash row, by the profile's name for
   *  it ('Funds Received', 'Contribution', 'Conversion (incoming)'). */
  kinds?: Record<string, string>;
};

/** A copy of your plan, as Duplicate makes one: your plan with `set` over it,
 *  the items `drop` names taken out and `add` put in. */
export type SeedCopy = { name: string; set?: Partial<FirePlanV2>; drop?: string[]; add?: PlanItem[] };

export type SeedExtras = {
  /** Tags, by name, made before anything puts them on. */
  tags?: string[];
  rules?: SeedRule[];
  /** Tags, a note or an exclusion on one transaction. */
  marks?: { row: RowRef | null; tags?: string[]; note?: string; excluded?: true }[];
  /** A transaction filed under another category, as choosing one does: the
   *  merchant's choices count toward its default. */
  recategorized?: { row: RowRef | null; category: string }[];
  splits?: { row: RowRef | null; parts: { share: number; category: string; note?: string }[] }[];
  groups?: { name: string; category: string; rows: (RowRef | null)[] }[];
  /** People costs are shared with, by name. */
  people?: string[];
  /** A transaction shared: each person's part, by name. */
  shares?: { row: RowRef | null; what: string; parts: { person: string; amount: number }[] }[];
  ious?: { person: string; direction: 'to_you' | 'by_you'; amount: number; date: string; what: string; category?: string }[];
  /** The review queue on, from so many days back. */
  review?: { daysBack: number };
  /** Budgets (by Plaid key) that roll over, from the first month of the history. */
  rollover?: string[];
  /** Income carryover on, from the first month of the history. */
  incomeCarryover?: true;
  /** A budget on the group a Plaid key's category is in. */
  groupBudgets?: { key: string; amount: number }[];
  planned?: { items: { name: string; kind: 'expense' | 'income'; amount: number; date: string; cadence: 'once' | 'monthly' | 'quarterly' | 'semiannual' | 'yearly' }[]; threshold: number | null };
  /** Categories (by Plaid key) marked for the accountant's report. */
  reportMarked?: string[];
  runway?: { name: string; months: 3 | 6 | 12; lower_by: number; income_until: string | null; planned: boolean; leave_out_one_offs: boolean }[];
  /** An investment account's deposits and withdrawals, as of a day. */
  moneyInOut?: { mask: string; in: number; out: number; as_of: string }[];
  /** Months imported from Vanguard's Performance page, made up
   *  (lib/demo-seed/past-months.ts): from the month the account opened, so
   *  many months back, to last month, with `monthlyBefore` paid in each month
   *  before the activity Plaid shares. */
  investmentMonths?: { mask: string; file_name: string; openedMonthsBack: number; monthlyBefore: number };
  /** Transactions imported from Vanguard's download, made up, oldest first. */
  transactionImports?: SeedImport[];
  /** Accounts hidden, by mask. */
  hidden?: string[];
  /** Accounts that ended: closed on a day, with a note. */
  ended?: { mask: string; on: string; note: string }[];
  notes?: { date: string; text: string; mask?: string }[];
  /** Plan > Allocation's target; the funds are on Nya's list, so their classes are known. */
  allocation?: Pick<AllocationSettings, 'target'>;
  /** What the Plan holds beyond the profile's version 1 plan: items, workplace
   *  plans (by mask), copies, and tax worked out from the accounts. */
  plan?: {
    items?: PlanItem[];
    set?: Partial<Pick<FirePlanV2, 'stopAtFi' | 'fiNumber' | 'lastsIn'>>;
    payroll?: string[];
    copies?: SeedCopy[];
    /** Detailed tax turned on, as Work out tax from your accounts does, with these conversions. */
    detailed?: { conversions: Conversions; convertUntil: number | null };
    /** Your plan saved for Progress against your plan, so many months back. */
    savedMonthsBack?: number;
    /** Children, for the household (lib/fire/tax-facts.ts dependents). */
    dependents?: { id: string; untilAge: number }[];
  };
  /** What a scenario puts wrong, by institution id. */
  trouble?: {
    /** Signed out at Plaid (/sandbox/item/reset_login), once its balances are recorded. */
    loginRequired?: string;
    /** Plaid's warning that access ends in so many days. */
    reconnectSoon?: { institution_id: string; days: number };
    /** Plaid's word that more accounts can be shared. */
    newAccounts?: string;
  };
};
