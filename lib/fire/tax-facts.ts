// lib/fire/tax-facts.ts
//
// The tax facts: what the household and its accounts are, one set for every
// plan, in `plan-facts` version 2 (lib/fire/copies.ts). The Plan's other half,
// the tax choices, is per plan, in each entry.
//
// READS TAKE WHAT ANY RELEASE WROTE, as isPlanFacts does: isTaxFacts checks
// the shape and types, never a range. A range is the writer's (parseTaxFactOp,
// below). Its first reader (TF) knew every field and every enum value, a release
// before anything wrote them, so a rollback from the first writer loses nothing.
//
// CLOSED, AND EVERY FIELD LOOKED AT, so a restore takes no field this release
// doesn't know (lib/user-restore/check.ts unknownField replaces each field
// with a text, then an object, and expects the check to refuse one).
//
// Pure, importing nothing: the next release holds it byte for byte as its
// release before's (test/release-before.test.ts).
//
// A write is one small change, from the Plan's sheets (lib/plan-writes.ts
// saveTaxFacts). None writes `model`: only the opt-in does (T3). What is the
// same as saying nothing leaves its list (an owner of `you`, no basis, no
// amount), so the facts stay small and a row never means the default.

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
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
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

// ---- Writes ----

/** More accounts than anyone has, as invested history allows. */
export const MAX_FACT_ACCOUNTS = 500;
/** More than any account, or anyone's Roth, could hold. */
export const MAX_FACT_AMOUNT = 1_000_000_000_000;
/** The ids Plaid, manual accounts and connectors give, as invested history's. */
const ACCOUNT_ID = /^[A-Za-z0-9_:.=-]{1,128}$/;

/** One Save in a sheet: an account's owner, typed basis and Count it, or what
 *  one person has put into a Roth. */
export type TaxFactOp = { kind: 'account'; account_id: string; owner: Owner; basis: number | null; count: boolean } | { kind: 'roth'; owner: Owner; amount: number | null };

const isAmount = (v: unknown) => v === null || (isNumber(v) && v >= 0 && v <= MAX_FACT_AMOUNT);

/** What a page sent, or why it isn't a change this takes: the writer's rules,
 *  which the reader above doesn't hold. */
export function parseTaxFactOp(v: unknown): { op: TaxFactOp } | { error: string } {
  if (!isObject(v)) return { error: 'Send the change, as JSON' };
  if (v.kind === 'account') {
    if (!closed(v, ['kind', 'account_id', 'owner', 'basis', 'count'])) return { error: 'An account’s change is its account_id, owner, basis and count' };
    if (!isText(v.account_id) || !ACCOUNT_ID.test(v.account_id) || v.account_id === '__proto__') return { error: 'account_id is an account’s id' };
    if (!isOwner(v.owner)) return { error: 'owner is you or partner' };
    if (!isAmount(v.basis)) return { error: `basis is an amount of at most ${MAX_FACT_AMOUNT}, or null` };
    if (typeof v.count !== 'boolean') return { error: 'count is true or false' };
    return { op: { kind: 'account', account_id: v.account_id, owner: v.owner, basis: v.basis as number | null, count: v.count } };
  }
  if (v.kind === 'roth') {
    if (!closed(v, ['kind', 'owner', 'amount'])) return { error: 'A Roth’s change is its owner and amount' };
    if (!isOwner(v.owner)) return { error: 'owner is you or partner' };
    if (!isAmount(v.amount)) return { error: `amount is an amount of at most ${MAX_FACT_AMOUNT}, or null` };
    return { op: { kind: 'roth', owner: v.owner, amount: v.amount as number | null } };
  }
  return { error: 'kind is account or roth' };
}

/** The facts with one change made. */
export function applyTaxFactOp(tax: TaxFacts, op: TaxFactOp): TaxFacts {
  if (op.kind === 'roth') {
    const rest = tax.rothContributions.filter((r) => r.owner !== op.owner);
    return { ...tax, rothContributions: op.amount === null ? rest : [...rest, { owner: op.owner, amount: op.amount }] };
  }
  const { account_id, owner, basis, count } = op;
  const others = <T extends { account_id: string }>(list: readonly T[]) => list.filter((x) => x.account_id !== account_id);
  return {
    ...tax,
    owners: owner === 'you' ? others(tax.owners) : [...others(tax.owners), { account_id, owner }],
    basis: basis === null ? others(tax.basis) : [...others(tax.basis), { account_id, amount: basis }],
    countAnyway: [...tax.countAnyway.filter((id) => id !== account_id), ...(count ? [account_id] : [])],
  };
}

/** The facts without what is said about these accounts, gone for good: the same
 *  object when they say nothing about any. Who put what into a Roth stays, as it
 *  is said of a person and not of an account. */
export function withoutAccounts(tax: TaxFacts, gone: ReadonlySet<string>): TaxFacts {
  const owners = tax.owners.filter((x) => !gone.has(x.account_id));
  const basis = tax.basis.filter((x) => !gone.has(x.account_id));
  const countAnyway = tax.countAnyway.filter((id) => !gone.has(id));
  if (owners.length === tax.owners.length && basis.length === tax.basis.length && countAnyway.length === tax.countAnyway.length) return tax;
  return { ...tax, owners, basis, countAnyway };
}

/** Whether the facts hold more accounts than a write may leave there. */
export const tooManyFactAccounts = (tax: TaxFacts): boolean => Math.max(tax.owners.length, tax.basis.length, tax.countAnyway.length) > MAX_FACT_ACCOUNTS;
