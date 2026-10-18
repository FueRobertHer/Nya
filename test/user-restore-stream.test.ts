import { describe, expect, test } from 'bun:test';
import { JsonReadError, JsonStream, parseStrict, readJsonBytes, readJsonEvents, type JsonEvent, type JsonPath } from '@/lib/user-restore/stream';

// The reader a restore reads a download with (lib/user-restore/stream.ts):
// the same values as JSON.parse wherever JSON.parse is right, strict where it
// is lenient, and the same whatever the text's layout or how it is cut into
// pieces.

const all = () => true;

/** Pushes `text` in pieces of `size` characters and returns every event. */
function inPieces(text: string, size: number, build: (p: JsonPath) => boolean = all): JsonEvent[] {
  const s = new JsonStream({ build });
  const out: JsonEvent[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
  out.push(...s.end());
  return out;
}

const DOC = {
  format: 'nya-export',
  version: 2,
  notes: [],
  accounts: [
    { account_id: 'a1', name: 'Chase Checking', mask: '4821', balance: -12.5, hidden: false, lifecycle: null },
    { account_id: 'a2', name: 'Café “quoted” \\ slash / tab\t newline\n', mask: null, balance: 1e21, hidden: true, lifecycle: { state: 'closed', date: '2026-03-12' } },
  ],
  emoji: 'pile of \u{1F4A9} and é',
  nested: { a: [1, [2, [3, { b: [] }]], {}], z: 0, neg: -0.000123, exp: 6.02e23 },
};

describe('the same values as JSON.parse', () => {
  const layouts: [string, string][] = [
    ['compact', JSON.stringify(DOC)],
    ['indented', JSON.stringify(DOC, null, 2)],
    ['tabs and CRLF', JSON.stringify(DOC, null, '\t').replace(/\n/g, '\r\n')],
  ];
  for (const [name, text] of layouts) {
    test(`${name}, built whole`, () => {
      expect(parseStrict(text)).toEqual(JSON.parse(text));
    });
    test(`${name}, in every piece size from 1 to 17 characters`, () => {
      for (let size = 1; size <= 17; size++) {
        const events = inPieces(text, size);
        expect(events).toEqual([{ kind: 'value', path: [], value: JSON.parse(text) }]);
      }
    });
  }

  test('escapes, a surrogate pair and a lone surrogate read as JSON.parse reads them', () => {
    const text = '{"a":"\\u00e9\\ud83d\\udca9\\ud800 \\" \\\\ \\/ \\b\\f\\n\\r\\t"}';
    expect(parseStrict(text)).toEqual(JSON.parse(text));
  });

  test('numbers at the edges', () => {
    for (const n of ['0', '-0', '1.5', '-1.5e-7', '1E+300', '123456789012345678901234567890', '0.1', '9007199254740993']) {
      expect(parseStrict(n)).toEqual(JSON.parse(n));
    }
  });

  test('scalars at the top', () => {
    for (const v of ['true', 'false', 'null', '"x"', '12']) expect(parseStrict(` ${v} `)).toEqual(JSON.parse(v));
  });
});

describe('walking and building', () => {
  test('a walked container gives its members at their paths, and builds what the caller asks for', () => {
    const text = JSON.stringify({ format: 'nya-export', accounts: [{ id: 1 }, { id: 2 }], book: { version: 1, rows: [{ r: 1 }, { r: 2 }] } });
    const build = (p: JsonPath) => (p[0] === 'accounts' && p.length === 2) || (p[0] === 'book' && p[1] === 'rows' && p.length === 3);
    for (const size of [1, 3, 1000]) {
      expect(inPieces(text, size, build)).toEqual([
        { kind: 'start', path: [], container: 'object' },
        { kind: 'value', path: ['format'], value: 'nya-export' },
        { kind: 'start', path: ['accounts'], container: 'array' },
        { kind: 'value', path: ['accounts', 0], value: { id: 1 } },
        { kind: 'value', path: ['accounts', 1], value: { id: 2 } },
        { kind: 'end', path: ['accounts'], container: 'array' },
        { kind: 'start', path: ['book'], container: 'object' },
        { kind: 'value', path: ['book', 'version'], value: 1 },
        { kind: 'start', path: ['book', 'rows'], container: 'array' },
        { kind: 'value', path: ['book', 'rows', 0], value: { r: 1 } },
        { kind: 'value', path: ['book', 'rows', 1], value: { r: 2 } },
        { kind: 'end', path: ['book', 'rows'], container: 'array' },
        { kind: 'end', path: ['book'], container: 'object' },
        { kind: 'end', path: [], container: 'object' },
      ]);
    }
  });

  test('empty containers, walked and built', () => {
    expect(readJsonEvents('{"a":[],"b":{}}', { build: () => false })).toEqual([
      { kind: 'start', path: [], container: 'object' },
      { kind: 'start', path: ['a'], container: 'array' },
      { kind: 'end', path: ['a'], container: 'array' },
      { kind: 'start', path: ['b'], container: 'object' },
      { kind: 'end', path: ['b'], container: 'object' },
      { kind: 'end', path: [], container: 'object' },
    ]);
    expect(parseStrict('{"a":[],"b":{}}')).toEqual({ a: [], b: {} });
  });

  test('a built object has only its own keys, never a prototype from the text', () => {
    const v = parseStrict('{"constructor":"x","toString":1}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(['constructor', 'toString']);
  });
});

describe('refused, with nothing half read', () => {
  const refused: [string, string][] = [
    ['a key given twice', '{"a":1,"a":2}'],
    ['a key given twice in a nested object', '[{"x":{"a":1,"b":2,"a":3}}]'],
    ['a key named __proto__', '{"__proto__":{"polluted":true}}'],
    ['a nested __proto__', '{"a":[{"__proto__":1}]}'],
    ['a raw control character in a string', '{"a":"x\u0001y"}'],
    ['a raw newline in a string', '"a\nb"'],
    ['an escape JSON doesn’t allow', '"\\x41"'],
    ['a short \\u escape', '"\\u12"'],
    ['a leading zero', '[01]'],
    ['a lone minus', '[-]'],
    ['a number with a trailing point', '[1.]'],
    ['NaN', '[NaN]'],
    ['Infinity', '[Infinity]'],
    ['a single-quoted string', "['a']"],
    ['a trailing comma in an array', '[1,2,]'],
    ['a trailing comma in an object', '{"a":1,}'],
    ['a missing colon', '{"a" 1}'],
    ['a missing comma', '[1 2]'],
    ['a key that isn’t a string', '{a:1}'],
    ['a misspelt word', '[tru]'],
    ['more after the value', '{} {}'],
    ['a value then a stray character', '[1]x'],
    ['a document cut short', '{"a":[1,2'],
    ['a string cut short', '{"a":"bc'],
    ['nothing at all', '   '],
    ['a comment', '{"a":1 /* no */}'],
    ['a number too large to be finite', '[1e400]'],
  ];
  for (const [name, text] of refused) {
    test(name, () => {
      expect(() => parseStrict(text)).toThrow(JsonReadError);
      // The same, read a character at a time.
      expect(() => inPieces(text, 1)).toThrow(JsonReadError);
    });
  }

  test('the message names the problem and where, never the text', () => {
    try {
      parseStrict('{"secret account name":1,"secret account name":2}');
      throw new Error('not refused');
    } catch (err) {
      expect(err).toBeInstanceOf(JsonReadError);
      expect((err as Error).message).not.toContain('secret');
      expect((err as JsonReadError).at).toBeGreaterThan(0);
    }
  });
});

describe('bounded', () => {
  test('nesting deeper than the limit', () => {
    const deep = '['.repeat(65) + ']'.repeat(65);
    expect(() => parseStrict(deep)).toThrow(/nested too deeply/);
    expect(parseStrict('['.repeat(64) + ']'.repeat(64))).toBeDefined();
  });

  test('a string longer than the limit, even when it never ends', () => {
    expect(() => parseStrict(`"${'x'.repeat(2000)}"`, { string: 1000 })).toThrow(/longer than Nya reads/);
    const s = new JsonStream({ build: all, limits: { string: 1000 } });
    s.push('"');
    // Refused as soon as it is too long, not when it ends: an unterminated
    // string can't grow the buffer for ever.
    expect(() => s.push('y'.repeat(1500))).toThrow(/longer than Nya reads/);
  });

  test('a built value larger than the limit', () => {
    const text = JSON.stringify([{ a: 'x'.repeat(400) }, { a: 'y'.repeat(4000) }]);
    const build = (p: JsonPath) => p.length === 1;
    expect(() => readJsonEvents(text, { build, limits: { record: 1000 } })).toThrow(/larger than Nya reads/);
    expect(readJsonEvents(JSON.stringify([{ a: 'x'.repeat(400) }]), { build, limits: { record: 1000 } })).toHaveLength(3);
  });

  test('a walked list of many records is not one built value, so it isn’t bound by the record limit', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: `row-${i}`, amount: i / 100 }));
    const text = JSON.stringify({ rows });
    const events = inPieces(text, 4096, (p) => p.length === 2);
    expect(events.filter((e) => e.kind === 'value')).toHaveLength(2000);
    expect(() => readJsonEvents(text, { build: (p) => p.length === 2, limits: { record: 200 } })).not.toThrow();
  });

  test('a text longer than the whole limit', () => {
    const s = new JsonStream({ build: all, limits: { total: 100 } });
    s.push('[');
    expect(() => s.push('1,'.repeat(60))).toThrow(/larger than Nya reads/);
  });

  test('a run of digits can’t grow without bound', () => {
    expect(() => parseStrict(`[${'1'.repeat(500)}]`)).toThrow(/number is longer/);
  });
});

describe('bytes', () => {
  async function fromBytes(bytes: Uint8Array, size: number): Promise<unknown> {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
    let value: unknown;
    await readJsonBytes(chunks, { build: all }, (events) => {
      for (const e of events) if (e.kind === 'value') value = e.value;
    });
    return value;
  }

  test('multibyte characters cut between pieces decode whole', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(DOC));
    for (const size of [1, 2, 3, 5, 64]) expect(await fromBytes(bytes, size)).toEqual(DOC);
  });

  test('a byte order mark is dropped', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
    expect(await fromBytes(bytes, 2)).toEqual({ a: 1 });
  });

  test('bytes that aren’t UTF-8 are refused, never read as replacement characters', async () => {
    const bad = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    await expect(fromBytes(bad, 3)).rejects.toThrow(JsonReadError);
    // A sequence cut off at the very end.
    const cut = new Uint8Array([...new TextEncoder().encode('"é'), 0xc3]);
    await expect(fromBytes(cut, 1)).rejects.toThrow(JsonReadError);
  });
});
