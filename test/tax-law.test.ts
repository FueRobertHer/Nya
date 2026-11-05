import { describe, expect, test } from 'bun:test';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import { LAW_2027 } from '@/lib/fire/tax/law/2027';
import { LAW_YEARS, isComplete, lawFor, missingParts } from '@/lib/fire/tax/law/index';
import { LAW_PARTS, STATE_CODES, type Filing } from '@/lib/fire/tax/law/types';

// The law tables' shape (lib/fire/tax/law/): which year a plan uses, and that
// every table is whole and in order. The figures themselves are checked
// against their sources in tax-federal, tax-health, tax-rmd and
// tax-calculator.

describe('which law a plan uses', () => {
  test('2026 is complete; 2027 lacks the parts not out on 2026-11-01', () => {
    expect(isComplete(LAW_2026)).toBe(true);
    expect(isComplete(LAW_2027)).toBe(false);
    expect(missingParts(LAW_2027)).toEqual(['brackets', 'medicaidPoverty', 'medicare']);
  });

  test("a plan in 2027 uses 2026's law and says it is behind; one in 2026, 2026's", () => {
    expect(lawFor(2026)).toEqual({ law: LAW_2026, behind: false });
    expect(lawFor(2027)).toEqual({ law: LAW_2026, behind: true });
    expect(lawFor(2025)).toEqual({ law: LAW_2026, behind: false });
  });

  test('every part has a source, and a part not out has a due date but no publication date', () => {
    for (const law of LAW_YEARS) {
      for (const part of LAW_PARTS) {
        const s = law.sources[part];
        expect(s.source.length).toBeGreaterThan(0);
        expect(s.due.length).toBeGreaterThan(0);
        expect(s.published === null).toBe(law[part] === undefined);
        // A part not out says, for a program, the day its window opens.
        if (s.published === null) expect(s.opens).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        else expect(s.opens).toBeUndefined();
      }
    }
  });
});

describe("the tables' shape", () => {
  test('brackets ascend, end at Infinity, and their rates rise', () => {
    for (const filing of ['single', 'joint'] as Filing[]) {
      const b = LAW_2026.brackets.ordinary[filing];
      expect(b.at(-1)!.upTo).toBe(Infinity);
      for (let i = 1; i < b.length; i++) {
        expect(b[i].upTo).toBeGreaterThan(b[i - 1].upTo);
        expect(b[i].rate).toBeGreaterThan(b[i - 1].rate);
      }
      expect(LAW_2026.brackets.gains[filing].fifteenTo).toBeGreaterThan(LAW_2026.brackets.gains[filing].zeroTo);
    }
  });

  test('each applicable percentage table covers 0 to its cliff without a gap, never falling', () => {
    for (const schedule of [LAW_2026.aca, LAW_2027.aca!, LAW_2026.statute.enhanced]) {
      const bands = schedule.bands;
      expect(bands[0].from).toBe(0);
      for (let i = 0; i < bands.length; i++) {
        expect(bands[i].final).toBeGreaterThanOrEqual(bands[i].initial);
        if (i > 0) {
          expect(bands[i].from).toBe(bands[i - 1].to);
          expect(bands[i].initial).toBeGreaterThanOrEqual(bands[i - 1].final);
        }
      }
      expect(bands.at(-1)!.to).toBe(schedule.cliff === null ? Infinity : schedule.cliff * 100);
    }
  });

  test('every state and DC has a Medicaid line or none: 40 states at 138%, DC, Wisconsin and Georgia apart', () => {
    expect(STATE_CODES).toHaveLength(51);
    const lines = STATE_CODES.map((s) => LAW_2026.medicaidStates[s]);
    expect(lines.filter((l) => l !== null && l.line === 1.38)).toHaveLength(40);
    expect(LAW_2026.medicaidStates.DC).toEqual({ line: 2.15, through: null, ownRule: false });
    expect(LAW_2026.medicaidStates.WI).toEqual({ line: 1, through: null, ownRule: false });
    expect(LAW_2026.medicaidStates.GA).toEqual({ line: 1, through: 2026, ownRule: true });
    expect(STATE_CODES.filter((s) => LAW_2026.medicaidStates[s] === null)).toEqual(['AL', 'FL', 'KS', 'MS', 'SC', 'TN', 'TX', 'WY']);
  });

  test('IRMAA tiers ascend; only the top is "at or above"', () => {
    for (const filing of ['single', 'joint'] as Filing[]) {
      const tiers = LAW_2026.medicare.irmaa[filing];
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i].over).toBeGreaterThan(tiers[i - 1].over);
        expect(tiers[i].partB).toBeGreaterThan(tiers[i - 1].partB);
      }
      expect(tiers.map((t) => t.atLeast)).toEqual([false, false, false, false, true]);
    }
    // The joint top is $750,000, not double the single $500,000.
    expect(LAW_2026.medicare.irmaa.joint.at(-1)!.over).toBe(750_000);
  });

  test('the Uniform Lifetime Table covers 72 to 120 and falls each year', () => {
    const u = LAW_2026.uniform;
    expect(u.firstAge).toBe(72);
    expect(u.divisors).toHaveLength(120 - 72 + 1);
    for (let i = 1; i < u.divisors.length; i++) expect(u.divisors[i]).toBeLessThan(u.divisors[i - 1]);
  });

  test('the health growth defaults are the NHE arithmetic in the comment', () => {
    // Private insurance per enrollee 2027 to 2034 over CPI-U, and GDP per capita over CPI-U.
    const cagr = (a: number, b: number) => (b / a) ** (1 / 7) - 1;
    const prices = cagr(338.5, 399.6);
    expect((1 + cagr(9_659, 13_155)) / (1 + prices) - 1).toBeCloseTo(LAW_2026.healthGrowth.overPrices, 3);
    expect((1 + cagr(97_171, 124_127)) / (1 + prices) - 1).toBeCloseTo(LAW_2026.healthGrowth.incomeOverPrices, 3);
  });
});
