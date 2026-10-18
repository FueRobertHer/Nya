import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bypasses, clientModules, closing, drawnParts, fieldsWithoutPlaceholder, lex, staleMemos, unmaskedChildren, unspokenLabels } from './amount-sources';

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

describe('the reader', () => {
  test('passes over what is no code: strings, template text, regular expressions, comments, and JSX text and quoted attributes', () => {
    const text = [
      "const a = f(`it's (${g(')')} at https://x.io`, /^https?:\\/\\/[)]/, 'b)', \"c(\");",
      '// a comment: (',
      '/* another ( */',
      "const el = <p title=\"(\">Don't ( {h(1)} </p>;",
      '',
    ].join('\n');
    const lx = lex(text, true);
    expect(closing(lx, text.indexOf('f(') + 1)).toBe(text.indexOf(');'));
    expect(closing(lx, text.indexOf('${') + 1)).toBe(text.indexOf('} at'));
    expect(closing(lx, text.indexOf('{h(1)'))).toBe(text.indexOf('} </p>'));
    // The comments go, every offset kept; what is no code is left out of its names.
    expect(lx.code.length).toBe(text.length);
    expect(lx.code).not.toContain('comment');
    expect(lx.names).not.toMatch(/https|another|Don|it's/);
    expect(lx.names).toContain('g(');
    expect(lx.names).toContain('h(1)');
  });

  test('so a "//" in a template or a regular expression, or an apostrophe in a template, hides nothing after it', () => {
    const found = scan({
      // A link's template and the expression testing it, before an amount drawn bare.
      Slashes: ['const site = `https://${flag}`; const web = /^https?:\\/\\//.test(site); return <a href={site}>{web ? 1 : 0}</a>;', ['export function Later({ n }: any) { return <b>{fmt(n)}</b>; }']],
      // A component whose template says "it's", given a formatter to draw with.
      Apostrophe: ['return <Note money={fmt} />;', ['function Note({ money }: any) {', '  const s = String(`it\'s`);', '  return <p>{s}{money(2)}</p>;', '}']],
      // A memo whose template says it.
      Memo: 'const s = useMemo(() => `It\'s ${fmt(n)}`, [n]); return <i>{s ? 1 : 0}</i>;',
    });
    expect(found.children).toEqual({ Slashes: [9], Apostrophe: [11] });
    expect(found.memos).toEqual({ Memo: [7] });
  });
});

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

  test('Intl with `new` or without, toPrecision, a number rounded as one but drawn as it is, and a count’s exemption not taken by an amount’s words', () => {
    const found = scan({
      NoNew: "return <span>{Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n)}</span>;",
      Precision: 'return <span>{balance.toPrecision(6)}</span>;',
      RoundedDrawn: 'return <span>{Number(balance.toFixed(2))}</span>;',
      Spent: 'return <p>{balance.toLocaleString()} spent</p>;',
      Monthly: 'return <p>{balance.toLocaleString()} a month</p>;',
    });
    expect(found.bypasses).toEqual({ NoNew: [7], Precision: [7], RoundedDrawn: [7], Spent: [7], Monthly: [7] });
  });

  test('guarded only by what writes the mask in its place: hiddenFigure around it, its own statement’s switch, or its function’s early return', () => {
    const found = scan({
      Around: 'return <p><Masked>{hiddenFigure((cents / 100).toFixed(2))}</Masked></p>;',
      Dollar: 'return <p><Masked>{`$${hiddenFigure(String(cents))}`}</Masked></p>;',
      Chosen: "return <p><Masked>{amountsHidden() ? '•••' : (cents / 100).toFixed(2)}</Masked></p>;",
      Early: ['return <p><Masked>{cell(n)}</Masked></p>;', ['function cell(n: number) { if (amountsHidden()) return hiddenMoney(n, null); return n.toFixed(2); }']],
      // A hidden figure earlier in the function guards nothing after it.
      Earlier: 'const q = hiddenFigure(String(n)); return <p><Masked>{q}</Masked><Masked>{(cents / 100).toFixed(2)}</Masked></p>;',
      // Nor does an early return of another function.
      Elsewhere: ['return <p><Masked>{cell(n)}</Masked></p>;', ['function cell(n: number) { const hide = () => { if (amountsHidden()) return 1; return 0; }; return `${hide()}${n.toFixed(2)}`; }']],
    });
    expect(found.bypasses).toEqual({ Earlier: [7], Elsewhere: [9] });
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

describe('where an amount is kept before it is drawn', () => {
  test('a `let` given one later, a list or a map it is put in, a callback given their items, and a for...of over them', () => {
    const found = scan({
      Later: "let label = 'none'; if (flag) label = fmt(n); return <span>{label}</span>;",
      Added: "let label = 'Spent '; label += fmt(n); return <span>{label}</span>;",
      Pushed: 'const lines: string[] = []; lines.push(`at ${fmt(n)}`); return <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>;',
      InMap: "const lines = new Map<string, string>(); lines.set('a', fmt(n)); return <ul>{[...lines].map(([k, line]) => <li key={k}>{line}</li>)}</ul>;",
      Returned: ['return <ul>{lines(n).map((l) => <li key={l}>{l}</li>)}</ul>;', ['function lines(n: number) { return [fmt(n), fmt(-n)]; }']],
      Looped: 'for (const line of values.map(fmt)) return <p>{line}</p>; return null;',
      Immediate: 'const text = (() => fmt(n))(); return <p>{text}</p>;',
    });
    const all = ['Later', 'Added', 'Pushed', 'InMap', 'Returned', 'Looped', 'Immediate'];
    expect(found.children).toEqual(Object.fromEntries(all.map((name) => [name, [7]])));
  });

  test('of an object or a list of them, the members given one, but not the others', () => {
    const found = scan({
      Value: "const rows = [{ label: 'Total', value: fmt(n) }]; return <dl>{rows.map((r) => <dd key={r.label}>{r.value}</dd>)}</dl>;",
      Label: "const rows = [{ label: 'Total', value: fmt(n) }]; return <dl>{rows.map((r) => <dt key={r.label}>{r.label}</dt>)}</dl>;",
      PushedValue: "const rows: { label: string; value: string }[] = []; rows.push({ label: 'Total', value: fmt(n) }); return <dl>{rows.filter((r) => r.label).map((r) => <dd key={r.label}>{r.value}</dd>)}</dl>;",
      PushedLabel: "const rows: { label: string; value: string }[] = []; rows.push({ label: 'Total', value: fmt(n) }); return <dl>{rows.map((r) => <dt key={r.label}>{r.label}</dt>)}</dl>;",
      // Destructured from what a function returns.
      Said: ['const { text } = describe(n); return <p>{text}</p>;', ["function describe(n: number) { return n > 0 ? { text: fmt(n), note: 'plain' } : { text: '', note: 'none' }; }"]],
      Note: ['const { note } = describe(n); return <p>{note}</p>;', ["function describe(n: number) { return n > 0 ? { text: fmt(n), note: 'plain' } : { text: '', note: 'none' }; }"]],
      Errors: ['const read = check(n); return <ul>{read.errors.map((e) => <li key={e}>{e}</li>)}</ul>;', ["function check(n: number) { const errors: string[] = []; if (n > 1) errors.push(`At most ${fmt(1)}`); return { errors, n }; }"]],
      Count: ['const { n: m } = check(n); return <p>{m}</p>;', ["function check(n: number) { const errors: string[] = []; if (n > 1) errors.push(`At most ${fmt(1)}`); return { errors, n }; }"]],
    });
    expect(found.children).toEqual({ Value: [7], PushedValue: [7], Said: [7], Errors: [7] });
  });

  test('a function given its formatter: by a default, or in an object handed to it, or under another name', () => {
    const found = scan({
      Default: ['return <p>{line(n)}</p>;', ["function line(n: number, money: (n: number) => string = fmt) { return 'at ' + money(n); }"]],
      Handed: ['const names = { money: fmt }; return <p>{sentence(n, names)}</p>;', ["function sentence(n: number, names: { money: (n: number) => string }) { return 'over ' + names.money(n); }"]],
      Renamed: "const money = formatMoney; return <p>{money(n, 'USD')}</p>;",
      Chosen: "const money = flag ? formatMoney : formatMoney; return <p>{money(n, null)}</p>;",
    });
    expect(found.children).toEqual({ Default: [7], Handed: [7], Renamed: [7], Chosen: [7] });
  });

  test('a list of choices whose labels hold one, read alone', () => {
    const found = scan({
      Choices: "return <select>{[['a', fmt(n)]].map(([v, t]) => <option key={v} value={v} aria-label={t}>{t}</option>)}</select>;",
      SaidChoices: "return <select>{[['a', fmt(n)]].map(([v, t]) => <option key={v} value={v} aria-label={spoken(t)}>{t}</option>)}</select>;",
    });
    expect(found.labels).toEqual({ Choices: [7] });
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

/** What the app draws in <Masked> that never holds an amount (a count, a
 *  currency's code, words): the scan owes no report for it drawn bare. */
const NEVER_AN_AMOUNT = [
  'components/FiProgressCard.tsx {leftOut.excluded}',
  'components/FiProgressCard.tsx {leftOut.otherCurrencies}',
  'components/GoalsCard.tsx {stateText(v)}',
  'components/ManualTxnSheet.tsx {balanceNote}',
];

/** A component's text with each amount it draws through <Masked> drawn bare,
 *  in a fragment, and each label it says through spoken() said as it is,
 *  every offset kept; and each place so changed, as "file:line code". */
function unwrapped(file: string, text: string): { text: string; sites: string[] } {
  const lx = lex(text, true);
  const out = text.split('');
  const sites: string[] = [];
  const blank = (from: number, to: number, put = '') => {
    for (let i = from; i < to; i++) out[i] = put[i - from] ?? ' ';
  };
  const lineOf = (at: number) => text.slice(0, at).split('\n').length;
  const said = (from: number, to: number) => text.slice(from, to).replace(/\s+/g, ' ').trim();
  for (const el of lx.jsx.elements) {
    if (el.name !== 'Masked') continue;
    const [x, ...more] = lx.jsx.exprs.filter((e) => e.element === el && e.attr === null);
    const open = el.start + '<Masked>'.length;
    const close = el.end - '</Masked>'.length;
    if (!x || more.length > 0 || text.slice(open, x.open).trim() || text.slice(x.close + 1, close).trim()) continue;
    blank(el.start, open, '<>');
    blank(close, el.end, '</>');
    sites.push(`${file}:${lineOf(x.open)} ${said(x.open, x.close + 1)}`);
  }
  for (const x of lx.jsx.exprs) {
    const inner = text.slice(x.open + 1, x.close);
    const call = /^\s*(spoken|spokenLabel)\s*\(/.exec(inner);
    // A label that is a call of spoken() and nothing else.
    if (!x.attr || !['aria-label', 'aria-valuetext', 'title', 'alt'].includes(x.attr) || !call) continue;
    if (closing(lx, x.open + call[0].length) !== x.open + inner.trimEnd().length) continue;
    const name = x.open + 1 + call[0].indexOf(call[1]);
    blank(name, name + call[1].length);
    sites.push(`${file}:${lineOf(text.lastIndexOf(x.attr, x.open))} ${x.attr}={${said(x.open + 1, x.close)}}`);
  }
  return { text: out.join(''), sites };
}

describe('held to the app’s own shapes', () => {
  test('each amount the app draws through <Masked>, or says through spoken(), is reported once drawn bare or said as it is', () => {
    const root = join(import.meta.dir, '..');
    const dir = mkdtempSync(join(tmpdir(), 'nya-amount-unwrapped-'));
    dirs.push(dir);
    for (const d of ['lib', 'app']) symlinkSync(join(root, d), join(dir, d));
    mkdirSync(join(dir, 'components'));
    const sites: string[] = [];
    for (const name of readdirSync(join(root, 'components'))) {
      const text = readFileSync(join(root, 'components', name), 'utf8').replace(/\r/g, '');
      const changed = name.endsWith('.tsx') && name !== 'HideAmounts.tsx' ? unwrapped(`components/${name}`, text) : { text, sites: [] };
      writeFileSync(join(dir, 'components', name), changed.text);
      sites.push(...changed.sites);
    }
    const modules = clientModules(dir);
    const reported = new Set([...unmaskedChildren(dir, modules), ...unspokenLabels(dir, modules)].map((r) => `${r.file}:${r.line}`));
    expect(sites.length).toBeGreaterThan(250);
    const missed = sites.filter((site) => !reported.has(site.split(' ')[0])).map((site) => site.replace(/:\d+ /, ' '));
    expect(missed.sort()).toEqual(NEVER_AN_AMOUNT);
  });
});
