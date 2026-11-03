// lib/flags.ts
//
// The feature switches: every flag this release knows, in code. A flag not
// here doesn't exist. Each has a short plain name and a sentence of what it
// does (shown where flags are set: /dev/flags and the admin page), its kind
// (a release flag is temporary and carries the date it should be gone by; an
// ops flag is a lasting on or off for an operation), the kind of value it
// holds, its default in each environment, what turning it off does to what was
// made while it was on, and, for a switch moved here from the environment, the
// variable that still decides it while set. Pure: nothing here reads storage. Values live in
// lib/flag-store.ts; lib/flag-read.ts reads and evaluates them.
//
// PRECEDENCE, for a switch moved from the environment: its variable while set,
// then the stored value, then the default. A variable is set when its whole
// value, trimmed, is not empty, decided before it is parsed: an empty
// OPS_ENABLED= is unset, and CLERK_ALLOWED_USER_IDS=' , ' is set and lists
// nobody. The variables stay the way to set up a new environment
// (docs/operations.md, "Feature switches"): no flag can be stored before an
// account owns a container.
//
// VALUE KINDS:
//   audience  who a feature is on for: nobody, the admin, the admin and the
//             demo accounts, or everyone, and the accounts it is also on for;
//   mode      the Content-Security-Policy's (off, report-only, enforce), for
//             the whole environment, since signed-out public pages carry it;
//   switch    on or off for the whole environment (the ops routes, which
//             carry no signed-in account);
//   list      who may sign in: Clerk user ids and emails, the variable's two
//             halves, matched by one function.

import { isContainerId, type ContainerId } from './containers';
import { cspMode, type CspMode } from './security-headers';

export type Environment = 'development' | 'preview' | 'production';

/** The environment flags are read for: Vercel's Production or Preview, and
 *  everything else (a local `next dev`, Vercel's Development) development. */
export function flagEnvironment(): Environment {
  const vercel = process.env.VERCEL_ENV;
  return vercel === 'production' || vercel === 'preview' ? vercel : 'development';
}

export const AUDIENCES = ['nobody', 'admin', 'admin-and-demo', 'everyone'] as const;
export type AudienceOn = (typeof AUDIENCES)[number];

export type AudienceValue = { on: AudienceOn; containers: ContainerId[]; updatedAt: string };
export type ModeValue = { mode: CspMode; updatedAt: string };
export type SwitchValue = { on: boolean; updatedAt: string };
export type ListValue = { ids: string[]; emails: string[]; updatedAt: string };
export type FlagValue = AudienceValue | ModeValue | SwitchValue | ListValue;

type Common = {
  /** A short plain name: the title of its row where flags are set. */
  name: string;
  /** One sentence: what it does, where flags are set. */
  about: string;
  /** What a value written while it was on does once it is off. */
  offMeans: string;
};
type Release = { kind: 'release'; /** The day it should be gone by (YYYY-MM-DD). */ removeBy: string };
type Ops = { kind: 'ops' };

export type AudienceFlag = Common & (Release | Ops) & { value: 'audience'; defaults: Record<Environment, AudienceOn>; variable?: string };
export type ModeFlag = Common & Ops & { value: 'mode'; defaults: Record<Environment, CspMode>; variable: string };
export type SwitchFlag = Common & Ops & { value: 'switch'; defaults: Record<Environment, boolean>; variable: string };
export type ListFlag = Common & Ops & { value: 'list'; variable: string };
export type FlagDef = AudienceFlag | ModeFlag | SwitchFlag | ListFlag;

const NOBODY: Record<Environment, AudienceOn> = { development: 'nobody', preview: 'nobody', production: 'nobody' };

export const FLAGS = {
  restore: {
    name: 'Bring back a download',
    about: 'Offers Bring back a download, which brings a person’s JSON download into an empty account.',
    kind: 'ops',
    value: 'audience',
    defaults: NOBODY,
    variable: 'RESTORE_ENABLED',
    offMeans: 'Starting a restore, sending a restore’s remaining batches and emptying an account for one are refused; a restore under way keeps its banner and can still be undone.',
  },
  'restore-carry-on': {
    name: 'Carry on a restored account',
    about: 'Lets an account a restore brought back from SimpleFIN or Lunch Flow be carried on by the account tracked in its place.',
    kind: 'ops',
    value: 'audience',
    defaults: NOBODY,
    variable: 'RESTORE_CARRY_ON_ENABLED',
    offMeans: 'Carrying on a restored account is refused; an account carried on already is still read and can still be undone.',
  },
  lunchflow: {
    name: 'Lunch Flow',
    about: 'Offers Connect with Lunch Flow beside Connect with SimpleFIN.',
    kind: 'ops',
    value: 'audience',
    defaults: NOBODY,
    variable: 'LUNCHFLOW_ENABLED',
    offMeans: 'New Lunch Flow connections are refused; connections made already keep working.',
  },
  'brokerage-link': {
    name: 'Brokerage and retirement accounts',
    about: 'Offers Connect a brokerage or retirement account beside the bank option.',
    kind: 'ops',
    value: 'audience',
    defaults: NOBODY,
    variable: 'PLAID_BROKERAGE_LINK',
    offMeans: 'New link tokens leave the option out; brokerage connections made already keep working.',
  },
  'api-writes': {
    name: 'Tokens that make changes',
    about: 'Lets people make API tokens that update manual accounts’ balances or make changes.',
    kind: 'ops',
    value: 'audience',
    defaults: NOBODY,
    variable: 'API_WRITES_ENABLED',
    offMeans: 'Every token reads only: a token made to write is refused each write, and new ones can only read.',
  },
  'plan-tax': {
    name: 'Detailed tax in the Plan',
    about: 'The Plan’s detailed US tax model: the opt-in, and plans saved as detailed.',
    kind: 'release',
    removeBy: '2027-06-30',
    value: 'audience',
    defaults: NOBODY,
    offMeans: 'A detailed plan says it uses the flat rate, and a plan can’t be saved as detailed.',
  },
  csp: {
    name: 'Content security policy',
    about: 'How pages send their Content-Security-Policy: enforced, only reported, or off.',
    kind: 'ops',
    value: 'mode',
    defaults: { development: 'report-only', preview: 'report-only', production: 'report-only' },
    variable: 'CSP_MODE',
    offMeans: 'Pages carry no policy.',
  },
  ops: {
    name: 'Ops routes',
    about: 'Opens the operator’s routes (a backup by hand, key rotation, the re-encryption pass and the rest), only while an operation runs.',
    kind: 'ops',
    value: 'switch',
    defaults: { development: false, preview: false, production: false },
    variable: 'OPS_ENABLED',
    offMeans: 'The ops routes answer as missing; OPS_SECRET is still required while they are on.',
  },
  'sign-in': {
    name: 'Who may sign in',
    about: 'Who may sign in with a Clerk account, beside the demo accounts and the deployment’s owners.',
    kind: 'ops',
    value: 'list',
    variable: 'CLERK_ALLOWED_USER_IDS',
    offMeans: 'Someone taken off the list is refused at the next request; the deployment’s owners can never be refused.',
  },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAGS;
export type AudienceKey = { [K in FlagKey]: (typeof FLAGS)[K]['value'] extends 'audience' ? K : never }[FlagKey];

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];
export const AUDIENCE_KEYS = FLAG_KEYS.filter((k): k is AudienceKey => FLAGS[k].value === 'audience');

export function isFlagKey(key: unknown): key is FlagKey {
  return typeof key === 'string' && Object.hasOwn(FLAGS, key);
}

export function flagDef(key: FlagKey): FlagDef {
  return FLAGS[key];
}

// ---- The variables ----

/** A flag's variable as it stands, or undefined when it has none or it is
 *  unset: absent, or nothing but blanks. */
export function variableText(key: FlagKey): string | undefined {
  const def: FlagDef = FLAGS[key];
  const name = 'variable' in def ? def.variable : undefined;
  if (!name) return undefined;
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}

/** Whether a flag's variable decides it now. */
export function variableSet(key: FlagKey): boolean {
  return variableText(key) !== undefined;
}

/** An on-or-off variable, as each was read: "1" is on, anything else off. */
const isOne = (raw: string) => raw === '1';

/** An audience flag's variable: on for everyone or off for everyone, or
 *  undefined while unset. */
export function audienceVariable(key: AudienceKey): boolean | undefined {
  const raw = variableText(key);
  return raw === undefined ? undefined : isOne(raw);
}

/** The CSP mode's variable, parsed as it always was, or undefined while unset. */
export function cspVariable(): CspMode | undefined {
  const raw = variableText('csp');
  return raw === undefined ? undefined : cspMode(raw);
}

/** The CSP mode the variable alone gives: its value, else the default. For a
 *  page rendered without the proxy's header. */
export function cspFromVariable(): CspMode {
  return cspVariable() ?? FLAGS.csp.defaults[flagEnvironment()];
}

/** The ops routes' variable, or undefined while unset. */
export function opsVariable(): boolean | undefined {
  const raw = variableText('ops');
  return raw === undefined ? undefined : isOne(raw);
}

/** Entries of a sign-in list, as CLERK_ALLOWED_USER_IDS has always been read:
 *  comma separated; one with "@" is an email, matched in any case. */
export function parseSignIn(raw: string): { ids: string[]; emails: string[] } {
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    if (entry.includes('@')) emails.add(entry.toLowerCase());
    else ids.add(entry);
  }
  return { ids: [...ids], emails: [...emails] };
}

/** The sign-in list's variable, or undefined while unset. */
export function signInVariable(): { ids: string[]; emails: string[] } | undefined {
  const raw = variableText('sign-in');
  return raw === undefined ? undefined : parseSignIn(raw);
}

// ---- Values ----

/** The most entries a list holds (an audience's accounts, the sign-in list's
 *  ids, its emails), and the longest entry. */
export const MAX_LIST = 1000;
export const MAX_ENTRY = 320;

const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const hasExactly = (v: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEntries = (v: unknown, ok: (s: string) => boolean): v is string[] =>
  Array.isArray(v) && v.length <= MAX_LIST && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_ENTRY && ok(s)) && new Set(v).size === v.length;

export function isAudienceValue(v: unknown): v is AudienceValue {
  return (
    isRecord(v) &&
    hasExactly(v, ['on', 'containers', 'updatedAt']) &&
    (AUDIENCES as readonly unknown[]).includes(v.on) &&
    isEntries(v.containers, isContainerId) &&
    isTime(v.updatedAt)
  );
}

export function isModeValue(v: unknown): v is ModeValue {
  return isRecord(v) && hasExactly(v, ['mode', 'updatedAt']) && (v.mode === 'off' || v.mode === 'report-only' || v.mode === 'enforce') && isTime(v.updatedAt);
}

export function isSwitchValue(v: unknown): v is SwitchValue {
  return isRecord(v) && hasExactly(v, ['on', 'updatedAt']) && typeof v.on === 'boolean' && isTime(v.updatedAt);
}

export function isListValue(v: unknown): v is ListValue {
  return (
    isRecord(v) &&
    hasExactly(v, ['ids', 'emails', 'updatedAt']) &&
    isEntries(v.ids, (s) => !s.includes('@') && !s.includes(',') && s.trim() === s) &&
    isEntries(v.emails, (s) => s.includes('@') && !s.includes(',') && s === s.trim().toLowerCase()) &&
    isTime(v.updatedAt)
  );
}

/** Whether `v` is a value the flag `key` holds: false for a key this release
 *  doesn't know. */
export function isFlagValue(key: string, v: unknown): v is FlagValue {
  if (!isFlagKey(key)) return false;
  switch (FLAGS[key].value) {
    case 'audience':
      return isAudienceValue(v);
    case 'mode':
      return isModeValue(v);
    case 'switch':
      return isSwitchValue(v);
    case 'list':
      return isListValue(v);
  }
}

/** The values a flag of each kind can be set to where flags are set
 *  (/dev/flags, the admin page): an audience's `on`, a mode, a switch's on or
 *  off. The list is set by adding and removing people (lib/flag-change.ts),
 *  not by a choice. */
export function choicesFor(key: FlagKey): readonly string[] {
  const def: FlagDef = FLAGS[key];
  switch (def.value) {
    case 'audience':
      return AUDIENCES;
    case 'mode':
      return ['off', 'report-only', 'enforce'];
    case 'switch':
      return ['off', 'on'];
    case 'list':
      return [];
  }
}

/** The value a choice sets, built on the one stored (an audience keeps the
 *  accounts it is also on for), or null when the flag takes no such choice. */
export function valueFromChoice(key: FlagKey, choice: unknown, current: FlagValue | null, now: number = Date.now()): FlagValue | null {
  if (typeof choice !== 'string' || !choicesFor(key).includes(choice)) return null;
  const updatedAt = new Date(now).toISOString();
  const def: FlagDef = FLAGS[key];
  switch (def.value) {
    case 'audience':
      return { on: choice as AudienceOn, containers: current && isAudienceValue(current) ? current.containers : [], updatedAt };
    case 'mode':
      return { mode: choice as CspMode, updatedAt };
    case 'switch':
      return { on: choice === 'on', updatedAt };
    case 'list':
      return null;
  }
}

/** The choice a stored value shows as, or null for none. */
export function choiceOf(key: FlagKey, value: FlagValue | null): string | null {
  if (value === null) return null;
  if (isAudienceValue(value) && FLAGS[key].value === 'audience') return value.on;
  if (isModeValue(value) && FLAGS[key].value === 'mode') return value.mode;
  if (isSwitchValue(value) && FLAGS[key].value === 'switch') return value.on ? 'on' : 'off';
  return null;
}

/** The choice a flag's default shows as, in this environment. */
export function defaultChoice(key: FlagKey): string | null {
  const def: FlagDef = FLAGS[key];
  const env = flagEnvironment();
  switch (def.value) {
    case 'audience':
      return def.defaults[env];
    case 'mode':
      return def.defaults[env];
    case 'switch':
      return def.defaults[env] ? 'on' : 'off';
    case 'list':
      return null;
  }
}
