import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEcbCsv, planWrites, type EcbFile } from '@/lib/fx/ecb-parse';

// The ECB's own rows, cut to a few stretches (test/fx-rates.test.ts says which).
const CSV = readFileSync(join(import.meta.dir, 'fixtures/ecb/eurofxref-hist-cut.csv'), 'utf8');
const HEAD = CSV.split('\n')[0];

const parsed = (text: string) => parseEcbCsv(text) as EcbFile;
const errorOf = (text: string) => (parseEcbCsv(text) as { error: string }).error;

describe('reading the ECB’s history file', () => {
  test('the real file: every publication day, each rate as published, N/A left out', () => {
    const file = parsed(CSV);
    expect(file.days.length).toBe(57);
    expect(file.days[0]).toBe('1999-01-04');
    expect(file.days[file.days.length - 1]).toBe('2026-09-14');
    const newest = file.rates.get('2026-09-14')!;
    expect(newest.USD).toBe('1.1551');
    expect(newest.GBP).toBe('0.85598');
    expect(newest.IDR).toBe('20398.66');
    expect(newest.BGN).toBeUndefined();
    expect(Object.keys(newest).length).toBe(29);
    expect(file.rates.get('2022-03-01')!.RUB).toBeDefined();
    expect(file.rates.get('2022-03-02')!.RUB).toBeUndefined();
  });

  test('CRLF line endings and a missing final newline read the same', () => {
    const crlf = CSV.trimEnd().split('\n').join('\r\n');
    expect(parsed(crlf).days).toEqual(parsed(CSV).days);
  });

  test.each([
    ['an empty file', ''],
    ['a header alone', `${HEAD}\n`],
    ['no Date column', `Day,USD,\n2026-09-14,1.1,\n`],
    ['a code that isn’t one', `Date,USD,usd,\n2026-09-14,1.1,1.2,\n`],
    ['a code twice', `Date,USD,USD,\n2026-09-14,1.1,1.2,\n`],
    ['a row of another length', `Date,USD,JPY,\n2026-09-14,1.1,\n`],
    ['a row that isn’t a day', `Date,USD,\n14 September 2026,1.1,\n`],
    ['a day twice', `Date,USD,\n2026-09-14,1.1,\n2026-09-14,1.2,\n`],
    ['a decimal comma', `Date,USD,JPY,\n2026-09-14,"1,1",178.5,\n`],
    ['a negative rate', `Date,USD,\n2026-09-14,-1.1,\n`],
    ['a zero rate', `Date,USD,\n2026-09-14,0,\n`],
    ['words for a rate', `Date,USD,\n2026-09-14,one,\n`],
    ['a row of nothing but N/A', `Date,USD,\n2026-09-14,N/A,\n`],
  ])('refuses %s, whole', (_, text) => {
    expect(typeof errorOf(text)).toBe('string');
  });
});

describe('what to write', () => {
  const file = parsed(CSV);
  const empty = { days: new Map<string, readonly string[] | null>(), latest: null };

  test('into an empty store: every year, newest first, the newest publication with its year', () => {
    const plan = planWrites(file, empty, { current: '2026' });
    expect(plan.years.map((s) => s.year)).toEqual(['2026', '2025', '2022', '2011', '2010', '1999']);
    expect(plan.refused).toEqual([]);
    expect(plan.latest?.date).toBe('2026-09-14');
    expect(plan.years[0].fields.get('latest')).toEqual(plan.latest);
    expect(plan.years.slice(1).every((s) => !s.fields.has('latest'))).toBe(true);
    const y2026 = plan.years[0].fields;
    expect((y2026.get('days:2026') as string[])[0]).toBe('2026-01-02');
    expect((y2026.get('USD:2026') as Record<string, string>)['2026-09-14']).toBe('1.1551');
    expect(y2026.has('BGN:2026')).toBe(false); // the lev left before 2026's first publication
    expect(plan.years.find((s) => s.year === '2025')!.fields.has('BGN:2025')).toBe(true);
  });

  test('a past year already stored is left alone; the current one is written again', () => {
    const stored = new Map<string, readonly string[] | null>([
      ['2026', parsed(CSV).days.filter((d) => d.startsWith('2026'))],
      ['2022', ['2022-03-01']],
      ['2011', []],
    ]);
    const plan = planWrites(file, { days: stored, latest: '2026-09-14' }, { current: '2026' });
    expect(plan.years.map((s) => s.year)).toEqual(['2026', '2025', '2010', '1999']);
    expect(plan.latest).toBeNull(); // not newer than what is stored
  });

  test('a stale copy never removes the newest day, nor moves the newest publication back', () => {
    const stale = parsed(CSV.split('\n').filter((l) => !l.startsWith('2026-09-14')).join('\n'));
    const stored = new Map<string, readonly string[] | null>([['2026', file.days.filter((d) => d.startsWith('2026'))]]);
    const plan = planWrites(stale, { days: stored, latest: '2026-09-14' }, { current: '2026' });
    expect(plan.refused).toEqual(['2026']);
    expect(plan.years.some((s) => s.year === '2026')).toBe(false);
    expect(plan.latest).toBeNull();
  });

  test('a stored calendar that can’t be used is written again', () => {
    const stored = new Map<string, readonly string[] | null>([['2010', null]]);
    const plan = planWrites(file, { days: stored, latest: null }, { current: '2026' });
    expect(plan.years.some((s) => s.year === '2010')).toBe(true);
  });

  test('all: every year again, still never fewer days than stored', () => {
    const stored = new Map<string, readonly string[] | null>([
      ['2010', file.days.filter((d) => d.startsWith('2010'))],
      ['1999', ['1999-01-04', '1999-12-31']],
    ]);
    const plan = planWrites(file, { days: stored, latest: '2026-09-14' }, { current: '2026', all: true });
    expect(plan.years.some((s) => s.year === '2010')).toBe(true);
    expect(plan.refused).toEqual(['1999']); // the file lacks a stored day
  });

  test('the year before is still written in January', () => {
    const stored = new Map<string, readonly string[] | null>([['2025', ['2025-12-30']]]);
    const plan = planWrites(file, { days: stored, latest: '2025-12-30' }, { current: '2026' });
    expect(plan.years.some((s) => s.year === '2025')).toBe(true);
  });
});
