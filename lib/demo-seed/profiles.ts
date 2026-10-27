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
import type { DEMO_NAMES } from '../demo';

export type DemoName = (typeof DEMO_NAMES)[number];

/** Plaid supports about 250 transactions per custom user; this leaves room. */
export const MAX_TXNS_PER_ITEM = 240;
/** Months of history, the current one included. */
export const HISTORY_MONTHS = 12;

export type SeedTxn = { date: string; amount: number; description: string; pending?: boolean };
export type SeedHolding = { ticker: string; name: string; price: number; quantity: number; cost_basis: number };
export type SeedInvTxn = { date: string; name: string; type: 'cash' | 'buy'; quantity: number; price: number; ticker: string };

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

export type SeedManual = { name: string; type: 'depository' | 'investment' | 'other'; subtype: string | null; balance: number };
/** A goal, tracking the account with this mask (or none). */
export type SeedGoal = { name: string; target: number; mask: string | null };

export type DemoProfile = {
  name: DemoName;
  institutions: SeedInstitution[];
  manual: SeedManual[];
  /** Monthly budgets by Plaid primary category. */
  budgets: Record<string, number>;
  goals: SeedGoal[];
  /** What the Plan tab starts from, over its defaults. */
  plan: Partial<FirePlan>;
};

// Plaid's sandbox institutions without OAuth, which keep every field of a
// custom user (Plaid's docs warn OAuth ones may not).
const PLATYPUS = { institution_id: 'ins_109508', name: 'First Platypus Bank' };
const GINGHAM = { institution_id: 'ins_109509', name: 'First Gingham Credit Union' };
const TATTERSALL = { institution_id: 'ins_109510', name: 'Tattersall Federal Credit Union' };
const TARTAN = { institution_id: 'ins_109511', name: 'Tartan Bank' };
const HOUNDSTOOTH = { institution_id: 'ins_109512', name: 'Houndstooth Bank' };
// Brokerages, also without OAuth in the sandbox. One investment account with
// activity per Item: the sandbox puts every investment transaction of a custom
// user on each of its investment accounts, so two in one Item would each show
// the other's too.
const BETTERMENT = { institution_id: 'ins_115605', name: 'Betterment' };
const WEALTHFRONT = { institution_id: 'ins_115617', name: 'Wealthfront' };
const SCHWAB_PLANS = { institution_id: 'ins_121400', name: 'Charles Schwab - Retirement Plan Center' };
const ETRADE = { institution_id: 'ins_129473', name: 'E*TRADE from Morgan Stanley' };
const ASCENSUS = { institution_id: 'ins_118645', name: 'Ascensus - Merrill Lynch' };

const FUNDS = {
  VTI: { name: 'Vanguard Total Stock Market ETF', price: 312.4 },
  VXUS: { name: 'Vanguard Total International Stock ETF', price: 71.25 },
  BND: { name: 'Vanguard Total Bond Market ETF', price: 74.1 },
} as const;
type Fund = keyof typeof FUNDS;

// ---------------------------------------------------------------- dates

const DAY_MS = 86_400_000;
const parseDay = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fmtDay(parseDay(d) + n * DAY_MS);

/** One month of the history: its first day, and the calendar month (1 to 12). */
type Month = { index: number; year: number; month: number };

function historyMonths(today: string): Month[] {
  const [y, m] = today.split('-').map(Number);
  const out: Month[] = [];
  for (let back = HISTORY_MONTHS - 1; back >= 0; back--) {
    const total = y * 12 + (m - 1) - back;
    out.push({ index: HISTORY_MONTHS - 1 - back, year: Math.floor(total / 12), month: (total % 12) + 1 });
  }
  return out;
}

const daysIn = (mo: Month) => new Date(Date.UTC(mo.year, mo.month, 0)).getUTCDate();
/** A day of the month, clamped to its last day. */
const on = (mo: Month, day: number) => `${mo.year}-${String(mo.month).padStart(2, '0')}-${String(Math.min(day, daysIn(mo))).padStart(2, '0')}`;
const lastDay = (mo: Month) => on(mo, 31);

// ---------------------------------------------------------------- randomness

/** mulberry32: small, seeded, the same sequence on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

type Rand = {
  /** About `base`, give or take `spread` (a fraction). */
  about(base: number, spread: number): number;
  /** A whole day in 1..max. */
  day(max: number): number;
  pick<T>(xs: readonly T[]): T;
};

function rand(seed: number): Rand {
  const r = rng(seed);
  return {
    about: (base, spread) => round2(base * (1 + (r() * 2 - 1) * spread)),
    day: (max) => 1 + Math.floor(r() * max),
    pick: (xs) => xs[Math.floor(r() * xs.length)],
  };
}

// ---------------------------------------------------------------- books

/** One account's rows for the year, which only ever include days up to today. */
class Book {
  readonly rows: SeedTxn[] = [];
  constructor(private readonly today: string) {}
  add(date: string, amount: number, description: string): void {
    if (date > this.today) return;
    this.rows.push({ date, amount: round2(amount), description });
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
const cashBalance = (opening: number, book: Book) => round2(opening - book.posted());
/** What a card or a loan owes today, from what it owed when the year opened. */
const owedBalance = (opening: number, book: Book) => round2(opening + book.posted());

/** An investment account: today's holdings worth `value`, split by weight
 *  with the rest in cash, and a year of contributions each followed by a buy. */
class Portfolio {
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
    const yearsAgo = (parseDay(this.today) - parseDay(buyOn)) / (365 * DAY_MS);
    const price = round2(FUNDS[fund].price * (1 - 0.12 * yearsAgo));
    this.txns.push({ date: buyOn, name: `BUY ${fund}`, type: 'buy', quantity: Math.round((amount / price) * 10_000) / 10_000, price, ticker: fund });
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
    if (mo.index % 3 === 1) card.add(on(mo, r.day(28)), r.about(120, 0.5), 'REI #105 SAN FRANCISCO');
    if (mo.index % 2 === 1) card.add(on(mo, r.day(28)), r.about(24, 0.4), 'WALGREENS #3021');
    if (mo.month === 7) {
      card.add(on(mo, 9), 412.6, 'UNITED AIRLINES');
      card.add(on(mo, 19), 389.2, 'HYATT HOTELS TOKYO');
    }
    if (mo.month === 2) card.add(on(mo, 13), 520, 'AIRBNB * HM4QZ8 TAHOE');
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
  return {
    name: 'Alex',
    institutions: [
      {
        ...PLATYPUS,
        products: ['transactions'],
        accounts: [
          { mask: '4821', type: 'depository', subtype: 'checking', name: 'Everyday Checking', balance: cashBalance(5_400, checking), transactions: checking.sorted() },
          { mask: '9930', type: 'depository', subtype: 'savings', name: 'High-Yield Savings', apy: 4.1, balance: cashBalance(15_500, savings), transactions: savings.sorted() },
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
    manual: [{ name: 'Health Savings Account', type: 'investment', subtype: 'hsa', balance: 9_850 }],
    budgets: { FOOD_AND_DRINK: 650, GENERAL_MERCHANDISE: 250, ENTERTAINMENT: 150, TRANSPORTATION: 120, TRAVEL: 300 },
    goals: [
      { name: 'Emergency fund', target: 25_000, mask: '9930' },
      { name: 'Japan trip', target: 6_000, mask: null },
    ],
    plan: { age: 31, targetAge: 45, withdrawalRate: 0.035, stocksPct: 90, bondsPct: 10 },
  };
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

  for (const mo of months) {
    const from = on(mo, 1);
    // Card: the household's spending.
    card.add(on(mo, 4), r.about(265, 0.25), 'COSTCO WHSE #0144');
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
    if (mo.month === 6) {
      card.add(on(mo, 3), 1_084.4, 'SOUTHWEST AIRLINES');
      card.add(on(mo, 20), 1_412, 'AIRBNB * HMX81Q SAN DIEGO');
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
      { name: 'College fund', target: 80_000, mask: '3360' },
    ],
    plan: {
      age: 38,
      targetAge: 52,
      withdrawalRate: 0.0375,
      stocksPct: 80,
      bondsPct: 20,
      income: [{ id: 'social-security', label: 'Social Security (both)', amount: 42_000, fromAge: 67, inflationAdjusted: true }],
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
