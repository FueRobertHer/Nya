// lib/user-restore/file.ts
//
// Reading a download in the page, for bringing it back (docs/data-export.md,
// "Bringing it back"): a few megabytes at a time, never whole
// (lib/user-restore/stream.ts), so a file of years of rows reads on a phone.
// Three passes over the file, each one record at a time:
//
//   collect   every record checked against this release's closed shapes
//             (lib/user-restore/shapes.ts), what is small held, what is large
//             counted (the bank's rows, books of rows, an import's records,
//             holdings months) and what the plan needs of it noted (each
//             account's span, which rows are pending): Collected.
//   plan      the batches built, in order (lib/user-restore/plan.ts), and each
//             one's SHA-256 taken: the plan the restore's record keeps. The
//             parts kept on the storage seam are checked by the server's own
//             checks as each batch is built (the page can't load the stores),
//             so a file is checked to its end before anything is written.
//   send      after the person confirms, the same batches built again from
//             the file, each sent only if its SHA-256 is the plan's: a file
//             changed since is never half sent.
//
// The large parts are read again in each pass rather than held: their
// batches are built in the file's own order, between the parts written
// first (categories, accounts) and those written after (what was said
// about the rows, history).

import { readJsonBytes, JsonReadError, type JsonEvent, type JsonPath } from './stream';
import { CORE, HEADER, checkFormat, problemShape, seamEntry, type Check } from './shapes';
import { CORE_PARTS, HEADER_PARTS, NEVER_CORE, SEAM, isKnownPart } from './parts';
import { acrossParts, accountsOf, Batcher, endedInFile, historySpan, turningIn, restoreProblems, restoredRowOf, smallParts, type BookEntry, type Collected, type Fact, type Without } from './plan';
import { BATCH_BYTES, BOOK_ROWS, investmentCoverageId, investmentPartId, MAX_BATCHES, restoredBookId } from './ids';
import { isRecord } from './records';

/** The file, as the page reads it: its size, whether it was protected (its
 *  opened text is read here), and its bytes a slice at a time. */
export type FileSource = { size: number; protected: boolean; bytes: () => AsyncIterable<Uint8Array> };

/** How many bytes of a file are read at a time. */
const SLICE = 4 * 1024 * 1024;

/** A Blob (a File, or a protected file's opened text) as a FileSource. */
export function blobSource(blob: Blob, isProtected: boolean): FileSource {
  return {
    size: blob.size,
    protected: isProtected,
    async *bytes() {
      for (let at = 0; at < blob.size; at += SLICE) yield new Uint8Array(await blob.slice(at, at + SLICE).arrayBuffer());
    },
  };
}

/** A file refused: what is wrong, in words for the person. */
export class FileRefused extends Error {
  constructor(readonly problem: string) {
    super(problem);
    this.name = 'FileRefused';
  }
}
const refuse = (problem: string): never => {
  throw new FileRefused(problem);
};

const EACH: ReadonlySet<string> = new Set(CORE_PARTS.filter((p) => CORE[p].each));
const WHOLE: ReadonlySet<string> = new Set(CORE_PARTS.filter((p) => CORE[p].whole));
/** The core parts read again to send, never held. */
const STREAMED_CORE: ReadonlySet<string> = new Set(['transactions', 'investment_transactions']);
/** The stores whose damaged entries are named by a transaction's id. */
const NAMED_BY_TXN: ReadonlySet<string> = new Set(['transaction-annotations', 'transaction-splits', 'transaction-approvals', 'expense-shares', 'expense-payments', 'expense-dismissed']);

/** Whether the value at `path` is built whole (see the header of stream.ts). */
function buildOf(path: JsonPath): boolean {
  const [part, , field, item] = path;
  if (path.length === 0) return false;
  if (typeof part !== 'string') return true;
  if (path.length === 1) {
    if ((HEADER_PARTS as readonly string[]).includes(part) || WHOLE.has(part)) return true;
    if (EACH.has(part)) return false;
    const seam = SEAM[part];
    if (!seam) return false; // refused when it is seen
    return seam.kind === 'value';
  }
  const seam = SEAM[part];
  if (path.length === 2) return !(seam?.split);
  if (path.length === 3) return field !== 'value';
  if (path.length === 4) return item !== seam?.split?.field;
  return true;
}

const at = (path: JsonPath): string => path.map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? s : `.${s}`)).join('');

/** Reads the file once (see the header): Collected, or FileRefused. */
export async function collect(source: FileSource): Promise<Collected> {
  const c: Collected = {
    version: 2,
    exported_at: '',
    notes: [],
    problems: [],
    parts: [],
    core: {},
    bank: { posted: new Set(), replaced: new Set(), pending: new Set(), accounts: new Map() },
    investments: new Map(),
    values: new Map(),
    entries: new Map(),
    books: new Map(),
    facts: new Map(),
    never: { api_tokens: 0, sharing: 0, attachments: 0 },
  };
  const header: Record<string, unknown> = {};
  let wanted = new Set<string>();
  const ids = new Map<string, Set<string>>();
  const unique = (part: string, id: string, where: string) => {
    const seen = ids.get(part) ?? new Set<string>();
    if (seen.has(id)) refuse(`${where}: the id ${'is'} there twice`);
    seen.add(id);
    ids.set(part, seen);
  };
  let book: { part: string; id: string | null; head: Record<string, unknown>; size: number; keys: Set<string> } | null = null;
  const check = (c_: Check, v: unknown, where: string) => {
    const problem = c_(v, where);
    if (problem) refuse(`This file can’t be brought back: ${problem}.`);
  };

  const onEvent = (e: JsonEvent) => {
    const [part] = e.path;
    if (e.path.length === 1 && typeof part === 'string' && e.kind !== 'end') {
      if (!isKnownPart(part)) refuse(`This file has a part this version of Nya doesn’t know (${part.slice(0, 60)}): it was made by a newer version. Bring it back there, or once this copy is updated.`);
      if (!c.parts.includes(part)) c.parts.push(part);
    }
    if (typeof part !== 'string') return;
    if (e.kind === 'value' && e.path.length === 1) {
      if ((HEADER_PARTS as readonly string[]).includes(part)) {
        header[part] = e.value;
        if (part === 'version' || part === 'format') {
          if (header.format !== undefined && header.version !== undefined) {
            const f = checkFormat(header.format, header.version);
            if (!f.ok) refuse(f.problem);
          }
        }
        if (part === 'problems' && Array.isArray(e.value)) {
          for (const p of e.value) if (isRecord(p) && NAMED_BY_TXN.has(String(p.section)) && Array.isArray(p.ids)) for (const id of p.ids) if (typeof id === 'string') wanted.add(id);
        }
        return;
      }
      if (WHOLE.has(part)) {
        check(CORE[part as keyof typeof CORE].whole!, e.value, part);
        c.core[part] = e.value;
        if (part === 'api_tokens') c.never.api_tokens = (e.value as unknown[]).length;
        if (part === 'attachments') c.never.attachments = (e.value as unknown[]).length;
        if (part === 'sharing' && isRecord(e.value) && Array.isArray(e.value.connections)) c.never.sharing = e.value.connections.length;
        return;
      }
      if (EACH.has(part)) refuse(`This file can’t be brought back: ${part}: must be a list.`);
      const seam = SEAM[part];
      if (seam?.kind === 'value') {
        c.values.set(part, e.value);
        return;
      }
      if (seam) refuse(`This file can’t be brought back: ${part}: must be a list.`);
      return;
    }
    if (e.kind === 'start' && e.path.length === 1 && e.container !== 'array') refuse(`This file can’t be brought back: ${part}: must be a list.`);
    if (e.path.length === 2 && e.kind === 'value') {
      const where = at(e.path);
      if (EACH.has(part)) {
        check(CORE[part as keyof typeof CORE].each!, e.value, where);
        const r = e.value as Record<string, unknown>;
        if (part === 'transactions') {
          const id = r.transaction_id as string;
          unique(part, id, where);
          if (wanted.has(id)) {
            const currency = (r.iso_currency_code as string | null) ?? (r.unofficial_currency_code as string | null) ?? null;
            c.facts.set(id, { date: r.date as string, amount: r.amount as number, currency, name: ((r.merchant_name as string | null) || (r.name as string)) ?? '', account: r.account_id as string });
          }
          if (r.pending === true) {
            c.bank.pending.add(id);
            return;
          }
          c.bank.posted.add(id);
          if (typeof r.pending_transaction_id === 'string') c.bank.replaced.add(r.pending_transaction_id);
          const span = c.bank.accounts.get(r.account_id as string);
          const date = r.date as string;
          c.bank.accounts.set(r.account_id as string, span ? { count: span.count + 1, first: date < span.first ? date : span.first, last: date > span.last ? date : span.last } : { count: 1, first: date, last: date });
          return;
        }
        if (part === 'investment_transactions') {
          unique(part, r.investment_transaction_id as string, where);
          c.investments.set(r.item_id as string, (c.investments.get(r.item_id as string) ?? 0) + 1);
          return;
        }
        const list = (c.core[part] as unknown[] | undefined) ?? [];
        list.push(e.value);
        c.core[part] = list;
        return;
      }
      const seam = SEAM[part];
      if (seam?.kind === 'map' && !seam.split) {
        check(seamEntry, e.value, where);
        const entry = e.value as { id: string; value: unknown };
        unique(part, entry.id, where);
        const list = c.entries.get(part) ?? [];
        list.push(entry);
        c.entries.set(part, list);
      }
      return;
    }
    // A large entry of a store on the seam, a field at a time.
    const seam = SEAM[part];
    if (!seam?.split) return;
    if (e.path.length === 2 && e.kind === 'start') {
      if (e.container !== 'object') refuse(`This file can’t be brought back: ${at(e.path)}: must be an object.`);
      book = { part, id: null, head: {}, size: 0, keys: new Set() };
      return;
    }
    if (!book) return;
    if (e.path.length === 2 && e.kind === 'end') {
      if (book.id === null) refuse(`This file can’t be brought back: ${at(e.path)}.id: is missing.`);
      const list = c.books.get(part) ?? [];
      list.push({ id: book.id!, head: book.head, size: book.size } satisfies BookEntry);
      c.books.set(part, list);
      book = null;
      return;
    }
    if (e.path.length === 3) {
      const field = e.path[2];
      if (field === 'id') {
        const id = e.kind === 'value' ? e.value : null;
        if (typeof id !== 'string') return refuse(`This file can’t be brought back: ${at(e.path)}: must be an id.`);
        unique(part, id, at(e.path));
        book.id = id;
      } else if (field !== 'value') refuse(`This file can’t be brought back: ${at(e.path)}: is a field this version of Nya doesn’t know.`);
      else if (e.kind === 'start' && e.container !== 'object') refuse(`This file can’t be brought back: ${at(e.path)}: must be an object.`);
      return;
    }
    if (e.path.length === 4) {
      const field = e.path[3] as string;
      if (field === seam.split.field) {
        if (e.kind === 'start' && e.container !== (seam.split.as === 'list' ? 'array' : 'object')) refuse(`This file can’t be brought back: ${at(e.path)}: must be a ${seam.split.as === 'list' ? 'list' : 'map'}.`);
        if (e.kind === 'value') refuse(`This file can’t be brought back: ${at(e.path)}: must be a ${seam.split.as === 'list' ? 'list' : 'map'}.`);
        return;
      }
      if (e.kind === 'value') book.head[field] = e.value;
      return;
    }
    if (e.path.length === 5 && e.kind === 'value') {
      book.size++;
      const v = e.value;
      if (isRecord(v) && typeof v.id === 'string' && wanted.has(v.id)) {
        c.facts.set(v.id, { date: String(v.date ?? ''), amount: Number(v.amount ?? 0), currency: typeof v.currency === 'string' ? v.currency : null, name: String(v.name ?? ''), account: typeof v.account_id === 'string' ? v.account_id : null });
      }
    }
  };

  try {
    await readJsonBytes(source.bytes(), { build: buildOf }, (events) => {
      for (const e of events) onEvent(e);
    });
  } catch (err) {
    if (err instanceof JsonReadError) refuse(err.message);
    throw err;
  }

  const f = checkFormat(header.format, header.version);
  if (!f.ok) refuse(f.problem);
  c.version = (f as { version: 1 | 2 }).version;
  for (const p of HEADER_PARTS) {
    if (!(p in header)) {
      // A version 1 file was whole or not made: nothing said missing.
      if (c.version === 1 && (p === 'problems' || p === 'notes')) continue;
      refuse(`This file can’t be brought back: ${p}: is missing.`);
    }
    if (p in header) check(HEADER[p], header[p], p);
  }
  c.exported_at = header.exported_at as string;
  c.notes = (header.notes as string[] | undefined) ?? [];
  c.problems = ((header.problems as unknown[] | undefined) ?? []).map((p) => {
    check(problemShape, p, 'problems[]');
    return p as Collected['problems'][number];
  });
  const across = acrossParts(c);
  if (across) refuse(`This file can’t be brought back: ${across}.`);
  wanted = new Set();
  return c;
}

// ---- The plan and its batches ----

/** One batch of the plan: its part, how many records, its SHA-256, and
 *  whether the server's checks read it before the restore starts (the parts
 *  kept on the seam, which the page can't check itself). */
export type PlannedBatch = { part: string; count: number; digest: string };

/** What the page shows before anything is written, and what the start sends. */
export type Preview = {
  collected: Collected;
  refuse: string | null;
  without: Without[];
  brought: Record<string, number>;
  left_out: Record<string, number>;
  history: { first: string; last: string } | null;
  earlier: { exported_at: string; restored_at: string }[];
  /** The accounts the file says ended that count here as they did there,
   *  up to their end (plan.ts endedInFile), each named as the card names it. */
  counted: { institution_name: string; name: string | null; mask: string | null; day: string }[];
  /** The accounts the file says were being turned over to match their kind
   *  (plan.ts turningIn), which the finish repairs where it can. */
  turning: { account_id: string; name: string }[];
};

/** What the file would bring back (see Preview). */
export function previewOf(c: Collected): Preview {
  const { refuse, without } = restoreProblems(c);
  const accounts = accountsOf(c);
  const small = smallParts(c, accounts);
  const brought: Record<string, number> = {};
  for (const p of [...small.before, ...small.after]) brought[p.part] = (brought[p.part] ?? 0) + p.records.length;
  const rows = [...c.bank.accounts.values()].reduce((n, a) => n + a.count, 0);
  if (rows > 0) brought['restored-rows'] = rows;
  const invested = [...c.investments.values()].reduce((n, x) => n + x, 0);
  if (invested > 0) brought['investment_transactions'] = invested;
  for (const [name, entries] of c.books) brought[`store:${name}`] = entries.length;
  const prior = c.values.get('user-restore');
  const earlier: Preview['earlier'] = [];
  if (isRecord(prior) && isRecord(prior.source) && typeof prior.source.exported_at === 'string' && typeof prior.started_at === 'string') {
    earlier.push(...(Array.isArray(prior.earlier) ? (prior.earlier as Preview['earlier']) : []), { exported_at: prior.source.exported_at, restored_at: prior.started_at });
  }
  const counted = endedInFile(c, accounts.restored).map(({ account: a, day }) => ({ institution_name: a.institution_name, name: a.name, mask: a.mask, day }));
  return { collected: c, refuse, without, brought, left_out: small.left_out, history: historySpan(c), earlier: earlier.slice(-50), counted, turning: turningIn(c) };
}

/** A batch as it is built: its part, its body (exactly the bytes sent), and
 *  how many records. */
export type BuiltBatch = { part: string; body: string; count: number };

/** Builds every batch, in the plan's order, reading the large parts from the
 *  file again (see the header). `emit` is awaited for each before the next is
 *  built, so a send applies back pressure. */
export async function buildBatches(source: FileSource, c: Collected, emit: (b: BuiltBatch) => Promise<void>): Promise<void> {
  const accounts = accountsOf(c);
  const small = smallParts(c, accounts);
  let n = 0;
  const batcher = new Batcher(async (part, body, count) => {
    if (++n > MAX_BATCHES) refuse(`This file would take more than ${MAX_BATCHES} batches to send.`);
    await emit({ part, body, count });
  });
  for (const p of small.before) for (const r of p.records) await batcher.add(p.part, r);
  await batcher.flush();

  // The large parts, read from the file again, in its order.
  const bookOf = new Map<string, number>();
  let restored: { records: Map<string, { id: string; from: number; rows: unknown[] }>; bytes: number } = { records: new Map(), bytes: 0 };
  const flushRows = async () => {
    if (restored.records.size === 0) return;
    for (const r of restored.records.values()) await batcher.add('restored-rows', r);
    await batcher.flush();
    restored = { records: new Map(), bytes: 0 };
  };
  const investPart = new Map<string, number>();
  let investing: { records: Map<string, { id: string; from: number; value: { version: 1; kind: 'rows'; item_id: string; part: number; rows: unknown[] } }>; bytes: number } = { records: new Map(), bytes: 0 };
  const flushInvest = async () => {
    if (investing.records.size === 0) return;
    for (const r of investing.records.values()) await batcher.add('store:restored-investment-transactions', r);
    await batcher.flush();
    investing = { records: new Map(), bytes: 0 };
  };
  const budget = BATCH_BYTES - 64 * 1024;
  const books = new Map([...c.books].map(([name, entries]) => [name, entries] as const));
  let piece: { part: string; entry: BookEntry; from: number; items: unknown[] | Record<string, unknown>; bytes: number } | null = null;
  let index = new Map<string, number>();
  const flushPiece = async () => {
    if (!piece) return;
    const split = SEAM[piece.part].split!;
    const value = { ...piece.entry.head, [split.field]: piece.items };
    await batcher.add(`store:${piece.part}`, split.as === 'list' ? { id: piece.entry.id, from: piece.from, value } : { id: piece.entry.id, value });
    piece = null;
  };
  let last: string | null = null;
  const onEvent = async (e: JsonEvent) => {
    const [part] = e.path;
    if (typeof part !== 'string') return;
    if (part !== last) {
      if (last === 'transactions') await flushRows();
      if (last === 'investment_transactions') {
        await flushInvest();
        // Which days each account's were checked complete for.
        const coverage = new Map<string, { account_id: string; from: string; through: string }[]>();
        for (const cv of (c.core.investment_history_coverage as { item_id: string; account_id: string; from: string; through: string }[] | undefined) ?? []) {
          coverage.set(cv.item_id, [...(coverage.get(cv.item_id) ?? []), { account_id: cv.account_id, from: cv.from, through: cv.through }]);
        }
        for (const [item_id, list] of [...coverage].sort(([a], [b]) => (a < b ? -1 : 1))) {
          await batcher.add('store:restored-investment-transactions', { id: investmentCoverageId(item_id), value: { version: 1, kind: 'coverage', item_id, coverage: list } });
        }
        await batcher.flush();
      }
      if (last !== null && SEAM[last]?.split) {
        await flushPiece();
        await batcher.flush();
      }
      last = part;
    }
    if (part === 'transactions' && e.path.length === 2 && e.kind === 'value') {
      const t = e.value as Record<string, unknown>;
      if (t.pending === true) return;
      const account = t.account_id as string;
      const k = bookOf.get(account) ?? 0;
      bookOf.set(account, k + 1);
      const id = restoredBookId(account, Math.floor(k / BOOK_ROWS) + 1);
      const row = restoredRowOf(t);
      const size = JSON.stringify(row).length + 1;
      if (restored.bytes + size > budget) await flushRows();
      const rec = restored.records.get(id) ?? { id, from: k % BOOK_ROWS, rows: [] };
      rec.rows.push(row);
      restored.records.set(id, rec);
      restored.bytes += size;
      return;
    }
    if (part === 'investment_transactions' && e.path.length === 2 && e.kind === 'value') {
      const r = e.value as Record<string, unknown>;
      const item = r.item_id as string;
      const k = investPart.get(item) ?? 0;
      investPart.set(item, k + 1);
      const p = Math.floor(k / BOOK_ROWS) + 1;
      const id = investmentPartId(item, p);
      const size = JSON.stringify(r).length + 1;
      if (investing.bytes + size > budget) await flushInvest();
      const rec = investing.records.get(id) ?? { id, from: k % BOOK_ROWS, value: { version: 1, kind: 'rows', item_id: item, part: p, rows: [] } };
      rec.value.rows.push(r);
      investing.records.set(id, rec);
      investing.bytes += size;
      return;
    }
    const seam = SEAM[part];
    if (!seam?.split || e.path.length !== 5 || e.kind !== 'value') return;
    const i = e.path[1] as number;
    const entry = books.get(part)![i];
    const key = e.path[4];
    const size = JSON.stringify(e.value).length + (typeof key === 'string' ? key.length + 4 : 1);
    if (piece && (piece.entry !== entry || piece.bytes + size > budget)) await flushPiece();
    if (!piece) {
      const from = index.get(`${part}\u0000${i}`) ?? 0;
      piece = { part, entry, from, items: seam.split.as === 'list' ? [] : {}, bytes: JSON.stringify(entry.head).length };
    }
    if (Array.isArray(piece.items)) piece.items.push(e.value);
    else piece.items[key as string] = e.value;
    piece.bytes += size;
    index.set(`${part}\u0000${i}`, (index.get(`${part}\u0000${i}`) ?? 0) + 1);
  };
  await readJsonBytes(source.bytes(), { build: buildOf }, async (events) => {
    for (const e of events) await onEvent(e);
  });
  await onEvent({ kind: 'end', path: ['\u0000end'], container: 'object' });
  index = new Map();

  for (const p of small.after) for (const r of p.records) await batcher.add(p.part, r);
  await batcher.flush();
}

/** A batch's SHA-256, in hex (Web Crypto, in the page and on the server). */
export async function digestOf(body: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The plan's own digest: of every batch's, in order, which a resume is
 *  checked against. */
export async function planDigest(batches: readonly PlannedBatch[]): Promise<string> {
  return digestOf(batches.map((b) => `${b.part} ${b.count} ${b.digest}`).join('\n'));
}

/** Whether a batch is read by the server's checks before the restore
 *  starts: its records are the file's own parts kept on the seam, which the
 *  page can't check itself (the large ones too). */
export const checkedFirst = (part: string): boolean => part.startsWith('store:') && part !== 'store:restored-investment-transactions';

export { NEVER_CORE, type Fact };
