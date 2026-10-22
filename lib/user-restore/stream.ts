// lib/user-restore/stream.ts
//
// Reading JSON a piece at a time, for bringing a download back into Nya
// (lib/user-restore/). A download of years of rows is about 100 MB of JSON
// (docs/data-export.md, "How big"): too much to hold as one parsed document
// on a phone, and far too much for one request to a function (Vercel takes
// 4.5 MB). So the page reads the file a few megabytes at a time and builds one
// record at a time (a transaction, an account's balance series, an entry of a
// store), never the whole document, and the server reads each batch with the
// same code, so the two read the same values.
//
// WHICH VALUES ARE BUILT. The caller says, for each value as it starts, by
// its path (the keys and indexes that lead to it), whether it is built whole
// and handed over as one `value` event, or walked: its own `start` and `end`
// events, with each of its members at its own path. A scalar is always one
// `value`. Any layout reads the same, the download's one record per line or a
// file a tool re-indented or squeezed onto one line.
//
// STRICTER THAN JSON.parse, where JSON.parse is lenient in a way that would
// let a file say one thing to the checks and another to a writer:
//   - a key given twice in one object is refused (JSON.parse keeps the last,
//     so a check of the first would pass a value it never saw);
//   - a key named "__proto__" is refused: assigned as an object's key it sets
//     the object's prototype, and validators that read `v.field` would then
//     read inherited values (objects here are only ever built from keys that
//     can't do that);
//   - text that isn't valid UTF-8, a raw control character in a string, and
//     anything after the document's one value are refused.
// And bounded, so a hostile file can't exhaust memory or the stack: nesting
// depth, the length of a string and of a number, the size of a built value,
// and the whole text.
//
// Pure: no I/O.

/** Why a text couldn't be read as JSON, and where (the character offset in
 *  the whole text). The message names the problem, never the text. */
export class JsonReadError extends Error {
  constructor(
    readonly problem: string,
    readonly at: number
  ) {
    super(`This file isn't JSON Nya can read: ${problem} (at character ${at}).`);
    this.name = 'JsonReadError';
  }
}

/** Where a value is: the keys and indexes that lead to it from the top. */
export type JsonPath = readonly (string | number)[];

export type JsonEvent =
  | { kind: 'start'; path: JsonPath; container: 'object' | 'array' }
  | { kind: 'value'; path: JsonPath; value: unknown }
  | { kind: 'end'; path: JsonPath; container: 'object' | 'array' };

export type ReadLimits = {
  /** Containers inside containers. */
  depth: number;
  /** Characters of one string as written (escapes counted as written). */
  string: number;
  /** Characters of one value built whole. */
  record: number;
  /** Characters of the whole text. */
  total: number;
};

export const DEFAULT_LIMITS: ReadLimits = {
  depth: 64,
  string: 1024 * 1024,
  record: 8 * 1024 * 1024,
  total: 2 * 1024 * 1024 * 1024,
};

/** Longer than any number a download writes, and short enough that a run of
 *  digits can't grow the buffer without bound. */
const MAX_NUMBER_CHARS = 400;
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const NUMBER_CHARS = /[0-9eE+\-.]/;

export type ReaderOptions = {
  /** Whether the value starting at `path` is built whole (one `value` event)
   *  rather than walked. Not asked inside a value being built. */
  build: (path: JsonPath) => boolean;
  limits?: Partial<ReadLimits>;
};

type Container = 'object' | 'array';

/** Where a container is in its own grammar. */
type Expect =
  | 'key-or-end' // just after "{"
  | 'key' // after ","
  | 'colon'
  | 'value' // a member's value, or an array's element after ","
  | 'value-or-end' // just after "["
  | 'comma-or-end';

type Frame = {
  container: Container;
  /** Built whole (its value is here), or walked (its members are events). */
  built: boolean;
  value: Record<string, unknown> | unknown[] | null;
  path: JsonPath;
  expect: Expect;
  keys: Set<string> | null;
  key: string | null;
  index: number;
};

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

/**
 * Reads JSON text pushed a piece at a time, handing back the events each
 * piece completed (see the header). `end()` says the text is whole, and
 * throws when the document isn't.
 */
export class JsonStream {
  private readonly limits: ReadLimits;
  private readonly build: (path: JsonPath) => boolean;
  private buf = '';
  /** The whole text's offset of buf[0]. */
  private base = 0;
  private total = 0;
  private stack: Frame[] = [];
  private done = false;
  private started = false;
  /** Where the value being built at the walk's level began (an offset), to
   *  bound its size. */
  private recordStart = -1;
  private ended = false;

  constructor(opts: ReaderOptions) {
    this.build = opts.build;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
  }

  push(text: string): JsonEvent[] {
    if (this.ended) throw new Error('JsonStream: push after end');
    this.total += text.length;
    if (this.total > this.limits.total) throw new JsonReadError('it is larger than Nya reads', this.base + this.buf.length);
    this.buf += text;
    return this.run(false);
  }

  end(): JsonEvent[] {
    if (this.ended) throw new Error('JsonStream: end twice');
    const events = this.run(true);
    this.ended = true;
    if (!this.done) throw new JsonReadError('the text ends before its value does', this.base + this.buf.length);
    return events;
  }

  private fail(problem: string, i: number): never {
    throw new JsonReadError(problem, this.base + i);
  }

  /** Consumes what it can of the buffer, and keeps the rest (an unfinished
   *  token) for the next push. */
  private run(final: boolean): JsonEvent[] {
    const events: JsonEvent[] = [];
    const buf = this.buf;
    let i = 0;
    const n = buf.length;
    // What's consumed is consumed: the next token starts at `i`.
    let consumed = 0;
    outer: while (true) {
      while (i < n && isSpace(buf.charCodeAt(i))) i++;
      consumed = i;
      if (i >= n) break;
      const c = buf.charCodeAt(i);
      if (this.done) this.fail('there is more after the end of its value', i);
      const top = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
      if (this.recordStart >= 0 && this.base + i - this.recordStart > this.limits.record) {
        this.fail('one of its values is larger than Nya reads', i);
      }

      // Punctuation the container expects.
      if (top) {
        switch (top.expect) {
          case 'colon':
            if (c !== 0x3a) this.fail('a key is not followed by ":"', i);
            top.expect = 'value';
            i++;
            continue outer;
          case 'comma-or-end':
            if (c === 0x2c) {
              top.expect = top.container === 'object' ? 'key' : 'value';
              i++;
              continue outer;
            }
            if ((top.container === 'object' && c === 0x7d) || (top.container === 'array' && c === 0x5d)) {
              i++;
              this.close(events);
              continue outer;
            }
            this.fail(top.container === 'object' ? 'members are not separated by ","' : 'elements are not separated by ","', i);
          case 'key-or-end':
          case 'key': {
            if (c === 0x7d && top.expect === 'key-or-end') {
              i++;
              this.close(events);
              continue outer;
            }
            if (c !== 0x22) this.fail('an object has something other than a key where one belongs', i);
            const s = this.readString(buf, i, final);
            if (s === null) break outer;
            const key = s.value;
            if (key === '__proto__') this.fail('it has a key named __proto__', i);
            if (top.keys!.has(key)) this.fail('an object gives the same key twice', i);
            top.keys!.add(key);
            top.key = key;
            top.expect = 'colon';
            i = s.next;
            continue outer;
          }
          case 'value-or-end':
            if (c === 0x5d) {
              i++;
              this.close(events);
              continue outer;
            }
            break;
          case 'value':
            break;
        }
      } else if (this.started) {
        this.fail('there is more after the end of its value', i);
      }

      // A value starts here.
      const path = this.childPath();
      const insideBuild = !!top && top.built;
      if (c === 0x7b || c === 0x5b) {
        if (this.stack.length >= this.limits.depth) this.fail('its values are nested too deeply', i);
        const container: Container = c === 0x7b ? 'object' : 'array';
        const built = insideBuild || this.build(path);
        if (built && !insideBuild) this.recordStart = this.base + i;
        this.started = true;
        this.stack.push({
          container,
          built,
          value: built ? (container === 'object' ? {} : []) : null,
          path,
          expect: container === 'object' ? 'key-or-end' : 'value-or-end',
          keys: container === 'object' ? new Set() : null,
          key: null,
          index: 0,
        });
        if (!built) events.push({ kind: 'start', path, container });
        i++;
        continue;
      }
      let scalar: unknown;
      let next: number;
      if (c === 0x22) {
        const s = this.readString(buf, i, final);
        if (s === null) break;
        scalar = s.value;
        next = s.next;
      } else if (c === 0x74 || c === 0x66 || c === 0x6e) {
        const word = c === 0x74 ? 'true' : c === 0x66 ? 'false' : 'null';
        if (n - i < word.length) {
          if (!final && word.startsWith(buf.slice(i))) break;
          this.fail('it has a word JSON doesn’t know', i);
        }
        if (buf.slice(i, i + word.length) !== word) this.fail('it has a word JSON doesn’t know', i);
        scalar = c === 0x74 ? true : c === 0x66 ? false : null;
        next = i + word.length;
      } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
        let j = i;
        while (j < n && NUMBER_CHARS.test(buf[j])) {
          j++;
          if (j - i > MAX_NUMBER_CHARS) this.fail('a number is longer than Nya reads', i);
        }
        if (j >= n && !final) break;
        const text = buf.slice(i, j);
        if (!NUMBER.test(text)) this.fail('a number is written in a way JSON doesn’t allow', i);
        scalar = Number(text);
        if (!Number.isFinite(scalar as number)) this.fail('a number is too large', i);
        next = j;
      } else {
        this.fail('a value starts with a character JSON doesn’t allow', i);
      }
      this.started = true;
      i = next;
      this.put(events, path, scalar, insideBuild);
    }
    // Keep only what wasn't consumed: an unfinished token, for the next push.
    this.base += consumed;
    this.buf = buf.slice(consumed);
    if (final && this.buf.trim() !== '') this.fail('the text ends in the middle of a value', 0);
    return events;
  }

  /** The path of the value about to start, in the frame on top. */
  private childPath(): JsonPath {
    const top = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    if (!top) return [];
    return [...top.path, top.container === 'object' ? top.key! : top.index];
  }

  /** A value is complete: into the container being built, or handed over. */
  private put(events: JsonEvent[], path: JsonPath, value: unknown, insideBuild: boolean): void {
    const top = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    if (top && insideBuild) {
      if (top.container === 'object') (top.value as Record<string, unknown>)[top.key!] = value;
      else (top.value as unknown[]).push(value);
    } else {
      events.push({ kind: 'value', path, value });
    }
    this.advance(top);
  }

  private advance(top: Frame | null): void {
    if (!top) {
      this.done = true;
      return;
    }
    if (top.container === 'array') top.index++;
    top.key = null;
    top.expect = 'comma-or-end';
  }

  /** A container ends (its closing bracket consumed). */
  private close(events: JsonEvent[]): void {
    const frame = this.stack.pop()!;
    const parent = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    if (frame.built) {
      const insideBuild = !!parent && parent.built;
      if (!insideBuild) this.recordStart = -1;
      if (parent && insideBuild) {
        if (parent.container === 'object') (parent.value as Record<string, unknown>)[parent.key!] = frame.value;
        else (parent.value as unknown[]).push(frame.value);
      } else {
        events.push({ kind: 'value', path: frame.path, value: frame.value });
      }
    } else {
      events.push({ kind: 'end', path: frame.path, container: frame.container });
    }
    this.advance(parent);
  }

  /**
   * A string from the opening quote at `start`, unescaped, and the offset just
   * after its closing quote; null when the buffer ends inside it and more may
   * come.
   */
  private readString(buf: string, start: number, final: boolean): { value: string; next: number } | null {
    let j = start + 1;
    let out = '';
    let from = j;
    const n = buf.length;
    while (true) {
      if (j - start > this.limits.string) this.fail('a string is longer than Nya reads', start);
      if (j >= n) {
        if (final) this.fail('a string isn’t closed', start);
        return null;
      }
      const c = buf.charCodeAt(j);
      if (c === 0x22) {
        out += buf.slice(from, j);
        return { value: out, next: j + 1 };
      }
      if (c < 0x20) this.fail('a string holds a control character JSON doesn’t allow', j);
      if (c !== 0x5c) {
        j++;
        continue;
      }
      // An escape: wait for all of it.
      if (j + 1 >= n) {
        if (final) this.fail('a string isn’t closed', start);
        return null;
      }
      out += buf.slice(from, j);
      const e = buf[j + 1];
      if (e === 'u') {
        if (j + 6 > n) {
          if (final) this.fail('a string isn’t closed', start);
          return null;
        }
        const hex = buf.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('a string has an escape JSON doesn’t allow', j);
        out += String.fromCharCode(parseInt(hex, 16));
        j += 6;
      } else {
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        const m = map[e];
        if (m === undefined) this.fail('a string has an escape JSON doesn’t allow', j);
        out += m;
        j += 2;
      }
      from = j;
    }
  }
}

/** Every event of a whole text, read as JsonStream reads it. */
export function readJsonEvents(text: string, opts: ReaderOptions): JsonEvent[] {
  const stream = new JsonStream(opts);
  return [...stream.push(text), ...stream.end()];
}

/** One whole JSON value, read strictly (see the header): for a batch the
 *  server receives, which is small enough to build whole. */
export function parseStrict(text: string, limits?: Partial<ReadLimits>): unknown {
  const events = readJsonEvents(text, { build: () => true, limits });
  return (events[events.length - 1] as { value: unknown }).value;
}

/**
 * Reads UTF-8 bytes as they come (the slices of a file the page reads, say),
 * decoding them strictly: bytes that aren't UTF-8 are refused, never read as
 * replacement characters. A leading byte order mark is dropped, as a JSON
 * reader may.
 */
export async function readJsonBytes(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, opts: ReaderOptions, onEvents: (events: JsonEvent[]) => void | Promise<void>): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const stream = new JsonStream(opts);
  let at = 0;
  const decode = (bytes: Uint8Array | undefined, last: boolean): string => {
    try {
      return last ? decoder.decode(bytes) : decoder.decode(bytes, { stream: true });
    } catch {
      throw new JsonReadError('it isn’t UTF-8 text', at);
    }
  };
  for await (const chunk of chunks) {
    const text = decode(chunk, false);
    at += chunk.length;
    if (text) await onEvents(stream.push(text));
  }
  const rest = decode(undefined, true);
  if (rest) await onEvents(stream.push(rest));
  await onEvents(stream.end());
}
