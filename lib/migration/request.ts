// lib/migration/request.ts
//
// What a request to import another app's export says (app/api/migration),
// checked strictly before anything is read: every field's type, length,
// range and count, as the import routes check theirs (app/api/import,
// lib/history-import/request.ts). Pure.

import { knownCurrency } from '../manual-txn-input';
import { MANUAL_TYPES, MAX_BALANCE, type ManualType } from '../manual';
import { CATEGORY_KINDS, type CategoryKind } from '../categories';
import { APP_ROLES, APPS, type AppColumns, type AppId, type AppReadOptions } from '../import/apps/types';
import { MAX_CSV_COLUMNS } from '../import/record';
import { cleanFileName, MAX_CHOICES } from '../history-import/request';
import { CONFLICT_CHOICES, PROPOSAL_CHOICES, type Choices, type HistoryChoices } from '../history-import/plan';
import { isMigrationId } from './store';
import { MAX_SOURCE_ACCOUNTS, type AccountChoice, type MigrationAnswers } from './plan';
import type { CategoryChoice } from './categories';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
/** An account id as Plaid writes one, or a manual one (and as the seam takes
 *  a field name). */
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
/** A category's id as the store keeps one. */
const CATEGORY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The most of the app's categories one answer may name: as many as one
 *  import maps (lib/migration/plan.ts MAX_SOURCE_CATEGORIES). */
const MAX_CATEGORY_ANSWERS = 1_000;
/** A record keyed by what the file wrote: no key is inherited, so an account
 *  the file calls "constructor" or "__proto__" is only ever its own. */
const keyed = <T,>(): Record<string, T> => Object.create(null) as Record<string, T>;

export type MigrationMeta = {
  action: 'preview' | 'import';
  file_name: string | null;
  /** The import's id, minted by the review: required to import. */
  migration_id: string | null;
  options: AppReadOptions;
  answers: MigrationAnswers;
  /** The digest of the review the person saw: required to import. */
  review: string | null;
};

function readOptions(v: unknown): AppReadOptions | string {
  if (v === undefined || v === null) return {};
  if (!isRecord(v) || !only(v, ['app', 'columns', 'date_order', 'decimal', 'sign'])) return 'Invalid options';
  const out: AppReadOptions = {};
  if (v.app !== undefined) {
    if (!(APPS as readonly unknown[]).includes(v.app)) return 'Choose one of the apps listed';
    out.app = v.app as AppId;
  }
  if (v.columns !== undefined) {
    if (!isRecord(v.columns)) return 'Invalid columns';
    const columns: AppColumns = {};
    for (const [role, at] of Object.entries(v.columns)) {
      if (!(APP_ROLES as readonly string[]).includes(role) || typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at >= MAX_CSV_COLUMNS) return 'Invalid columns';
      columns[role as keyof AppColumns] = at;
    }
    if (out.app === undefined) return 'Say which app the file is from';
    out.columns = columns;
  }
  if (v.date_order !== undefined) {
    if (v.date_order !== 'mdy' && v.date_order !== 'dmy') return 'Invalid date order';
    out.date_order = v.date_order;
  }
  if (v.decimal !== undefined) {
    if (v.decimal !== '.' && v.decimal !== ',') return 'Invalid decimal mark';
    out.decimal = v.decimal;
  }
  if (v.sign !== undefined) {
    if (v.sign !== 'negative-out' && v.sign !== 'positive-out') return 'Say how money out is written';
    out.sign = v.sign;
  }
  return out;
}

/** Where one of the file's accounts goes, checked as the Add form checks a
 *  new manual account's fields (app/api/manual-accounts). */
function readAccount(v: unknown): AccountChoice | string {
  if (!isRecord(v)) return 'Invalid account';
  if (v.to === 'skip' && only(v, ['to'])) return { to: 'skip' };
  if ((v.to === 'manual' || v.to === 'linked') && only(v, ['to', 'id'])) {
    if (typeof v.id !== 'string' || !ACCOUNT_ID.test(v.id)) return 'Invalid account';
    if (v.to === 'manual' && !v.id.startsWith('manual_')) return 'Invalid account';
    return { to: v.to, id: v.id };
  }
  if (v.to === 'new' && only(v, ['to', 'name', 'institution', 'type', 'balance'])) {
    if (typeof v.name !== 'string' || v.name.length > 200 || typeof v.institution !== 'string' || v.institution.length > 200) return 'Give the new account a name and an institution';
    if (!(MANUAL_TYPES as readonly unknown[]).includes(v.type)) return 'Invalid account type';
    if (typeof v.balance !== 'number' || !Number.isFinite(v.balance) || Math.abs(v.balance) > MAX_BALANCE) return 'Give the new account its balance';
    return { to: 'new', name: v.name, institution: v.institution, type: v.type as ManualType, balance: v.balance };
  }
  return 'Invalid account';
}

function readCategory(v: unknown): CategoryChoice | string {
  if (!isRecord(v)) return 'Invalid category';
  if (v.to === 'existing' && only(v, ['to', 'id']) && typeof v.id === 'string' && CATEGORY_ID.test(v.id)) return { to: 'existing', id: v.id };
  if (v.to === 'new' && only(v, ['to', 'kind']) && (CATEGORY_KINDS as readonly unknown[]).includes(v.kind)) return { to: 'new', kind: v.kind as CategoryKind };
  return 'Invalid category';
}

/** Choices of one kind, as lib/history-import/request.ts reads them. */
function readChoiceSet<T extends string>(v: unknown, allowed: readonly T[]): Choices<T> | string {
  if (v === undefined || v === null) return {};
  if (!isRecord(v) || !only(v, ['all', 'each'])) return 'Invalid choices';
  const out: Choices<T> = {};
  if (v.all !== undefined) {
    if (!(allowed as readonly unknown[]).includes(v.all)) return 'Invalid choices';
    out.all = v.all as T;
  }
  if (v.each !== undefined) {
    if (!isRecord(v.each)) return 'Invalid choices';
    const entries = Object.entries(v.each);
    if (entries.length > MAX_CHOICES) return 'Too many choices';
    const each = keyed<T>();
    for (const [index, choice] of entries) {
      // Keyed by the line of the file a row starts on (lib/migration/plan.ts
      // MigrationAnswers).
      if (!/^\d{1,8}$/.test(index) || Number(index) < 1 || Number(index) > 10_000_000 || !(allowed as readonly unknown[]).includes(choice)) return 'Invalid choices';
      each[String(Number(index))] = choice as T;
    }
    out.each = each;
  }
  return out;
}

/** The request, checked strictly, or why not. */
export function readMigrationMeta(v: unknown): MigrationMeta | string {
  if (!isRecord(v) || !only(v, ['action', 'file_name', 'migration_id', 'options', 'accounts', 'categories', 'tags', 'carry', 'currency', 'choices', 'review'])) return 'Invalid request';
  if (v.action !== 'preview' && v.action !== 'import') return 'Invalid request';
  if (v.file_name !== undefined && v.file_name !== null && typeof v.file_name !== 'string') return 'Invalid request';
  const options = readOptions(v.options);
  if (typeof options === 'string') return options;

  const accounts = keyed<AccountChoice>();
  if (v.accounts !== undefined && v.accounts !== null) {
    if (!isRecord(v.accounts)) return 'Invalid accounts';
    const entries = Object.entries(v.accounts);
    if (entries.length > MAX_SOURCE_ACCOUNTS) return 'Too many accounts';
    for (const [key, choice] of entries) {
      if (key.length > 200) return 'Invalid accounts';
      const read = readAccount(choice);
      if (typeof read === 'string') return read;
      accounts[key] = read;
    }
  }
  const categories = keyed<CategoryChoice>();
  if (v.categories !== undefined && v.categories !== null) {
    if (!isRecord(v.categories)) return 'Invalid categories';
    const entries = Object.entries(v.categories);
    if (entries.length > MAX_CATEGORY_ANSWERS) return 'Too many categories';
    for (const [key, choice] of entries) {
      if (key.length > 300) return 'Invalid categories';
      const read = readCategory(choice);
      if (typeof read === 'string') return read;
      categories[key] = read;
    }
  }
  if (v.tags !== undefined && typeof v.tags !== 'boolean') return 'Invalid request';
  if (v.carry !== undefined && typeof v.carry !== 'boolean') return 'Invalid request';
  let currency: string | null = null;
  if (v.currency !== undefined && v.currency !== null) {
    const code = typeof v.currency === 'string' ? v.currency.trim().toUpperCase() : '';
    if (!knownCurrency(code)) return 'Enter a currency as its three-letter code, like USD or EUR';
    currency = code;
  }
  const choices = keyed<HistoryChoices>();
  if (v.choices !== undefined && v.choices !== null) {
    if (!isRecord(v.choices)) return 'Invalid choices';
    const entries = Object.entries(v.choices);
    if (entries.length > MAX_SOURCE_ACCOUNTS) return 'Too many choices';
    for (const [key, c] of entries) {
      if (!/^linked:[A-Za-z0-9_.:-]{1,100}$/.test(key) || !isRecord(c) || !only(c, ['proposals', 'conflicts'])) return 'Invalid choices';
      const proposals = readChoiceSet(c.proposals, PROPOSAL_CHOICES);
      if (typeof proposals === 'string') return proposals;
      const conflicts = readChoiceSet(c.conflicts, CONFLICT_CHOICES);
      if (typeof conflicts === 'string') return conflicts;
      choices[key] = { proposals, conflicts };
    }
  }
  let migration_id: string | null = null;
  if (v.migration_id !== undefined && v.migration_id !== null) {
    if (!isMigrationId(v.migration_id)) return 'Invalid request';
    migration_id = v.migration_id;
  }
  let review: string | null = null;
  if (v.review !== undefined && v.review !== null) {
    if (typeof v.review !== 'string' || !/^[0-9a-f]{32}$/.test(v.review)) return 'Invalid review';
    review = v.review;
  }
  if (v.action === 'import' && (review === null || migration_id === null)) return 'Review the file before importing it';
  return {
    action: v.action,
    file_name: cleanFileName(v.file_name),
    migration_id,
    options,
    answers: { accounts, categories, tags: v.tags !== false, carry: v.carry !== false, currency, choices },
    review,
  };
}
