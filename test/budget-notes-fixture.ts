// The month a Budgets > Month view test draws, with every note it can say:
// what may leave the month short (each kind), why a carry may be off, what
// explains the figures, the errors and load states, the pool's notes, a
// group's reconcile and non-spending notes, the rollover and suggestion
// notes, and the income setting's words. Data only, so the same scenes can
// be drawn by the views as they were before rollout phase 6a2 (to record
// what they said, test/budget-words-before-6a2.json) and as they are.

import { categoriesFor } from './category-fixture';
import { addMonths, monthName } from '@/lib/rollover';
import type { Carry, IncomePool, MonthGap } from '@/lib/rollover';
import { instantDay, localDate, localMonth } from '@/lib/local-date';
import { indexTaxonomy, type Taxonomy } from '@/lib/categories';
import { consideredMonths, suggestBudgets } from '@/lib/budget-suggestions';
import type { Txn } from '@/components/MonthBreakdown';
import type { BudgetMonthState, BudgetMonthView } from '@/components/budget-month-state';
import type { Incomplete, Stopped } from '@/lib/month-coverage';
import type { NoTransactionsView } from '@/lib/no-transactions';

export const NOW = localMonth();
export const { taxonomy } = categoriesFor({}, { words: ['groceries', 'restaurants', 'coffee'], groups: { groceries: 'Food', restaurants: 'Food', coffee: 'Food' } });
const id = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name)!.id;
export const FOOD = taxonomy.groups.find((g) => g.name === 'Food')!.id;
export const TRANSFERS = taxonomy.groups.find((g) => g.name === 'Transfers')!.id;
export const GROCERIES = id(taxonomy, 'groceries');
export const RESTAURANTS = id(taxonomy, 'restaurants');
export const LOANS = id(taxonomy, 'loan payments');

export const row = (transaction_id: string, over: Partial<Txn> = {}): Txn =>
  ({
    transaction_id,
    date: localDate(),
    name: 'Shop',
    amount: 80,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Bank',
    category: 'groceries',
    iso_currency_code: 'USD',
    vendor_key: transaction_id,
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: null,
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...over,
  }) as Txn;

/** This month's rows: groceries, a meal in euros (named, not added), and a
 *  split's part for what its amount changed by since it was split. */
export const TXNS: Txn[] = [
  row('g'),
  row('eur', { amount: 20, category: 'restaurants', iso_currency_code: 'EUR' }),
  row('costco:rest', { amount: 5, split_of: 'costco', split_remainder: { was: 150 } }),
];

/** A cap on Food that its categories' budgets add up past (the reconcile
 *  rule), and a budget on loan payments, which is never spending. */
export const BUDGETS = { categories: { [GROCERIES]: { amount: 300 }, [RESTAURANTS]: { amount: 100 }, [LOANS]: { amount: 900 } }, groups: { [FOOD]: { amount: 350 } } };

const carry = (over: Partial<Carry>): Carry => ({ carry: 0, from: addMonths(NOW, -2), why: 'start', start: addMonths(NOW, -2), uncertain: [], ...over });

const POOL: IncomePool = {
  start: addMonths(NOW, -3),
  from: addMonths(NOW, -2),
  clamped: true,
  carried_in: 2140.5,
  income: 3100,
  spending: 1890.25,
  available: 3350.25,
  uncertain: [addMonths(NOW, -1)],
  months: [
    { month: addMonths(NOW, -2), carried_in: 0, income: 5200, spending: 3150.5, carried_out: 2049.5, uncertain: false },
    { month: addMonths(NOW, -1), carried_in: 2049.5, income: 1800, spending: 1709, carried_out: 2140.5, uncertain: true },
    { month: NOW, carried_in: 2140.5, income: 3100, spending: 1890.25, carried_out: 3350.25, uncertain: false },
  ],
};

const GAPS: MonthGap[] = [
  { kind: 'stopped', institution: 'Chase', since: `${addMonths(NOW, -1)}-15T12:00:00.000Z` },
  { kind: 'exclusions', count: 2 },
];

/** This month as the server works it out: groceries rolling over with a
 *  carry that counts last month, which may be incomplete; restaurants
 *  turned off this month; amounts assumed from before budgets were kept by
 *  month; the pool on, counting a month that may be incomplete. */
export const VIEW: BudgetMonthView = {
  history: true,
  month: NOW,
  today: NOW,
  currency: 'USD',
  budgets: BUDGETS,
  assumed: { categories: [GROCERIES], groups: [] },
  recorded_since: NOW,
  carries: { categories: { [GROCERIES]: carry({ carry: 120, uncertain: [addMonths(NOW, -1)] }) }, groups: {} },
  rollover: { categories: { [GROCERIES]: addMonths(NOW, -2) }, groups: {} },
  starts: { categories: { [GROCERIES]: addMonths(NOW, -6), [RESTAURANTS]: addMonths(NOW, -6) }, groups: {} },
  ended: { categories: { [RESTAURANTS]: addMonths(NOW, -2) }, groups: {} },
  spent: {},
  income: { version: 1, enabled: true, start: addMonths(NOW, -3) },
  pool: POOL,
  earliest: addMonths(NOW, -6),
  gaps: [{ month: addMonths(NOW, -1), gaps: GAPS }],
  left_out_text: null,
  counted_left_out_text: "1 transaction in EUR isn't in what rolled over from earlier months, which is in USD.",
  notes: [],
  suggestions: null,
};

export const ready = (view: BudgetMonthView | null): BudgetMonthState => ({ status: 'ready', view, error: null, reload: () => {} });

/** What may leave this month short, one of each kind the page knows. */
export const INCOMPLETE: Incomplete[] = [
  { institution_name: 'Ally', coverage: 'missing' },
  { institution_name: 'Wells', coverage: 'importing' },
  { institution_name: 'Old Bank', coverage: 'held', from: `${NOW}-01`, to: `${NOW}-28` },
];
export const STOPPED: Stopped[] = [{ institution_name: 'Capital One', last_ok_at: null }];
export const WITHOUT: NoTransactionsView = {
  without: [
    { institution_name: 'Acme CU', reason: 'refused' },
    { institution_name: 'Credit Union', reason: 'no_consent' },
  ],
  connections: 6,
};

/** Base props for the tab. */
export const TAB = {
  txns: TXNS,
  budgets: BUDGETS,
  taxonomy,
  onSave: async () => true,
  goals: [],
  onSaveGoals: async () => true,
  accounts: [],
  loading: false,
  series: [],
};

/** Every scene of the tab, by name: its props over TAB. */
export const TAB_SCENES = {
  // Every note at once, and a save that didn't go through.
  'this month': {
    budgetMonth: ready(VIEW),
    incomplete: INCOMPLETE,
    stopped: STOPPED,
    withoutTransactions: WITHOUT,
    budgetsSaveError: 'Could not save budgets. Showing what is saved.',
  },
  'budgets not loaded': { budgetsStatus: 'error' as const, budgetsError: 'Budgets could not be loaded. Editing is paused until they are; press Refresh to try again.' },
  'budgets loading': { budgetsStatus: 'loading' as const },
  'month not worked out': { budgetMonth: { status: 'error' as const, view: null, error: 'Rollover couldn’t be worked out just now, so each budget shows its amount without it.', reload: () => {} } },
  'categories not loaded': { taxonomy: null, categoriesError: 'Your categories couldn’t be loaded.' },
  'categories loading': { taxonomy: null },
  'no spending to count': { txns: [], withoutTransactions: { without: [{ institution_name: 'Empower', reason: 'investment_accounts' as const }], connections: 1 } },
  'spending only by hand': { txns: [row('hand', { source: 'manual' } as Partial<Txn>)], withoutTransactions: { without: [{ institution_name: 'Empower', reason: 'investment_accounts' as const }], connections: 1 } },
};

/** The suggestions from history for the budgets' sheet: a month that may be
 *  incomplete, and a row in another currency, each said. */
const [JUL, AUG, SEP] = consideredMonths(NOW);
export const SUGGESTIONS = suggestBudgets({
  month: NOW,
  rows: [
    { date: `${JUL}-03`, amount: 300, category: 'restaurants', transaction_code: null, iso_currency_code: 'USD', excluded: false },
    { date: `${AUG}-03`, amount: 330, category: 'restaurants', transaction_code: null, iso_currency_code: 'USD', excluded: false },
    { date: `${SEP}-03`, amount: 337.11, category: 'restaurants', transaction_code: null, iso_currency_code: 'USD', excluded: false },
    { date: `${SEP}-04`, amount: 40, category: 'restaurants', transaction_code: null, iso_currency_code: 'EUR', excluded: false },
  ],
  currency: 'USD',
  ix: indexTaxonomy(taxonomy),
  earliest: addMonths(NOW, -24),
  gaps: (m) => (m === AUG ? [{ kind: 'stopped', institution: 'Chase', since: null }] : []),
});

/** The rollover settings the sheets read, from VIEW. */
export const ROLLOVER = { rolling: VIEW.rollover, starts: VIEW.starts, ended: VIEW.ended, earliest: VIEW.earliest };

/** The budgets' card, Food and Transfers opened, with the month's carries. */
export const CARD = {
  taxonomy,
  budgets: BUDGETS,
  spent: { [GROCERIES]: 80, [RESTAURANTS]: 40 },
  currency: 'USD',
  editable: true,
  noSpending: false,
  onSave: async () => true,
  open: [FOOD, TRANSFERS],
  carries: VIEW.carries,
  month: NOW,
  rollover: ROLLOVER,
  suggestions: SUGGESTIONS,
};

/** A note's level by its class, before 6a2 (stale-note, chart-note,
 *  panel-note) and after (the Notice's levels, helper); empty-note both. */
function levelOf(cls: string): string | null {
  const c = new Set(cls.split(/\s+/));
  if (c.has('notice')) return c.has('critical') ? 'critical' : c.has('caution') ? 'caution' : c.has('info') ? 'info' : c.has('done') ? 'done' : null;
  if (c.has('error')) return 'critical';
  if (c.has('stale-note')) return 'caution';
  if (c.has('chart-note')) return 'info';
  if (c.has('panel-note') || c.has('helper')) return 'helper';
  if (c.has('empty-note')) return 'empty';
  return null;
}

const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Each note in rendered markup, as its words (what a screen reader is
 *  given first included: "Caution: ") and its level. */
export function notesIn(html: string): { text: string; level: string }[] {
  const out: { text: string; level: string }[] = [];
  const open: { level: string | null; text: string[] }[] = [];
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  for (const m of html.matchAll(/<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[1]) {
      const el = open.pop();
      if (el?.level) out.push({ text: el.text.join(' ').replace(/\s+/g, ' ').trim(), level: el.level });
      if (el) for (const o of open) o.text.push(' ');
    } else if (m[2]) {
      if (VOID.has(m[2].toLowerCase()) || m[4] === '/') continue;
      const cls = m[3]?.match(/\sclass="([^"]*)"/)?.[1] ?? '';
      open.push({ level: levelOf(cls), text: [] });
    } else if (m[5]) {
      for (const o of open) o.text.push(decode(m[5]));
    }
  }
  return out;
}

/** The Month panel's markup alone, out of the tab's. */
export const monthPanel = (html: string) => html.slice(html.indexOf('id="budgets-panel-month"'), html.indexOf('id="budgets-panel-upcoming"'));

/** The months and the day the scenes name, as the views write them in this
 *  run, each with a placeholder: recorded words hold the placeholders, so
 *  they read the same whatever month the suite runs in. */
const PLACES: [string, string][] = [
  ...[0, -1, -2, -3, -6].flatMap((n): [string, string][] => [
    [monthName(addMonths(NOW, n)), `{month ${n} with its year}`],
    [monthName(addMonths(NOW, n), NOW), `{month ${n}}`],
  ]),
  [instantDay(`${addMonths(NOW, -1)}-15T12:00:00.000Z`) ?? '', '{day}'],
];
export const placeheld = (s: string) => PLACES.reduce((t, [real, place]) => t.split(real).join(place), s);
export const filled = (s: string) => PLACES.reduce((t, [real, place]) => t.split(place).join(real), s);

/** The pool before it began, and with no transactions to count yet. */
export const POOL_BEFORE: IncomePool = { ...POOL, start: NOW, from: NOW, clamped: false, months: [] };
export const POOL_EMPTY: IncomePool = { ...POOL, start: addMonths(NOW, -2), from: NOW, clamped: true, months: [] };
export { POOL };
