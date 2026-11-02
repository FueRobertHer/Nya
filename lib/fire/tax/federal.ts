// lib/fire/tax/federal.ts
//
// One year's federal income tax (and the flat state rate) for a single or
// joint return, the way the IRS's own worksheets work it out:
//
//   1. Capital gains less any loss carried in; a net loss offsets ordinary
//      income up to $3,000 (IRC 1211(b)), never qualified dividends.
//   2. Social Security's taxable share by Pub 915 Worksheet 1: provisional
//      income (income before benefits, tax-exempt interest and half the
//      benefits) over the base amount, 50% then 85%, capped at 85%.
//   3. AGI, and the two MAGIs: the ACA's (AGI plus nontaxable Social Security
//      plus tax-exempt interest, IRC 36B(d)(2)(B)) and IRMAA's (AGI plus
//      tax-exempt interest).
//   4. The deduction: the standard deduction, the additions for each filer
//      65 or older, and through 2028 the senior deduction, each filer's $6,000
//      less 6% of AGI over the threshold.
//   5. Tax by the Qualified Dividends and Capital Gain Tax Worksheet: ordinary
//      income by the brackets, gains and qualified dividends stacked on top in
//      the 0%, 15% and 20% bands, and its line 25, the smaller of that and the
//      regular tax on all of taxable income (which binds between the 0% band's
//      top and the 12% bracket's).
//   6. The net investment income tax on interest, dividends and gains less the
//      allowed loss (not retirement money or Social Security), the state rate
//      on AGI less taxable Social Security, the additional taxes on early
//      distributions, and the employee's FICA on wages.
//
// Every input is a Lin (lib/fire/tax/piece.ts): a value and its slope in the
// year's withdrawal, so one evaluation gives the year's solver the tax, its
// slope and where it next changes. Called with slopes of 0 it is a plain tax
// calculation, which is how the golden tests call it.
//
// Amounts the law doesn't index (Social Security's base amounts, NIIT's
// thresholds, the senior deduction, the loss limit) are divided by
// `priceLevel`, prices this year over the law year's, since a plan's dollars
// are today's (Tax engine: Today's dollars and nominal law).
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import type { Filing, TaxLaw } from './law/types';
import { addScaled, atLeastOf, atMost, bracketTax, lin, plus, scale, set, smaller, type Lin } from './piece';

export type FederalInput = {
  filing: Filing;
  /** The calendar year, for scheduled changes (the senior deduction ends after 2028). */
  calendarYear: number;
  /** Prices this year over the law year's: amounts the law doesn't index are divided by it. */
  priceLevel: number;
  /** Filers 65 or older by the year's end: 0, 1 or 2. */
  aged: number;
  /** Each filer's wages (the second 0 on a single return). */
  wages: [Lin, Lin];
  /** Other ordinary income: pensions, tax-deferred and 457(b) money, conversions,
   *  an HSA's taxed money, interest and ordinary dividends. */
  ordinary: Lin;
  /** The part of `ordinary` that is net investment income (interest and ordinary dividends). */
  investmentOrdinary: Lin;
  /** Qualified dividends. */
  qualified: Lin;
  /** Long-term gains realized this year; below 0 for a loss. */
  gains: Lin;
  /** Tax-exempt interest. */
  exempt: Lin;
  /** Social Security benefits, gross. */
  socialSecurity: number;
  /** The capital loss carried in from last year. */
  carryover: number;
  /** Amounts under the 10% additional tax on early distributions. */
  early: Lin;
  /** An HSA's non-medical amounts under the 20% additional tax. */
  hsaEarly: Lin;
  /** The state's one rate, on AGI less taxable Social Security. */
  stateRate: number;
};

export type FederalResult = {
  agi: Lin;
  taxableSocialSecurity: Lin;
  /** The ACA's MAGI: AGI plus nontaxable Social Security plus tax-exempt interest. */
  magiAca: Lin;
  /** IRMAA's MAGI: AGI plus tax-exempt interest. */
  magiIrmaa: Lin;
  deduction: Lin;
  taxableIncome: Lin;
  /** Taxable income less qualified dividends and net gain (the worksheet's line 5). */
  ordinaryTaxable: Lin;
  /** The tax on ordinary taxable income (line 22). */
  ordinaryTax: Lin;
  /** The tax on gains and qualified dividends (lines 18 and 21). */
  gainsTax: Lin;
  /** Income tax: the worksheet's line 25. */
  incomeTax: Lin;
  niit: Lin;
  state: Lin;
  penalty: Lin;
  fica: Lin;
  /** Everything above, together. */
  total: Lin;
  /** The capital loss deducted against ordinary income this year. */
  lossDeduction: number;
  /** The capital loss carried to next year, by the Capital Loss Carryover Worksheet. */
  carryoverOut: number;
};

export function newFederalInput(filing: Filing = 'single'): FederalInput {
  return {
    filing, calendarYear: 2026, priceLevel: 1, aged: 0, wages: [lin(), lin()],
    ordinary: lin(), investmentOrdinary: lin(), qualified: lin(), gains: lin(), exempt: lin(),
    socialSecurity: 0, carryover: 0, early: lin(), hsaEarly: lin(), stateRate: 0,
  };
}

export function newFederalResult(): FederalResult {
  return {
    agi: lin(), taxableSocialSecurity: lin(), magiAca: lin(), magiIrmaa: lin(), deduction: lin(),
    taxableIncome: lin(), ordinaryTaxable: lin(), ordinaryTax: lin(), gainsTax: lin(), incomeTax: lin(),
    niit: lin(), state: lin(), penalty: lin(), fica: lin(), total: lin(), lossDeduction: 0, carryoverOut: 0,
  };
}

// Scratch, made once: an evaluation allocates nothing.
const net = lin(), netGain = lin(), loss = lin(), lossDed = lin(), before = lin(), t = lin(), u = lin();
const l10 = lin(), l12 = lin(), l13 = lin(), l15 = lin(), l17 = lin(), each = lin(), tiRaw = lin();
const pref = lin(), q5 = lin(), q7 = lin(), q8 = lin(), q9 = lin(), q10 = lin(), q12 = lin(), q14 = lin();
const q16 = lin(), q17 = lin(), q20 = lin(), q23 = lin(), q24 = lin(), nii = lin(), over = lin();

/** The year's federal tax (and state rate) into `out`. */
export function federal(inp: FederalInput, law: TaxLaw, out: FederalResult): FederalResult {
  const st = law.statute;
  const br = law.brackets;
  const f = inp.filing;
  const p = inp.priceLevel;
  const ss = inp.socialSecurity;

  // 1. Gains less the carryover; a net loss's deduction.
  plus(net, inp.gains, -inp.carryover);
  atLeastOf(netGain, net, 0);
  scale(loss, net, -1);
  atLeastOf(loss, loss, 0);
  atMost(lossDed, loss, st.capitalLoss / p);

  // Income before Social Security: AGI's other lines.
  addScaled(t, inp.wages[0], inp.wages[1]);
  addScaled(t, t, inp.ordinary);
  addScaled(t, t, lossDed, -1);
  addScaled(t, t, inp.qualified);
  addScaled(before, t, netGain);

  // 2. Pub 915 Worksheet 1. Line 8 is provisional income (no adjustments);
  // lines 10 to 19 as printed.
  const out1 = out.taxableSocialSecurity;
  if (ss > 0) {
    const base = st.socialSecurity.base[f] / p;
    const second = (st.socialSecurity.adjusted[f] - st.socialSecurity.base[f]) / p;
    addScaled(t, before, inp.exempt);
    plus(t, t, 0.5 * ss - base);
    atLeastOf(l10, t, 0); // line 10
    plus(t, l10, -second);
    atLeastOf(l12, t, 0); // line 12
    atMost(l13, l10, second); // line 13
    scale(t, l13, 0.5); // line 14
    atMost(l15, t, 0.5 * ss); // line 15
    addScaled(l17, l15, l12, 0.85); // lines 16 and 17
    atMost(out1, l17, 0.85 * ss); // line 19
  } else {
    set(out1, 0);
  }

  // 3. AGI and the MAGIs.
  addScaled(out.agi, before, out1);
  plus(t, before, ss);
  addScaled(out.magiAca, t, inp.exempt);
  addScaled(out.magiIrmaa, out.agi, inp.exempt);

  // 4. The deduction.
  const aged = f === 'joint' ? br.aged.married : br.aged.unmarried;
  set(out.deduction, br.standard[f] + inp.aged * aged);
  if (inp.aged > 0 && inp.calendarYear <= st.senior.through) {
    plus(t, out.agi, -st.senior.threshold[f] / p);
    atLeastOf(t, t, 0);
    scale(t, t, -st.senior.rate);
    plus(t, t, st.senior.amount / p);
    atLeastOf(each, t, 0);
    addScaled(out.deduction, out.deduction, each, inp.aged);
  }
  addScaled(tiRaw, out.agi, out.deduction, -1);
  atLeastOf(out.taxableIncome, tiRaw, 0);

  // 5. The Qualified Dividends and Capital Gain Tax Worksheet.
  const ti = out.taxableIncome;
  const bands = br.gains[f];
  addScaled(pref, inp.qualified, netGain); // line 4
  addScaled(t, ti, pref, -1);
  atLeastOf(q5, t, 0); // line 5
  atMost(q7, ti, bands.zeroTo); // line 7
  smaller(q8, q5, q7); // line 8
  addScaled(q9, q7, q8, -1); // line 9, taxed at 0%
  smaller(q10, ti, pref); // line 10
  addScaled(q12, q10, q9, -1); // line 12
  atMost(q14, ti, bands.fifteenTo); // line 14
  addScaled(t, q5, q9); // line 15
  addScaled(t, q14, t, -1);
  atLeastOf(q16, t, 0); // line 16
  smaller(q17, q12, q16); // line 17
  addScaled(t, q9, q17); // line 19
  addScaled(q20, q10, t, -1); // line 20
  scale(t, q17, st.gainsRates.fifteen); // line 18
  addScaled(out.gainsTax, t, q20, st.gainsRates.twenty); // lines 18 and 21
  bracketTax(out.ordinaryTax, q5, br.ordinary[f]); // line 22
  addScaled(q23, out.gainsTax, out.ordinaryTax); // line 23
  bracketTax(q24, ti, br.ordinary[f]); // line 24
  smaller(out.incomeTax, q23, q24); // line 25
  set(out.ordinaryTaxable, q5.v, q5.s);

  // 6. NIIT, the state rate, the additional taxes and FICA.
  addScaled(t, inp.investmentOrdinary, inp.qualified);
  addScaled(t, t, netGain);
  addScaled(t, t, lossDed, -1);
  atLeastOf(nii, t, 0);
  plus(t, out.agi, -st.niit.threshold[f] / p);
  atLeastOf(over, t, 0);
  smaller(t, nii, over);
  scale(out.niit, t, st.niit.rate);

  atLeastOf(t, before, 0);
  scale(out.state, t, inp.stateRate);

  scale(t, inp.early, st.early);
  addScaled(out.penalty, t, inp.hsaEarly, st.hsa.rate);

  set(out.fica, 0);
  for (let i = 0; i < 2; i++) {
    const w = inp.wages[i];
    atMost(u, w, law.wageBase);
    addScaled(out.fica, out.fica, u, st.fica.socialSecurity);
    addScaled(out.fica, out.fica, w, st.fica.medicare);
  }

  addScaled(t, out.incomeTax, out.niit);
  addScaled(t, t, out.state);
  addScaled(t, t, out.penalty);
  addScaled(out.total, t, out.fica);

  // The Capital Loss Carryover Worksheet: the deduction counts as used only as
  // far as taxable income before it (lines 1 to 4), the rest carries on.
  out.lossDeduction = lossDed.v;
  const used = Math.min(lossDed.v, Math.max(0, tiRaw.v + lossDed.v));
  out.carryoverOut = loss.v - used;
  return out;
}
