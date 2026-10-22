// lib/user-restore/check.ts
//
// The server's check of one batch of a restore (docs/data-export.md,
// "Bringing it back"), before it is written or, asked by the page before the
// restore starts, instead of being written: every record checked as it will
// be stored, by the store's own check (MapStore.check, ValueStore.check:
// after a JSON round trip, as its reads would take it) or, for the stores kept
// the older way, by the shape its module reads, and closed. Nothing here
// trusts the page: a batch holds only records the server can check alone (the
// file's own records, the bank's rows re-keyed by restoredId), and nothing is
// read but what a record names.
//
// CLOSED BY THE STORE'S OWN CHECK. Some stores keep fields a later release
// adds (lib/history-import/store.ts isImportedTxn, lib/txn-annotations.ts),
// so a rollback reads that release's values. A file is the other way round:
// this release can't know what such a field changes, so it refuses it. A
// field is known when the store's own check looks at it: replaced by a value
// of another kind (text, then an object), the check refuses the record
// (unknownField). Where the store keeps the outside world's own record (an
// import's raw records and how they were read), anything is taken, as stored
// (SPECS `open`); where an object's keys are ids or days, one entry is looked
// at for all (`maps`). Each kind of object is looked at once a batch, and each
// on the smallest value that holds it (a book of its one row), so a batch of
// thousands of rows costs a handful of checks.

import { declaredStore } from '../stores';
import type { MapStore, ValueStore } from '../repo';
import { isManualId, MANUAL_TYPES, MAX_BALANCE } from '../manual';
import { isBudgetSet, isLegacyBudgets, sameLegacy } from '../budget-set';
import { isVendorKey } from '../vendor-defaults';
import { MAX_GOALS } from '../goal-model';
import { isCalendarDay, isCount, isInstant, isRecord, ID, onlyKeys } from './records';
import { isPlaidId, isRestoredId, isUserRestoreId, PART, restoredBookId, BOOK_ROWS, MAX_BOOKS } from './ids';
import { SEAM } from './parts';
import { literal, nullable, number, object, text, textOrNull, type Check } from './shapes';

/** A batch refused, with what is wrong, for the page: never a value. */
export class BatchRefused extends Error {
  readonly status = 400;
  constructor(readonly problem: string) {
    super(problem);
    this.name = 'BatchRefused';
  }
}

/** What a batch is checked against: the download's day (no measurement can
 *  be after it), and today. */
export type CheckEnv = { exported: string; today: string };

/** The writers a plan's batches name (lib/user-restore/plan.ts). */
export const LEGACY_PARTS = [
  'manual-accounts',
  'directory',
  'restored-accounts',
  'restored-rows',
  'hidden',
  'overrides',
  'renames',
  'carried-categories',
  'links',
  'declined',
  'budgets',
  'goals',
] as const;

/** The history layers a batch can write a day of (lib/history.ts), and
 *  whether a day there is a measurement (never after the download). */
export const HISTORY_LAYERS: Readonly<Record<string, { map: boolean; measured: boolean }>> = {
  'net-worth': { map: false, measured: true },
  'net-worth:est': { map: false, measured: false },
  accounts: { map: true, measured: true },
  'accounts:partial': { map: true, measured: true },
  'accounts:est': { map: true, measured: false },
  'accounts:est:ext': { map: true, measured: false },
  'accounts:est:flatd': { map: true, measured: false },
};
/** The flat balances of estimated totals from before they were kept by day
 *  (lib/history.ts ACCOUNTS_EST_FLAT_LEGACY): one value, written whole. */
export const FLAT_BEFORE = 'history:accounts:est:flat';

/** The store a "store:<name>" part writes, if it is one a restore writes. */
export function storeOfPart(part: string): { name: string; store: MapStore<unknown> | ValueStore<unknown> } | null {
  if (!part.startsWith('store:')) return null;
  const name = part.slice('store:'.length);
  if (SEAM[name]?.restore !== 'write') return null;
  const store = declaredStore(name);
  if (!store || (store.kind !== 'value' && store.kind !== 'map')) return null;
  return { name, store: store as MapStore<unknown> | ValueStore<unknown> };
}

/** Whether a part is one a plan can name. */
export function isPartName(part: unknown): part is string {
  if (typeof part !== 'string' || !PART.test(part)) return false;
  if (part.startsWith('store:')) return storeOfPart(part) !== null;
  if (part.startsWith('history:')) return part === FLAT_BEFORE || Object.hasOwn(HISTORY_LAYERS, part.slice('history:'.length));
  return (LEGACY_PARTS as readonly string[]).includes(part);
}

// ---- Closed by the store's own check ----

/** What a store's check reads of a value: where anything is taken, and
 *  which objects are keyed by ids or days. Paths name fields with ".", a
 *  list's items "[]", a map's entries "{}". */
type Spec = { open?: readonly string[]; maps?: readonly string[]; extra?: (value: unknown) => string | null };

const statement = nullable(
  object({
    kind: literal('bank', 'creditcard'),
    label: text(500),
    bank_id: textOrNull(200),
    mask: textOrNull(40),
    type: textOrNull(40),
    currency: textOrNull(20),
    start: textOrNull(40),
    end: textOrNull(40),
    ledger: nullable(object({ amount: number, as_of: textOrNull(40) })),
  })
);

const SPECS: Readonly<Record<string, Spec>> = {
  imports: { open: ['records[].raw', 'read'] },
  // Its statement is only checked to be an object by the store: closed here.
  'history-imports': { open: ['records[].raw', 'read', 'statement'], extra: (v) => (isRecord(v) ? statement(v.statement, 'statement') : null) },
  'holdings:history': { maps: ['days', 'days.{}'] },
  'imported-twins': { maps: ['twins'] },
  'carried-imported-twins': { maps: ['twins'] },
  'carried-annotations': { maps: ['rows'] },
  'budget-months': { maps: ['categories', 'groups'] },
  categories: { maps: ['merged'] },
  'import-settings': { maps: ['csv.columns'] },
};

const POISONS: readonly unknown[] = ['\u0000nya-restore-probe', { '\u0000nya-restore-probe': true }];

type Step = string | number;
const patternOf = (path: readonly Step[], maps: ReadonlySet<string>): string => {
  let out = '';
  for (let i = 0; i < path.length; i++) {
    const s = path[i];
    if (typeof s === 'number') out += '[]';
    else if (maps.has(out)) out += out === '' ? '{}' : '.{}';
    else out += out === '' ? s : `.${s}`;
  }
  return out;
};

/** The value copied along `path`, the node at its end too, so a probe can
 *  change it; with `cut`, each list on the way holds only the item on it
 *  (and the path then names index 0), so the store's check reads the
 *  smallest value that holds the node. */
function along(root: unknown, path: readonly Step[], cut: boolean): { copy: unknown; node: Record<string, unknown>; path: Step[] } {
  const copyOf = (v: unknown): unknown => (Array.isArray(v) ? [...v] : isRecord(v) ? { ...v } : v);
  const top = copyOf(root);
  const out: Step[] = [];
  let at = top as Record<string, unknown> | unknown[];
  for (const s of path) {
    const child = copyOf((at as Record<string | number, unknown>)[s as never]);
    if (Array.isArray(at) && cut) {
      at.length = 0;
      at.push(child);
      out.push(0);
    } else {
      (at as Record<string | number, unknown>)[s as never] = child;
      out.push(s);
    }
    at = child as Record<string, unknown> | unknown[];
  }
  return { copy: top, node: at as Record<string, unknown>, path: out };
}

/**
 * The first field of `value` the store's check doesn't look at (see the
 * header), as a path, or null. `check` is the store's own (null when it
 * refuses). `seen` holds the kinds of object looked at already, across a
 * batch.
 */
export function unknownField(check: (v: unknown) => unknown | null, value: unknown, spec: Spec, seen = new Set<string>()): string | null {
  const open = new Set(spec.open ?? []);
  const maps = new Set(spec.maps ?? []);
  const isOpen = (pattern: string) => [...open].some((o) => pattern === o || pattern.startsWith(`${o}.`) || pattern.startsWith(`${o}[]`));
  // Whether the store's check refuses the value with `key` of the node at
  // `path` changed to each poison: on the smallest value that holds it, or,
  // where that value alone doesn't pass (a list whose items name each other,
  // a holdings month's securities), on the whole value.
  const probe = (root: unknown, path: readonly Step[], key: string, small: boolean): boolean => {
    const base = along(root, path, small);
    if (small && check(base.copy) === null) return probe(root, path, key, false);
    for (const poison of POISONS) {
      const { copy, node } = along(base.copy, base.path, false);
      node[key] = poison;
      // Refused: the check looks at the field.
      if (check(copy) === null) return false;
    }
    return true;
  };
  let found: string | null = null;
  const walk = (v: unknown, path: Step[]) => {
    if (found) return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && !found; i++) walk(v[i], [...path, i]);
      return;
    }
    if (!isRecord(v)) return;
    const pattern = patternOf(path, maps);
    if (isOpen(pattern)) return;
    const keys = Object.keys(v).sort();
    const isMap = maps.has(pattern);
    const kind = `${pattern}|${isMap ? '{}' : keys.join(',')}`;
    if (!seen.has(kind)) {
      seen.add(kind);
      for (const k of isMap ? keys.slice(0, 1) : keys) {
        if (isOpen(isMap ? `${pattern}${pattern === '' ? '' : '.'}{}` : pattern === '' ? k : `${pattern}.${k}`)) continue;
        if (probe(value, path, k, true)) {
          found = `${pattern === '' ? '' : `${pattern}.`}${isMap ? '{}' : k}`;
          return;
        }
      }
    }
    for (const k of keys) walk(v[k], [...path, k]);
  };
  walk(value, []);
  return found;
}

// ---- Each part's records ----

const fail = (problem: string): never => {
  throw new BatchRefused(problem);
};

/** One record of a store on the seam, checked as it will be stored. */
function storeValue(name: string, store: MapStore<unknown> | ValueStore<unknown>, value: unknown, seen: Set<string>, at: string): void {
  if (store.check(value) === null) fail(`${at}: isn’t ${store.what} this version of Nya can read`);
  const spec = SPECS[name] ?? {};
  const unknown = unknownField((v) => store.check(v), value, spec, seen);
  if (unknown !== null) fail(`${at}.${unknown}: is a field this version of Nya doesn’t know`);
  const extra = spec.extra?.(value);
  if (extra) fail(`${at}.${extra}`);
}

/** An entry's id, as the store's entries are kept under: the seam's field
 *  names (lib/repo.ts IDS ARE PLAINTEXT). */
const entryId = (v: unknown, at: string): string => (typeof v === 'string' && ID.test(v) && v !== '__proto__' ? v : fail(`${at}.id: must be an id`));

/** A store's entry ids, where the entry says what it must be kept under. */
function idMatches(name: string, id: string, value: unknown, at: string): void {
  const v = isRecord(value) ? value : {};
  const rowsOf = (x: unknown) => (Array.isArray(x) ? x : []);
  if (name === 'restored-transactions' && id !== restoredBookId(String(v.account_id), Number(v.part))) fail(`${at}.id: isn’t its book’s`);
  if ((name === 'imported-transactions' || name === 'manual-transactions') && rowsOf(v.rows).some((r) => !isRecord(r) || r.account_id !== id)) fail(`${at}.id: isn’t its rows’ account`);
  if (name === 'restored-investment-transactions' && !id.startsWith(`${String(v.item_id)}.`)) fail(`${at}.id: isn’t its connection’s`);
}

/** A piece of a large entry (parts.ts SEAM `split`): where it starts in the
 *  entry's list, for a list. */
function pieceFrom(name: string, r: Record<string, unknown>, at: string): number | null {
  const split = SEAM[name]?.split;
  if (!split || split.as !== 'list') {
    if ('from' in r) fail(`${at}.from: isn’t taken by this part`);
    return null;
  }
  if (!('from' in r)) return 0;
  return isCount(r.from) ? r.from : fail(`${at}.from: must be a whole number`);
}

const instantOrEpoch = (v: unknown): boolean => isInstant(v);

const manualAccount = (v: unknown, id: string): boolean =>
  isRecord(v) &&
  onlyKeys(v, ['account_id', 'name', 'institution_name', 'type', 'subtype', 'balance', 'updated_at', 'currency']) &&
  v.account_id === id &&
  isManualId(id) &&
  typeof v.name === 'string' &&
  v.name.length <= 500 &&
  typeof v.institution_name === 'string' &&
  v.institution_name.length <= 500 &&
  (MANUAL_TYPES as readonly unknown[]).includes(v.type) &&
  (v.subtype === null || (typeof v.subtype === 'string' && v.subtype.length <= 100)) &&
  typeof v.balance === 'number' &&
  Number.isFinite(v.balance) &&
  Math.abs(v.balance) <= MAX_BALANCE &&
  instantOrEpoch(v.updated_at) &&
  (v.currency === undefined || (typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) && v.currency !== 'USD'));

const directoryEntry = (v: unknown): boolean =>
  isRecord(v) &&
  onlyKeys(v, ['provider', 'item_id', 'institution_id', 'institution_name', 'name', 'official_name', 'mask', 'type', 'subtype', 'persistent_account_id', 'first_seen', 'last_seen']) &&
  (v.provider === undefined || (typeof v.provider === 'string' && v.provider.length <= 40)) &&
  isPlaidId(v.item_id) &&
  (v.institution_id === null || (typeof v.institution_id === 'string' && v.institution_id.length <= 200)) &&
  typeof v.institution_name === 'string' &&
  v.institution_name.length <= 500 &&
  ['name', 'official_name', 'mask', 'type', 'subtype', 'persistent_account_id'].every((k) => v[k] === null || (typeof v[k] === 'string' && (v[k] as string).length <= 500)) &&
  isCalendarDay(v.first_seen) &&
  isCalendarDay(v.last_seen) &&
  v.first_seen <= v.last_seen;

const textValue = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;

/** A history day's value: a total, or a map of balances by account id. */
function historyValue(layer: { map: boolean }, v: unknown): boolean {
  if (!layer.map) return typeof v === 'number' && Number.isFinite(v);
  if (!isRecord(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= 100_000 && entries.every(([id, n]) => ID.test(id) && id !== '__proto__' && typeof n === 'number' && Number.isFinite(n));
}

/** The records of a legacy writer's part, each checked (see LEGACY_PARTS). */
function legacyRecord(part: string, r: Record<string, unknown>, env: CheckEnv, at: string): void {
  const valueAt = `${at}.value`;
  switch (part) {
    case 'manual-accounts': {
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      const id = entryId(r.id, at);
      if (!manualAccount(r.value, id)) fail(`${valueAt}: isn’t a manual account this version of Nya can read`);
      return;
    }
    case 'directory': {
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      if (!isPlaidId(r.id)) fail(`${at}.id: must be an account id`);
      if (!directoryEntry(r.value)) fail(`${valueAt}: isn’t an account this version of Nya can read`);
      return;
    }
    case 'restored-accounts': {
      // The entry without the restore's own id and time, which the server
      // gives it from the record (lib/user-restore/commit.ts).
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      if (!isPlaidId(r.id)) fail(`${at}.id: must be an account id`);
      return;
    }
    case 'restored-rows': {
      if (!onlyKeys(r, ['id', 'from', 'rows'])) fail(`${at}: has a field this part doesn’t take`);
      const id = entryId(r.id, at);
      const dot = id.lastIndexOf('.');
      const part_ = Number(id.slice(dot + 1));
      if (dot <= 0 || !isPlaidId(id.slice(0, dot)) || !Number.isSafeInteger(part_) || part_ < 1 || part_ > MAX_BOOKS || restoredBookId(id.slice(0, dot), part_) !== id) fail(`${at}.id: isn’t a book’s`);
      if (!isCount(r.from) || r.from >= BOOK_ROWS) fail(`${at}.from: must be a whole number under ${BOOK_ROWS}`);
      if (!Array.isArray(r.rows) || r.rows.length === 0 || (r.from as number) + r.rows.length > BOOK_ROWS) fail(`${at}.rows: must be a list that fits its book`);
      for (const [i, row] of (r.rows as unknown[]).entries()) {
        if (!isRecord(row) || !onlyKeys(row, ['id', 'account_id', 'bank']) || !isRestoredId(row.id) || row.account_id !== id.slice(0, dot)) fail(`${at}.rows[${i}]: isn’t a restored row of its book`);
      }
      return;
    }
    case 'hidden': {
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      entryId(r.id, at);
      const v = r.value;
      if (!isRecord(v) || !onlyKeys(v, ['type', 'hidden_at']) || !textValue(v.type, 40) || !isInstant(v.hidden_at)) fail(`${valueAt}: isn’t a hidden account this version of Nya can read`);
      return;
    }
    case 'overrides': {
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      entryId(r.id, at);
      if (!textValue(r.value, 500)) fail(`${valueAt}: must be a category`);
      return;
    }
    case 'renames': {
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      if (!isVendorKey(r.id)) fail(`${at}.id: must be a merchant’s key`);
      if (!textValue(r.value, 500)) fail(`${valueAt}: must be a name`);
      return;
    }
    case 'carried-categories': {
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      const id = entryId(r.id, at);
      const v = r.value;
      if (!isRecord(v) || !Object.entries(v).every(([k, c]) => k.startsWith(`${id}|`) && k.length <= 3_000 && (c === null || textValue(c, 500)))) fail(`${valueAt}: isn’t categories carried for that account`);
      return;
    }
    case 'links': {
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      if (!isPlaidId(r.id)) fail(`${at}.id: must be an account id`);
      const v = r.value;
      if (!isRecord(v) || !onlyKeys(v, ['to', 'linked_at', 'evidence']) || !isPlaidId(v.to) || v.to === r.id || !isInstant(v.linked_at) || !isRecord(v.evidence) || JSON.stringify(v.evidence).length > 10_000) {
        fail(`${valueAt}: isn’t a link this version of Nya can read`);
      }
      return;
    }
    case 'declined': {
      if (!onlyKeys(r, ['id', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      const key = typeof r.id === 'string' ? r.id : '';
      const [old, to, ...rest] = key.split('>');
      if (rest.length > 0 || !isPlaidId(old) || old.length > 100 || !(to === '*' || (isPlaidId(to) && to.length <= 100))) fail(`${at}.id: isn’t a declined offer’s`);
      if (!isInstant(r.value)) fail(`${valueAt}: must be a time`);
      return;
    }
    case 'budgets': {
      if (!onlyKeys(r, ['set', 'copy'])) fail(`${at}: has a field this part doesn’t take`);
      if (!isLegacyBudgets(r.copy) || Object.keys(r.copy as object).length > 1_000) fail(`${at}.copy: isn’t budgets by name`);
      if (r.set !== null && (!isBudgetSet(r.set) || !sameLegacy((r.set as { mirror: Record<string, number> }).mirror, r.copy as Record<string, number>))) {
        fail(`${at}.set: isn’t budgets this version of Nya can read, beside its copy by name`);
      }
      return;
    }
    case 'goals': {
      if (!onlyKeys(r, ['value'])) fail(`${at}: has a field this part doesn’t take`);
      const v = r.value;
      if (
        !Array.isArray(v) ||
        v.length > MAX_GOALS ||
        !v.every((g) => isRecord(g) && onlyKeys(g, ['id', 'name', 'target', 'account_id']) && textValue(g.id, 200) && textValue(g.name, 500) && typeof g.target === 'number' && Number.isFinite(g.target) && (g.account_id === null || isPlaidId(g.account_id)))
      ) {
        fail(`${valueAt}: isn’t goals this version of Nya can read`);
      }
      return;
    }
  }
  fail(`${at}: isn’t a part this version of Nya can write`);
}

/** A history day (see HISTORY_LAYERS), checked: a real day, numbers, and a
 *  measurement no later than the download, or today. */
function historyRecord(layerName: string, r: Record<string, unknown>, env: CheckEnv, at: string): void {
  if (layerName === 'accounts:est:flat') {
    if (!onlyKeys(r, ['value']) || !historyValue({ map: true }, r.value)) fail(`${at}: isn’t balances held flat`);
    return;
  }
  const layer = HISTORY_LAYERS[layerName];
  if (!onlyKeys(r, ['date', 'value'])) fail(`${at}: has a field this part doesn’t take`);
  if (!isCalendarDay(r.date)) fail(`${at}.date: must be a day (YYYY-MM-DD)`);
  if (layer.measured && ((r.date as string) > env.exported || (r.date as string) > env.today)) fail(`${at}.date: a recorded day after the download was made can’t be a measurement`);
  if (!historyValue(layer, r.value)) fail(`${at}.value: isn’t ${layer.map ? 'balances by account' : 'a total'}`);
}

/**
 * A batch's body (lib/user-restore/plan.ts: { part, records }), every record
 * checked (see the header). Throws BatchRefused naming the first problem.
 * Answers the part and its records.
 */
export function checkBatch(body: unknown, env: CheckEnv): { part: string; records: Record<string, unknown>[] } {
  if (!isRecord(body) || !onlyKeys(body, ['part', 'records']) || !Array.isArray(body.records)) fail('A batch must be { part, records }.');
  const { part, records } = body as { part: unknown; records: unknown[] };
  if (!isPartName(part)) fail('This batch names a part this version of Nya doesn’t write.');
  const name = part as string;
  if (records.length === 0) fail(`${name}: a batch has at least one record`);
  const seen = new Set<string>();
  const store = storeOfPart(name);
  for (const [i, r] of records.entries()) {
    const at = `${name}[${i}]`;
    if (!isRecord(r)) fail(`${at}: must be an object`);
    const rec = r as Record<string, unknown>;
    if (store) {
      if (store.store.kind === 'value') {
        if (records.length !== 1 || !onlyKeys(rec, ['value'])) fail(`${name}: a value is written whole, in one record`);
        storeValue(store.name, store.store, rec.value, seen, `${at}.value`);
        continue;
      }
      const from = pieceFrom(store.name, rec, at);
      if (!onlyKeys(rec, from === null ? ['id', 'value'] : ['id', 'from', 'value'])) fail(`${at}: has a field this part doesn’t take`);
      const id = entryId(rec.id, at);
      storeValue(store.name, store.store, rec.value, seen, `${at}.value`);
      idMatches(store.name, id, rec.value, at);
      if (store.name === 'user-restore' && !isUserRestoreId(id)) fail(`${at}.id: isn’t a restore’s`);
      continue;
    }
    if (name.startsWith('history:')) historyRecord(name.slice('history:'.length), rec, env, at);
    else legacyRecord(name, rec, env, at);
  }
  return { part: name, records: records as Record<string, unknown>[] };
}

export type { Check };
