import { describe, expect, test } from 'bun:test';
import { federal, newFederalInput, newFederalResult, type FederalInput } from '@/lib/fire/tax/federal';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import { LAW_2027 } from '@/lib/fire/tax/law/2027';
import type { Bracket, Filing, TaxLaw } from '@/lib/fire/tax/law/types';
import { begin, bracketTax, lin } from '@/lib/fire/tax/piece';

// Golden tests: federal.ts against the IRS's own printed figures and its
// worksheets' lines, worked by hand where the IRS prints no example.
//
// Sources:
//   - Rev. Proc. 2025-32 (October 9, 2025), sec. 4.01 Tables 1 and 3: each
//     2026 bracket's tax at its start ("$11,600 plus 22% of the excess over
//     $100,800").
//   - Rev. Proc. 2026-35 (November 5, 2026), sec. 3.01 Tables 1 and 3: the
//     same for 2027 ("$11,974.00 plus 22% of the excess over $104,050").
//   - The 2025 Tax Computation Worksheet (Instructions for Form 1040, Tax
//     Table), on 2025's brackets from Rev. Proc. 2024-40 sec. 3.01: "multiply
//     by 22%, subtract $5,086.00" and the rest.
//   - Pub 915 (2025), Worksheet 1, Examples 1 and 3. Social Security's base
//     amounts aren't indexed, so 2025's examples hold for 2026.
//   - The Qualified Dividends and Capital Gain Tax Worksheet, Schedule 1-A
//     (2025) Part V, Form 8960 and the Capital Loss Carryover Worksheet, line
//     by line below.

const fixed = (v: number) => lin(v, 0);

function run(filing: Filing, set: (inp: FederalInput) => void, law: TaxLaw = LAW_2026) {
  const inp = newFederalInput(filing);
  set(inp);
  begin(false);
  return federal(inp, law, newFederalResult());
}

/** Taxable income exactly `ti` from ordinary income alone. */
function ordinaryTo(filing: Filing, ti: number, law: TaxLaw = LAW_2026) {
  return run(filing, (inp) => {
    inp.ordinary = fixed(ti + law.brackets.standard[filing]);
  }, law);
}

function tax(brackets: readonly Bracket[], x: number): number {
  begin(false);
  return bracketTax(lin(), lin(x), brackets).v;
}

describe('the 2026 brackets', () => {
  test("each bracket's tax at its start is Rev. Proc. 2025-32's printed base", () => {
    const single = [[12_400, 1_240], [50_400, 5_800], [105_700, 17_966], [201_775, 41_024], [256_225, 58_448], [640_600, 192_979.25]];
    const joint = [[24_800, 2_480], [100_800, 11_600], [211_400, 35_932], [403_550, 82_048], [512_450, 116_896], [768_700, 206_583.5]];
    for (const [ti, base] of single) {
      expect(tax(LAW_2026.brackets.ordinary.single, ti)).toBeCloseTo(base, 6);
      expect(ordinaryTo('single', ti).incomeTax.v).toBeCloseTo(base, 6);
    }
    for (const [ti, base] of joint) {
      expect(tax(LAW_2026.brackets.ordinary.joint, ti)).toBeCloseTo(base, 6);
      expect(ordinaryTo('joint', ti).incomeTax.v).toBeCloseTo(base, 6);
    }
  });

  test('the 2025 Tax Computation Worksheet: rate times income less the printed subtraction', () => {
    // Rev. Proc. 2024-40 sec. 3.01, Tables 1 and 3 (test-only: Nya plans use 2026's law).
    const single2025: Bracket[] = [
      { upTo: 11_925, rate: 0.1 }, { upTo: 48_475, rate: 0.12 }, { upTo: 103_350, rate: 0.22 }, { upTo: 197_300, rate: 0.24 },
      { upTo: 250_525, rate: 0.32 }, { upTo: 626_350, rate: 0.35 }, { upTo: Infinity, rate: 0.37 },
    ];
    const joint2025: Bracket[] = [
      { upTo: 23_850, rate: 0.1 }, { upTo: 96_950, rate: 0.12 }, { upTo: 206_700, rate: 0.22 }, { upTo: 394_600, rate: 0.24 },
      { upTo: 501_050, rate: 0.32 }, { upTo: 751_600, rate: 0.35 }, { upTo: Infinity, rate: 0.37 },
    ];
    // Section A (single) and B (joint): [from, to, multiplication, subtraction].
    const a = [[100_000, 103_350, 0.22, 5_086], [103_350, 197_300, 0.24, 7_153], [197_300, 250_525, 0.32, 22_937], [250_525, 626_350, 0.35, 30_452.75], [626_350, 900_000, 0.37, 42_979.75]];
    const b = [[100_000, 206_700, 0.22, 10_172], [206_700, 394_600, 0.24, 14_306], [394_600, 501_050, 0.32, 45_874], [501_050, 751_600, 0.35, 60_905.5], [751_600, 1_200_000, 0.37, 75_937.5]];
    for (const [rows, brackets] of [[a, single2025], [b, joint2025]] as const) {
      for (const [from, to, rate, less] of rows) {
        for (const ti of [from + 1, Math.round((from + to) / 2), to]) {
          expect(tax(brackets, ti)).toBeCloseTo(ti * rate - less, 6);
        }
      }
    }
  });
});

describe('the 2027 brackets', () => {
  // 2027's table isn't whole yet, so 2026's Medicare and Medicaid poverty
  // guidelines stand in; the federal tax reads neither.
  const law2027: TaxLaw = { ...LAW_2026, ...LAW_2027 };

  test("each bracket's tax at its start is Rev. Proc. 2026-35's printed base", () => {
    const single = [[12_800, 1_280], [52_025, 5_987], [109_125, 18_549], [208_325, 42_357], [264_550, 60_349], [661_375, 199_237.75]];
    const joint = [[25_600, 2_560], [104_050, 11_974], [218_250, 37_098], [416_650, 84_714], [529_100, 120_698], [793_650, 213_290.5]];
    for (const [ti, base] of single) {
      expect(tax(law2027.brackets.ordinary.single, ti)).toBeCloseTo(base, 6);
      expect(ordinaryTo('single', ti, law2027).incomeTax.v).toBeCloseTo(base, 6);
    }
    for (const [ti, base] of joint) {
      expect(tax(law2027.brackets.ordinary.joint, ti)).toBeCloseTo(base, 6);
      expect(ordinaryTo('joint', ti, law2027).incomeTax.v).toBeCloseTo(base, 6);
    }
  });
});

describe("Social Security's taxable share (Pub 915 Worksheet 1)", () => {
  test('Example 1: single, $5,980 of benefits, $28,990 of other income: $2,990 taxable', () => {
    // A pension of $18,600, wages of $9,400 and $990 of interest.
    const r = run('single', (inp) => {
      inp.socialSecurity = 5_980;
      inp.wages = [fixed(9_400), fixed(0)];
      inp.ordinary = fixed(18_600 + 990);
      inp.investmentOrdinary = fixed(990);
    });
    expect(r.taxableSocialSecurity.v).toBeCloseTo(2_990, 6);
  });

  test("Example 3: joint, $10,000 of benefits, $40,500 on line 3: line 16's 85% applies, $6,275 taxable", () => {
    const r = run('joint', (inp) => {
      inp.socialSecurity = 10_000;
      inp.ordinary = fixed(40_500);
    });
    expect(r.taxableSocialSecurity.v).toBeCloseTo(6_275, 6);
  });

  test('provisional income at the base amount leaves none taxable, and 85% caps it', () => {
    // $32,000 joint: benefits of $20,000 (half is $10,000) and $22,000 of pension.
    expect(run('joint', (inp) => { inp.socialSecurity = 20_000; inp.ordinary = fixed(22_000); }).taxableSocialSecurity.v).toBeCloseTo(0, 6);
    expect(run('single', (inp) => { inp.socialSecurity = 30_000; inp.ordinary = fixed(200_000); }).taxableSocialSecurity.v).toBeCloseTo(25_500, 6);
  });
});

describe('the Qualified Dividends and Capital Gain Tax Worksheet', () => {
  test('single: $40,000 ordinary taxable, $5,000 qualified dividends, $20,000 gains', () => {
    // Line 1 $65,000; 4 $25,000; 5 $40,000; 7 $49,450; 8 $40,000; 9 $9,450 at
    // 0%; 10 $25,000; 12 $15,550; 14 $65,000; 15 $49,450; 16 $15,550; 17
    // $15,550; 18 $2,332.50; 20 $0; 22 the tax on $40,000, $4,552; 23
    // $6,884.50; 24 the tax on $65,000, $9,012; 25 $6,884.50.
    const r = run('single', (inp) => {
      inp.ordinary = fixed(40_000 + 16_100);
      inp.qualified = fixed(5_000);
      inp.gains = fixed(20_000);
    });
    expect(r.taxableIncome.v).toBeCloseTo(65_000, 6);
    expect(r.ordinaryTax.v).toBeCloseTo(4_552, 6);
    expect(r.gainsTax.v).toBeCloseTo(2_332.5, 6);
    expect(r.incomeTax.v).toBeCloseTo(6_884.5, 6);
  });

  test('line 25 binds between the 0% band and the 12% bracket: joint $98,800 ordinary plus $2,000 of gains', () => {
    // Line 23: $11,360 on $98,800 plus 15% of $1,900, $285: $11,645. Line 24:
    // the regular tax on $100,800, $11,600. Line 25 takes the smaller.
    const r = run('joint', (inp) => {
      inp.ordinary = fixed(98_800 + 32_200);
      inp.gains = fixed(2_000);
    });
    expect(r.ordinaryTax.v).toBeCloseTo(11_360, 6);
    expect(r.gainsTax.v).toBeCloseTo(285, 6);
    expect(r.incomeTax.v).toBeCloseTo(11_600, 6);
  });

  test('gains past the 15% band pay 20%', () => {
    // Joint, no ordinary income past the deduction, $700,000 of gains: line 9
    // $98,900 at 0%, line 17 $514,800 at 15%, line 20 $86,300 at 20%.
    const r = run('joint', (inp) => {
      inp.ordinary = fixed(32_200);
      inp.gains = fixed(700_000);
    });
    expect(r.gainsTax.v).toBeCloseTo(514_800 * 0.15 + 86_300 * 0.2, 6);
  });
});

describe('the senior deduction (Schedule 1-A Part V)', () => {
  // Line 31 MAGI (AGI here), line 33 over $75,000 ($150,000 joint), line 34
  // 6% of that, line 35 $6,000 less it, entered for each qualifying spouse.
  const deduction = (filing: Filing, aged: number, agi: number, year = 2026) =>
    run(filing, (inp) => {
      inp.aged = aged;
      inp.calendarYear = year;
      inp.ordinary = fixed(agi);
    }).deduction.v;

  test('single at 70: AGI $80,000 leaves $6,000 - 6% of $5,000 = $5,700', () => {
    expect(deduction('single', 1, 80_000)).toBeCloseTo(16_100 + 2_050 + 5_700, 6);
    expect(deduction('single', 1, 60_000)).toBeCloseTo(16_100 + 2_050 + 6_000, 6);
  });

  test('joint: each senior is reduced by 6% of the same MAGI, both gone at $250,000', () => {
    expect(deduction('joint', 2, 200_000)).toBeCloseTo(32_200 + 2 * 1_650 + 2 * 3_000, 6);
    expect(deduction('joint', 1, 200_000)).toBeCloseTo(32_200 + 1_650 + 3_000, 6);
    expect(deduction('joint', 2, 250_000)).toBeCloseTo(32_200 + 2 * 1_650, 6);
    expect(deduction('joint', 2, 260_000)).toBeCloseTo(32_200 + 2 * 1_650, 6);
  });

  test('it ends after 2028', () => {
    expect(deduction('single', 1, 50_000, 2028)).toBeCloseTo(16_100 + 2_050 + 6_000, 6);
    expect(deduction('single', 1, 50_000, 2029)).toBeCloseTo(16_100 + 2_050, 6);
  });

  test('unindexed amounts shrink with prices: at twice the price level, $3,000 less 6% of AGI over $37,500', () => {
    const r = run('single', (inp) => {
      inp.aged = 1;
      inp.priceLevel = 2;
      inp.ordinary = fixed(47_500);
    });
    expect(r.deduction.v).toBeCloseTo(16_100 + 2_050 + (3_000 - 0.06 * 10_000), 6);
  });
});

describe('the net investment income tax (Form 8960)', () => {
  test('3.8% of the smaller of net investment income and MAGI over the threshold', () => {
    const r = run('single', (inp) => {
      inp.ordinary = fixed(50_000);
      inp.investmentOrdinary = fixed(50_000);
      inp.gains = fixed(200_000);
    });
    expect(r.niit.v).toBeCloseTo(0.038 * 50_000, 6);
    // IRA money raises MAGI but isn't investment income.
    const ira = run('joint', (inp) => {
      inp.ordinary = fixed(300_000);
      inp.qualified = fixed(10_000);
    });
    expect(ira.niit.v).toBeCloseTo(0.038 * 10_000, 6);
  });
});

describe('capital losses (IRC 1211(b) and the Capital Loss Carryover Worksheet)', () => {
  test('a $10,000 carryover with a $10,000 pension: $3,000 deducted, but not used, so all of it carries on', () => {
    // Line 1: taxable income as if negative, $7,000 - $16,100 = -$9,100; line
    // 3: -$9,100 + $3,000, so 0; line 4: 0 used.
    const r = run('single', (inp) => {
      inp.ordinary = fixed(10_000);
      inp.carryover = 10_000;
    });
    expect(r.lossDeduction).toBeCloseTo(3_000, 6);
    expect(r.agi.v).toBeCloseTo(7_000, 6);
    expect(r.carryoverOut).toBeCloseTo(10_000, 6);
  });

  test('with enough taxable income the $3,000 is used and $7,000 carries', () => {
    const r = run('single', (inp) => {
      inp.ordinary = fixed(30_000);
      inp.carryover = 10_000;
    });
    expect(r.carryoverOut).toBeCloseTo(7_000, 6);
  });

  test('a loss offsets gains first and never qualified dividends', () => {
    const r = run('single', (inp) => {
      inp.ordinary = fixed(40_000);
      inp.qualified = fixed(5_000);
      inp.gains = fixed(4_000);
      inp.carryover = 10_000;
    });
    expect(r.lossDeduction).toBeCloseTo(3_000, 6);
    expect(r.agi.v).toBeCloseTo(40_000 + 5_000 - 3_000, 6);
    expect(r.carryoverOut).toBeCloseTo(3_000, 6);
  });
});

describe('the rest of the year', () => {
  test("FICA is the employee's 6.2% to the wage base and 1.45% on all wages", () => {
    const r = run('joint', (inp) => {
      inp.wages = [fixed(50_000), fixed(200_000)];
    });
    expect(r.fica.v).toBeCloseTo(0.0765 * 50_000 + 0.062 * 184_500 + 0.0145 * 200_000, 6);
  });

  test('the state rate is on AGI less taxable Social Security; the additional taxes are 10% and 20%', () => {
    const r = run('single', (inp) => {
      inp.socialSecurity = 30_000;
      inp.ordinary = fixed(60_000);
      inp.stateRate = 0.05;
      inp.early = fixed(10_000);
      inp.hsaEarly = fixed(1_000);
    });
    expect(r.state.v).toBeCloseTo(0.05 * 60_000, 6);
    expect(r.penalty.v).toBeCloseTo(1_000 + 200, 6);
    expect(r.total.v).toBeCloseTo(r.incomeTax.v + r.niit.v + r.state.v + r.penalty.v + r.fica.v, 6);
  });

  test("the ACA's MAGI adds nontaxable Social Security and tax-exempt interest; IRMAA's only the interest", () => {
    const r = run('single', (inp) => {
      inp.socialSecurity = 20_000;
      inp.ordinary = fixed(30_000);
      inp.exempt = fixed(2_000);
    });
    expect(r.magiAca.v).toBeCloseTo(30_000 + 20_000 + 2_000, 6);
    expect(r.magiIrmaa.v).toBeCloseTo(r.agi.v + 2_000, 6);
  });
});
