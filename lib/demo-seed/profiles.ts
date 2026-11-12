// lib/demo-seed/profiles.ts
//
// What the demo accounts hold once seeded (lib/demo-seed/seed.ts): two
// FIRE-minded people with a year of ordinary money in Plaid's sandbox. Alex is
// a single earner who rents, pays down a student loan and saves about half of
// what comes in. Sam runs a two-income household with a child, a mortgage and
// a car loan, and saves into six investment accounts.
//
// Pure and deterministic: the same name and day give the same profile, so a
// re-run resets the account to a known state. Every date is counted back from
// the day the seed runs, so the history always ends today.
//
// THE BANKS are Plaid sandbox custom users (plaid.com/docs/sandbox/user-custom):
// one Item per institution, each made from the JSON customUserConfig builds.
// Plaid assigns each transaction its category from the description, as it does
// for a real bank's, so the descriptions read like a bank statement's. Plaid
// supports about 250 transactions per custom user, so each institution stays
// under MAX_TXNS_PER_ITEM, and each balance is worked out from an opening
// balance and the year's rows, so walking a balance back through its rows (the
// net-worth backfill) never takes a cash account below zero.
//
// Amounts follow Plaid's sign: positive is money out of the account (a
// purchase, a bill), negative is money in (a paycheck, a payment to a card).

import type { FirePlan } from '../fire/plan';
import type { BeforeMedicare } from '../fire/tax-choices';
import type { Filing, StateCode } from '../fire/tax/law/types';
import type { DEMO_NAMES } from '../demo';
import { atAge, atStop, planItem, ref, type SeedExtras } from './extras';

export type DemoName = (typeof DEMO_NAMES)[number];

/** Plaid supports about 250 transactions per custom user; this leaves room. */
export const MAX_TXNS_PER_ITEM = 240;
/** Months of history, the current one included. */
export const HISTORY_MONTHS = 12;

export type SeedTxn = { date: string; amount: number; description: string; pending?: boolean };
export type SeedHolding = { ticker: string; name: string; price: number; quantity: number; cost_basis: number };
/** A cash row's quantity is -1 for money in and 1 for money out, its price the
 *  amount; a sell's quantity is below zero, as Plaid's custom users take it. */
export type SeedInvTxn = { date: string; name: string; type: 'cash' | 'buy' | 'sell'; quantity: number; price: number; ticker: string };

export type SeedAccount = {
  /** Matched to the account Plaid makes by this mask. */
  mask: string;
  type: 'depository' | 'credit' | 'loan' | 'investment';
  subtype: string;
  name: string;
  /** Today's balance: owed for a card or a loan. */
  balance: number;
  limit?: number;
  apy?: number;
  transactions: SeedTxn[];
  holdings?: SeedHolding[];
  investment_transactions?: SeedInvTxn[];
  liability?: Record<string, unknown>;
};

export type SeedInstitution = {
  institution_id: string;
  name: string;
  products: ('transactions' | 'investments' | 'liabilities')[];
  accounts: SeedAccount[];
};

/** A manual account, and the rows entered on it (Plaid's sign: positive is money out). */
export type SeedManual = {
  name: string;
  type: 'depository' | 'investment' | 'other';
  subtype: string | null;
  balance: number;
  rows?: { date: string; amount: number; name: string; category: string | null }[];
};
/** A goal, tracking the account with this mask (or none), and its plan
 *  (lib/goal-plans.ts): a start is the day its target date was set and what
 *  it held then. */
export type SeedGoal = {
  name: string;
  target: number;
  mask: string | null;
  plan?: { monthly_target?: number; target_date?: string; started?: { date: string; amount: number }; archived?: { on: string; amount: number } };
};

export type DemoProfile = {
  /** Who it is, for the tests: a demo account's name, or a scenario's own. */
  name: string;
  institutions: SeedInstitution[];
  manual: SeedManual[];
  /** Monthly budgets by Plaid primary category. */
  budgets: Record<string, number>;
  goals: SeedGoal[];
  /** What the Plan tab starts from, over its defaults. */
  plan: Partial<FirePlan>;
  /** What every plan shares about the accounts (lib/fire/tax-facts.ts), each
   *  account by the mask it ends in, and a partner's age so it can be asked
   *  whose an account is. Left out, nothing is saved. */
  tax?: {
    partnerAge: number | null;
    accounts: { mask: string; owner: 'you' | 'partner'; basis: number | null }[];
    roth: { owner: 'you' | 'partner'; amount: number }[];
    /** What working tax out from the accounts reads, said while the plan stays flat:
     *  `socialSecurity` is the income that is Social Security, given before tax. */
    detail?: { filing: Filing; state: StateCode; beforeMedicare: BeforeMedicare; socialSecurity: string };
  };
  /** The rest of what it has set up (lib/demo-seed/extras.ts). */
  extras?: SeedExtras;
};

// Plaid's sandbox institutions without OAuth, which keep every field of a
// custom user (Plaid's docs warn OAuth ones may not).
export const PLATYPUS = { institution_id: 'ins_109508', name: 'First Platypus Bank' };
export const GINGHAM = { institution_id: 'ins_109509', name: 'First Gingham Credit Union' };
export const TATTERSALL = { institution_id: 'ins_109510', name: 'Tattersall Federal Credit Union' };
export const TARTAN = { institution_id: 'ins_109511', name: 'Tartan Bank' };
export const HOUNDSTOOTH = { institution_id: 'ins_109512', name: 'Houndstooth Bank' };
// Brokerages, also without OAuth in the sandbox. One investment account with
// activity per Item: the sandbox puts every investment transaction of a custom
// user on each of its investment accounts, so two in one Item would each show
// the other's too.
export const BETTERMENT = { institution_id: 'ins_115605', name: 'Betterment' };
export const WEALTHFRONT = { institution_id: 'ins_115617', name: 'Wealthfront' };
export const SCHWAB_PLANS = { institution_id: 'ins_121400', name: 'Charles Schwab - Retirement Plan Center' };
export const ETRADE = { institution_id: 'ins_129473', name: 'E*TRADE from Morgan Stanley' };
export const ASCENSUS = { institution_id: 'ins_118645', name: 'Ascensus - Merrill Lynch' };
// The one brokerage whose own record of past months Nya reads
// (lib/investment-months.ts isVanguard). Possibly OAuth at Plaid, where a
// custom user may not keep every field, so only its own scenario has it.
export const VANGUARD = { institution_id: 'ins_115616', name: 'Vanguard' };

const FUNDS = {
  VTI: { name: 'Vanguard Total Stock Market ETF', price: 312.4 },
  VXUS: { name: 'Vanguard Total International Stock ETF', price: 71.25 },
  BND: { name: 'Vanguard Total Bond Market ETF', price: 74.1 },
} as const;
export type Fund = keyof typeof FUNDS;

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;
const parseDay = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fmtDay(parseDay(d) + n * DAY_MS);

/** One month of the history: its first day, and the calendar month (1 to 12). */
export type Month = { index: number; year: number; month: number };

export function historyMonths(today: string): Month[] {
  return monthsBack(today, HISTORY_MONTHS - 1, 0);
}

/** The `count` months before the history's first, oldest first, indexed on
 *  back from it (-1 the month just before). */
export function monthsBeforeHistory(today: string, count: number): Month[] {
  return monthsBack(today, HISTORY_MONTHS + count - 1, HISTORY_MONTHS);
}

/** The months from `from` to `to` months back from today's, oldest first,
 *  indexed from the history's first. */
function monthsBack(today: string, from: number, to: number): Month[] {
  const [y, m] = today.split('-').map(Number);
  const out: Month[] = [];
  for (let back = from; back >= to; back--) {
    const total = y * 12 + (m - 1) - back;
    out.push({ index: HISTORY_MONTHS - 1 - back, year: Math.floor(total / 12), month: (total % 12) + 1 });
  }
  return out;
}

const daysIn = (mo: Month) => new Date(Date.UTC(mo.year, mo.month, 0)).getUTCDate();
/** A day of the month, clamped to its last day. */
export const on = (mo: Month, day: number) => `${mo.year}-${String(mo.month).padStart(2, '0')}-${String(Math.min(day, daysIn(mo))).padStart(2, '0')}`;
export const lastDay = (mo: Month) => on(mo, 31);

// ---------------------------------------------------------------- randomness

/** mulberry32: small, seeded, the same sequence on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

type Rand = {
  /** About `base`, give or take `spread` (a fraction). */
  about(base: number, spread: number): number;
  /** A whole day in 1..max. */
  day(max: number): number;
  pick<T>(xs: readonly T[]): T;
};

export function rand(seed: number): Rand {
  const r = rng(seed);
  return {
    about: (base, spread) => round2(base * (1 + (r() * 2 - 1) * spread)),
    day: (max) => 1 + Math.floor(r() * max),
    pick: (xs) => xs[Math.floor(r() * xs.length)],
  };
}

// ---------------------------------------------------------------- books

/** One account's rows for the year, which only ever include days up to today. */
export class Book {
  readonly rows: SeedTxn[] = [];
  constructor(private readonly today: string) {}
  /** The row added, or null for a day after today, which isn't. */
  add(date: string, amount: number, description: string): SeedTxn | null {
    if (date > this.today) return null;
    const row = { date, amount: round2(amount), description };
    this.rows.push(row);
    return row;
  }
  /** A purchase made today that the bank hasn't posted yet. */
  pending(amount: number, description: string): void {
    this.rows.push({ date: this.today, amount: round2(amount), description, pending: true });
  }
  /** What the posted rows add up to (Plaid's sign). */
  posted(from = '0000-00-00', to = '9999-99-99'): number {
    return round2(this.rows.filter((t) => !t.pending && t.date >= from && t.date <= to).reduce((s, t) => s + t.amount, 0));
  }
  sorted(): SeedTxn[] {
    return [...this.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
}

/** A cash account's balance today, from what it opened the year with. */
export const cashBalance = (opening: number, book: Book) => round2(opening - book.posted());
/** What a card or a loan owes today, from what it owed when the year opened. */
export const owedBalance = (opening: number, book: Book) => round2(opening + book.posted());

/** How far the market stood below today's on `day`: it rose about 12% over
 *  the year, so a fund's price then was its price today times this. */
export const marketOn = (today: string, day: string) => 1 - (0.12 * (parseDay(today) - parseDay(day))) / (365 * DAY_MS);

/** An investment account: today's holdings worth `value`, split by weight
 *  with the rest in cash, and a year of contributions each followed by a buy. */
export class Portfolio {
  readonly txns: SeedInvTxn[] = [];
  constructor(
    private readonly today: string,
    private readonly value: number,
    private readonly mix: Partial<Record<Fund, number>>
  ) {}
  /** Money paid in and put to work the next day in `fund`, at about the
   *  price then (the market rose about 12% over the year). */
  contribute(date: string, amount: number, fund: Fund, name: string): void {
    if (date > this.today) return;
    this.txns.push({ date, name, type: 'cash', quantity: -1, price: round2(amount), ticker: 'CUR:USD' });
    const buyOn = addDays(date, 1) > this.today ? date : addDays(date, 1);
    const price = round2(FUNDS[fund].price * marketOn(this.today, buyOn));
    this.txns.push({ date: buyOn, name: `BUY ${fund}`, type: 'buy', quantity: Math.round((amount / price) * 10_000) / 10_000, price, ticker: fund });
  }
  /** Money taken out: `fund` sold the day before at about the price then,
   *  and the cash paid out on `date`. */
  withdraw(date: string, amount: number, fund: Fund, name: string): void {
    if (date > this.today) return;
    const sellOn = addDays(date, -1);
    const price = round2(FUNDS[fund].price * marketOn(this.today, sellOn));
    this.txns.push({ date: sellOn, name: `SELL ${fund}`, type: 'sell', quantity: -Math.round((amount / price) * 10_000) / 10_000, price, ticker: fund });
    this.txns.push({ date, name, type: 'cash', quantity: 1, price: round2(amount), ticker: 'CUR:USD' });
  }
  holdings(): SeedHolding[] {
    const out: SeedHolding[] = [];
    let invested = 0;
    for (const [fund, weight] of Object.entries(this.mix) as [Fund, number][]) {
      const f = FUNDS[fund];
      const quantity = Math.round(((this.value * weight) / f.price) * 10_000) / 10_000;
      const worth = round2(quantity * f.price);
      invested += worth;
      out.push({ ticker: fund, name: f.name, price: f.price, quantity, cost_basis: round2(worth * 0.74) });
    }
    const cash = round2(this.value - invested);
    out.push({ ticker: 'CUR:USD', name: 'Cash', price: 1, quantity: cash, cost_basis: cash });
    return out;
  }
}

// ---------------------------------------------------------------- Alex

function alex(today: string): DemoProfile {
  const r = rand(31);
  const months = historyMonths(today);
  const checking = new Book(today);
  const savings = new Book(today);
  const card = new Book(today);
  const loan = new Book(today);
  const brokerage = new Portfolio(today, 64_300, { VTI: 0.8, VXUS: 0.18 });
  const roth = new Portfolio(today, 41_800, { VTI: 0.6, VXUS: 0.3, BND: 0.08 });
  const k401 = new Portfolio(today, 96_500, { VTI: 0.7, VXUS: 0.2, BND: 0.09 });

  const CARD_OPENING = 1_184.36;
  let lastStatement = CARD_OPENING;
  let savingsBalance = 15_500;
  let united: SeedTxn | null = null;
  let hyatt: SeedTxn | null = null;
  let tahoe: SeedTxn | null = null;
  let laptop: SeedTxn | null = null;
  const rei: SeedTxn[] = [];

  for (const mo of months) {
    const raise = mo.index >= 5; // a raise partway through the year
    const net = raise ? 3_388.42 : 3_240.18;

    // Card: the month's spending.
    const from = on(mo, 1);
    for (const d of [3, 10, 17, 24]) card.add(on(mo, d), r.about(78, 0.35), d % 2 ? "TRADER JOE'S #552 SAN FRANCISCO CA" : 'SAFEWAY #1711 SAN FRANCISCO CA');
    for (let i = 0; i < 5; i++) {
      card.add(on(mo, r.day(28)), r.about(32, 0.6), r.pick(['CHIPOTLE 1234 SAN FRANCISCO', 'SWEETGREEN MISSION', 'TARTINE BAKERY', 'BURMA SUPERSTAR', 'DOORDASH*THAI GARDEN']));
    }
    card.add(on(mo, r.day(28)), r.about(6.25, 0.1), 'BLUE BOTTLE COFFEE');
    card.add(on(mo, 3), 50, 'CLIPPER CARD RELOAD');
    if (mo.index % 2 === 0) card.add(on(mo, r.day(28)), r.about(24, 0.3), 'LYFT *RIDE SUN 8PM');
    card.add(on(mo, 1), 95, 'MISSION CLIFFS CLIMBING GYM');
    card.add(on(mo, 7), 15.49, 'NETFLIX.COM');
    card.add(on(mo, 11), 11.99, 'SPOTIFY USA');
    card.add(on(mo, r.day(28)), r.about(42, 0.6), 'AMAZON.COM*2K4LT8 AMZN.COM/BILL');
    if (mo.index % 3 === 1) {
      const row = card.add(on(mo, r.day(28)), r.about(120, 0.5), 'REI #105 SAN FRANCISCO');
      if (row) rei.push(row);
    }
    if (mo.index % 2 === 1) card.add(on(mo, r.day(28)), r.about(24, 0.4), 'WALGREENS #3021');
    // A trip, a weekend shared with friends and a new laptop, counted in
    // months back from today so each is there whatever day the seed runs.
    if (mo.index === 6) {
      united = card.add(on(mo, 9), 412.6, 'UNITED AIRLINES');
      hyatt = card.add(on(mo, 19), 389.2, 'HYATT HOTELS TOKYO');
    }
    if (mo.index === 2) tahoe = card.add(on(mo, 13), 520, 'AIRBNB * HM4QZ8 TAHOE');
    if (mo.index === 4) laptop = card.add(on(mo, 21), 1_899, 'APPLE STORE #R014 SAN FRANCISCO');
    if (mo.month === 12) {
      card.add(on(mo, 6), 318.4, 'ALASKA AIRLINES');
      card.add(on(mo, 12), 186.5, 'AMAZON.COM*HOLIDAY AMZN.COM/BILL');
    }

    // Checking: pay in, bills and saving out.
    checking.add(on(mo, 15), -net, 'NORTHWIND LABS PAYROLL DIR DEP');
    checking.add(lastDay(mo), -net, 'NORTHWIND LABS PAYROLL DIR DEP');
    if (mo.month === 3) checking.add(on(mo, 15), -6_500, 'NORTHWIND LABS BONUS DIR DEP');
    checking.add(on(mo, 1), 1_950, 'ACH DEBIT SUNSET TERRACE APTS RENT');
    checking.add(on(mo, 5), r.about(mo.month === 1 || mo.month === 8 ? 118 : 82, 0.15), 'PG&E ELECTRIC AUTOPAY');
    checking.add(on(mo, 8), 65, 'COMCAST XFINITY INTERNET');
    checking.add(on(mo, 12), 45, 'T-MOBILE AUTOPAY');
    if (mo.index % 2 === 0) checking.add(on(mo, r.day(28)), r.about(45, 0.5), 'VENMO PAYMENT');

    checking.add(on(mo, 18), 420, 'FIRST GINGHAM CU LOAN PMT');
    loan.add(on(mo, 18), -420, 'PAYMENT RECEIVED THANK YOU');

    checking.add(on(mo, 22), lastStatement, 'TARTAN BANK CARD PAYMENT');
    card.add(on(mo, 22), -lastStatement, 'AUTOPAY PAYMENT THANK YOU');
    lastStatement = round2(card.rows.filter((t) => t.amount > 0 && t.date >= from && t.date <= lastDay(mo)).reduce((s, t) => s + t.amount, 0));

    checking.add(on(mo, 16), 800, 'ONLINE TRANSFER TO SAVINGS XXXX9930');
    savings.add(on(mo, 16), -800, 'ONLINE TRANSFER FROM CHECKING XXXX4821');
    if (on(mo, 16) <= today) savingsBalance += 800;
    const interest = round2((savingsBalance * 0.041) / 12);
    savings.add(lastDay(mo), -interest, 'INTEREST EARNED');
    if (lastDay(mo) <= today) savingsBalance += interest;

    checking.add(on(mo, 16), 1_500, 'ONLINE TRANSFER TO BROKERAGE XXXX7788');
    brokerage.contribute(on(mo, 16), 1_500, 'VTI', 'ACH CONTRIBUTION');
    if (mo.month === 3) {
      checking.add(on(mo, 20), 5_000, 'ONLINE TRANSFER TO BROKERAGE XXXX7788');
      brokerage.contribute(on(mo, 20), 5_000, 'VXUS', 'ACH CONTRIBUTION');
    }
    checking.add(on(mo, 2), 583, 'ROTH IRA CONTRIBUTION XXXX5521');
    roth.contribute(on(mo, 2), 583, mo.index % 2 ? 'VXUS' : 'VTI', 'ROTH CONTRIBUTION');
    k401.contribute(on(mo, 15), 1_150, 'VTI', 'PAYROLL CONTRIBUTION');
    k401.contribute(lastDay(mo), 1_150, mo.index % 3 ? 'VTI' : 'BND', 'PAYROLL CONTRIBUTION');
  }
  card.pending(r.about(64, 0.3), "TRADER JOE'S #552 SAN FRANCISCO CA");

  const cardOwed = owedBalance(CARD_OPENING, card);
  const savingsStart = on(months[5], 1);
  return {
    name: 'Alex',
    institutions: [
      {
        ...PLATYPUS,
        products: ['transactions'],
        accounts: [
          { mask: '4821', type: 'depository', subtype: 'checking', name: 'Everyday Checking', balance: cashBalance(5_400, checking), transactions: checking.sorted() },
          { mask: '9930', type: 'depository', subtype: 'savings', name: 'High-Yield Savings', apy: 4.1, balance: cashBalance(15_500, savings), transactions: savings.sorted() },
          // A parent's bills, paid from here: Alex's to manage, not to count, so hidden.
          { mask: '4830', type: 'depository', subtype: 'checking', name: "Mom's Bill Pay", balance: 1_240, transactions: [] },
        ],
      },
      {
        ...TARTAN,
        products: ['transactions', 'liabilities'],
        accounts: [
          {
            mask: '1077', type: 'credit', subtype: 'credit card', name: 'Cash Rewards Visa', limit: 15_000, balance: cardOwed, transactions: card.sorted(),
            liability: { type: 'credit', purchase_apr: 22.99, minimum_payment_amount: 40, last_statement_balance: lastStatement, last_payment_amount: 1_200 },
          },
        ],
      },
      {
        ...WEALTHFRONT,
        products: ['investments'],
        accounts: [{ mask: '7788', type: 'investment', subtype: 'brokerage', name: 'Individual Brokerage', balance: 64_300, transactions: [], holdings: brokerage.holdings(), investment_transactions: brokerage.txns }],
      },
      {
        ...BETTERMENT,
        products: ['investments'],
        accounts: [{ mask: '5521', type: 'investment', subtype: 'roth', name: 'Roth IRA', balance: 41_800, transactions: [], holdings: roth.holdings(), investment_transactions: roth.txns }],
      },
      {
        ...SCHWAB_PLANS,
        products: ['investments'],
        accounts: [{ mask: '3314', type: 'investment', subtype: '401k', name: 'Northwind 401(k)', balance: 96_500, transactions: [], holdings: k401.holdings(), investment_transactions: k401.txns }],
      },
      {
        // Not subtype `student`, and no `liability`: given either, the sandbox
        // replaces the balance and the rows with a schedule of its own.
        ...GINGHAM,
        products: ['transactions'],
        accounts: [{ mask: '6620', type: 'loan', subtype: 'loan', name: 'Graduate Student Loan', balance: owedBalance(18_600, loan), transactions: loan.sorted() }],
      },
    ],
    manual: [
      { name: 'Health Savings Account', type: 'investment', subtype: 'hsa', balance: 9_850 },
      {
        name: 'Cash on hand',
        type: 'depository',
        subtype: 'cash',
        balance: 120,
        rows: [
          { date: addDays(today, -26), amount: 34, name: 'Farmers market', category: 'FOOD_AND_DRINK' },
          { date: addDays(today, -12), amount: 20, name: 'Haircut tip', category: 'PERSONAL_CARE' },
          { date: addDays(today, -4), amount: 18.5, name: 'Taqueria', category: 'FOOD_AND_DRINK' },
        ],
      },
    ],
    budgets: { FOOD_AND_DRINK: 650, GENERAL_MERCHANDISE: 250, ENTERTAINMENT: 150, TRANSPORTATION: 120, TRAVEL: 300 },
    goals: [
      // Its target date was set six months back, at what savings held then, so
      // the goal says where it should be by now.
      {
        name: 'Emergency fund',
        target: 30_000,
        mask: '9930',
        plan: { target_date: addDays(today, 274), started: { date: savingsStart, amount: cashBalance(15_500, savingsBefore(savings, savingsStart)) } },
      },
      { name: 'Japan trip', target: 6_000, mask: null, plan: { monthly_target: 500, target_date: addDays(today, 300) } },
      ...(laptop ? [{ name: 'New laptop', target: 1_900, mask: null, plan: { archived: { on: laptop.date, amount: 1_900 } } }] : []),
    ],
    plan: { age: 31, targetAge: 45, withdrawalRate: 0.035, stocksPct: 90, bondsPct: 10, partTimeIncome: 18_000 },
    tax: { partnerAge: null, accounts: [], roth: [{ owner: 'you', amount: 26_000 }] },
    extras: {
      tags: ['Subscriptions', 'Vacation'],
      rules: [
        { name: 'NETFLIX', tags: ['Subscriptions'] },
        { name: 'SPOTIFY', tags: ['Subscriptions'] },
        { name: 'VENMO PAYMENT', op: 'equals', rename: 'Venmo' },
        { name: 'CLIPPER', rename: 'Clipper (transit)', off: true },
      ],
      marks: [
        { row: ref('1077', united), tags: ['Vacation'] },
        { row: ref('1077', hyatt), tags: ['Vacation'], note: 'Tokyo, five nights' },
        { row: ref('1077', laptop), excluded: true, note: 'New laptop: a one-off, from the laptop fund' },
      ],
      // Two of the merchant's last three filed the same way: its default.
      recategorized: rei.slice(-2).map((row) => ({ row: ref('1077', row), category: 'ENTERTAINMENT' })),
      people: ['Priya', 'Marcus'],
      shares: [{ row: ref('1077', tahoe), what: 'Tahoe cabin', parts: [{ person: 'Priya', amount: 173.33 }, { person: 'Marcus', amount: 173.33 }] }],
      ious: [{ person: 'Marcus', direction: 'to_you', amount: 40, date: addDays(today, -12), what: 'Concert tickets' }],
      review: { daysBack: 7 },
      rollover: ['TRAVEL'],
      planned: {
        items: [
          { name: 'Renter’s insurance', kind: 'expense', amount: 180, date: on(months[2], 5), cadence: 'yearly' },
          { name: 'Flights to Japan', kind: 'expense', amount: 1_400, date: addDays(today, 40), cadence: 'once' },
        ],
        threshold: 2_000,
      },
      // The Individual Brokerage ••7788 is left to set (and to its own history import).
      moneyInOut: [
        { mask: '5521', in: 29_400, out: 0, as_of: lastDay(months[8]) },
        { mask: '3314', in: 71_250, out: 0, as_of: lastDay(months[8]) },
      ],
      hidden: ['4830'],
      notes: [{ date: on(months[5], 15), text: 'Raise at Northwind', mask: '4821' }],
      allocation: { target: { 'us-stocks': 65, 'intl-stocks': 25, bonds: 10 } },
      plan: {
        items: [planItem({ id: 'japan-trip', label: 'Japan trip', kind: 'one-off', from: atAge(32), once: 6_000 })],
        payroll: ['3314'],
        copies: [
          {
            name: 'Coast from 40',
            set: { targetAge: 40, rule: 'guardrails' },
            add: [planItem({ id: 'freelance', label: 'Freelance design', kind: 'part-time', from: atStop(), until: { years: 10 }, yearly: 18_000, replaces: 0 })],
          },
          { name: 'Earliest stop that lasts', set: { lastsIn: 0.9 } },
        ],
        savedMonthsBack: 3,
      },
    },
  };
}

/** The savings book's rows up to the end of `day`, for its balance then. */
function savingsBefore(book: Book, day: string): Book {
  const upTo = new Book(day);
  for (const t of book.rows) if (!t.pending && t.date <= day) upTo.add(t.date, t.amount, t.description);
  return upTo;
}

// ---------------------------------------------------------------- Sam

function sam(today: string): DemoProfile {
  const r = rand(38);
  const months = historyMonths(today);
  const checking = new Book(today);
  const savings = new Book(today);
  const card = new Book(today);
  const mortgage = new Book(today);
  const auto = new Book(today);
  const k401 = new Portfolio(today, 238_400, { VTI: 0.7, VXUS: 0.2, BND: 0.09 });
  const b403 = new Portfolio(today, 171_900, { VTI: 0.65, VXUS: 0.2, BND: 0.14 });
  const rothSam = new Portfolio(today, 68_200, { VTI: 0.7, VXUS: 0.29 });
  const rothJordan = new Portfolio(today, 54_600, { VTI: 0.7, VXUS: 0.29 });
  const joint = new Portfolio(today, 126_300, { VTI: 0.85, VXUS: 0.13 });
  const college = new Portfolio(today, 27_800, { VTI: 0.8, BND: 0.19 });

  const CARD_OPENING = 2_948.12;
  let lastStatement = CARD_OPENING;
  let savingsBalance = 26_000;
  let costco: SeedTxn | null = null;
  let flights: SeedTxn | null = null;
  let stay: SeedTxn | null = null;

  for (const mo of months) {
    const from = on(mo, 1);
    // Card: the household's spending.
    const bulk = card.add(on(mo, 4), r.about(265, 0.25), 'COSTCO WHSE #0144');
    if (mo.index === 9) costco = bulk; // split into groceries and household things
    card.add(on(mo, 19), r.about(240, 0.25), 'COSTCO WHSE #0144');
    card.add(on(mo, 10), r.about(118, 0.3), 'SAFEWAY #2290');
    card.add(on(mo, 25), r.about(104, 0.3), 'SAFEWAY #2290');
    card.add(on(mo, r.day(28)), r.about(82, 0.4), 'TARGET T-1426');
    card.add(on(mo, r.day(28)), r.about(46, 0.5), 'AMAZON.COM*9H2KQ1 AMZN.COM/BILL');
    card.add(on(mo, r.day(28)), r.about(38, 0.5), 'AMAZON.COM*7XU3D0 AMZN.COM/BILL');
    for (let i = 0; i < 3; i++) card.add(on(mo, r.day(28)), r.about(58, 0.45), r.pick(['OLIVE GARDEN 4471', 'PANERA BREAD #601', 'IN-N-OUT BURGER', 'DOMINOS 7731']));
    card.add(on(mo, 2), 95, 'YMCA OF THE EAST BAY');
    card.add(on(mo, 9), r.about(58, 0.2), 'CHEVRON 0091254');
    card.add(on(mo, 23), r.about(55, 0.2), 'CHEVRON 0091254');
    card.add(on(mo, 7), 22.99, 'NETFLIX.COM');
    card.add(on(mo, 14), 13.99, 'DISNEY PLUS');
    if (mo.index % 2 === 0) card.add(on(mo, r.day(28)), r.about(92, 0.5), 'THE HOME DEPOT #6612');
    if (mo.index % 3 === 2) card.add(on(mo, r.day(28)), r.about(30, 0.4), 'CVS/PHARMACY #9921');
    // The summer trip, counted in months back from today so it is there
    // whatever day the seed runs, and grouped as one.
    if (mo.index === 4) {
      flights = card.add(on(mo, 3), 1_084.4, 'SOUTHWEST AIRLINES');
      stay = card.add(on(mo, 20), 1_412, 'AIRBNB * HMX81Q SAN DIEGO');
    }
    if (mo.month === 12) card.add(on(mo, 8), 412.75, 'AMAZON.COM*HOLIDAY AMZN.COM/BILL');

    // Checking: two paychecks each, the house, the child, the bills.
    checking.add(on(mo, 15), -3_452.6, 'CONTOSO HEALTH PAYROLL DIR DEP');
    checking.add(lastDay(mo), -3_452.6, 'CONTOSO HEALTH PAYROLL DIR DEP');
    checking.add(on(mo, 15), -2_684.15, 'FABRIKAM INC PAYROLL DIR DEP');
    checking.add(lastDay(mo), -2_684.15, 'FABRIKAM INC PAYROLL DIR DEP');
    checking.add(on(mo, 1), 2_865.4, 'TATTERSALL FCU MORTGAGE PMT');
    mortgage.add(on(mo, 1), -(948 + mo.index * 4.1), 'PRINCIPAL PAYMENT');
    checking.add(on(mo, 3), 1_650, 'BRIGHT HORIZONS TUITION');
    checking.add(on(mo, 6), r.about(mo.month >= 6 && mo.month <= 9 ? 228 : 164, 0.12), 'PG&E ELECTRIC AUTOPAY');
    checking.add(on(mo, 11), r.about(72, 0.15), 'EBMUD WATER BILL');
    checking.add(on(mo, 8), 80, 'COMCAST XFINITY INTERNET');
    checking.add(on(mo, 12), 110, 'VERIZON WIRELESS AUTOPAY');
    checking.add(on(mo, 20), 142.5, 'GEICO AUTO INSURANCE');
    checking.add(on(mo, 17), 465, 'FIRST GINGHAM CU AUTO LOAN PMT');
    auto.add(on(mo, 17), -(408 + mo.index * 1.6), 'PRINCIPAL PAYMENT');
    if (mo.month === 4) checking.add(on(mo, 18), -2_410, 'IRS TREAS 310 TAX REF');

    checking.add(on(mo, 22), lastStatement, 'TARTAN BANK CARD PAYMENT');
    card.add(on(mo, 22), -lastStatement, 'AUTOPAY PAYMENT THANK YOU');
    lastStatement = round2(card.rows.filter((t) => t.amount > 0 && t.date >= from && t.date <= lastDay(mo)).reduce((s, t) => s + t.amount, 0));

    checking.add(on(mo, 16), 1_500, 'ONLINE TRANSFER TO SAVINGS XXXX6145');
    savings.add(on(mo, 16), -1_500, 'ONLINE TRANSFER FROM CHECKING XXXX2208');
    if (on(mo, 16) <= today) savingsBalance += 1_500;
    if (mo.month === 1) {
      // Both Roths are filled each January, from savings.
      for (const [who, roth, mask] of [['SAM', rothSam, '7741'], ['JORDAN', rothJordan, '7742']] as const) {
        savings.add(on(mo, 5), 7_000, `ONLINE TRANSFER TO ROTH IRA XXXX${mask}`);
        if (on(mo, 5) <= today) savingsBalance -= 7_000;
        roth.contribute(on(mo, 5), 7_000, 'VTI', `${who} ROTH CONTRIBUTION`);
      }
    }
    const interest = round2((savingsBalance * 0.04) / 12);
    savings.add(lastDay(mo), -interest, 'INTEREST EARNED');
    if (lastDay(mo) <= today) savingsBalance += interest;

    checking.add(on(mo, 16), 2_800, 'ONLINE TRANSFER TO BROKERAGE XXXX9013');
    joint.contribute(on(mo, 16), 2_800, 'VTI', 'ACH CONTRIBUTION');
    checking.add(on(mo, 16), 250, 'SCHOLARSHARE 529 CONTRIBUTION');
    college.contribute(on(mo, 16), 250, 'VTI', '529 CONTRIBUTION');
    k401.contribute(lastDay(mo), 1_900, mo.index % 4 ? 'VTI' : 'VXUS', 'PAYROLL CONTRIBUTION');
    b403.contribute(lastDay(mo), 1_450, mo.index % 3 ? 'VTI' : 'BND', 'PAYROLL CONTRIBUTION');
  }
  card.pending(r.about(212, 0.2), 'COSTCO WHSE #0144');

  return {
    name: 'Sam',
    institutions: [
      {
        ...HOUNDSTOOTH,
        products: ['transactions'],
        accounts: [
          { mask: '2208', type: 'depository', subtype: 'checking', name: 'Joint Checking', balance: cashBalance(7_800, checking), transactions: checking.sorted() },
          { mask: '6145', type: 'depository', subtype: 'savings', name: 'Emergency Savings', apy: 4.0, balance: cashBalance(26_000, savings), transactions: savings.sorted() },
        ],
      },
      {
        ...TARTAN,
        products: ['transactions', 'liabilities'],
        accounts: [
          {
            mask: '4410', type: 'credit', subtype: 'credit card', name: 'Family Rewards Mastercard', limit: 25_000, balance: owedBalance(CARD_OPENING, card), transactions: card.sorted(),
            liability: { type: 'credit', purchase_apr: 21.49, minimum_payment_amount: 75, last_statement_balance: lastStatement, last_payment_amount: 3_050 },
          },
          // Paid off and closed when the family card came, still listed by the bank.
          { mask: '4402', type: 'credit', subtype: 'credit card', name: 'Old Cash Back Card', limit: 5_000, balance: 0, transactions: [] },
        ],
      },
      {
        ...SCHWAB_PLANS,
        products: ['investments'],
        accounts: [{ mask: '1182', type: 'investment', subtype: '401k', name: 'Sam 401(k)', balance: 238_400, transactions: [], holdings: k401.holdings(), investment_transactions: k401.txns }],
      },
      {
        ...PLATYPUS,
        products: ['investments'],
        accounts: [{ mask: '5530', type: 'investment', subtype: '403B', name: 'Jordan 403(b)', balance: 171_900, transactions: [], holdings: b403.holdings(), investment_transactions: b403.txns }],
      },
      {
        ...WEALTHFRONT,
        products: ['investments'],
        accounts: [{ mask: '7741', type: 'investment', subtype: 'roth', name: 'Sam Roth IRA', balance: 68_200, transactions: [], holdings: rothSam.holdings(), investment_transactions: rothSam.txns }],
      },
      {
        ...BETTERMENT,
        products: ['investments'],
        accounts: [{ mask: '7742', type: 'investment', subtype: 'roth', name: 'Jordan Roth IRA', balance: 54_600, transactions: [], holdings: rothJordan.holdings(), investment_transactions: rothJordan.txns }],
      },
      {
        ...ETRADE,
        products: ['investments'],
        accounts: [{ mask: '9013', type: 'investment', subtype: 'brokerage', name: 'Joint Brokerage', balance: 126_300, transactions: [], holdings: joint.holdings(), investment_transactions: joint.txns }],
      },
      {
        ...ASCENSUS,
        products: ['investments'],
        accounts: [{ mask: '3360', type: 'investment', subtype: '529', name: '529 College Savings', balance: 27_800, transactions: [], holdings: college.holdings(), investment_transactions: college.txns }],
      },
      {
        ...TATTERSALL,
        products: ['transactions'],
        accounts: [{ mask: '8871', type: 'loan', subtype: 'mortgage', name: 'Home Mortgage', balance: owedBalance(381_500, mortgage), transactions: mortgage.sorted() }],
      },
      {
        ...GINGHAM,
        products: ['transactions'],
        accounts: [{ mask: '2290', type: 'loan', subtype: 'auto', name: 'Auto Loan', balance: owedBalance(19_800, auto), transactions: auto.sorted() }],
      },
    ],
    manual: [{ name: 'Home (estimated value)', type: 'other', subtype: 'real estate', balance: 612_000 }],
    budgets: { FOOD_AND_DRINK: 1_350, GENERAL_MERCHANDISE: 600, TRANSPORTATION: 320, ENTERTAINMENT: 120, HOME_IMPROVEMENT: 150 },
    goals: [
      { name: 'Emergency fund (6 months)', target: 45_000, mask: '6145' },
      { name: 'College fund', target: 80_000, mask: '3360', plan: { monthly_target: 250 } },
    ],
    plan: {
      age: 38,
      targetAge: 52,
      withdrawalRate: 0.0375,
      stocksPct: 80,
      bondsPct: 20,
      income: [{ id: 'social-security', label: 'Social Security (both)', amount: 42_000, fromAge: 67, inflationAdjusted: true }],
    },
    // The College fund's 529 stays out of these, to show the group it leaves
    // invested assets for.
    tax: {
      partnerAge: 37,
      accounts: [
        { mask: '5530', owner: 'partner', basis: null },
        { mask: '7742', owner: 'partner', basis: null },
        { mask: '9013', owner: 'you', basis: 88_000 },
      ],
      roth: [
        { owner: 'you', amount: 42_000 },
        { owner: 'partner', amount: 31_000 },
      ],
      detail: { filing: 'joint', state: 'NV', beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, socialSecurity: 'social-security' },
    },
    extras: {
      tags: ['Kids', 'Home'],
      rules: [
        { name: 'BRIGHT HORIZONS', tags: ['Kids'] },
        { name: 'HOME DEPOT', category: 'HOME_IMPROVEMENT', tags: ['Home'] },
      ],
      splits: [
        {
          row: ref('4410', costco),
          parts: [
            { share: 0.6, category: 'FOOD_AND_DRINK', note: 'Groceries' },
            { share: 0.4, category: 'GENERAL_MERCHANDISE', note: 'Paper goods and a booster seat' },
          ],
        },
      ],
      groups: [{ name: 'San Diego trip', category: 'TRAVEL', rows: [ref('4410', flights), ref('4410', stay)] }],
      // Under the food group's own budget, so the category's is capped by it.
      groupBudgets: [{ key: 'FOOD_AND_DRINK', amount: 1_300 }],
      planned: {
        items: [
          { name: 'Car registration', kind: 'expense', amount: 284, date: on(months[3], 12), cadence: 'yearly' },
          { name: 'Tax refund', kind: 'income', amount: 2_400, date: addDays(today, 150), cadence: 'once' },
        ],
        threshold: 5_000,
      },
      reportMarked: ['MEDICAL'],
      runway: [{ name: 'If both paychecks stop', months: 6, lower_by: 800, income_until: today, planned: true, leave_out_one_offs: true }],
      moneyInOut: [
        { mask: '1182', in: 176_500, out: 0, as_of: lastDay(months[9]) },
        { mask: '5530', in: 128_300, out: 0, as_of: lastDay(months[9]) },
        { mask: '7741', in: 49_000, out: 0, as_of: lastDay(months[9]) },
        { mask: '7742', in: 38_500, out: 0, as_of: lastDay(months[9]) },
        { mask: '9013', in: 104_000, out: 8_500, as_of: lastDay(months[9]) },
        { mask: '3360', in: 24_250, out: 3_100, as_of: lastDay(months[9]) },
      ],
      ended: [{ mask: '4402', on: on(months[6], 1), note: 'Closed once the family card came' }],
      allocation: { target: { 'us-stocks': 60, 'intl-stocks': 20, bonds: 20 } },
      plan: {
        items: [
          planItem({ id: 'maya', label: 'Maya', kind: 'child', from: atAge(38), until: { years: 14 }, yearly: 9_000 }),
          planItem({ id: 'sam-consulting', label: 'Sam consulting', kind: 'part-time', owner: 'you', from: atStop(), until: { years: 5 }, yearly: 30_000, replaces: 0 }),
          planItem({ id: 'jordan-tutoring', label: 'Jordan tutoring', kind: 'part-time', owner: 'partner', from: atStop(1), until: { years: 5 }, yearly: 18_000, replaces: 0 }),
        ],
        payroll: ['1182', '5530'],
        copies: [
          {
            name: 'Jordan part-time at 48',
            drop: ['jordan-tutoring'],
            add: [planItem({ id: 'jordan-part-time', label: 'Jordan part-time', kind: 'part-time', owner: 'partner', from: atAge(48), until: { years: 8 }, yearly: 40_000, replaces: 90_000 })],
          },
          { name: 'A bigger home', add: [planItem({ id: 'bigger-home', label: 'A bigger home', kind: 'home', from: atAge(42), once: 150_000, yearly: 6_000 })] },
        ],
        dependents: [{ id: 'maya', untilAge: 52 }],
      },
    },
  };
}

/** The profile for a demo account, as of `today` (YYYY-MM-DD, UTC). */
export function demoProfile(name: DemoName, today: string): DemoProfile {
  return name === 'Alex' ? alex(today) : sam(today);
}

/** How many transactions an institution's custom user carries. */
export const txnCount = (inst: SeedInstitution) => inst.accounts.reduce((n, a) => n + a.transactions.length, 0);

/** The JSON Plaid's sandbox makes a custom user from (sent as the password
 *  of `user_custom`, lib/demo-seed/seed.ts). */
export function customUserConfig(inst: SeedInstitution, today: string): object {
  return {
    override_accounts: inst.accounts.map((a) => ({
      type: a.type,
      subtype: a.subtype,
      starting_balance: a.balance,
      currency: 'USD',
      meta: { name: a.name, mask: a.mask, ...(a.limit !== undefined ? { limit: a.limit } : {}), ...(a.apy !== undefined ? { apy: a.apy } : {}) },
      transactions: a.transactions.map((t) => ({
        date_transacted: t.date,
        // A posting date still to come is how Plaid's sandbox makes a row pending.
        date_posted: t.pending ? addDays(today, 1) : t.date,
        amount: t.amount,
        description: t.description,
        currency: 'USD',
      })),
      ...(a.holdings
        ? {
            holdings: a.holdings.map((h) => ({
              institution_price: h.price,
              institution_price_as_of: today,
              cost_basis: h.cost_basis,
              quantity: h.quantity,
              currency: 'USD',
              security: { ticker_symbol: h.ticker, name: h.name, currency: 'USD' },
            })),
          }
        : {}),
      ...(a.investment_transactions
        ? {
            investment_transactions: a.investment_transactions.map((t) => ({
              date: t.date,
              name: t.name,
              quantity: t.quantity,
              price: t.price,
              fees: 0,
              type: t.type,
              currency: 'USD',
              security: { ticker_symbol: t.ticker, currency: 'USD' },
            })),
          }
        : {}),
      ...(a.liability ? { liability: a.liability } : {}),
    })),
  };
}
