import { describe, expect, test } from 'bun:test';
import { csvCell, csvRow } from '@/lib/csv';
import { parseCsv } from './csv-parse';

describe('RFC 4180', () => {
  test('a field is quoted only when it holds a comma, a quote, a CR or an LF, and quotes inside are doubled', () => {
    expect(csvCell('Blue Bottle')).toBe('Blue Bottle');
    expect(csvCell('Coffee, beans')).toBe('"Coffee, beans"');
    expect(csvCell('6" sub')).toBe('"6"" sub"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('a\rb')).toBe('"a\rb"');
  });

  test('records end in CRLF, and read back exactly', () => {
    const values = ['plain', 'a, b', 'say "hi"', 'line\nbreak', 'cr\rhere', '', 'ünïcødé ☕'];
    const text = csvRow(values) + csvRow(['x', 'y', 'z', '1', '2', '3', '4']);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(parseCsv(text)).toEqual([values, ['x', 'y', 'z', '1', '2', '3', '4']]);
  });

  test('empty for nothing, and for a number that is not finite', () => {
    expect(csvRow([null, undefined, NaN, Infinity, '', 0])).toBe(',,,,,0\r\n');
  });

  test('numbers and booleans as JavaScript writes them', () => {
    expect(csvRow([12.5, -3, 0.1, 1e21, -1e-7, true, false])).toBe('12.5,-3,0.1,1e+21,-1e-7,true,false\r\n');
  });
});

describe('formula injection', () => {
  test('a cell a spreadsheet would run gets a leading quote', () => {
    for (const evil of ['=1+1', '+1+1', '-2+3', '@SUM(A1:A9)', '\t=1', '=cmd|’ /C calc’!A0', '-', '+', '@']) {
      expect(csvCell(evil)).toBe(`'${evil}`);
    }
  });

  test('a leading carriage return is guarded and quoted', () => {
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
    expect(parseCsv(csvRow(['\r=1+1']))).toEqual([["'\r=1+1"]]);
  });

  test('guarded and quoted together, and still read back as text', () => {
    const cell = csvCell('=HYPERLINK("http://evil.example","click")');
    expect(cell).toBe('"\'=HYPERLINK(""http://evil.example"",""click"")"');
    expect(parseCsv(cell + '\r\n')).toEqual([['\'=HYPERLINK("http://evil.example","click")']]);
  });

  test('a negative amount is a number, not a formula, and keeps adding up', () => {
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('-1e-7')).toBe('-1e-7');
    // Text that only starts like a number is still guarded.
    expect(csvCell('-12.5+1')).toBe("'-12.5+1");
    expect(csvCell('-1e5x')).toBe("'-1e5x");
  });

  test('the characters are only dangerous at the start', () => {
    for (const fine of ['a=1', 'Mom & Pop @ Main', 'x-y', '1+1', ' =1']) expect(csvCell(fine)).toBe(fine);
  });
});
