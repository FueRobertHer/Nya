import { describe, expect, test } from 'bun:test';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import { divisor, rmd, rmdAge } from '@/lib/fire/tax/rmd';

// RMDs against Treas. Reg. 1.401(a)(9)-9(c) as IRS Pub 590-B (2025)
// Appendix B Table III prints it, and IRC 401(a)(9)(C)(v)'s start ages.

const TABLE_III: [number, number][] = [
  [72, 27.4], [73, 26.5], [74, 25.5], [75, 24.6], [76, 23.7], [77, 22.9], [78, 22], [79, 21.1], [80, 20.2],
  [81, 19.4], [82, 18.5], [83, 17.7], [84, 16.8], [85, 16], [86, 15.2], [87, 14.4], [88, 13.7], [89, 12.9],
  [90, 12.2], [91, 11.5], [92, 10.8], [93, 10.1], [94, 9.5], [95, 8.9], [96, 8.4], [97, 7.8], [98, 7.3],
  [99, 6.8], [100, 6.4], [101, 6], [102, 5.6], [103, 5.2], [104, 4.9], [105, 4.6], [106, 4.3], [107, 4.1],
  [108, 3.9], [109, 3.7], [110, 3.5], [111, 3.4], [112, 3.3], [113, 3.1], [114, 3], [115, 2.9], [116, 2.8],
  [117, 2.7], [118, 2.5], [119, 2.3], [120, 2],
];

describe('the Uniform Lifetime Table', () => {
  test('every row of Table III, and 120 and over', () => {
    for (const [age, d] of TABLE_III) expect(divisor(age, LAW_2026.uniform)).toBe(d);
    expect(divisor(125, LAW_2026.uniform)).toBe(2);
  });
});

describe('RMD start ages (SECURE 2.0)', () => {
  test('72 to 1950, 73 for 1951 to 1959 (1959 included), 75 from 1960', () => {
    const s = LAW_2026.statute;
    expect(rmdAge(1950, s)).toBe(72);
    expect(rmdAge(1951, s)).toBe(73);
    expect(rmdAge(1959, s)).toBe(73);
    expect(rmdAge(1960, s)).toBe(75);
    expect(rmdAge(1985, s)).toBe(75);
  });
});

describe('the RMD', () => {
  test("last year's close over the divisor at this year's age, nothing before the start age", () => {
    expect(rmd(500_000, 75, 75, LAW_2026.uniform)).toBeCloseTo(500_000 / 24.6, 6);
    expect(rmd(500_000, 80, 75, LAW_2026.uniform)).toBeCloseTo(500_000 / 20.2, 6);
    expect(rmd(500_000, 74, 75, LAW_2026.uniform)).toBe(0);
    expect(rmd(0, 80, 75, LAW_2026.uniform)).toBe(0);
  });
});
