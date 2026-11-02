import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import { LAW_YEARS } from '@/lib/fire/tax/law/index';
import type { PartialLaw } from '@/lib/fire/tax/law/types';
import {
  POVERTY_TITLE,
  Unreachable,
  Unrecognised,
  checkLaw,
  cites,
  exitCode,
  fetchText,
  fetcher,
  formatRows,
  frSearchUrl,
  needsAttention,
  parseFrSearch,
  parsePartB,
  parsePoverty,
  parseWageBase,
  partBTitle,
  reportMarkdown,
  ssaTitle,
  type Get,
} from '@/scripts/law-check';

// The law check (scripts/law-check.ts) over saved copies of the official
// answers in test/fixtures/law-check/, fetched on 2026-11-02 from the URLs the
// script builds: the Federal Register's search, HHS's 2025 and 2026 poverty
// guidelines notices (90 FR 5917, 91 FR 1797), CMS's 2026 Part B notice (90
// FR 52063) and its 2025 one (89 FR 90002, its tables printed as images) as
// XML, and SSA's 2026 and 2027 cost-of-living notices (90 FR 49047, 91 FR
// 67380) as text. No test reaches the network.

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'law-check', name), 'utf8');

const POVERTY_2025 = fixture('poverty-2025.xml');
const POVERTY_2026 = fixture('poverty-2026.xml');
const PART_B_XML = fixture('partb-2026.xml');
const PART_B_IMAGES = fixture('partb-2025.xml');
const SSA_2026 = fixture('ssa-2026.txt');
const SSA_2027 = fixture('ssa-2027.txt');

/** Sizes 1 to 8 of guidelines that start at `first` and add `added` a person. */
const even = (first: number, added: number) => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => first + (n - 1) * added);

describe("HHS's poverty guidelines notice", () => {
  test('reads sizes 1 to 8 for the contiguous states, Alaska and Hawaii', () => {
    expect(parsePoverty(POVERTY_2026, 2026)).toEqual({
      contiguous: even(15_960, 5_680),
      AK: even(19_950, 7_100),
      HI: even(18_360, 6_530),
    });
    expect(parsePoverty(POVERTY_2025, 2025)).toEqual({
      contiguous: even(15_650, 5_500),
      AK: even(19_550, 6_880),
      HI: even(17_990, 6_330),
    });
  });

  test("a heading split over two lines, as 2024's was, reads the same", () => {
    const split = POVERTY_2026.replaceAll('<CHED H="1">Persons in family/household</CHED>', '<CHED H="1">\n Persons in family/\n <LI>household</LI>\n</CHED>');
    expect(split).not.toBe(POVERTY_2026);
    expect(parsePoverty(split, 2026)).toEqual(parsePoverty(POVERTY_2026, 2026));
  });

  test("another year's notice, or a notice without a region's table, is unrecognised", () => {
    expect(() => parsePoverty(POVERTY_2026, 2027)).toThrow(
      'has 0 tables titled "2027 Poverty Guidelines for the 48 Contiguous States and the District of Columbia"',
    );
    const noHawaii = POVERTY_2026.replace('2026 Poverty Guidelines for Hawaii', '2026 Poverty Guidelines for Guam');
    expect(() => parsePoverty(noHawaii, 2026)).toThrow('has 0 tables titled "2026 Poverty Guidelines for Hawaii"');
    const twoAlaskas = POVERTY_2026.replace('2026 Poverty Guidelines for Hawaii', '2026 Poverty Guidelines for Alaska');
    expect(() => parsePoverty(twoAlaskas, 2026)).toThrow('has 2 tables titled "2026 Poverty Guidelines for Alaska"');
    const subject = POVERTY_2026.replace(`<SUBJECT>${POVERTY_TITLE}</SUBJECT>`, '<SUBJECT>Poverty Guidelines</SUBJECT>');
    expect(subject).not.toBe(POVERTY_2026);
    expect(() => parsePoverty(subject, 2026)).toThrow("doesn't have its title as its subject");
  });

  test('a table whose columns or rows are not the ones known is unrecognised', () => {
    const columns = POVERTY_2026.replace('<CHED H="1">Persons in family/household</CHED>', '<CHED H="1">Persons</CHED>');
    expect(() => parsePoverty(columns, 2026)).toThrow(
      "The 2026 poverty guidelines notice's table for contiguous: its columns aren't persons in family/household and poverty guideline",
    );
    const guideline = POVERTY_2026.replace('Poverty\n                            <LI>guideline</LI>', 'Poverty\n                            <LI>threshold</LI>');
    expect(guideline).not.toBe(POVERTY_2026);
    expect(() => parsePoverty(guideline, 2026)).toThrow("table for contiguous: its columns aren't");
    const cell = POVERTY_2026.replace('<ENT>27,320</ENT>', '<ENT>27,32</ENT>');
    expect(() => parsePoverty(cell, 2026)).toThrow('table for contiguous: row 3 reads "3 | 27,32"');
    const order = POVERTY_2026.replace('<ENT I="01">3</ENT>', '<ENT I="01">4</ENT>');
    expect(() => parsePoverty(order, 2026)).toThrow('table for contiguous: row 3 reads "4 | 27,320"');
    const falls = POVERTY_2026.replace('<ENT>21,640</ENT>', '<ENT>11,640</ENT>');
    expect(() => parsePoverty(falls, 2026)).toThrow("table for contiguous: the guidelines don't rise with the size");
    const nine = POVERTY_2026.replace('</GPOTABLE>', '<ROW><ENT I="01">9</ENT><ENT>61,400</ENT></ROW></GPOTABLE>');
    expect(() => parsePoverty(nine, 2026)).toThrow('table for contiguous: 9 rows');
  });
});

describe("the Federal Register's search", () => {
  test('finds the notice with exactly the title, and its citation and full text', () => {
    expect(parseFrSearch(fixture('fr-partb-2026.json'), partBTitle(2026))).toMatchObject({
      notice: {
        citation: '90 FR 52063',
        publication_date: '2025-11-19',
        full_text_xml_url: 'https://www.federalregister.gov/documents/full_text/xml/2025/11/19/2025-20251.xml',
      },
      corrections: [],
    });
    expect(parseFrSearch(fixture('fr-ssa-2027.json'), ssaTitle(2027))).toMatchObject({
      notice: {
        citation: '91 FR 67380',
        raw_text_url: 'https://www.federalregister.gov/documents/full_text/text/2026/10/26/2026-21796.txt',
      },
    });
  });

  test('no result is null, and so is a correction alone', () => {
    expect(parseFrSearch(fixture('fr-partb-2027.json'), partBTitle(2027))).toBeNull();
    const correction = fixture('fr-partb-2026.json').replace(
      `"title":"${partBTitle(2026)}"`,
      `"title":"${partBTitle(2026)}; Correction"`,
    );
    expect(correction).not.toBe(fixture('fr-partb-2026.json'));
    expect(parseFrSearch(correction, partBTitle(2026))).toBeNull();
  });

  test('a correction beside the notice is listed with it; another longer title is not', () => {
    // As SSA's for 2011 was titled (75 FR 74123).
    const search = withResults(fixture('fr-ssa-2026.json'), [
      { title: `Office of the Commissioner; ${ssaTitle(2026)}; Correction`, citation: '91 FR 1234', publication_date: '2026-01-05' },
      { title: `${ssaTitle(2026)}: Request for Comment`, citation: '91 FR 999', publication_date: '2026-01-02' },
    ]);
    const found = parseFrSearch(search, ssaTitle(2026));
    expect(found?.notice.citation).toBe('90 FR 49047');
    expect(found?.corrections.map((c) => c.citation)).toEqual(['91 FR 1234']);
  });

  test('a correction without a citation is unrecognised, and a citation counts only whole', () => {
    const blank = withResults(fixture('fr-ssa-2026.json'), [
      { title: `${ssaTitle(2026)}; Correction`, citation: '', publication_date: '2026-01-05' },
    ]);
    expect(() => parseFrSearch(blank, ssaTitle(2026))).toThrow('has no citation or date');
    expect(cites('SSA; corrected by 91 FR 1234', '91 FR 1234')).toBe(true);
    expect(cites('SSA; corrected by 91 FR\n1234.', '91 FR 1234')).toBe(true);
    expect(cites('SSA; corrected by 91 FR 1234', '91 FR 123')).toBe(false);
    expect(cites('SSA; corrected by 191 FR 1234', '91 FR 1234')).toBe(false);
  });

  test('two notices with the title, or an answer without a count, is unrecognised', () => {
    const json = JSON.parse(fixture('fr-partb-2026.json'));
    const twice = JSON.stringify({ ...json, count: 2, results: [json.results[0], json.results[0]] });
    expect(() => parseFrSearch(twice, partBTitle(2026))).toThrow(Unrecognised);
    expect(() => parseFrSearch('{"results":[]}', partBTitle(2026))).toThrow(Unrecognised);
  });

  test('the search asks for the quoted title, notices only', () => {
    const url = new URL(frSearchUrl(ssaTitle(2027)));
    expect(url.searchParams.get('conditions[term]')).toBe('"Cost-of-Living Increase and Other Determinations for 2027"');
    expect(url.searchParams.getAll('conditions[type][]')).toEqual(['NOTICE']);
    expect(url.searchParams.has('conditions[publication_date][year]')).toBe(false);
  });

  test('the poverty notice, titled the same every year, is searched for by the year it came out', () => {
    const url = new URL(frSearchUrl(POVERTY_TITLE, 2026));
    expect(url.searchParams.get('conditions[term]')).toBe('"Annual Update of the HHS Poverty Guidelines"');
    expect(url.searchParams.get('conditions[publication_date][year]')).toBe('2026');
    expect(parseFrSearch(fixture('fr-poverty-2026.json'), POVERTY_TITLE)).toMatchObject({
      notice: {
        citation: '91 FR 1797',
        publication_date: '2026-01-15',
        full_text_xml_url: 'https://www.federalregister.gov/documents/full_text/xml/2026/01/15/2026-00755.xml',
      },
      corrections: [],
    });
  });
});

describe("CMS's Part B notice", () => {
  test('reads the standard premium and the single and joint tiers from the first Full Part B Coverage table', () => {
    // 90 FR 52063: the 4-column table, before the married filing separately
    // and immunosuppressive drug tables.
    const tiers = (overs: number[]) =>
      overs.map((over, i) => ({ over, atLeast: i === 4, partB: [284.1, 405.8, 527.5, 649.2, 689.9][i] }));
    expect(parsePartB(PART_B_XML, 2026)).toEqual({
      partB: 202.9,
      irmaa: {
        single: tiers([109_000, 137_000, 171_000, 205_000, 500_000]),
        joint: tiers([218_000, 274_000, 342_000, 410_000, 750_000]),
      },
    });
  });

  test('a notice that prints its tables as images reads as null', () => {
    // 89 FR 90002 has no GPOTABLE, only GPH images (2024's notice was the same).
    expect(parsePartB(PART_B_IMAGES, 2025)).toBeNull();
  });

  test("another year's notice, or a notice without the table or images of it, is unrecognised", () => {
    expect(() => parsePartB(PART_B_XML, 2027)).toThrow("doesn't have its title as its subject");
    const noTable = PART_B_XML.replaceAll('<TTITLE>Full Part B Coverage</TTITLE>', '<TTITLE>Part B</TTITLE>');
    expect(() => parsePartB(noTable, 2026)).toThrow('has no "Full Part B Coverage" table');
    const neither = PART_B_IMAGES.replaceAll('<GPH', '<FIG');
    expect(neither).not.toBe(PART_B_IMAGES);
    expect(() => parsePartB(neither, 2025)).toThrow('has no "Full Part B Coverage" table');
  });

  test('a table whose columns, bands or sums are not the ones known is unrecognised', () => {
    const columns = PART_B_XML.replace('Total monthly', 'Monthly');
    expect(() => parsePartB(columns, 2026)).toThrow("isn't single, joint, adjustment, total");
    const gap = PART_B_XML.replace('Greater than $137,000 and less than or equal to $171,000', 'Greater than $138,000 and less than or equal to $171,000');
    expect(() => parsePartB(gap, 2026)).toThrow("the single bands don't run on at row 3");
    const sum = PART_B_XML.replace('<ENT>405.80</ENT>', '<ENT>405.90</ENT>');
    expect(() => parsePartB(sum, 2026)).toThrow("row 3's total isn't the standard premium plus its adjustment");
    const cell = PART_B_XML.replace('<ENT>81.20</ENT>', '<ENT>81.2</ENT>');
    expect(() => parsePartB(cell, 2026)).toThrow('row 2 reads');
  });
});

describe("SSA's cost-of-living notice", () => {
  test('reads the OASDI contribution and benefit base', () => {
    expect(parseWageBase(SSA_2026, 2026)).toBe(184_500);
    expect(parseWageBase(SSA_2027, 2027)).toBe(192_300);
  });

  test("another year's notice, statements that disagree, or none, is unrecognised", () => {
    expect(() => parseWageBase(SSA_2027, 2026)).toThrow("doesn't carry its title");
    // The second statement, after the computation, broken over two lines.
    const disagree = SSA_2027.replace('base is \n$192,300 for 2027.', 'base is \n$192,600 for 2027.');
    expect(disagree).not.toBe(SSA_2027);
    expect(() => parseWageBase(disagree, 2027)).toThrow('gives the base as $192,300 and $192,600');
    const none = SSA_2027.replaceAll('OASDI contribution and benefit base is', 'OASDI base was');
    expect(() => parseWageBase(none, 2027)).toThrow(Unrecognised);
  });
});

/** A fake web serving the fixtures at the URLs the script builds, as the
 *  sources stood on 2026-11-02, with `changes` laid over it. Counts each URL's
 *  fetches. */
function fakeWeb(changes: Record<string, string | Error> = {}) {
  const pages = new Map<string, string | Error>();
  const none = fixture('fr-partb-2027.json');
  for (const year of [2026, 2027, 2028]) {
    pages.set(frSearchUrl(partBTitle(year)), none);
    pages.set(frSearchUrl(ssaTitle(year)), none);
    pages.set(frSearchUrl(POVERTY_TITLE, year), none);
  }
  pages.set(frSearchUrl(POVERTY_TITLE, 2025), fixture('fr-poverty-2025.json'));
  pages.set(frSearchUrl(POVERTY_TITLE, 2026), fixture('fr-poverty-2026.json'));
  pages.set('https://www.federalregister.gov/documents/full_text/xml/2025/01/17/2025-01377.xml', POVERTY_2025);
  pages.set('https://www.federalregister.gov/documents/full_text/xml/2026/01/15/2026-00755.xml', POVERTY_2026);
  pages.set(frSearchUrl(partBTitle(2026)), fixture('fr-partb-2026.json'));
  pages.set(frSearchUrl(ssaTitle(2026)), fixture('fr-ssa-2026.json'));
  pages.set(frSearchUrl(ssaTitle(2027)), fixture('fr-ssa-2027.json'));
  pages.set('https://www.federalregister.gov/documents/full_text/xml/2025/11/19/2025-20251.xml', PART_B_XML);
  pages.set('https://www.federalregister.gov/documents/full_text/text/2025/11/03/2025-19763.txt', SSA_2026);
  pages.set('https://www.federalregister.gov/documents/full_text/text/2026/10/26/2026-21796.txt', SSA_2027);
  for (const [url, page] of Object.entries(changes)) pages.set(url, page);

  const fetched = new Map<string, number>();
  const get: Get = async (url) => {
    fetched.set(url, (fetched.get(url) ?? 0) + 1);
    const page = pages.get(url);
    if (page === undefined) throw new Error(`The fake web has no ${url}`);
    if (page instanceof Error) throw page;
    return page;
  };
  return { get, fetched };
}

const statuses = (rows: { year: number; part: string; status: string }[]) => rows.map((r) => `${r.year} ${r.part} ${r.status}`);

/** A saved search answer with these entries added to its results. */
function withResults(search: string, added: { title: string; citation: string; publication_date: string }[]): string {
  const json = JSON.parse(search);
  const results = [...(json.results ?? []), ...added.map((a) => ({ ...a, type: 'Notice', full_text_xml_url: null, raw_text_url: null }))];
  return JSON.stringify({ ...json, count: results.length, results });
}

describe('the whole check', () => {
  test('as the sources stood on 2026-11-02: every figure held matches, and the rest is not out', async () => {
    const { get, fetched } = fakeWeb();
    const rows = await checkLaw(LAW_YEARS, get);
    expect(statuses(rows)).toEqual([
      '2026 creditPoverty match',
      '2026 medicaidPoverty match',
      '2026 medicare match',
      '2026 wageBase match',
      '2027 creditPoverty match',
      '2027 medicaidPoverty not out',
      '2027 medicare not out',
      '2027 wageBase match',
      '2028 creditPoverty not out',
      '2028 medicaidPoverty not out',
      '2028 medicare not out',
      '2028 wageBase not out',
    ]);
    expect(rows[0].detail).toBe(
      "HHS's 2025 poverty guidelines (90 FR 5917, 2025-01-17): contiguous $15,650 + $5,500; AK $19,550 + $6,880; HI $17,990 + $6,330",
    );
    expect(rows[2].detail).toBe("CMS's Part B notice for 2026 (90 FR 52063, 2025-11-19): Part B $202.90, 5 single and 5 joint IRMAA tiers");
    expect(rows[5].detail).toBe("HHS's 2027 poverty guidelines; ours: none yet (published null, due January 2027)");
    expect(rows[6].detail).toBe("CMS's Part B notice for 2027; ours: none yet (published null, due Mid-November 2026)");
    expect(rows[11].detail).toBe("SSA's notice for 2028; ours: no 2028 table");
    expect(exitCode(rows)).toBe(0);
    expect(needsAttention(rows)).toBe(false);
    // 2026's guidelines serve both 2026's Medicaid and 2027's credit, and 2027's
    // both 2027's Medicaid and 2028's credit: each URL is fetched once.
    expect(Math.max(...fetched.values())).toBe(1);
  });

  test('a figure that differs from its source is named, and fails the run', async () => {
    const law: PartialLaw = {
      ...LAW_2026,
      wageBase: 184_800,
      medicaidPoverty: { ...LAW_2026.medicaidPoverty, AK: { first: 19_950, added: 7_000 } },
      medicare: {
        ...LAW_2026.medicare,
        irmaa: { ...LAW_2026.medicare.irmaa, joint: LAW_2026.medicare.irmaa.joint.map((t, i) => (i === 1 ? { ...t, over: 276_000 } : t)) },
      },
    };
    const rows = await checkLaw([law, ...LAW_YEARS.slice(1)], fakeWeb().get);
    const differ = rows.filter((r) => r.status === 'differ');
    expect(differ.map((r) => r.part)).toEqual(['medicaidPoverty', 'medicare', 'wageBase']);
    expect(differ[0].detail).toStartWith("HHS's 2026 poverty guidelines (91 FR 1797, 2026-01-15): AK size 2 ours $26,950, official $27,050; AK size 3");
    expect(differ[1].detail).toBe("CMS's Part B notice for 2026 (90 FR 52063, 2025-11-19): joint tier 2 threshold ours $276,000, official $274,000");
    expect(differ[2].detail).toBe("SSA's notice for 2026 (90 FR 49047, 2025-11-03): ours $184,800, official $184,500");
    expect(exitCode(rows)).toBe(1);
    expect(needsAttention(rows)).toBe(true);
  });

  test("a notice the tables don't hold yet is new: reported, but not a failure", async () => {
    const search = JSON.parse(fixture('fr-partb-2026.json'));
    search.results[0] = {
      ...search.results[0],
      title: partBTitle(2027),
      citation: '91 FR 70000',
      publication_date: '2026-11-18',
      full_text_xml_url: 'https://www.federalregister.gov/documents/full_text/xml/2026/11/18/2026-23000.xml',
    };
    const poverty = JSON.parse(fixture('fr-poverty-2026.json'));
    poverty.results[0] = {
      ...poverty.results[0],
      citation: '92 FR 2000',
      publication_date: '2027-01-14',
      full_text_xml_url: 'https://example.test/poverty-2027.xml',
    };
    const { get } = fakeWeb({
      [frSearchUrl(partBTitle(2027))]: JSON.stringify(search),
      'https://www.federalregister.gov/documents/full_text/xml/2026/11/18/2026-23000.xml': PART_B_XML.replaceAll(partBTitle(2026), partBTitle(2027)),
      [frSearchUrl(POVERTY_TITLE, 2027)]: JSON.stringify(poverty),
      'https://example.test/poverty-2027.xml': POVERTY_2026.replaceAll('2026 Poverty Guidelines', '2027 Poverty Guidelines'),
    });
    const rows = await checkLaw(LAW_YEARS, get);
    const news = rows.filter((r) => r.status === 'new');
    expect(news.map((r) => `${r.year} ${r.part}`)).toEqual(['2027 medicaidPoverty', '2027 medicare', '2028 creditPoverty']);
    expect(news[0].detail).toBe(
      "HHS's 2027 poverty guidelines now out (92 FR 2000, 2027-01-14): contiguous $15,960 + $5,680; AK $19,950 + $7,100; HI $18,360 + $6,530; ours: none yet (published null, due January 2027)",
    );
    expect(news[1].detail).toStartWith("CMS's Part B notice for 2027 now out (91 FR 70000, 2026-11-18): Part B $202.90");
    // The next year has no file yet: the line says to start one.
    expect(news[2].detail).toEndWith('; ours: no 2028 table (start lib/fire/tax/law/2028.ts and add it to LAW_YEARS)');
    expect(exitCode(rows)).toBe(0);
    expect(needsAttention(rows)).toBe(true);
  });

  test('a notice whose tables are images is new until the table holds it, then checked by hand', async () => {
    const search = JSON.parse(fixture('fr-partb-2026.json'));
    search.results[0] = { ...search.results[0], title: partBTitle(2027), citation: '91 FR 70000', publication_date: '2026-11-18', full_text_xml_url: 'https://example.test/2027.xml' };
    const { get } = fakeWeb({
      [frSearchUrl(partBTitle(2027))]: JSON.stringify(search),
      'https://example.test/2027.xml': PART_B_IMAGES.replaceAll(partBTitle(2025), partBTitle(2027)),
      // 2026's notice as images too, for the part the tables hold.
      'https://www.federalregister.gov/documents/full_text/xml/2025/11/19/2025-20251.xml': PART_B_IMAGES.replaceAll(partBTitle(2025), partBTitle(2026)),
    });
    const rows = await checkLaw(LAW_YEARS, get);
    const medicare = rows.filter((r) => r.part === 'medicare');
    expect(medicare.map((r) => `${r.year} ${r.status}: ${r.detail}`)).toEqual([
      "2026 by hand: CMS's Part B notice for 2026 (90 FR 52063, 2025-11-19) prints its tables as images, which this can't read: check the table (Part B $202.90, 5 single and 5 joint IRMAA tiers) against it by hand",
      "2027 new: CMS's Part B notice for 2027 now out (91 FR 70000, 2026-11-18): its tables are images, so read the figures by hand; ours: none yet (published null, due Mid-November 2026)",
      "2028 not out: CMS's Part B notice for 2028; ours: no 2028 table",
    ]);
    expect(exitCode(rows)).toBe(0);
    // The images alone would ask for nothing: only the 2027 notice is news.
    expect(needsAttention(rows.filter((r) => r.year === 2026))).toBe(false);
  });

  test('a correction is new until its citation is in the source, then checked against the notice as first printed', async () => {
    const correction = { title: `Office of the Commissioner; ${ssaTitle(2026)}; Correction`, citation: '91 FR 1234', publication_date: '2026-01-05' };
    const { get } = fakeWeb({ [frSearchUrl(ssaTitle(2026))]: withResults(fixture('fr-ssa-2026.json'), [correction]) });
    const wageBase = async (law: PartialLaw) => (await checkLaw([law, ...LAW_YEARS.slice(1)], get)).find((r) => r.year === 2026 && r.part === 'wageBase')!;

    const unread = await wageBase(LAW_2026);
    expect(unread).toMatchObject({
      status: 'new',
      detail: "91 FR 1234, 2026-01-05 corrects SSA's notice for 2026 (90 FR 49047, 2025-11-03): read it, make the table agree, then add its citation to sources.wageBase.source",
    });

    const sources = { ...LAW_2026.sources, wageBase: { ...LAW_2026.sources.wageBase, source: 'SSA, contribution and benefit base; corrected by 91 FR 1234' } };
    expect(await wageBase({ ...LAW_2026, sources })).toMatchObject({
      status: 'match',
      detail: "SSA's notice for 2026 (90 FR 49047, 2025-11-03), corrected by 91 FR 1234, 2026-01-05: $184,500",
    });
    // A correction that changed the figure: the table agrees with it, not
    // with the notice as first printed, which only a person can confirm.
    const corrected = await wageBase({ ...LAW_2026, sources, wageBase: 184_800 });
    expect(corrected.status).toBe('by hand');
    expect(corrected.detail).toStartWith("SSA's notice for 2026 (90 FR 49047, 2025-11-03) as first printed: ours $184,800, official $184,500; corrected by 91 FR 1234");
    expect(exitCode([corrected])).toBe(0);
    expect(needsAttention([corrected])).toBe(false);
  });

  test("a shape the parser doesn't know, or a cited notice that can't be found, is unrecognised and fails the run", async () => {
    const { get } = fakeWeb({
      'https://www.federalregister.gov/documents/full_text/xml/2025/11/19/2025-20251.xml': '<NOTICE></NOTICE>',
      [frSearchUrl(ssaTitle(2026))]: fixture('fr-partb-2027.json'),
    });
    const rows = await checkLaw(LAW_YEARS, get);
    const odd = rows.filter((r) => r.status === 'unrecognised');
    expect(odd.map((r) => `${r.year} ${r.part}: ${r.detail}`)).toEqual([
      "2026 medicare: The Part B notice for 2026 doesn't have its title as its subject",
      "2026 wageBase: SSA's notice for 2026 can't be found, but the table holds $184,500",
    ]);
    expect(exitCode(rows)).toBe(1);
    expect(needsAttention(rows)).toBe(true);
  });

  test("a poverty notice without a region's table is unrecognised for each part it serves", async () => {
    const noHawaii = POVERTY_2026.replace('2026 Poverty Guidelines for Hawaii', '2026 Poverty Guidelines for Guam');
    const { get, fetched } = fakeWeb({ 'https://www.federalregister.gov/documents/full_text/xml/2026/01/15/2026-00755.xml': noHawaii });
    const rows = await checkLaw(LAW_YEARS, get);
    const missing = 'The 2026 poverty guidelines notice has 0 tables titled "2026 Poverty Guidelines for Hawaii"';
    expect(rows.filter((r) => r.status === 'unrecognised').map((r) => `${r.year} ${r.part}: ${r.detail}`)).toEqual([
      `2026 medicaidPoverty: ${missing}`,
      `2027 creditPoverty: ${missing}`,
    ]);
    expect(fetched.get('https://www.federalregister.gov/documents/full_text/xml/2026/01/15/2026-00755.xml')).toBe(1);
    expect(exitCode(rows)).toBe(1);
  });

  test('an unreachable source fails the run but asks for no report', async () => {
    const down = new Unreachable('https://www.federalregister.gov/... answered 503');
    const rows = await checkLaw(LAW_YEARS, fakeWeb({ [frSearchUrl(ssaTitle(2027))]: down }).get);
    expect(rows.find((r) => r.year === 2027 && r.part === 'wageBase')).toMatchObject({ status: 'unreachable', detail: down.message });
    expect(exitCode(rows)).toBe(1);
    expect(needsAttention(rows)).toBe(false);
  });

  test('the lines and the report', async () => {
    const rows = await checkLaw(LAW_YEARS, fakeWeb().get);
    const lines = formatRows(rows);
    expect(lines[3]).toBe("2026 wageBase        match        SSA's notice for 2026 (90 FR 49047, 2025-11-03): $184,500");
    const report = reportMarkdown(rows);
    expect(report).toContain(['```', ...lines, '```'].join('\n'));
    expect(report).toContain("Part D's IRMAA amounts aren't in CMS's Federal Register notice");
    expect(report).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('fetching', () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = new URL(req.url).pathname.slice(1);
        if (path === 'stall') {
          // Sends the headers and a first chunk, then nothing.
          return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('<NOTICE>')) }));
        }
        const status = Number(path);
        return new Response(`answered ${status}`, { status });
      },
    });
  });
  afterAll(() => server.stop(true));

  const at = (status: number) => `http://127.0.0.1:${server.port}/${status}`;

  test('a 2xx answer is its text', async () => {
    expect(await fetchText(at(200))).toBe('answered 200');
  });

  test('a 5xx or a 429 is unreachable (likely passing); another failure means the source moved', async () => {
    await expect(fetchText(at(503))).rejects.toBeInstanceOf(Unreachable);
    await expect(fetchText(at(429))).rejects.toBeInstanceOf(Unreachable);
    await expect(fetchText(at(404))).rejects.toBeInstanceOf(Unrecognised);
  });

  test('a connection refused is unreachable', async () => {
    const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const gone = `http://127.0.0.1:${closed.port}/`;
    closed.stop(true);
    await expect(fetchText(gone)).rejects.toBeInstanceOf(Unreachable);
  });

  test('a body that stops coming within the time limit is unreachable, not a crash', async () => {
    const error = await fetcher(300)(`http://127.0.0.1:${server.port}/stall`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unreachable);
  });
});
