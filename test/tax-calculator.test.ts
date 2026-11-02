import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { Filing } from '@/lib/fire/tax/law/types';

// A second source for the figures where typos are likeliest: PSL
// Tax-Calculator's current-law parameters, copied byte for byte as a fixture
// from the pinned commit below. Tax-Calculator is in the public domain in the
// United States and dedicated worldwide under CC0 1.0 (its LICENSE). It can
// lag the IRS by weeks, so it is compared only for the years it marks as
// known (LAST_KNOWN_YEAR in taxcalc/policy.py at the same commit); a new law
// year is checked first by its golden tests, and the pin moves when
// Tax-Calculator catches up (docs/operations.md, step 3). A parameter holds
// its latest value at or before a year, as Tax-Calculator carries values
// forward.

const COMMIT = '3ae49a2216b0bbb1ec1be388623d272f9c7fc7ae'; // tag 6.9.0, October 30, 2026
const SHA256 = '61d22cf6bd6d48ce9d41240cb7cfc032477b68c9f44fd14fd5d83b51364d222f';
const LAST_KNOWN_YEAR = 2026;

type Row = { year: number; MARS?: string; value: number | boolean };
type Parameter = { indexed?: boolean; value: Row[] };

const bytes = readFileSync(join(import.meta.dir, 'fixtures', 'taxcalc', 'policy_current_law.json'));
const policy = JSON.parse(bytes.toString('utf-8')) as Record<string, Parameter>;
const MARS: Record<Filing, string> = { single: 'single', joint: 'mjoint' };

function at(name: string, year: number, filing?: Filing): number {
  const rows = policy[name].value.filter((r) => r.year <= year && (filing === undefined || r.MARS === MARS[filing]));
  if (rows.length === 0) throw new Error(`${name} has no value by ${year}`);
  return rows.reduce((a, b) => (b.year > a.year ? b : a)).value as number;
}

const FILINGS: Filing[] = ['single', 'joint'];

describe(`Tax-Calculator ${COMMIT.slice(0, 7)} against the 2026 tables`, () => {
  test('the fixture is the pinned file, byte for byte', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA256);
    expect(LAW_2026.year).toBeLessThanOrEqual(LAST_KNOWN_YEAR);
  });

  test('the ordinary brackets and rates', () => {
    for (const f of FILINGS) {
      const b = LAW_2026.brackets.ordinary[f];
      for (let i = 0; i < 6; i++) expect(at(`II_brk${i + 1}`, 2026, f)).toBe(b[i].upTo);
      for (let i = 0; i < 7; i++) expect(at(`II_rt${i + 1}`, 2026)).toBe(b[i].rate);
    }
  });

  test('the standard deduction, its additions for age, and the gains bands and rates', () => {
    for (const f of FILINGS) {
      expect(at('STD', 2026, f)).toBe(LAW_2026.brackets.standard[f]);
      expect(at('STD_Aged', 2026, f)).toBe(f === 'joint' ? LAW_2026.brackets.aged.married : LAW_2026.brackets.aged.unmarried);
      expect(at('CG_brk1', 2026, f)).toBe(LAW_2026.brackets.gains[f].zeroTo);
      expect(at('CG_brk2', 2026, f)).toBe(LAW_2026.brackets.gains[f].fifteenTo);
    }
    expect(at('CG_rt1', 2026)).toBe(0);
    expect(at('CG_rt2', 2026)).toBe(LAW_2026.statute.gainsRates.fifteen);
    expect(at('CG_rt3', 2026)).toBe(LAW_2026.statute.gainsRates.twenty);
  });

  test("NIIT, Social Security's tiers, FICA and the wage base", () => {
    const st = LAW_2026.statute;
    for (const f of FILINGS) {
      expect(at('NIIT_thd', 2026, f)).toBe(st.niit.threshold[f]);
      expect(at('SS_thd1', 2026, f)).toBe(st.socialSecurity.base[f]);
      expect(at('SS_thd2', 2026, f)).toBe(st.socialSecurity.adjusted[f]);
    }
    expect(at('NIIT_rt', 2026)).toBe(st.niit.rate);
    // federal.ts's Pub 915 lines use 50% and 85%.
    expect(at('SS_percentage1', 2026)).toBe(0.5);
    expect(at('SS_percentage2', 2026)).toBe(0.85);
    expect(at('FICA_ss_trt_employee', 2026)).toBe(st.fica.socialSecurity);
    expect(at('FICA_mc_trt_employee', 2026)).toBe(st.fica.medicare);
    expect(at('SS_Earnings_c', 2026)).toBe(LAW_2026.wageBase);
  });

  test('the senior deduction, and its end after 2028', () => {
    const s = LAW_2026.statute.senior;
    expect(at('SeniorDed_c', 2026)).toBe(s.amount);
    expect(at('SeniorDed_prt', 2026)).toBe(s.rate);
    for (const f of FILINGS) expect(at('SeniorDed_ps', 2026, f)).toBe(s.threshold[f]);
    expect(at('SeniorDed_c', s.through)).toBe(s.amount);
    expect(at('SeniorDed_c', s.through + 1)).toBe(0);
  });

  test('which amounts the law indexes, as federal.ts treats them', () => {
    for (const name of ['II_brk1', 'STD', 'STD_Aged', 'CG_brk1', 'SS_Earnings_c']) expect(policy[name].indexed).toBe(true);
    for (const name of ['NIIT_thd', 'SS_thd1', 'SS_thd2', 'SeniorDed_c', 'SeniorDed_ps']) expect(policy[name].indexed ?? false).toBe(false);
  });

  test("2025's brackets, the test-only table tax-federal checks the Tax Computation Worksheet with", () => {
    const single2025 = [11_925, 48_475, 103_350, 197_300, 250_525, 626_350];
    const joint2025 = [23_850, 96_950, 206_700, 394_600, 501_050, 751_600];
    for (let i = 0; i < 6; i++) {
      expect(at(`II_brk${i + 1}`, 2025, 'single')).toBe(single2025[i]);
      expect(at(`II_brk${i + 1}`, 2025, 'joint')).toBe(joint2025[i]);
    }
  });
});
