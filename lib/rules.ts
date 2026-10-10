// lib/rules.ts
//
// Your rules (#36): each matches transactions by what they say and then
// files them under a category, gives them a name, adds tags or hides them
// (leaves them out of budgets and reports, still listed). The pure part is
// safe in the browser; the store is at the end.
//
// APPLIED ON READ, never written into a stored row (lib/txn-layers.ts, in the
// read layer every reader shares: the app, the read-only API and its MCP
// server, reports, recurring detection, the Plan, and the download). So a rule
// saved changes every past and future match at once, a rule disabled puts
// every row back exactly as it was without deleting the rule, and deleting
// one does the same for good. Nothing is cached with a rule applied: the
// transactions cache holds the banks' rows before rules (lib/activity.ts).
//
// WHERE RULES SIT. Over the bank's data (or a manual or imported row's own),
// under everything the person says about one transaction: a category chosen
// for it (or written on a row entered or imported), their name for its
// merchant, a tag taken off it or put on it, an exclusion set or cleared on
// it, and what was carried across a re-link from an earlier account's row. A
// choice made on one transaction always wins over every rule.
//
// CONDITIONS, all of which must match (never a regular expression):
//   - name: the merchant's name, as the bank gives it or as the person
//     renamed it, or the merchant behind a payment processor, `contains`,
//     `equals` or `starts_with` the text, in any case, with accents and
//     repeated spaces ignored (matchText);
//   - amount: the size of the amount, never negative, `gt` (more than) or `lt`
//     (less than) `value`, or `between` `value` and `value2`, both included;
//     with `direction` "out" for money out (Plaid's positive amounts, a charge),
//     "in" for money in (negative ones, a refund or pay), or either when
//     absent. Compared in the row's own currency: nothing is converted;
//   - account: the account it is on, by id, following the person's links
//     between an earlier account and the one it became (lib/link-core.ts);
//   - institution: the institution's name, in any case;
//   - category: the category it is filed under before any rule runs (the
//     person's choice, else the bank's), by id, following a merge to where it
//     went (lib/categories.ts categoryById);
//   - source: where it came from: "plaid" (a bank), "manual" (entered by
//     hand), "import" (from a file, of any format) or "simplefin".
//
// PRIORITY. Rules run in priority order, 1 first. When two rules that match
// one transaction both set its category, or its name, the one that runs
// first decides it, so a rule further down the list never undoes one above
// it; tags are added from every rule that matches; a transaction is hidden
// when any rule that matches hides it. A new rule goes first, so a rule made
// from a transaction applies to it. Rules never see each other's changes:
// every condition reads the transaction as it was before any rule ran.
//
// IDS, NEVER NAMES. A rule holds a category's id and tags' ids, so renaming
// either changes nothing here, and a merge is followed. A rule whose category
// was deleted is broken: it does nothing at all until it is fixed, never
// files a transaction somewhere else (lib/categories.ts deleteCategory
// refuses to delete a category a rule uses, so only a change from outside the
// app leaves one). A deleted tag is taken out of every rule (lib/tag-delete.ts).
//
// THE STORED SHAPE IS CLOSED. One value per container on the storage seam
// (lib/repo.ts), the `rules` store, encrypted. A condition, an action or a
// field this release doesn't know makes the whole set unrecognised, never
// partly applied: a rule read without a condition a later release added
// would match more than it should. So nothing is applied while it can't be
// read, the Activity tab says so, and nothing is saved over it. A new field
// ships in two releases, one that reads it and then one that writes it.

import { defineValueStore } from './repo';
import type { Ctx } from './containers';
import { categoryById, displayName, isProvisionalId, type CategoryIndex } from './categories';
import { MAX_AMOUNT, MAX_PAYEE_CHARS } from './manual-txn-input';
import { isTagId, type TagSet } from './tags';

export const RULES_VERSION = 1;

export const TEXT_OPS = ['contains', 'equals', 'starts_with'] as const;
export type TextOp = (typeof TEXT_OPS)[number];
export const AMOUNT_OPS = ['gt', 'lt', 'between'] as const;
export type AmountOp = (typeof AMOUNT_OPS)[number];
export const DIRECTIONS = ['out', 'in'] as const;
export type Direction = (typeof DIRECTIONS)[number];
/** Where a transaction comes from, as a source condition names it. */
export const SOURCE_KINDS = ['plaid', 'manual', 'import', 'simplefin'] as const;

export type RuleCondition =
  | { field: 'name'; op: TextOp; value: string }
  | { field: 'amount'; op: AmountOp; value: number; value2?: number; direction?: Direction }
  | { field: 'account'; op: 'equals'; value: string }
  | { field: 'institution'; op: 'equals'; value: string }
  | { field: 'category'; op: 'equals'; value: string }
  | { field: 'source'; op: 'equals'; value: string };

export type RuleField = RuleCondition['field'];
export const RULE_FIELDS: readonly RuleField[] = ['name', 'amount', 'account', 'institution', 'category', 'source'];

export type RuleActions = {
  /** A category's id. */
  set_category?: string;
  /** The name the transaction shows. */
  set_name?: string;
  /** Tags' ids. */
  add_tags?: string[];
  /** Left out of budgets and reports, still listed. */
  hide?: true;
};

export type Rule = {
  /** Random (crypto.randomUUID()). */
  id: string;
  enabled: boolean;
  /** 1 runs first; every rule has its own. */
  priority: number;
  /** All must match; at least one. */
  conditions: RuleCondition[];
  actions: RuleActions;
  created_at: string;
  updated_at: string;
};

export type RuleSet = { version: typeof RULES_VERSION; rules: Rule[] };

// ---- Limits ----

/** Rules a person can have. */
export const MAX_RULES = 250;
/** Conditions in one rule. */
export const MAX_CONDITIONS = 10;
/** Tags one rule adds. */
export const MAX_RULE_TAGS = 10;
/** A condition's text: a name or an institution. */
export const RULE_TEXT_MAX = 100;
/** A name a rule gives: as long as a vendor rename (app/api/rename). */
export const RULE_NAME_MAX = MAX_PAYEE_CHARS;

// ---- Text ----

/** Text as conditions compare it: in any case, accents and repeated spaces
 *  ignored, "Ｃａｆé" the same as "cafe". */
export function matchText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Text as an edit keeps it: Unicode-normalized, spaces collapsed, trimmed. */
const cleanText = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Where a row comes from, as a source condition reads it: "plaid" for a
 *  bank's (no source), else the first word of its own ("import:csv" is
 *  "import"). */
export function sourceKind(source: string | undefined): string {
  return source ? source.split(':')[0] : 'plaid';
}

// ---- The stored shape ----

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const SOURCE = /^[a-z][a-z0-9]{0,30}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
/** Text within a bound, not blank: the stored shape's bound, wider than an
 *  edit may make. */
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_AMOUNT;
/** Exactly these keys, these required. */
const keysAre = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every((k) => allowed.includes(k));

function isCondition(c: unknown): c is RuleCondition {
  if (!isRecord(c)) return false;
  switch (c.field) {
    case 'name':
      return keysAre(c, ['field', 'op', 'value']) && (TEXT_OPS as readonly unknown[]).includes(c.op) && isText(c.value, 500);
    case 'amount':
      if (!keysAre(c, ['field', 'op', 'value', 'value2', 'direction']) || !(AMOUNT_OPS as readonly unknown[]).includes(c.op) || !isAmount(c.value)) return false;
      if (c.direction !== undefined && !(DIRECTIONS as readonly unknown[]).includes(c.direction)) return false;
      return c.op === 'between' ? isAmount(c.value2) && c.value2 >= c.value : c.value2 === undefined;
    case 'account':
      return keysAre(c, ['field', 'op', 'value']) && c.op === 'equals' && typeof c.value === 'string' && ACCOUNT_ID.test(c.value);
    case 'institution':
      return keysAre(c, ['field', 'op', 'value']) && c.op === 'equals' && isText(c.value, 500);
    case 'category':
      return keysAre(c, ['field', 'op', 'value']) && c.op === 'equals' && typeof c.value === 'string' && ID.test(c.value);
    case 'source':
      return keysAre(c, ['field', 'op', 'value']) && c.op === 'equals' && typeof c.value === 'string' && SOURCE.test(c.value);
    default:
      return false;
  }
}

function isActions(a: unknown): a is RuleActions {
  if (!isRecord(a) || !keysAre(a, ['set_category', 'set_name', 'add_tags', 'hide'])) return false;
  if (a.set_category !== undefined && (typeof a.set_category !== 'string' || !ID.test(a.set_category))) return false;
  if (a.set_name !== undefined && !isText(a.set_name, 500)) return false;
  if (a.add_tags !== undefined && (!Array.isArray(a.add_tags) || a.add_tags.length > 100 || !a.add_tags.every(isTagId))) return false;
  if (a.hide !== undefined && a.hide !== true) return false;
  return true;
}

function isRule(r: unknown): r is Rule {
  if (!isRecord(r) || !keysAre(r, ['id', 'enabled', 'priority', 'conditions', 'actions', 'created_at', 'updated_at'])) return false;
  if (typeof r.id !== 'string' || !ID.test(r.id) || typeof r.enabled !== 'boolean') return false;
  if (typeof r.priority !== 'number' || !Number.isInteger(r.priority) || r.priority < 1) return false;
  if (!Array.isArray(r.conditions) || r.conditions.length === 0 || r.conditions.length > 50 || !r.conditions.every(isCondition)) return false;
  return isActions(r.actions) && isInstant(r.created_at) && isInstant(r.updated_at);
}

/**
 * The stored shape, checked on every read and before every write: version 1,
 * each rule with its own id and its own priority, at least one condition, and
 * nothing this release doesn't know (see THE STORED SHAPE IS CLOSED). The
 * bounds are the stored shape's, wider than an edit may make, so rules saved
 * under other limits still read. A rule may have no action left (its tags
 * were deleted): it matches and does nothing.
 */
export function isRuleSet(v: unknown): v is RuleSet {
  if (!isRecord(v) || !keysAre(v, ['version', 'rules']) || v.version !== RULES_VERSION || !Array.isArray(v.rules) || v.rules.length > 5000) return false;
  const ids = new Set<string>();
  const priorities = new Set<number>();
  for (const r of v.rules) {
    if (!isRule(r) || ids.has(r.id) || priorities.has(r.priority)) return false;
    ids.add(r.id);
    priorities.add(r.priority);
  }
  return true;
}

/** No rules, for a container that never saved any. */
export const emptyRuleSet = (): RuleSet => ({ version: RULES_VERSION, rules: [] });

/** In the order they run. */
export function sortedRules(set: RuleSet | null): Rule[] {
  return [...(set?.rules ?? [])].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- Editing ----

/** An edit refused, with what to say to the person and the status a route
 *  answers with: 400 a bad request, 404 nothing there, 409 not now. */
export class RuleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = 'RuleError';
  }
}

/** What an edit checks a rule's categories and tags against. */
export type RuleContext = { ix: CategoryIndex; tags: TagSet | null };

/** A category an edit names, by id: one the set has, following a merge to
 *  where it went, never one the read-only API made up. */
function checkCategory(raw: unknown, ctx: RuleContext): string {
  const c = typeof raw === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(raw) ? categoryById(ctx.ix, raw) : null;
  if (!c || isProvisionalId(c.id)) throw new RuleError('That category no longer exists. Reload to see your categories as they are.', 404);
  return c.id;
}

/** A condition as an edit takes it, checked strictly, in its stored form. */
function checkCondition(raw: unknown, ctx: RuleContext): RuleCondition {
  if (!isRecord(raw)) throw new RuleError('Each condition says what to match.');
  const text = (what: string): string => {
    if (typeof raw.value !== 'string') throw new RuleError(`Say what the ${what} should match.`);
    const value = cleanText(raw.value);
    if (!value || !matchText(value)) throw new RuleError(`Say what the ${what} should match.`);
    if (value.length > RULE_TEXT_MAX) throw new RuleError(`A ${what} to match can be at most ${RULE_TEXT_MAX} characters.`);
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new RuleError(`A ${what} to match can’t hold control characters.`);
    return value;
  };
  const amount = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_AMOUNT) throw new RuleError('An amount in a rule is a size: a number, never negative.');
    return Math.round(v * 1e8) / 1e8;
  };
  switch (raw.field) {
    case 'name': {
      if (!(TEXT_OPS as readonly unknown[]).includes(raw.op)) throw new RuleError('A name is matched by contains, equals or starts with.');
      return { field: 'name', op: raw.op as TextOp, value: text('name') };
    }
    case 'amount': {
      if (!(AMOUNT_OPS as readonly unknown[]).includes(raw.op)) throw new RuleError('An amount is matched by more than, less than or between.');
      if (raw.direction !== undefined && raw.direction !== null && !(DIRECTIONS as readonly unknown[]).includes(raw.direction)) {
        throw new RuleError('Say whether the amount is money out, money in, or either.');
      }
      const value = amount(raw.value);
      const c: RuleCondition = { field: 'amount', op: raw.op as AmountOp, value };
      if (raw.op === 'between') {
        const value2 = amount(raw.value2);
        if (value2 < value) throw new RuleError('Between: the first amount is the smaller.');
        c.value2 = value2;
      } else if (raw.value2 !== undefined && raw.value2 !== null) throw new RuleError('Only between takes a second amount.');
      if (raw.direction === 'out' || raw.direction === 'in') c.direction = raw.direction;
      return c;
    }
    case 'account': {
      if (typeof raw.value !== 'string' || !ACCOUNT_ID.test(raw.value)) throw new RuleError('Choose an account.');
      return { field: 'account', op: 'equals', value: raw.value };
    }
    case 'institution':
      return { field: 'institution', op: 'equals', value: text('institution') };
    case 'category':
      return { field: 'category', op: 'equals', value: checkCategory(raw.value, ctx) };
    case 'source': {
      if (!(SOURCE_KINDS as readonly unknown[]).includes(raw.value)) throw new RuleError(`A source is one of ${SOURCE_KINDS.join(', ')}.`);
      return { field: 'source', op: 'equals', value: raw.value as string };
    }
    default:
      throw new RuleError('A condition is on the name, the amount, the account, the institution, the category or the source.');
  }
}

/** Actions as an edit takes them: at least one. */
function checkActions(raw: unknown, ctx: RuleContext): RuleActions {
  if (!isRecord(raw)) throw new RuleError('Say what the rule does.');
  const out: RuleActions = {};
  if (raw.set_category !== undefined && raw.set_category !== null && raw.set_category !== '') out.set_category = checkCategory(raw.set_category, ctx);
  if (raw.set_name !== undefined && raw.set_name !== null && raw.set_name !== '') {
    if (typeof raw.set_name !== 'string') throw new RuleError('A name is text.');
    const name = cleanText(raw.set_name);
    if (!name) throw new RuleError('Give the name it should show.');
    if (name.length > RULE_NAME_MAX) throw new RuleError(`A name can be at most ${RULE_NAME_MAX} characters.`);
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new RuleError('A name can’t hold control characters.');
    out.set_name = name;
  }
  if (raw.add_tags !== undefined && raw.add_tags !== null) {
    if (!Array.isArray(raw.add_tags) || raw.add_tags.length > MAX_RULE_TAGS || !raw.add_tags.every(isTagId)) {
      throw new RuleError(`A rule adds at most ${MAX_RULE_TAGS} tags.`);
    }
    const live = new Set((ctx.tags?.tags ?? []).map((t) => t.id));
    if (raw.add_tags.some((id) => !live.has(id))) throw new RuleError('That tag no longer exists. Reload to see your tags as they are.', 404);
    if (raw.add_tags.length > 0) out.add_tags = [...new Set(raw.add_tags as string[])];
  }
  if (raw.hide !== undefined && raw.hide !== null && raw.hide !== false) {
    if (raw.hide !== true) throw new RuleError('Say whether the rule hides what it matches.');
    out.hide = true;
  }
  if (Object.keys(out).length === 0) throw new RuleError('Say what the rule does: a category, a name, tags, or hiding what it matches.');
  return out;
}

/** A rule's conditions and actions as an edit takes them, every field
 *  checked strictly (RuleError says what is wrong). */
export function checkRuleInput(raw: unknown, ctx: RuleContext): { conditions: RuleCondition[]; actions: RuleActions } {
  if (!isRecord(raw)) throw new RuleError('Invalid request');
  if (!Array.isArray(raw.conditions) || raw.conditions.length === 0) throw new RuleError('Add at least one condition: a rule that matches everything would change every transaction.');
  if (raw.conditions.length > MAX_CONDITIONS) throw new RuleError(`A rule can have at most ${MAX_CONDITIONS} conditions.`);
  return { conditions: raw.conditions.map((c) => checkCondition(c, ctx)), actions: checkActions(raw.actions, ctx) };
}

/** The rules numbered 1, 2, 3... in the order given. */
const numbered = (rules: Rule[]): Rule[] => rules.map((r, i) => (r.priority === i + 1 ? r : { ...r, priority: i + 1 }));

function findRule(set: RuleSet, id: unknown): Rule {
  const r = typeof id === 'string' ? set.rules.find((x) => x.id === id) : undefined;
  if (!r) throw new RuleError('That rule no longer exists. Reload to see your rules as they are.', 404);
  return r;
}

/** A new rule, first: a rule made from a transaction applies to it. */
export function addRule(set: RuleSet, raw: unknown, ctx: RuleContext, newId: () => string, now: Date = new Date()): { set: RuleSet; rule: Rule } {
  if (set.rules.length >= MAX_RULES) throw new RuleError(`You can have at most ${MAX_RULES} rules. Delete some first.`, 409);
  const input = checkRuleInput(raw, ctx);
  const enabled = isRecord(raw) && raw.enabled === false ? false : true;
  const at = now.toISOString();
  const rule: Rule = { id: newId(), enabled, priority: 1, ...input, created_at: at, updated_at: at };
  const rules = numbered([rule, ...sortedRules(set)]);
  return { set: { ...set, rules }, rule: rules[0] };
}

/** New conditions and actions for a rule, where it stands in the order. */
export function editRule(set: RuleSet, id: unknown, raw: unknown, ctx: RuleContext, now: Date = new Date()): RuleSet {
  const r = findRule(set, id);
  const input = checkRuleInput(raw, ctx);
  const enabled = isRecord(raw) && typeof raw.enabled === 'boolean' ? raw.enabled : r.enabled;
  const next: Rule = { ...r, ...input, enabled, updated_at: now.toISOString() };
  return { ...set, rules: set.rules.map((x) => (x.id === r.id ? next : x)) };
}

/** On or off: off puts every transaction it matched back as it was, and keeps it. */
export function enableRule(set: RuleSet, id: unknown, enabled: unknown, now: Date = new Date()): RuleSet {
  const r = findRule(set, id);
  if (typeof enabled !== 'boolean') throw new RuleError('Say whether the rule is on.');
  if (r.enabled === enabled) return set;
  return { ...set, rules: set.rules.map((x) => (x.id === r.id ? { ...x, enabled, updated_at: now.toISOString() } : x)) };
}

/** The rules in a new order: `ids` is every rule's id, once, first to run
 *  first. A list that isn't (a rule added or deleted meanwhile) is refused,
 *  so nothing is put somewhere by guesswork. */
export function orderRules(set: RuleSet, ids: unknown): RuleSet {
  if (!Array.isArray(ids) || ids.length !== set.rules.length || new Set(ids).size !== ids.length || !ids.every((id) => set.rules.some((r) => r.id === id))) {
    throw new RuleError('Your rules changed since this page loaded. Reload to see them as they are.', 409);
  }
  const byId = new Map(set.rules.map((r) => [r.id, r]));
  return { ...set, rules: numbered((ids as string[]).map((id) => byId.get(id)!)) };
}

export function deleteRule(set: RuleSet, id: unknown): RuleSet {
  const r = findRule(set, id);
  return { ...set, rules: numbered(sortedRules(set).filter((x) => x.id !== r.id)) };
}

/** The rules with deleted tags taken out (lib/tag-delete.ts). */
export function withoutTags(set: RuleSet, ids: readonly string[]): RuleSet {
  if (!set.rules.some((r) => r.actions.add_tags?.some((t) => ids.includes(t)))) return set;
  return {
    ...set,
    rules: set.rules.map((r) => {
      if (!r.actions.add_tags?.some((t) => ids.includes(t))) return r;
      const actions = { ...r.actions, add_tags: r.actions.add_tags.filter((t) => !ids.includes(t)) };
      if (actions.add_tags.length === 0) delete (actions as RuleActions).add_tags;
      return { ...r, actions };
    }),
  };
}

// ---- What a rule says, and whether it can ----

/** The category ids a rule names, in its conditions and its action. */
export function ruleCategories(r: Rule): string[] {
  return [...r.conditions.flatMap((c) => (c.field === 'category' ? [c.value] : [])), ...(r.actions.set_category ? [r.actions.set_category] : [])];
}

/** Why a rule can't do what it says, or null: a category it names that no
 *  longer exists (deleted, never re-pointed). With no categories to check
 *  against, nothing can be said. */
export function ruleProblem(r: Rule, ix: CategoryIndex | null): string | null {
  if (!ix) return null;
  return ruleCategories(r).some((id) => !categoryById(ix, id)) ? 'A category it names was deleted, so it does nothing until you choose another.' : null;
}

/** A rule that does nothing: no action left (its tags were deleted). */
export const doesNothing = (r: Rule): boolean => Object.keys(r.actions).length === 0;

// ---- Applying ----

/** What conditions read of a transaction, worked out once per row
 *  (lib/txn-layers.ts). */
export type RuleSubject = {
  /** The names it can be matched by, as matchText makes them. */
  names: string[];
  /** Plaid's sign: positive is money out. */
  amount: number;
  /** The account it is on, as resolveAccount makes it. */
  account: string | null;
  /** The institution's name, as matchText makes it. */
  institution: string;
  /** The id of the category it is filed under before any rule runs. */
  category: string | null;
  /** sourceKind. */
  source: string;
  /** For a preview (app/api/rules/preview): whether a rule's category or name
   *  would show on it. The person's own category for it, or their name for
   *  its merchant (a manual or imported row's are its own), keep it. */
  keeps_category?: boolean;
  keeps_name?: boolean;
};

export type CompiledRule = { rule: Rule; test: (s: RuleSubject) => boolean; tags: string[] };
export type CompiledRules = {
  /** Enabled, working and doing something, in the order they run. */
  rules: CompiledRule[];
  /** Whether a condition reads the account (links are read only then). */
  readsAccount: boolean;
};

function compileCondition(c: RuleCondition, ix: CategoryIndex | null, account: (id: string) => string): ((s: RuleSubject) => boolean) | null {
  switch (c.field) {
    case 'name': {
      const v = matchText(c.value);
      if (c.op === 'contains') return (s) => s.names.some((n) => n.includes(v));
      if (c.op === 'equals') return (s) => s.names.some((n) => n === v);
      return (s) => s.names.some((n) => n.startsWith(v));
    }
    case 'amount': {
      const { op, value, value2, direction } = c;
      return (s) => {
        if (direction === 'out' ? !(s.amount > 0) : direction === 'in' ? !(s.amount < 0) : false) return false;
        const size = Math.abs(s.amount);
        return op === 'gt' ? size > value : op === 'lt' ? size < value : size >= value && size <= (value2 ?? value);
      };
    }
    case 'account': {
      const id = account(c.value);
      return (s) => s.account === id;
    }
    case 'institution': {
      const v = matchText(c.value);
      return (s) => s.institution === v;
    }
    case 'category': {
      const cat = ix ? categoryById(ix, c.value) : null;
      if (!cat) return null;
      return (s) => s.category === cat.id;
    }
    case 'source':
      return (s) => s.source === c.value;
  }
}

/**
 * The rules ready to apply: enabled ones, in the order they run, each
 * condition made into a test once. A broken rule (ruleProblem) and one that
 * does nothing are left out. `liveTags` keeps a rule's tags to those that
 * exist. `account` is how an account id is known now (following links).
 */
export function compileRules(
  set: RuleSet | null,
  opts: { ix: CategoryIndex | null; liveTags: ReadonlySet<string>; account?: (id: string) => string }
): CompiledRules {
  const account = opts.account ?? ((id: string) => id);
  const out: CompiledRule[] = [];
  let readsAccount = false;
  for (const rule of sortedRules(set)) {
    if (!rule.enabled || doesNothing(rule)) continue;
    if (rule.actions.set_category && !(opts.ix && categoryById(opts.ix, rule.actions.set_category))) continue;
    const tests = rule.conditions.map((c) => compileCondition(c, opts.ix, account));
    if (tests.some((t) => t === null)) continue;
    const all = tests as ((s: RuleSubject) => boolean)[];
    if (rule.conditions.some((c) => c.field === 'account')) readsAccount = true;
    out.push({ rule, test: (s) => all.every((t) => t(s)), tags: (rule.actions.add_tags ?? []).filter((id) => opts.liveTags.has(id)) });
  }
  return { rules: out, readsAccount };
}

/** What the rules that match one transaction say: each field from the first
 *  rule that sets it, the tags of all of them, and which matched. */
export type RuleOutcome = {
  category?: { id: string; rule: string };
  name?: { value: string; rule: string };
  hide?: { rule: string };
  tags: string[];
  matched: string[];
};

export function evaluateRules(compiled: CompiledRules, s: RuleSubject, ix: CategoryIndex | null): RuleOutcome {
  const out: RuleOutcome = { tags: [], matched: [] };
  for (const { rule, test, tags } of compiled.rules) {
    if (!test(s)) continue;
    out.matched.push(rule.id);
    const a = rule.actions;
    if (a.set_category && !out.category) {
      const c = ix ? categoryById(ix, a.set_category) : null;
      if (c) out.category = { id: c.id, rule: rule.id };
    }
    if (a.set_name && !out.name) out.name = { value: a.set_name, rule: rule.id };
    if (a.hide && !out.hide) out.hide = { rule: rule.id };
    for (const t of tags) if (!out.tags.includes(t)) out.tags.push(t);
  }
  return out;
}

// ---- In words ----

const AMOUNT_WORDS: Record<AmountOp, string> = { gt: 'more than', lt: 'less than', between: 'between' };
const TEXT_WORDS: Record<TextOp, string> = { contains: 'contains', equals: 'is', starts_with: 'starts with' };
const SOURCE_WORDS: Record<string, string> = { plaid: 'from a bank', manual: 'entered by hand', import: 'imported from a file', simplefin: 'from SimpleFIN' };

/** What the app calls things a rule names, for saying it in words. */
export type RuleNames = {
  ix: CategoryIndex | null;
  tags: TagSet | null;
  /** An account's name by id, where known. */
  account?: (id: string) => string | null;
  /** An amount as the app shows it. */
  money?: (n: number) => string;
};

/** One condition in words: "name contains “amzn”". */
export function conditionWords(c: RuleCondition, names: RuleNames): string {
  const money = names.money ?? ((n: number) => String(n));
  switch (c.field) {
    case 'name':
      return `name ${TEXT_WORDS[c.op]} “${c.value}”`;
    case 'amount': {
      const which = c.direction === 'out' ? 'money out' : c.direction === 'in' ? 'money in' : 'amount';
      return c.op === 'between' ? `${which} between ${money(c.value)} and ${money(c.value2 ?? c.value)}` : `${which} ${AMOUNT_WORDS[c.op]} ${money(c.value)}`;
    }
    case 'account':
      return `account is ${names.account?.(c.value) ?? 'an account no longer here'}`;
    case 'institution':
      return `institution is ${c.value}`;
    case 'category': {
      const cat = names.ix ? categoryById(names.ix, c.value) : null;
      return `category is ${cat ? displayName(cat.name) : 'a deleted category'}`;
    }
    case 'source':
      return SOURCE_WORDS[c.value] ?? `from ${c.value}`;
  }
}

/** What a rule does, in words: "file under Groceries, add Work". */
export function actionWords(a: RuleActions, names: RuleNames): string[] {
  const out: string[] = [];
  if (a.set_category) {
    const cat = names.ix ? categoryById(names.ix, a.set_category) : null;
    out.push(`file under ${cat ? displayName(cat.name) : 'a deleted category'}`);
  }
  if (a.set_name) out.push(`name it “${a.set_name}”`);
  const tagNames = (a.add_tags ?? []).map((id) => names.tags?.tags.find((t) => t.id === id)?.name).filter((n): n is string => !!n);
  if (tagNames.length) out.push(`tag ${tagNames.join(', ')}`);
  if (a.hide) out.push('hide it from budgets and reports');
  return out;
}

/** A rule in one sentence: "If name contains “amzn” and money out more than
 *  $50: file under Shopping, tag Work." */
export function ruleSentence(r: Rule, names: RuleNames): string {
  const does = actionWords(r.actions, names);
  return `If ${r.conditions.map((c) => conditionWords(c, names)).join(' and ')}: ${does.length ? does.join(', ') : 'nothing (its tags were deleted)'}.`;
}

// ---- Stored ----

export const rulesStore = defineValueStore<RuleSet>('rules', {
  what: 'rules',
  isValid: isRuleSet,
  exportable: true, // the person's own rules
});

/** A new rule's id: random, so it says nothing of what it matches. */
export const newRuleId = (): string => crypto.randomUUID();

/** Strict: the stored rules, or null when none were ever saved. */
export function readRuleSet(ctx: Ctx): Promise<RuleSet | null> {
  return rulesStore.get(ctx);
}

/**
 * The rules for showing transactions (lib/activity.ts): the stored ones, or
 * none, with a note when they can't be read (damaged, or saved by a version
 * this one doesn't know): no rule is applied then, so a transaction a rule
 * hid counts again until they can be, and nothing writes on this answer.
 * Storage that can't be reached throws, as every read does.
 */
export async function rulesForDisplay(ctx: Ctx): Promise<{ set: RuleSet | null; note: string | null }> {
  const report = await rulesStore.getReport(ctx);
  if (report.unreadable || report.unrecognised) {
    console.error(`Stored rules ${report.unreadable ? 'unreadable' : 'unrecognised'}`);
    return { set: null, note: "Your rules couldn't be read, so none are applied until they can be: transactions show as the bank and you have them." };
  }
  return { set: report.value, note: null };
}

/** Changes the rules with `op` (from none when none were saved), in one
 *  compare-and-set: `op` may run more than once and throws RuleError to
 *  refuse. Rules that can't be read are refused (StoredDataUnreadableError),
 *  never replaced. */
export async function changeRules(ctx: Ctx, op: (set: RuleSet) => RuleSet): Promise<RuleSet> {
  return (await rulesStore.update(ctx, (cur) => op(cur ?? emptyRuleSet())))!;
}

/** Takes deleted tags' ids out of every rule (lib/tag-delete.ts). Returns how
 *  many rules changed. Rules that can't be read are left as they are: no
 *  rule is applied while they can't be, and nothing shows a deleted tag. */
export async function sweepRuleTags(ctx: Ctx, ids: readonly string[]): Promise<number> {
  const report = await rulesStore.getReport(ctx);
  if (!report.value) return 0;
  const before = report.value.rules.filter((r) => r.actions.add_tags?.some((t) => ids.includes(t))).length;
  if (before === 0) return 0;
  await rulesStore.update(ctx, (cur) => (cur ? withoutTags(cur, ids) : cur));
  return before;
}
