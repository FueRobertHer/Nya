// lib/demo-seed/scenario-profiles.ts
//
// The scenarios beyond the two demo accounts' own (lib/demo-seed/
// scenarios.ts), for the states one fixed demo can't show:
//
// - Riley, retired early: stopped work at 44 and is 47 now, living on a
//   taxable brokerage drawn on each month, with consulting that pays when it
//   pays, ACA cover until Medicare and Roth conversions planned. More has
//   come out of the brokerage than went in, as of totals typed a while back.
// - Alex with things to fix: the student loan's bank needs signing in again
//   (after its balances are recorded, so the total keeps them as last
//   known), a connection that ends in five days, new accounts to review, an
//   old savings account sitting at $0, and deposits and withdrawals typed as
//   of a day before the Roth's activity starts, so they can't be carried.
// - Alex with the brokerage and the Roth at Vanguard: the brokerage's months
//   since it opened four years back imported from Vanguard's Performance page
//   (made up, lib/demo-seed/past-months.ts), before the two years of activity
//   Plaid shares and the year Nya recorded; and Vanguard's transactions
//   download imported (lib/demo-seed/imports.ts): a CSV of the last year
//   into both, which says the Roth's conversion two months back is one, and
//   a QFX taken into the brokerage half a year back, whose days the CSV
//   decides from where they meet. Two connections to Vanguard, since the
//   sandbox puts each investment transaction on every investment account of
//   an Item. A scenario of its own, since Vanguard may be OAuth at Plaid,
//   where a custom user may not link as asked.
//
// Pure and deterministic, as lib/demo-seed/profiles.ts is.

import { atAge, planItem } from './extras';
import {
  addDays,
  Book,
  BETTERMENT,
  cashBalance,
  demoProfile,
  ETRADE,
  GINGHAM,
  historyMonths,
  lastDay,
  monthsBeforeHistory,
  on,
  owedBalance,
  Portfolio,
  rand,
  round2,
  PLATYPUS,
  TARTAN,
  VANGUARD,
  WEALTHFRONT,
  type DemoProfile,
} from './profiles';

/** Riley, 47, who stopped work three years ago. */
export function earlyRetiree(today: string): DemoProfile {
  const r = rand(47);
  const months = historyMonths(today);
  const checking = new Book(today);
  const savings = new Book(today);
  const card = new Book(today);
  const brokerage = new Portfolio(today, 1_084_000, { VTI: 0.82, VXUS: 0.15 });
  const ira = new Portfolio(today, 612_500, { VTI: 0.55, VXUS: 0.15, BND: 0.29 });
  const roth = new Portfolio(today, 186_400, { VTI: 0.75, VXUS: 0.24 });

  const CARD_OPENING = 1_312.4;
  let lastStatement = CARD_OPENING;
  let savingsBalance = 58_000;
  // Consulting: a few clients a year, paid when the work is done.
  const consulting: Record<number, number> = { 1: 4_200, 4: 2_800, 5: 6_500, 8: 3_100, 10: 5_400 };

  for (const mo of months) {
    const from = on(mo, 1);
    // Card: a household of one with a paid-off house.
    for (const d of [4, 12, 20, 27]) card.add(on(mo, d), r.about(96, 0.3), d % 8 === 4 ? 'PCC COMMUNITY MARKETS' : 'QFC #5812');
    for (let i = 0; i < 3; i++) card.add(on(mo, r.day(28)), r.about(36, 0.5), r.pick(['TAMARIND TREE', 'MOLLY MOON ICE CREAM', 'PHO BAC SUP SHOP', 'THE PINK DOOR']));
    card.add(on(mo, 9), r.about(52, 0.2), 'COSTCO GAS #0007');
    card.add(on(mo, 14), 17.99, 'NETFLIX.COM');
    if (mo.index % 3 === 0) card.add(on(mo, r.day(28)), r.about(140, 0.5), 'REI #11 SEATTLE');
    if (mo.index === 3) card.add(on(mo, 8), 640.2, 'ALASKA AIRLINES');
    if (mo.index === 7) card.add(on(mo, 15), 1_180, 'AIRBNB * HMQ2K9 MOAB');
    card.add(on(mo, 22), -lastStatement, 'AUTOPAY PAYMENT THANK YOU');
    checking.add(on(mo, 22), lastStatement, 'TARTAN BANK CARD PAYMENT');
    lastStatement = round2(card.rows.filter((t) => t.amount > 0 && t.date >= from && t.date <= lastDay(mo)).reduce((s, t) => s + t.amount, 0));

    // Checking: the month's draw from the brokerage, consulting when it
    // comes, the bills.
    brokerage.withdraw(on(mo, 3), 3_500, 'VTI', 'ACH WITHDRAWAL');
    checking.add(on(mo, 3), -3_500, 'ONLINE TRANSFER FROM BROKERAGE XXXX6604');
    if (consulting[mo.index]) checking.add(on(mo, 18), -consulting[mo.index], 'BLUEFIN ADVISORY ACH PMT');
    checking.add(on(mo, 1), 412, 'WA HEALTHPLANFINDER PREMIUM');
    checking.add(on(mo, 6), r.about(mo.month <= 2 || mo.month === 12 ? 168 : 96, 0.12), 'PUGET SOUND ENERGY');
    checking.add(on(mo, 11), r.about(88, 0.15), 'SEATTLE PUBLIC UTILITIES');
    checking.add(on(mo, 8), 70, 'CENTURYLINK INTERNET');
    checking.add(on(mo, 12), 30, 'MINT MOBILE');
    if (mo.month === 4 || mo.month === 10) checking.add(on(mo, 28), 2_140, 'KING COUNTY PROPERTY TAX');
    if (mo.month === 6) checking.add(on(mo, 10), 1_380, 'PEMCO HOMEOWNERS INSURANCE');

    // Savings: the cash buffer, topped up in a month consulting paid.
    if (consulting[mo.index]) {
      checking.add(on(mo, 20), 2_000, 'ONLINE TRANSFER TO SAVINGS XXXX3302');
      savings.add(on(mo, 20), -2_000, 'ONLINE TRANSFER FROM CHECKING XXXX3301');
      if (on(mo, 20) <= today) savingsBalance += 2_000;
    }
    const interest = round2((savingsBalance * 0.039) / 12);
    savings.add(lastDay(mo), -interest, 'INTEREST EARNED');
    if (lastDay(mo) <= today) savingsBalance += interest;
  }
  card.pending(r.about(58, 0.3), 'QFC #5812');

  return {
    name: 'Riley',
    institutions: [
      {
        ...PLATYPUS,
        products: ['transactions'],
        accounts: [
          { mask: '3301', type: 'depository', subtype: 'checking', name: 'Checking', balance: cashBalance(8_400, checking), transactions: checking.sorted() },
          { mask: '3302', type: 'depository', subtype: 'savings', name: 'Cash Buffer', apy: 3.9, balance: cashBalance(58_000, savings), transactions: savings.sorted() },
        ],
      },
      {
        ...TARTAN,
        products: ['transactions', 'liabilities'],
        accounts: [
          {
            mask: '3310', type: 'credit', subtype: 'credit card', name: 'Travel Rewards Visa', limit: 20_000, balance: owedBalance(CARD_OPENING, card), transactions: card.sorted(),
            liability: { type: 'credit', purchase_apr: 23.49, minimum_payment_amount: 40, last_statement_balance: lastStatement, last_payment_amount: 1_300 },
          },
        ],
      },
      {
        ...ETRADE,
        products: ['investments'],
        accounts: [{ mask: '6604', type: 'investment', subtype: 'brokerage', name: 'Taxable Brokerage', balance: 1_084_000, transactions: [], holdings: brokerage.holdings(), investment_transactions: brokerage.txns }],
      },
      {
        ...BETTERMENT,
        products: ['investments'],
        accounts: [{ mask: '6611', type: 'investment', subtype: 'ira', name: 'Rollover IRA', balance: 612_500, transactions: [], holdings: ira.holdings(), investment_transactions: ira.txns }],
      },
      {
        ...WEALTHFRONT,
        products: ['investments'],
        accounts: [{ mask: '6612', type: 'investment', subtype: 'roth', name: 'Roth IRA', balance: 186_400, transactions: [], holdings: roth.holdings(), investment_transactions: roth.txns }],
      },
    ],
    manual: [
      { name: 'Health Savings Account', type: 'investment', subtype: 'hsa', balance: 41_800 },
      { name: 'Home (estimated value)', type: 'other', subtype: 'real estate', balance: 745_000 },
    ],
    budgets: { FOOD_AND_DRINK: 750, TRAVEL: 400, ENTERTAINMENT: 120, RENT_AND_UTILITIES: 420, GENERAL_MERCHANDISE: 200 },
    goals: [{ name: 'Two-year cash buffer', target: 84_000, mask: '3302' }],
    plan: {
      age: 47,
      // The stop is now: a stop before today's age is refused, and it has passed.
      targetAge: 47,
      spending: 46_000,
      withdrawalRate: 0.035,
      stocksPct: 75,
      bondsPct: 25,
      rule: 'guardrails',
      income: [{ id: 'social-security', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }],
    },
    tax: {
      partnerAge: null,
      accounts: [{ mask: '6604', owner: 'you', basis: 690_000 }],
      roth: [{ owner: 'you', amount: 64_000 }],
      detail: { filing: 'single', state: 'WA', beforeMedicare: { kind: 'aca', adult: 7_800, quotedAge: 47, child: null }, socialSecurity: 'social-security' },
    },
    extras: {
      tags: ['Consulting'],
      rules: [{ name: 'BLUEFIN ADVISORY', tags: ['Consulting'] }],
      incomeCarryover: true,
      planned: {
        items: [
          { name: 'Property tax', kind: 'expense', amount: 2_140, date: on(months[4], 28), cadence: 'semiannual' },
          { name: 'Consulting invoice', kind: 'income', amount: 4_000, date: addDays(today, 45), cadence: 'once' },
        ],
        threshold: 3_000,
      },
      runway: [{ name: 'If the market drops and I stop drawing', months: 12, lower_by: 500, income_until: today, planned: true, leave_out_one_offs: false }],
      // Typed as of three months back: more taken out than put in.
      moneyInOut: [{ mask: '6604', in: 402_000, out: 436_500, as_of: lastDay(months[8]) }],
      allocation: { target: { 'us-stocks': 60, 'intl-stocks': 15, bonds: 25 } },
      plan: {
        items: [planItem({ id: 'consulting', label: 'Consulting', kind: 'part-time', from: atAge(47), until: { years: 6 }, yearly: 14_000, replaces: 0 })],
        copies: [{ name: 'Spend 10% more', set: { spending: 50_600 } }],
        detailed: { conversions: { kind: 'aca-then-bracket', top: 0.12 }, convertUntil: 63 },
        savedMonthsBack: 4,
      },
    },
  };
}

/** Alex's money, with what a connection or an account can need fixing. */
export function needsAttention(today: string): DemoProfile {
  const alex = demoProfile('Alex', today);
  const months = historyMonths(today);
  const institutions = alex.institutions.map((inst) =>
    inst.institution_id === PLATYPUS.institution_id
      ? // Emptied when the high-yield account opened, never closed.
        { ...inst, accounts: [...inst.accounts, { mask: '7001', type: 'depository' as const, subtype: 'savings', name: 'Old Savings', balance: 0, transactions: [] }] }
      : inst
  );
  const x = alex.extras!;
  return {
    ...alex,
    name: 'Alex, needs attention',
    institutions,
    extras: {
      ...x,
      // As of a day before the Roth's first activity Nya has, so the
      // activity between can't be carried forward.
      moneyInOut: [
        { mask: '5521', in: 22_400, out: 0, as_of: addDays(on(months[0], 2), -20) },
        ...(x.moneyInOut ?? []).filter((m) => m.mask !== '5521'),
      ],
      trouble: { loginRequired: GINGHAM.institution_id, reconnectSoon: { institution_id: TARTAN.institution_id, days: 5 }, newAccounts: PLATYPUS.institution_id },
    },
  };
}

/** Alex's money, the brokerage and the Roth at Vanguard, with their history
 *  imported from Vanguard's own files. */
export function vanguardHistory(today: string): DemoProfile {
  const alex = demoProfile('Alex', today);
  const months = historyMonths(today);
  // The eleven months before the history: Plaid shares two years of an
  // investment account's activity, a bank's one here.
  const earlier = new Portfolio(today, 0, {});
  for (const mo of monthsBeforeHistory(today, 11)) earlier.contribute(on(mo, 16), 1_500, 'VTI', 'ACH CONTRIBUTION');
  // An old Traditional IRA's money, not in Nya, converted to the Roth: Plaid
  // says only that it came in, Vanguard's CSV that it was a conversion.
  const converted = new Portfolio(today, 0, {});
  converted.contribute(on(months[9], 6), 5_000, 'VTI', 'ROTH CONVERSION');
  const institutions = alex.institutions.map((inst) => {
    const brokerage = inst.accounts.find((a) => a.mask === '7788');
    if (brokerage) return { ...inst, ...VANGUARD, accounts: [{ ...brokerage, investment_transactions: [...earlier.txns, ...(brokerage.investment_transactions ?? [])] }] };
    const roth = inst.accounts.find((a) => a.mask === '5521');
    if (roth) {
      const rows = [...(roth.investment_transactions ?? []), ...converted.txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return { ...inst, ...VANGUARD, accounts: [{ ...roth, investment_transactions: rows }] };
    }
    return inst;
  });
  return {
    ...alex,
    name: 'Alex, Vanguard history',
    institutions,
    extras: {
      ...alex.extras,
      investmentMonths: { mask: '7788', file_name: 'Vanguard performance.pdf', openedMonthsBack: 48, monthlyBefore: 300 },
      transactionImports: [
        // The brokerage's eighteen months to half a year back, as a QFX.
        { source: 'vanguard-qfx', file_name: 'Vanguard transactions.qfx', masks: ['7788'], from: on(monthsBeforeHistory(today, 7)[0], 1), made: on(months[5], 5) },
        // The last year of both, as a CSV, downloaded nine days back.
        {
          source: 'vanguard-csv',
          file_name: 'Vanguard transactions.csv',
          masks: ['7788', '5521'],
          from: on(monthsBeforeHistory(today, 1)[0], 1),
          made: addDays(today, -9),
          kinds: { 'ACH CONTRIBUTION': 'Funds Received', 'ROTH CONTRIBUTION': 'Contribution', 'ROTH CONVERSION': 'Conversion (incoming)' },
        },
      ],
    },
  };
}
