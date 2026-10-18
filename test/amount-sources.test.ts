import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bypasses, clientModules, drawnParts, fieldsWithoutPlaceholder, staleMemos, unmaskedChildren, unspokenLabels } from './amount-sources';

// The scan of the source (test/amount-sources.ts) on its own: each shape an
// amount can be written in that it is there to catch, each in a component of
// its own, and beside them the shapes that are no amount, or are drawn
// masked, which it must leave alone. test/hide-amounts.test.tsx runs it over
// the app.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Each shape as a component of its own, `components/<name>.tsx`: the shape on
 * line 7, in a component given every prop the shapes use, and any `extra`
 * lines from line 9. `fmt` (line 5) writes an amount through the formatter.
 */
function caseFile(shape: string, extra: string[] = []): string {
  return [
    "'use client';",
    "import { useMemo } from 'react';",
    "import { fieldAmount, formatMoney, hideAmountsIn, plainNumber, spoken } from '@/lib/format';",
    "import { Masked } from './HideAmounts';",
    "const fmt = (v: number) => formatMoney(v, 'USD');",
    'export function Case({ n, cents, balance, share, x, y, flag, values, value }: any) {',
    `  ${shape}`,
    '}',
    ...extra,
    '',
  ].join('\n');
}

/** A case's file: its shape (caseFile), with extra lines, or a whole file. */
type Case = string | [string, string[]] | { file: string };

/** What the scan says of each case, by the case's name: the lines reported. */
function scan(cases: Record<string, Case>): Record<'bypasses' | 'memos' | 'labels' | 'children' | 'fields', Record<string, number[]>> {
  const dir = mkdtempSync(join(tmpdir(), 'nya-amount-sources-'));
  dirs.push(dir);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  mkdirSync(join(dir, 'app'));
  write(
    'lib/format.ts',
    [
      'export function formatMoney(n: number, c: string | null): string { return String(n) + (c ?? ""); }',
      'export function hideAmountsIn(text: string): string { return text; }',
      'export function spoken(text: string): string { return text; }',
      'export function plainNumber(n: number): string { return n.toLocaleString(); }',
      'export function fieldAmount(n: number, places = 2): string { return n.toFixed(places); }',
      '',
    ].join('\n')
  );
  write('components/HideAmounts.tsx', 'export function Masked({ children }: { children: string | null }) { return children; }\n');
  for (const [name, c] of Object.entries(cases)) write(`components/${name}.tsx`, typeof c === 'string' ? caseFile(c) : Array.isArray(c) ? caseFile(...c) : c.file);
  const modules = clientModules(dir);
  const sources = modules.filter((m) => m !== 'lib/format.ts').map((m) => ({ path: m, text: readFileSync(join(dir, m), 'utf8') }));
  const byCase = (found: { file: string; line: number }[]) => {
    const out: Record<string, number[]> = {};
    for (const { file, line } of found) (out[file.replace(/^components\/|\.tsx$/g, '')] ??= []).push(line);
    return out;
  };
  return {
    bypasses: byCase(bypasses(sources)),
    memos: byCase(staleMemos(dir, modules)),
    labels: byCase(unspokenLabels(dir, modules)),
    children: byCase(unmaskedChildren(dir, modules)),
    fields: byCase(fieldsWithoutPlaceholder(dir, modules)),
  };
}

describe('a number written as an amount past the formatters', () => {
  test('toFixed, and toLocaleString given no options, are amounts', () => {
    const found = scan({
      Cents: 'return <span>{(cents / 100).toFixed(2)}</span>;',
      Balance: 'return <p>Balance {balance.toLocaleString()} USD</p>;',
      LocaleOnly: "return <p>{`${n.toLocaleString('en-US')} ${flag}`}</p>;",
      InText: 'const text = `${n.toFixed(2)} USD`; return <i>{text.length}</i>;',
    });
    expect(found.bypasses).toEqual({ Cents: [7], Balance: [7], LocaleOnly: [7], InText: [7] });
  });

  test('unless the code beside it says what else it is', () => {
    const found = scan({
      Percent: 'return <span>{(share * 100).toFixed(1)}%</span>;',
      MadeAPercent: 'const pct = (share * 100).toFixed(1); return <span>{pct} of it</span>;',
      Coordinates: 'return <path d={`M${x.toFixed(1)},${y.toFixed(1)}L${x.toFixed(1)},0`} />;',
      Size: 'return <p>{`${(n / 1048576).toFixed(1)} MB`}</p>;',
      Years: 'return <p>{`about ${Number(n.toFixed(1))} years`}</p>;',
      Rounded: 'const v = Number((n * 3).toFixed(6)); return <b>{v}</b>;',
      Color: 'return <div style={{ background: `rgba(1, 2, 3, ${share.toFixed(3)})` }} />;',
      Count: 'return <p>{n.toLocaleString()} rows, {plainNumber(n)} of them new</p>;',
      Plural: "return <p>{`${n.toLocaleString()} ${n === 1 ? 'row' : 'rows'}`}</p>;",
      Length: 'return <p>Show all {values.length.toLocaleString()}</p>;',
      Bound: 'return <p>From 0 to {plainNumber(n)}</p>;',
      Date: 'return <p>{new Date(n).toLocaleString()}</p>;',
      Field: 'return <input inputMode="decimal" value={fieldAmount(n)} readOnly />;',
    });
    expect(found.bypasses).toEqual({});
    expect(found.children).toEqual({});
  });

  test('kept in a memo the switch can’t change', () => {
    const found = scan({
      Memo: 'const rows = useMemo(() => [n].map((v: number) => ({ text: `${v.toFixed(2)} USD` })), [n]); return <i>{rows.length}</i>;',
      // A formatter kept uncalled writes nothing yet: it is called when drawn.
      Kept: 'const names = useMemo(() => ({ money: fmt }), []); return <i>{names ? 1 : 0}</i>;',
    });
    expect(found.memos).toEqual({ Memo: [7] });
  });
});

describe('an amount drawn as text outside <Masked>', () => {
  test('anywhere in a child: alone, in a template literal, a ternary or a list, or in a call given a formatter', () => {
    const found = scan({
      Alone: 'return <span>{fmt(n)}</span>;',
      Template: "return <span>{`Spent ${formatMoney(n, 'USD')} so far`}</span>;",
      Ternary: "return <span>{flag ? formatMoney(n, 'USD') : 'none'}</span>;",
      Either: "return <span>{flag || fmt(n)}</span>;",
      Last: 'return <span>{flag && n > 0 && fmt(n)}</span>;',
      Joined: "return <span>{values.map(fmt).join(', ')}</span>;",
      ServerText: 'return <div className="error">{hideAmountsIn(String(n))}</div>;',
      InSentence: "return <p>Don't spend {fmt(n)} today</p>;",
      Callback: ["return <p>{describe(n, (v: number) => formatMoney(v, 'USD'))}</p>;", ["function describe(n: number, money: (v: number) => string) { return 'at ' + money(n); }"]],
      Button: "return <button>{flag ? 'Saving…' : `Add ${fmt(n)}`}</button>;",
    });
    const all = ['Alone', 'Template', 'Ternary', 'Either', 'Last', 'Joined', 'ServerText', 'InSentence', 'Callback', 'Button'];
    expect(found.children).toEqual(Object.fromEntries(all.map((name) => [name, [7]])));
  });

  test('a variable given an amount, drawn', () => {
    const found = scan({
      Variable: "const label = formatMoney(n, 'USD'); return <span>{label}</span>;",
      FromAMemo: 'const label = useMemo(() => fmt(n), [n]); return <span>{flag ? label : null}</span>;',
      Mapped: 'const labels = values.map(fmt); return <span>{labels}</span>;',
      Member: 'const label = { amount: fmt(n) }; return <span>{label.amount}</span>;',
    });
    expect(found.children).toEqual({ Variable: [7], FromAMemo: [7], Mapped: [7], Member: [7] });
  });

  test('a formatter handed on as a callback or a prop, and a prop given an amount, drawn where they go', () => {
    const found = scan({
      MapFormatter: 'return <p>{values.map(fmt)}</p>;',
      MapArrow: 'return <ul>{values.map((v: number) => formatMoney(v, null))}</ul>;',
      FormatProp: ['return <Figure value={n} format={fmt} />;', ['function Figure({ value, format }: any) { return <b>{format(value)}</b>; }']],
      ArrowProp: ["return <Figure value={n} format={(v: number) => formatMoney(v, 'USD')} />;", ['function Figure({ value, format }: any) { return <b>{format(value)}</b>; }']],
      AmountProp: ["return <Stat label={formatMoney(n, 'USD')} />;", ['function Stat({ label }: any) { return <i>{label}</i>; }']],
      // To components of other modules: one imported as the default, one by name.
      Imported: ['return <><Shown amount={fmt(n)} /><Told format={fmt} /></>;', ["import Shown, { Told } from './Shown';"]],
      Shown: {
        file: [
          'export default function Shown({ amount }: { amount: string }) {',
          '  return <i>{amount}</i>;',
          '}',
          'export function Told({ format }: { format: (n: number) => string }) {',
          '  return <i>{format(1)}</i>;',
          '}',
          '',
        ].join('\n'),
      },
    });
    expect(found.children).toEqual({ MapFormatter: [7], MapArrow: [7], FormatProp: [9], ArrowProp: [9], AmountProp: [9], Shown: [2, 5] });
  });

  test('a field’s own figures, drawn as text, in <Masked> or not', () => {
    const found = scan({
      Bare: 'return <span>{fieldAmount(n)}</span>;',
      InMasked: 'return <span><Masked>{fieldAmount(n)}</Masked></span>;',
      Through: ['return <span>{typed(n)}</span>;', ['function typed(v: number) { return fieldAmount(v, 0); }']],
      InLabel: 'return <span aria-label={`now ${fieldAmount(n)}`} />;',
      InField: 'return <input value={fieldAmount(n)} readOnly />;',
    });
    expect(found.children).toEqual({ Bare: [7], InMasked: [7], Through: [7] });
    expect(found.labels).toEqual({ InLabel: [7] });
  });

  test('but not one drawn in <Masked>, tested, said through spoken(), or drawn by an element of its own', () => {
    const found = scan({
      Masked: 'return <span><Masked>{fmt(n)}</Masked></span>;',
      Tested: 'const label = fmt(n); return <p>{label && <Masked>{label}</Masked>}</p>;',
      TestedToo: 'const label = fmt(n); return <p>{label !== null && n > 0 ? <Masked>{label}</Masked> : null}</p>;',
      Compared: 'const label = fmt(n); return <p>{label === fmt(0) ? <b>none</b> : <Masked>{label}</Masked>}</p>;',
      Rows: 'return <ul>{values.map((v: number) => <li key={v}><Masked>{fmt(v)}</Masked></li>)}</ul>;',
      Block: 'return <ul>{values.map((v: number) => { const s = fmt(v); return <li key={v}><Masked>{s}</Masked></li>; })}</ul>;',
      Built: 'const rows = values.map((v: number) => <li key={v}><Masked>{fmt(v)}</Masked></li>); return <ul>{rows}</ul>;',
      Said: "return <p className=\"visually-hidden\">{flag ? spoken(`at ${fmt(n)}`) : ''}</p>;",
      Chart: 'return <svg role="img"><text>{fmt(n)}</text><title>{fmt(n)}</title></svg>;',
      Option: 'return <select><option>{fmt(n)}</option></select>;',
      Generic: ['return <p>{none().length}</p>;', ['const none = <T,>(): T[] => [];']],
      // A prop given an amount by its parent: in <Masked> when it is a
      // string, and as it is when it is not (an element, drawing its own).
      NotText: ["return <p>{typeof value === 'string' ? <Masked>{value}</Masked> : value}</p>;", ["export function Parent({ n }: any) { return <Case value={formatMoney(n, 'USD')} />; }"]],
    });
    expect(found.children).toEqual({});
    expect(found.labels).toEqual({});
    // The same prop drawn bare is reported.
    const bare = scan({ GivenValue: ['return <p>{flag ? value : null}</p>;', ["export function Parent({ n }: any) { return <Case value={formatMoney(n, 'USD')} />; }"]] });
    expect(bare.children).toEqual({ GivenValue: [7] });
  });
});

describe('a label a screen reader reads alone', () => {
  test('built from an amount, not said through spoken()', () => {
    const found = scan({
      Direct: 'return <div aria-label={fmt(n)} />;',
      Variable: 'const label = fmt(n); return <div title={label} />;',
      Ternary: "return <div aria-label={flag ? `Paid ${fmt(n)}` : 'Unpaid'} />;",
      Said: 'return <div aria-label={spoken(fmt(n))} />;',
      Tested: "return <div aria-label={n > 0 ? 'Some' : 'None'} />;",
    });
    expect(found.labels).toEqual({ Direct: [7], Variable: [7], Ternary: [7] });
  });
});

describe('what of a child expression is drawn', () => {
  test('a ternary’s branches, each side of || and ??, the last of a run of &&, and what .map returns', () => {
    expect(drawnParts('a ? b : c')).toEqual(['b', 'c']);
    expect(drawnParts('a ? (b ? c : d) : e')).toEqual(['c', 'd', 'e']);
    expect(drawnParts('x && y && z')).toEqual(['z']);
    expect(drawnParts('a || b ?? c')).toEqual(['a', 'b', 'c']);
    expect(drawnParts('rows.filter(Boolean).map((r) => fmt(r))')).toEqual(['fmt(r)']);
    expect(drawnParts('rows.map(fmt)')).toEqual(['fmt()']);
    expect(drawnParts('rows.map((r) => { const s = fmt(r); return s; })')).toEqual(['s']);
    expect(drawnParts("`${a ? 'x' : 'y'} left`")).toEqual(["`${a ? 'x' : 'y'} left`"]);
    expect(drawnParts('a?.b ?? c')).toEqual(['a?.b', 'c']);
  });

  test('nothing for a test, and past a test that a value is not a string, not that value', () => {
    for (const test of ['n > 0', 'a === b', '!flag', 'typeof v', 'n >= 1 && m <= 2']) expect([test, drawnParts(test)]).toEqual([test, []]);
    expect(drawnParts("typeof v === 'string' ? A : v")).toEqual(['A']);
    expect(drawnParts("typeof v !== 'string' ? v : A")).toEqual(['A']);
  });
});

describe('a field the CSS hook covers while amounts are hidden', () => {
  test('has a placeholder, so an empty one shows it rather than the mask', () => {
    const found = scan({
      Bare: 'return <input inputMode="decimal" value={value} readOnly />;',
      Budget: 'return <input className="text-input budget-input" type="number" value={value} readOnly />;',
      Braced: "return <input inputMode={'decimal'} value={value} readOnly />;",
      Example: 'return <input inputMode="decimal" placeholder="0.00" value={value} readOnly />;',
      NoExample: "return <input inputMode=\"decimal\" placeholder={' '} value={value} readOnly />;",
      Percent: 'return <input inputMode="decimal" data-percent value={value} readOnly />;',
      Count: 'return <input inputMode="numeric" value={value} readOnly />;',
    });
    expect(found.fields).toEqual({ Bare: [7], Budget: [7], Braced: [7] });
  });

  test('every one the app has', () => {
    const root = join(import.meta.dir, '..');
    expect(fieldsWithoutPlaceholder(root, clientModules(root))).toEqual([]);
  });
});
