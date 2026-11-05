// lib/fire/tax-facts.ts
//
// The tax facts: what the household and its accounts are, one set for every
// plan, in `plan-facts` version 2 (lib/fire/copies.ts). The Plan's other half,
// the tax choices, is per plan, in each entry.
//
// READS TAKE WHAT ANY RELEASE WROTE, as isPlanFacts does: isTaxFacts checks
// the shape and types, never a range. A range is the writer's. Its first reader
// (TF) knows every field and every enum value, a release before anything
// writes them, so a rollback from the first writer loses nothing.
//
// CLOSED, AND EVERY FIELD LOOKED AT, so a restore takes no field this release
// doesn't know (lib/user-restore/check.ts unknownField replaces each field
// with a text, then an object, and expects the check to refuse one).
//
// Pure, importing nothing: the next release holds it byte for byte as its
// release before's (test/release-before.test.ts).

/** Whose an account, a contribution or a birth year is. */
export type Owner = 'you' | 'partner';

export type TaxFacts = {
  version: 1;
  /** Flat is today's behaviour. One model for every plan, so Compare is like
   *  for like. */
  model: 'flat' | 'detailed';
  filing: 'single' | 'joint' | null;
  /** Only when it decides the age required distributions start. */
  birthYears: { owner: Owner; year: number }[];
  /** The tax household by year, by your age. */
  dependents: { id: string; untilAge: number }[];
  /** What each person has put into a Roth: reachable before 59½. */
  rothContributions: { owner: Owner; amount: number }[];
  /** Accounts that aren't yours. */
  owners: { account_id: string; owner: Owner }[];
  /** Typed, where holdings have none. */
  basis: { account_id: string; amount: number }[];
  /** Accounts for a child's education counted all the same. */
  countAnyway: string[];
  /** Coverage already in measured spending, left out of it in every plan. */
  paidToday: { kind: 'category' | 'tag'; name: string } | null;
};

/** The tax facts before anyone has given one. */
export const DEFAULT_TAX_FACTS: TaxFacts = {
  version: 1,
  model: 'flat',
  filing: null,
  birthYears: [],
  dependents: [],
  rothContributions: [],
  owners: [],
  basis: [],
  countAnyway: [],
  paidToday: null,
};

const KEYS = ['version', 'model', 'filing', 'birthYears', 'dependents', 'rothContributions', 'owners', 'basis', 'countAnyway', 'paidToday'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const closed = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

const isText = (v: unknown): v is string => typeof v === 'string';
const isNumber =(v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOwner = (v: unknown): v is Owner => v === 'you' || v === 'partner';

/** A list of closed records of these keys, each passing `ok`. */
const listOf = (v: unknown, keys: readonly string[], ok: (x: Record<string, unknown>) => boolean) => Array.isArray(v) && v.every((x) => isObject(x) && closed(x, keys) && ok(x));

/** Whether a value is the tax facts as stored: the shape and types. */
export function isTaxFacts(v: unknown): v is TaxFacts {
  if (!isObject(v) || !closed(v, KEYS) || v.version !== 1) return false;
  if (v.model !== 'flat' && v.model !== 'detailed') return false;
  if (v.filing !== null && v.filing !== 'single' && v.filing !== 'joint') return false;
  if (!listOf(v.birthYears, ['owner', 'year'], (x) => isOwner(x.owner) && isNumber(x.year))) return false;
  if (!listOf(v.dependents, ['id', 'untilAge'], (x) => isText(x.id) && isNumber(x.untilAge))) return false;
  if (!listOf(v.rothContributions, ['owner', 'amount'], (x) => isOwner(x.owner) && isNumber(x.amount))) return false;
  if (!listOf(v.owners, ['account_id', 'owner'], (x) => isText(x.account_id) && isOwner(x.owner))) return false;
  if (!listOf(v.basis, ['account_id', 'amount'], (x) => isText(x.account_id) && isNumber(x.amount))) return false;
  if (!Array.isArray(v.countAnyway) || !v.countAnyway.every(isText)) return false;
  if (v.paidToday === null) return true;
  return isObject(v.paidToday) && closed(v.paidToday, ['kind', 'name']) && (v.paidToday.kind === 'category' || v.paidToday.kind === 'tag') && isText(v.paidToday.name);
}
